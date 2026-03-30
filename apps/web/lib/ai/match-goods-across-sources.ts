/**
 * ТЗ-first: базовый список из структурного извлечения ТЗ, цены/п/п только из извещения.
 */

import type { TenderAiGoodItem } from "@tendery/contracts";
import {
  extractGoodsFromTechSpec,
  extractQuantityFromTabularGoodsLine,
  shouldUseTechSpecBackbone,
  type ExtractGoodsFromTechSpecResult,
  type GoodsTechSpecParseAudit
} from "@/lib/ai/extract-goods-from-tech-spec";
import {
  extractMoneyStringsForGoodsRow,
  isNoticeGoodsTableRowCandidate
} from "@/lib/ai/extract-goods-notice-table";
import { appendDebugLog } from "@/lib/debug-logger";

/**
 * ТЗ-first сужает итог до строк детерминированного парсера. Если парсер нашёл слишком мало
 * позиций по сравнению с ответом модели (часто 1 «ложная» строка при длинной спецификации),
 * ответ модели нельзя отбрасывать — остаёмся на trusted TZ+notice merge.
 */
function shouldReconcileViaTechSpecRowsFirst(
  bundle: ExtractGoodsFromTechSpecResult,
  aiItemsCount: number
): boolean {
  if (!shouldUseTechSpecBackbone(bundle)) return false;
  const tz = bundle.techSpecExtractedCount;
  /** Одна строка парсера ТЗ при нескольких позициях модели — не сужаем итог до одной позиции. При 0/1 позиции у AI — каркас ТЗ уместен. */
  if (tz === 1 && aiItemsCount >= 2) return false;
  if (tz >= 2 && aiItemsCount > tz + 1 && aiItemsCount >= 2) return false;
  return true;
}
import {
  buildGoodsCorpusClassification,
  type GoodsCorpusClassification
} from "@/lib/ai/masked-corpus-sources";

function parseRoughMoneyAmount(s: string): number | null {
  if (!s?.trim()) return null;
  let t = s.replace(/\s/g, "").replace(",", ".");
  t = t.replace(/[^\d.]/g, "");
  const parts = t.split(".");
  if (parts.length > 2) {
    t = parts.slice(0, -1).join("") + "." + parts[parts.length - 1];
  }
  const n = parseFloat(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export type GoodsSourceAuditRow = {
  matchedKey: string;
  acceptedFromTechSpec: boolean;
  acceptedFromNotice: boolean;
  quantitySource: "tech_spec" | "notice" | "unknown";
  priceSource: "notice" | "other_doc" | "missing";
  wasRejectedAsUntrusted: boolean;
  rejectionReason?: string;
};

export type GoodsSourceAuditSummary = {
  techSpecExtractedCount: number;
  finalRetainedFromTechSpecCount: number;
  matchedWithNoticeCount: number;
  missingPriceCount: number;
  rejectedFromTechSpecCount: number;
  rejectedFromTechSpecReasons: string[];
  rejectedHallucinatedGoodsCount: number;
  goodsCountFromNoticeAnchors: number;
};

export type GoodsBackboneSourceAudit = {
  chosenBackboneSource: string;
  chosenBackboneReason: string[];
  rejectedCandidateSources: { source: string; reason: string }[];
  techSpecParseFailed: boolean;
  foreignSpecRejectedCount: number;
  strictTechFileIndexes: number[];
  strictNoticeFileIndexes: number[];
  ancillaryExcludedFileIndexes: number[];
  positionsAcceptedFromNoticeOnly: number;
};

export type ReconcileGoodsDocumentSourcesResult = {
  items: TenderAiGoodItem[];
  goodsSourceAudit: GoodsSourceAuditRow[];
  goodsSourceSummary: GoodsSourceAuditSummary;
  /** Детерминированный разбор ТЗ-таблицы (строки accepted/rejected). */
  goodsTechSpecParseAudit?: GoodsTechSpecParseAudit;
  goodsBackboneSourceAudit?: GoodsBackboneSourceAudit;
};

const CYR_X = /[\u0445\u0425]/g;

export function normalizeGoodsMatchingKey(text: string): string {
  let t = (text ?? "").toLowerCase();
  t = t.replace(/ё/g, "е");
  t = t.replace(CYR_X, "x");
  t = t.replace(/\bкартридж(?:\s+для)?\s*/gi, "");
  t = t.replace(/\s*,?\s*или\s+эквивалент\b.*$/i, "");
  t = t.replace(/\bчерн(?:ый|ого|ом)\b/gi, "bk");
  t = t.replace(/\bжелт(?:ый|ого)\b/gi, "y");
  t = t.replace(/\bмагент[ао]\b/gi, "m");
  t = t.replace(/\bголуб(?:ой|ого)\b/gi, "c");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

export function extractModelTokens(normalized: string): string[] {
  const out: string[] = [];
  const push = (s: string | undefined) => {
    if (!s) return;
    const x = s.replace(/\s+/g, "").toLowerCase();
    if (x.length >= 3) out.push(x);
  };
  const reList = [
    /\bcf\s*[-]?\s*\d{3,4}[a-z]?\b/gi,
    /\bce\s*[-]?\s*\d{3,4}[a-z]?\b/gi,
    /\btw\s*[-]?\s*\d{3,4}[a-z]?\b/gi,
    /\btk\s*[-]?\s*\d{3,5}\b/gi,
    /\btn\s*[-]?\s*\d{4}\b/gi,
    /\b\d{3}\s*h\s*[cmbyk]{1,3}\b/gi,
    /\b067\s*h\b/gi
  ];
  for (const re of reList) {
    let m: RegExpExecArray | null;
    const r = new RegExp(re.source, re.flags);
    while ((m = r.exec(normalized))) push(m[0]);
  }
  const ktru = normalized.match(/\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{5}/);
  push(ktru?.[0]);
  const okpd = normalized.match(/\d{2}\.\d{2}\.\d{2}\.\d{2,3}(?:\.\d{3})?/);
  push(okpd?.[0]);
  return [...new Set(out)];
}

function buildTrustedHaystack(strictTech: string, strictNotice: string): string {
  return normalizeGoodsMatchingKey(`${strictTech}\n${strictNotice}`);
}

/**
 * Подтверждение позиции в доверенном корпусе (строгое ТЗ + строгое извещение), без побочных «спецификаций».
 */
export function goodItemHasTrustedCorpusEvidence(g: TenderAiGoodItem, trustedHaystack: string): boolean {
  const parts = [
    g.name,
    g.codes,
    ...(g.characteristics ?? []).map((c) => `${c.value ?? ""}`)
  ].join("\n");
  const nk = normalizeGoodsMatchingKey(parts);
  const toks = extractModelTokens(nk);
  const nonKtru = toks.filter((t) => !/^\d{2}\.\d{2}\.\d{2}/.test(t));
  const hay = trustedHaystack.toLowerCase();
  for (const t of nonKtru) {
    const c = t.replace(/\s/g, "").toLowerCase();
    if (c.length >= 4 && hay.includes(c)) return true;
  }
  for (const ch of g.characteristics ?? []) {
    const v = normalizeGoodsMatchingKey((ch.value ?? "").trim());
    if (v.length >= 6 && hay.includes(v)) return true;
  }
  const pid = (g.positionId ?? "").trim();
  if (/^\d{8,}$/.test(pid) && hay.includes(pid)) return true;
  const code = (g.codes ?? "").replace(/\s/g, "").toLowerCase();
  if (code.length >= 14 && hay.includes(code)) {
    const charVals = (g.characteristics ?? [])
      .map((c) => normalizeGoodsMatchingKey((c.value ?? "").trim()))
      .filter((v) => v.length >= 6);
    if (charVals.some((v) => hay.includes(v))) return true;
  }
  return false;
}

export type { MaskedCorpusSourceSplit } from "@/lib/ai/masked-corpus-sources";
export { splitMaskedCorpusByLikelySource, buildGoodsCorpusClassification } from "@/lib/ai/masked-corpus-sources";

function lineHasRub(line: string): boolean {
  return /\d[\d\s]*(?:[.,]\d{1,2})?\s*(?:руб|₽)/i.test(line);
}

function lineLooksLikeTechQtyRow(line: string): boolean {
  const t = line.trim();
  if (t.length < 14) return false;
  if (lineHasRub(t)) return false;
  if (/(?:\d+(?:[.,]\d+)?\s*(?:шт|ед\.?\s*изм|упак|компл|комплект))/i.test(t)) return true;
  if (
    /\d{2}\.\d{2}\.\d{2}/.test(t) &&
    /\d+(?:[.,]\d+)?/.test(t) &&
    /(?:наименован|модел|картридж|тонер|состав|характеристик)/i.test(t)
  ) {
    return true;
  }
  return false;
}

function lineLooksLikeNoticePriceRow(line: string): boolean {
  const t = line.trim();
  if (t.length < 14) return false;
  if (lineHasRub(t)) return true;
  /** В печатных формах ЕИС «руб» часто только в шапке колонки, не в каждой строке. */
  return isNoticeGoodsTableRowCandidate(t);
}

function extractLeadingPositionId(line: string): string | undefined {
  const m = line.match(/^\s*(\d{1,4})\s*[\.)]\s/);
  return m?.[1];
}

function extractQuantityFromLine(line: string): string | undefined {
  return extractQuantityFromTabularGoodsLine(line);
}

function extractPricesFromNoticeLine(line: string): { unitPrice: string; lineTotal: string } {
  const rubs = [...line.matchAll(/(\d[\d\s]*(?:[.,]\d{1,2})?)\s*(?:руб|₽)/gi)];
  if (rubs.length === 0) return { unitPrice: "", lineTotal: "" };
  const nums = rubs.map((x) => x[1]!.replace(/\s/g, "").trim());
  if (nums.length >= 2) {
    return { unitPrice: nums[0]!, lineTotal: nums[nums.length - 1]! };
  }
  return { unitPrice: nums[0]!, lineTotal: nums[0]! };
}

type CorpusAnchor = {
  key: string;
  tokens: string[];
  positionId?: string;
  quantity?: string;
  unitPrice: string;
  lineTotal: string;
  rawLine: string;
  source: "tech" | "notice";
};

function buildAnchorsFromText(text: string, source: "tech" | "notice"): CorpusAnchor[] {
  const out: CorpusAnchor[] = [];
  for (const line of text.split("\n")) {
    const ok =
      source === "tech" ? lineLooksLikeTechQtyRow(line) : lineLooksLikeNoticePriceRow(line);
    if (!ok) continue;
    const nk = normalizeGoodsMatchingKey(line);
    const tokens = extractModelTokens(nk);
    if (tokens.length === 0 && !/\d{2}\.\d{2}\.\d{2}/.test(line)) {
      if (source === "tech" && line.trim().length < 40) continue;
      if (source === "notice") continue;
    }
    const qty = extractQuantityFromLine(line);
    const pos = extractLeadingPositionId(line);
    const regPos = line.match(/\b(20\d{7,11})\b/)?.[1];
    const { unitPrice, lineTotal } =
      source === "notice" ? extractPricesFromNoticeLine(line) : { unitPrice: "", lineTotal: "" };
    const key = tokens[0] ?? nk.slice(0, 32).replace(/\s+/g, "_");
    if (key.length < 3) continue;
    out.push({
      key,
      tokens: tokens.length ? tokens : [key],
      positionId: regPos || pos,
      quantity: qty,
      unitPrice,
      lineTotal,
      rawLine: line.trim(),
      source
    });
  }
  return out;
}

/**
 * Печатная форма с ценами часто лежит в том же файле, что и ТЗ, и классифицируется как tech_primary —
 * тогда strictNoticeText пустой, а строки с рублями и реестровым id есть только в полном корпусе.
 */
function mergeDedupeNoticeAnchors(a: CorpusAnchor[], b: CorpusAnchor[]): CorpusAnchor[] {
  const seen = new Set<string>();
  const out: CorpusAnchor[] = [];
  for (const list of [a, b]) {
    for (const x of list) {
      const k = x.rawLine.replace(/\s+/g, " ").trim();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}

function buildNoticeAnchorsForReconcile(strictNoticeText: string, maskedFullCorpus: string): CorpusAnchor[] {
  const fromStrict = buildAnchorsFromText(strictNoticeText, "notice");
  const fromFull = buildAnchorsFromText(maskedFullCorpus ?? "", "notice");
  return mergeDedupeNoticeAnchors(fromStrict, fromFull);
}

function tokensOverlap(a: string[], b: string[]): boolean {
  const A = new Set(a.map((x) => x.toLowerCase()));
  for (const x of b) {
    if (A.has(x.toLowerCase())) return true;
  }
  for (const ta of a) {
    for (const tb of b) {
      if (ta.length >= 5 && tb.length >= 5 && (ta.includes(tb) || tb.includes(ta))) return true;
    }
  }
  return false;
}

function findBestAnchor(
  itemTokens: string[],
  anchors: CorpusAnchor[],
  itemNameNorm: string,
  minScore = 4
): CorpusAnchor | null {
  let best: CorpusAnchor | null = null;
  let bestScore = 0;
  for (const a of anchors) {
    let sc = 0;
    if (tokensOverlap(a.tokens, itemTokens)) sc += 5;
    if (
      itemNameNorm.length >= 12 &&
      normalizeGoodsMatchingKey(a.rawLine).includes(itemNameNorm.slice(0, 28))
    ) {
      sc += 3;
    }
    if (itemTokens.some((t) => t.length >= 5 && normalizeGoodsMatchingKey(a.rawLine).includes(t))) {
      sc += 2;
    }
    if (sc > bestScore) {
      bestScore = sc;
      best = a;
    }
  }
  return bestScore >= minScore ? best : null;
}

function lineIndexContainingRegistryId(lines: string[], pid: string): number {
  const compactPid = pid.replace(/\s/g, "");
  return lines.findIndex((ln) => {
    if (ln.includes(pid)) return true;
    return compactPid.length >= 8 && ln.replace(/\s/g, "").includes(compactPid);
  });
}

/** Окно строк вокруг реестрового id: в OCR/извлечении КТРУ, кол-во и суммы часто на соседних строках. */
function buildRegistryWindowText(corpus: string, pid: string): string {
  if (!corpus.trim() || !pid) return "";
  const lines = corpus.split("\n");
  const i = lineIndexContainingRegistryId(lines, pid);
  if (i < 0) return "";
  const from = Math.max(0, i - 2);
  const to = Math.min(lines.length, i + 3);
  return lines
    .slice(from, to)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function tailAfterRegistryId(block: string, pid: string): string {
  const idx = block.indexOf(pid);
  if (idx >= 0) return block.slice(idx + pid.length);
  const cPid = pid.replace(/\s/g, "");
  const cBlock = block.replace(/\s/g, "");
  const ci = cBlock.indexOf(cPid);
  return ci < 0 ? "" : cBlock.slice(ci + cPid.length);
}

function extractQuantityAfterRegistryShPt(block: string, pid: string): string | undefined {
  const tail = tailAfterRegistryId(block, pid);
  if (!tail) return undefined;
  const matches = [...tail.matchAll(/(\d{1,4})\s*(?:шт|ед\.?\s*изм|упак|компл|комплект)\b/gi)];
  if (!matches.length) return undefined;
  const m = matches[matches.length - 1]!;
  const q = m[1]!.replace(/\s/g, "").replace(",", ".");
  const n = parseFloat(q);
  if (!Number.isFinite(n) || n < 1 || n > 100_000) return undefined;
  if (!Number.isInteger(n) && n > 200) return undefined;
  return String(n);
}

/** Якорь без предварительного попадания строки в noticeAnchors (разорванная таблица, нет «руб» в строке и т.д.). */
function syntheticNoticeAnchorFromRegistry(corpus: string, pid: string): CorpusAnchor | null {
  const block = buildRegistryWindowText(corpus, pid);
  if (!block.includes(pid)) return null;
  const qtyTab = extractQuantityFromTabularGoodsLine(block)?.trim() ?? "";
  const qtySh = extractQuantityAfterRegistryShPt(block, pid)?.trim() ?? "";
  const qty = qtyTab || qtySh;
  const money = extractMoneyStringsForGoodsRow(block);
  if (!qty && money.length === 0) return null;
  const nk = normalizeGoodsMatchingKey(block);
  const tokens = extractModelTokens(nk);
  const key = (tokens[0] ?? pid).slice(0, 64);
  let unitPrice = "";
  let lineTotal = "";
  if (money.length >= 2) {
    unitPrice = money[0]!;
    lineTotal = money[money.length - 1]!;
  } else if (money.length === 1) {
    lineTotal = money[0]!;
  }
  // #region agent log
  fetch("http://127.0.0.1:7684/ingest/4fdbeace-af80-41b7-ba60-fe62d0bf9aba", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "7d64fb" },
    body: JSON.stringify({
      sessionId: "7d64fb",
      location: "match-goods-across-sources.ts:syntheticNoticeAnchorFromRegistry",
      message: "registry_window_anchor",
      data: {
        pid,
        qty,
        moneyLen: money.length,
        blockPreview: block.slice(0, 380)
      },
      timestamp: Date.now(),
      hypothesisId: "F"
    })
  }).catch(() => {});
  appendDebugLog({
    location: "match-goods-across-sources.ts:syntheticNoticeAnchorFromRegistry",
    message: "registry_window_anchor",
    data: {
      pid,
      qty,
      moneyLen: money.length,
      blockPreview: block.slice(0, 380)
    },
    hypothesisId: "F"
  });
  // #endregion
  return {
    key,
    tokens: tokens.length ? tokens : [pid],
    positionId: pid,
    quantity: qty || undefined,
    unitPrice,
    lineTotal,
    rawLine: block.slice(0, 2500),
    source: "notice"
  };
}

/** Строка извещения с тем же реестровым id позиции — приоритетнее общего token-match (один КТРУ на много моделей). */
function resolveNoticeAnchorForGoodsItem(
  g: TenderAiGoodItem,
  itemTokens: string[],
  itemNameNorm: string,
  noticeAnchors: CorpusAnchor[],
  maskedFullCorpus: string
): CorpusAnchor | null {
  const pid = (g.positionId ?? "").replace(/^№\s*/i, "").trim();
  if (/^20\d{7,11}$/.test(pid)) {
    const byReg = noticeAnchors.find((a) => a.rawLine.includes(pid));
    if (byReg) return byReg;
    const syn = syntheticNoticeAnchorFromRegistry(maskedFullCorpus, pid);
    if (syn) return syn;
  }
  return findBestAnchor(itemTokens, noticeAnchors, itemNameNorm, 3);
}

function resolveNoticeHitForTechRow(
  tzPid: string,
  tzTokens: string[],
  tzNorm: string,
  noticeAnchors: CorpusAnchor[],
  maskedFullCorpus: string
): CorpusAnchor | null {
  const pid = tzPid.replace(/^№\s*/i, "").trim();
  if (/^20\d{7,11}$/.test(pid)) {
    const byReg = noticeAnchors.find((a) => a.rawLine.includes(pid));
    if (byReg) return byReg;
    const syn = syntheticNoticeAnchorFromRegistry(maskedFullCorpus, pid);
    if (syn) return syn;
  }
  return findBestAnchor(tzTokens, noticeAnchors, tzNorm, 3);
}

function moneyConfirmedInLine(line: string, value: string): boolean {
  const amt = parseRoughMoneyAmount(value);
  if (amt == null) return false;
  const compact = String(Math.round(amt * 100) / 100);
  const flat = line.replace(/\s/g, "");
  return flat.includes(value.replace(/\s/g, "")) || flat.includes(compact.replace(".", ","));
}

function preferLonger(a: string, b: string): string {
  const x = (a ?? "").trim();
  const y = (b ?? "").trim();
  return y.length > x.length ? y : x;
}

function pickBestAiForTechRow(
  tz: TenderAiGoodItem,
  aiItems: TenderAiGoodItem[],
  tzTokens: string[],
  tzNorm: string
): TenderAiGoodItem | null {
  let best: TenderAiGoodItem | null = null;
  let bestSc = 0;
  for (const ai of aiItems) {
    const nk = normalizeGoodsMatchingKey(`${ai.name} ${ai.codes}`);
    const toks = extractModelTokens(nk);
    let sc = 0;
    if (tokensOverlap(tzTokens, toks)) sc += 6;
    if (tzNorm.length >= 10 && nk.includes(tzNorm.slice(0, Math.min(28, tzNorm.length)))) sc += 4;
    if (toks.some((t) => tzNorm.includes(t) && t.length >= 4)) sc += 3;
    if (sc > bestSc) {
      bestSc = sc;
      best = ai;
    }
  }
  return bestSc >= 4 ? best : null;
}

function aiOverlapsAnyTechRow(ai: TenderAiGoodItem, techRows: TenderAiGoodItem[]): boolean {
  const nk = normalizeGoodsMatchingKey(`${ai.name} ${ai.codes}`);
  const toks = extractModelTokens(nk);
  for (const tz of techRows) {
    const tzNorm = normalizeGoodsMatchingKey(`${tz.name} ${tz.codes}`);
    const tzToks = extractModelTokens(tzNorm);
    if (tokensOverlap(toks, tzToks)) return true;
    if (nk.length >= 14 && tzNorm.includes(nk.slice(0, 22))) return true;
    if (nk.length >= 14 && nk.includes(tzNorm.slice(0, 22))) return true;
  }
  return false;
}

function attachNoticePrices(
  noticeHit: CorpusAnchor | null,
  fallbackAi: TenderAiGoodItem | null
): { unitPrice: string; lineTotal: string; priceSource: GoodsSourceAuditRow["priceSource"] } {
  let unitPrice = "";
  let lineTotal = "";
  let priceSource: GoodsSourceAuditRow["priceSource"] = "missing";
  if (noticeHit) {
    if (noticeHit.unitPrice && moneyConfirmedInLine(noticeHit.rawLine, noticeHit.unitPrice)) {
      unitPrice = noticeHit.unitPrice;
    }
    if (noticeHit.lineTotal && moneyConfirmedInLine(noticeHit.rawLine, noticeHit.lineTotal)) {
      lineTotal = noticeHit.lineTotal;
    }
    if (!unitPrice && fallbackAi?.unitPrice?.trim() && moneyConfirmedInLine(noticeHit.rawLine, fallbackAi.unitPrice)) {
      unitPrice = fallbackAi.unitPrice.trim();
    }
    if (!lineTotal && fallbackAi?.lineTotal?.trim() && moneyConfirmedInLine(noticeHit.rawLine, fallbackAi.lineTotal)) {
      lineTotal = fallbackAi.lineTotal.trim();
    }
    if (unitPrice || lineTotal) priceSource = "notice";
  }
  return { unitPrice, lineTotal, priceSource };
}

function mergeFallbackLenient(
  aiItems: TenderAiGoodItem[],
  classification: GoodsCorpusClassification,
  bundle: ExtractGoodsFromTechSpecResult,
  maskedFullCorpus: string
): ReconcileGoodsDocumentSourcesResult {
  const strictTech = classification.strictTechText;
  const strictNotice = classification.strictNoticeText;
  const techAnchors = buildAnchorsFromText(strictTech, "tech");
  const noticeAnchorsStrict = buildAnchorsFromText(strictNotice, "notice");
  const noticeAnchors = buildNoticeAnchorsForReconcile(strictNotice, maskedFullCorpus);
  const trustedHaystack = buildTrustedHaystack(strictTech, strictNotice);

  const techSpecParseFailed =
    bundle.techSpecExtractedCount === 0 && bundle.strictTechCorpusChars >= 80;

  const rejectedCandidateSources = classification.blocks
    .filter((b) => b.role === "ancillary_spec")
    .map((b) => ({
      source: b.headline,
      reason: "spec_without_tz_title_excluded_from_goods_backbone"
    }));

  const chosenBackboneReason: string[] = [
    `strict_tech_chars=${strictTech.length}`,
    `strict_notice_chars=${strictNotice.length}`,
    `tech_anchors=${techAnchors.length}`,
    `notice_anchors_strict=${noticeAnchorsStrict.length}`,
    `notice_anchors_merged=${noticeAnchors.length}`,
    techSpecParseFailed ? "tech_spec_parser_zero_on_non_empty_strict_corpus" : "structured_tech_backbone_not_used"
  ];

  let foreignSpecRejectedCount = 0;
  let positionsAcceptedFromNoticeOnly = 0;

  const audit: GoodsSourceAuditRow[] = [];
  const out: TenderAiGoodItem[] = [];

  for (const g of aiItems) {
    const nk = normalizeGoodsMatchingKey(`${g.name} ${g.codes}`);
    const toks = extractModelTokens(nk);
    const techHit = findBestAnchor(toks, techAnchors, nk, 3);
    const noticeHit = resolveNoticeAnchorForGoodsItem(g, toks, nk, noticeAnchors, maskedFullCorpus);
    const distinct = goodItemHasTrustedCorpusEvidence(g, trustedHaystack);

    const acceptedTech = Boolean(techHit);
    const acceptedNotice = Boolean(noticeHit);
    const accepted = acceptedTech || acceptedNotice || distinct;

    if (!accepted) {
      foreignSpecRejectedCount++;
      audit.push({
        matchedKey: toks[0] ?? nk.slice(0, 40),
        acceptedFromTechSpec: false,
        acceptedFromNotice: false,
        quantitySource: "unknown",
        priceSource: "missing",
        wasRejectedAsUntrusted: true,
        rejectionReason: "not_confirmed_in_strict_tz_or_notice"
      });
      continue;
    }

    if (!acceptedTech && acceptedNotice) positionsAcceptedFromNoticeOnly++;

    const noticeQtyFromLine = noticeHit
      ? (noticeHit.quantity?.trim() ||
          extractQuantityFromTabularGoodsLine(noticeHit.rawLine) ||
          "")
      : "";
    const aiQty = (g.quantity ?? "").trim();
    const tzQty = techHit?.quantity?.trim() ?? "";
    /** Печатная форма / извещение — источник количества и цен; ТЗ — характеристики; tech anchor часто цепляет неверную строку при одном КТРУ. */
    const qty = noticeQtyFromLine || aiQty || tzQty;

    const { unitPrice, lineTotal, priceSource } = attachNoticePrices(noticeHit, g);

    let quantitySource: GoodsSourceAuditRow["quantitySource"] = "unknown";
    if (noticeQtyFromLine) quantitySource = "notice";
    else if (aiQty) quantitySource = "unknown";
    else if (tzQty) quantitySource = "tech_spec";

    audit.push({
      matchedKey: toks[0] ?? nk.slice(0, 40),
      acceptedFromTechSpec: acceptedTech || distinct,
      acceptedFromNotice: acceptedNotice,
      quantitySource,
      priceSource,
      wasRejectedAsUntrusted: false
    });

    const pidNorm = (g.positionId ?? "").replace(/^№\s*/i, "").trim();
    const positionIdOut =
      (/^20\d{7,11}$/.test(pidNorm) ? (g.positionId ?? "").trim() : "") ||
      (noticeHit?.positionId?.trim() || "") ||
      (g.positionId ?? "").trim() ||
      "";

    // #region agent log
    if (/^20\d{7,11}$/.test(pidNorm)) {
      const payload = {
        location: "match-goods-across-sources.ts:mergeFallbackLenient",
        message: "goods_qty_sources",
        data: {
          pid: pidNorm,
          noticeQty: noticeQtyFromLine,
          aiQty,
          tzQty,
          qtyOut: qty,
          noticeLinePreview: noticeHit?.rawLine?.slice(0, 200) ?? "",
          noticeAnchorsMerged: noticeAnchors.length,
          corpusLen: maskedFullCorpus.length,
          runId: "post-fix"
        },
        hypothesisId: "B",
        timestamp: Date.now()
      };
      fetch("http://127.0.0.1:7684/ingest/4fdbeace-af80-41b7-ba60-fe62d0bf9aba", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "7d64fb" },
        body: JSON.stringify({ sessionId: "7d64fb", ...payload })
      }).catch(() => {});
      appendDebugLog(payload);
    }
    // #endregion

    out.push({
      ...g,
      quantity: qty,
      unitPrice,
      lineTotal,
      positionId: positionIdOut
    });
  }

  const summary: GoodsSourceAuditSummary = {
    techSpecExtractedCount: bundle.techSpecExtractedCount,
    finalRetainedFromTechSpecCount: out.length,
    matchedWithNoticeCount: audit.filter((r) => !r.wasRejectedAsUntrusted && r.acceptedFromNotice)
      .length,
    missingPriceCount: audit.filter((r) => !r.wasRejectedAsUntrusted && r.priceSource === "missing")
      .length,
    rejectedFromTechSpecCount: 0,
    rejectedFromTechSpecReasons: [],
    rejectedHallucinatedGoodsCount: foreignSpecRejectedCount,
    goodsCountFromNoticeAnchors: new Set(noticeAnchors.map((a) => a.key)).size
  };

  const goodsBackboneSourceAudit: GoodsBackboneSourceAudit = {
    chosenBackboneSource: "trusted_tz_notice_validated_ai_merge",
    chosenBackboneReason,
    rejectedCandidateSources,
    techSpecParseFailed,
    foreignSpecRejectedCount,
    strictTechFileIndexes: classification.blocks.filter((b) => b.role === "tech_primary").map((b) => b.fileIndex),
    strictNoticeFileIndexes: classification.blocks
      .filter((b) => b.role === "notice_primary")
      .map((b) => b.fileIndex),
    ancillaryExcludedFileIndexes: [...classification.ancillaryExcludedFileIndexes],
    positionsAcceptedFromNoticeOnly
  };

  return {
    items: out,
    goodsSourceAudit: audit,
    goodsSourceSummary: summary,
    goodsTechSpecParseAudit: bundle.parseAudit,
    goodsBackboneSourceAudit
  };
}

/**
 * ТЗ-first reconcile: при явной ТЗ-таблице итог = строки парсера ТЗ + enrichment из AI + цены/п/п из извещения.
 */
export function reconcileGoodsItemsWithDocumentSources(
  aiItems: TenderAiGoodItem[],
  maskedFullCorpus: string,
  precomputedTechSpec?: ExtractGoodsFromTechSpecResult
): ReconcileGoodsDocumentSourcesResult {
  const classification = buildGoodsCorpusClassification(maskedFullCorpus);
  const bundle = precomputedTechSpec ?? extractGoodsFromTechSpec(maskedFullCorpus);
  const strictNotice = classification.strictNoticeText;
  const noticeAnchors = buildNoticeAnchorsForReconcile(strictNotice, maskedFullCorpus);

  if (!shouldReconcileViaTechSpecRowsFirst(bundle, aiItems.length)) {
    const fb = mergeFallbackLenient(aiItems, classification, bundle, maskedFullCorpus);
    const reason =
      shouldUseTechSpecBackbone(bundle) && !shouldReconcileViaTechSpecRowsFirst(bundle, aiItems.length)
        ? [
            `tech_rows_first_skipped:tz=${bundle.techSpecExtractedCount},ai=${aiItems.length}`,
            ...bundle.diagnostics.map((d) => `tech_extract:${d}`)
          ]
        : bundle.diagnostics.map((d) => `tech_extract:${d}`);
    return {
      ...fb,
      goodsSourceSummary: {
        ...fb.goodsSourceSummary,
        techSpecExtractedCount: bundle.techSpecExtractedCount,
        rejectedFromTechSpecReasons: [...fb.goodsSourceSummary.rejectedFromTechSpecReasons, ...reason]
      }
    };
  }

  const audit: GoodsSourceAuditRow[] = [];
  const out: TenderAiGoodItem[] = [];
  let matchedWithNotice = 0;
  let missingPrice = 0;
  let rejectedHallucinated = 0;

  for (const ai of aiItems) {
    if (!aiOverlapsAnyTechRow(ai, bundle.items)) rejectedHallucinated++;
  }

  for (const tz of bundle.items) {
    const tzNorm = normalizeGoodsMatchingKey(`${tz.name} ${tz.codes}`);
    const tzTokens = extractModelTokens(tzNorm);
    const bestAi = pickBestAiForTechRow(tz, aiItems, tzTokens, tzNorm);
    const tzPid = (tz.positionId ?? "").replace(/^№\s*/i, "").trim();
    const noticeHit = resolveNoticeHitForTechRow(tzPid, tzTokens, tzNorm, noticeAnchors, maskedFullCorpus);

    const { unitPrice, lineTotal, priceSource } = attachNoticePrices(noticeHit, bestAi);

    if (noticeHit && (unitPrice || lineTotal)) matchedWithNotice++;
    if (!unitPrice && !lineTotal) missingPrice++;

    const noticeQtyFromLine = noticeHit
      ? (noticeHit.quantity?.trim() ||
          extractQuantityFromTabularGoodsLine(noticeHit.rawLine) ||
          "")
      : "";
    const qtyFromTz = (tz.quantity ?? "").trim();
    const qtyFinal =
      noticeQtyFromLine || qtyFromTz || (bestAi?.quantity ?? "").trim() || "";
    let quantitySource: GoodsSourceAuditRow["quantitySource"] = "unknown";
    if (noticeQtyFromLine) quantitySource = "notice";
    else if (qtyFromTz) quantitySource = "tech_spec";
    else if ((bestAi?.quantity ?? "").trim()) quantitySource = "unknown";

    const positionId =
      (/^20\d{7,11}$/.test(tzPid) ? (tz.positionId ?? "").trim() : "") ||
      (noticeHit?.positionId?.trim() ||
        (bestAi?.positionId ?? "").trim() ||
        (tz.positionId ?? "").trim()) ||
      "";

    const tzChars = (tz.characteristics ?? []).filter((c) => (c.name ?? "").trim() || (c.value ?? "").trim());
    const aiChars = (bestAi?.characteristics ?? []).filter(
      (c) => (c.name ?? "").trim() || (c.value ?? "").trim()
    );
    const characteristics = tzChars.length > 0 ? tzChars : aiChars;

    out.push({
      name: preferLonger(tz.name, bestAi?.name ?? ""),
      codes: (tz.codes || "").trim() || (bestAi?.codes ?? "").trim(),
      unit: (tz.unit || bestAi?.unit || "шт").trim(),
      quantity: qtyFinal,
      positionId: positionId || (bestAi?.positionId ?? "") || (tz.positionId ?? "") || "",
      unitPrice,
      lineTotal,
      sourceHint: tz.sourceHint || bestAi?.sourceHint || "",
      characteristics
    });

    audit.push({
      matchedKey: tzTokens[0] ?? tzNorm.slice(0, 40),
      acceptedFromTechSpec: true,
      acceptedFromNotice: Boolean(noticeHit),
      quantitySource,
      priceSource,
      wasRejectedAsUntrusted: false
    });
  }

  const summary: GoodsSourceAuditSummary = {
    techSpecExtractedCount: bundle.techSpecExtractedCount,
    finalRetainedFromTechSpecCount: out.length,
    matchedWithNoticeCount: matchedWithNotice,
    missingPriceCount: missingPrice,
    rejectedFromTechSpecCount: 0,
    rejectedFromTechSpecReasons: bundle.diagnostics,
    rejectedHallucinatedGoodsCount: rejectedHallucinated,
    goodsCountFromNoticeAnchors: new Set(noticeAnchors.map((a) => a.key)).size
  };

  const rejectedCandidateSources = classification.blocks
    .filter((b) => b.role === "ancillary_spec")
    .map((b) => ({
      source: b.headline,
      reason: "spec_without_tz_title_excluded_from_goods_backbone"
    }));

  const goodsBackboneSourceAudit: GoodsBackboneSourceAudit = {
    chosenBackboneSource: "tech_spec_deterministic_parser",
    chosenBackboneReason: [
      `parsed_rows=${bundle.techSpecExtractedCount}`,
      `strict_tech_chars=${bundle.strictTechCorpusChars}`,
      `ancillary_excluded_files=[${classification.ancillaryExcludedFileIndexes.join(",")}]`
    ],
    rejectedCandidateSources,
    techSpecParseFailed: bundle.techSpecExtractedCount === 0 && bundle.strictTechCorpusChars >= 80,
    foreignSpecRejectedCount: rejectedHallucinated,
    strictTechFileIndexes: classification.blocks.filter((b) => b.role === "tech_primary").map((b) => b.fileIndex),
    strictNoticeFileIndexes: classification.blocks
      .filter((b) => b.role === "notice_primary")
      .map((b) => b.fileIndex),
    ancillaryExcludedFileIndexes: [...classification.ancillaryExcludedFileIndexes],
    positionsAcceptedFromNoticeOnly: matchedWithNotice
  };

  return {
    items: out,
    goodsSourceAudit: audit,
    goodsSourceSummary: summary,
    goodsTechSpecParseAudit: {
      ...bundle.parseAudit,
      finalRetainedFromTechSpecCount: out.length
    },
    goodsBackboneSourceAudit
  };
}

/** Recheck: позиция допустима, если есть в тексте ТЗ/извещения или пересекается с извлечённым ТЗ. */
export function filterGoodsItemsForTrustedRecheck(
  items: TenderAiGoodItem[],
  maskedFullCorpus: string
): TenderAiGoodItem[] {
  if (!items.length) return items;
  const classification = buildGoodsCorpusClassification(maskedFullCorpus);
  const bundle = extractGoodsFromTechSpec(maskedFullCorpus);
  const trustedHaystack = buildTrustedHaystack(classification.strictTechText, classification.strictNoticeText);
  const noticeAnchors = buildNoticeAnchorsForReconcile(classification.strictNoticeText, maskedFullCorpus);

  return items.filter((g) => {
    if (aiOverlapsAnyTechRow(g, bundle.items)) return true;
    if (goodItemHasTrustedCorpusEvidence(g, trustedHaystack)) return true;
    const nk = normalizeGoodsMatchingKey(`${g.name} ${g.codes}`);
    const toks = extractModelTokens(nk);
    if (findBestAnchor(toks, noticeAnchors, nk, 3)) return true;
    return false;
  });
}
