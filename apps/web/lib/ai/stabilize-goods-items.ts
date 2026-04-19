/**
 * Пост-обработка goodsItems после ответа модели: выбор одного «правильного» списка по корпусу,
 * дедуп, усечение по НМЦК. Не меняет merge/chunk/pipeline — только sanitize-слой.
 */

import type { TenderAiGoodItem } from "@tendery/contracts";
import type { ExtractGoodsFromTechSpecResult } from "@/lib/ai/extract-goods-from-tech-spec";
import {
  formatQuantityValueForStorage,
  lineLooksLikeTechSpecGoodsRow
} from "@/lib/ai/extract-goods-from-tech-spec";
import {
  extractModelTokens,
  extractTrustedQuantityFromItemBlock,
  normalizeGoodsMatchingKey
} from "@/lib/ai/match-goods-across-sources";

function normWs(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function canonicalGoodsQtyForDedupe(g: TenderAiGoodItem): string {
  if (g.quantityValue != null && Number.isFinite(g.quantityValue)) {
    return normWs(formatQuantityValueForStorage(g.quantityValue));
  }
  return normWs(g.quantity ?? "");
}

/** Грубый разбор суммы из поля НМЦК / денег в строке. */
export function parseRoughMoneyAmount(s: string): number | null {
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

function parseLineTotalAmount(g: TenderAiGoodItem): number {
  const lt = parseRoughMoneyAmount(g.lineTotal ?? "");
  if (lt != null) return lt;
  const q = parseRoughMoneyAmount(g.quantity ?? "");
  const up = parseRoughMoneyAmount(g.unitPrice ?? "");
  if (q != null && up != null) return q * up;
  return 0;
}

/** Строка похожа на строку спецификации (наименование + количество + деньги). */
export function lineHasNameQtyAndPrice(line: string): boolean {
  const t = line.trim();
  if (t.length < 12) return false;
  const hasQty =
    /\d+(?:[.,]\d+)?\s*(?:шт|ед\.?\s*изм|упак|компл|комплект|м(?![а-яё])|кг|л\b|м2|м³)/i.test(
      t
    ) || /\b\d+(?:[.,]\d+)?\s*[xх×]\s*\d+(?:[.,]\d+)?/i.test(t);
  const hasMoney =
    /\d[\d\s]*(?:[.,]\d{2})\s*(?:руб|₽)/i.test(t) ||
    /\d{2,}(?:[.,]\d{2})?\s*(?:руб|₽)/i.test(t) ||
    (/\d{4,}/.test(t.replace(/\s/g, "")) && /\d+(?:[.,]\d+)?/.test(t));
  const notPureHeader =
    !/^(наименование|п\/п|№\s*п\/п|ед\.?\s*изм|количество|цена|стоимость)\s*$/i.test(
      t
    );
  return hasQty && hasMoney && notPureHeader;
}

function lineHasStructuralCode(line: string): boolean {
  return /\d{2}\.\d{2}\.\d{2}\.\d{2,3}(?:\.\d{3})?/.test(line) || /\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{5}/.test(line);
}

function clusterStructuralUniformity(lines: string[]): boolean {
  const dataLines = lines.filter((l) => lineHasNameQtyAndPrice(l));
  if (dataLines.length < 4) return false;
  const counts = dataLines.map((l) => {
    if (l.includes("|")) return l.split("|").filter((c) => c.trim()).length;
    if (/\t/.test(l)) return l.split(/\t/).filter((c) => c.trim()).length;
    return 0;
  });
  const nonzero = counts.filter((c) => c >= 3);
  if (nonzero.length < 3) return false;
  const freq = new Map<number, number>();
  for (const c of nonzero) {
    freq.set(c, (freq.get(c) ?? 0) + 1);
  }
  const max = Math.max(...freq.values());
  return max / nonzero.length >= 0.65;
}

function segmentHasLongLegalBlob(text: string): boolean {
  if (/федеральн[ыйого]\s+закон|постановлени[ем]\s+правительства/i.test(text)) {
    return true;
  }
  for (const line of text.split("\n")) {
    if (line.length > 320 && !/\d{4,}/.test(line)) return true;
  }
  return false;
}

type ScoredSegment = { start: number; end: number; text: string; score: number };

function scoreSegment(lines: string[], start: number, end: number): number {
  const slice = lines.slice(start, end + 1);
  const chunk = slice.join("\n");
  let score = 0;
  for (const line of slice) {
    if (lineHasNameQtyAndPrice(line)) score += 3;
  }
  if (lineHasStructuralCode(chunk)) score += 2;
  if (clusterStructuralUniformity(slice)) score += 2;
  if (/объект\s+закупки|описание\s+объекта\s+закупки/i.test(chunk)) score += 3;
  if (/\bитого\b/i.test(chunk)) score += 2;
  if (!segmentHasLongLegalBlob(chunk)) score += 1;
  return score;
}

const TECH_REGION_PRIORITY_SCORE = 88;

/**
 * Находит непересекающиеся кластеры строк, похожих на таблицу спецификации, и возвращает лучший.
 * При явной таблице ТЗ (много строк с qty без руб.) — приоритет этому фрагменту, а не только «ценовым» строкам.
 */
export function pickBestGoodsListRegion(corpus: string): { text: string; score: number } {
  const lines = corpus.split(/\n/);
  if (lines.length === 0) return { text: corpus, score: 0 };

  const techRowIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lineLooksLikeTechSpecGoodsRow(lines[i]!)) techRowIdx.push(i);
  }
  if (techRowIdx.length >= 2) {
    const techStart = Math.min(...techRowIdx);
    const techEnd = Math.max(...techRowIdx);
    const start = Math.max(0, techStart - 10);
    const end = Math.min(lines.length - 1, techEnd + 5);
    return {
      text: lines.slice(start, end + 1).join("\n"),
      score: TECH_REGION_PRIORITY_SCORE
    };
  }

  const goodIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lineHasNameQtyAndPrice(lines[i]!) || lineHasStructuralCode(lines[i]!)) {
      goodIdx.push(i);
    }
  }
  if (goodIdx.length === 0) return { text: corpus, score: 0 };

  const clusters: Array<{ start: number; end: number }> = [];
  let cs = goodIdx[0]!;
  let pe = goodIdx[0]!;
  for (let k = 1; k < goodIdx.length; k++) {
    const g = goodIdx[k]!;
    if (g - pe <= 4) {
      pe = g;
    } else {
      clusters.push({ start: cs, end: pe });
      cs = g;
      pe = g;
    }
  }
  clusters.push({ start: cs, end: pe });

  let best: ScoredSegment | null = null;
  for (const { start: g0, end: g1 } of clusters) {
    const start = Math.max(0, g0 - 8);
    const end = Math.min(lines.length - 1, g1 + 4);
    const sc = scoreSegment(lines, start, end);
    const text = lines.slice(start, end + 1).join("\n");
    if (!best || sc > best.score || (sc === best.score && text.length > best.text.length)) {
      best = { start, end, text, score: sc };
    }
  }

  return best ? { text: best.text, score: best.score } : { text: corpus, score: 0 };
}

/** Число строк в тексте, похожих на товарные строки спецификации (для оценки полноты по главному блоку). */
export function countGoodsLikeSpecificationLines(text: string): number {
  if (!text?.trim()) return 0;
  return text.split("\n").filter((line) => lineHasNameQtyAndPrice(line)).length;
}

/** Количество + идентификация позиции; цены могут быть только из печатной формы — после reconcile. */
function itemHasCoreSpecificationFields(g: TenderAiGoodItem): boolean {
  const name = (g.name ?? "").trim();
  const q = (g.quantity ?? "").trim();
  const hasQtyNum =
    g.quantityValue != null && Number.isFinite(g.quantityValue) && g.quantityValue >= 0;
  const codes = (g.codes ?? "").trim();
  if (name.length < 2) return false;
  if (!/\d/.test(q) && !hasQtyNum) return false;
  if (codes.length >= 4) return true;
  return name.length >= 8;
}

/** КТРУ/ОКПД в поле codes или вшитые в name (печатная форма / чанки без отдельного codes). */
function extractStructuralCodeSegment(g: TenderAiGoodItem): string {
  const blob = `${g.codes ?? ""} ${g.name ?? ""}`;
  const ktru = blob.match(/\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{5}/);
  if (ktru) return ktru[0]!.toLowerCase();
  const okpd = blob.match(/\d{2}\.\d{2}\.\d{2}\.\d{2,3}(?:\.\d{3})?/);
  if (okpd) return okpd[0]!.toLowerCase();
  return "";
}

function hasStructuralGoodsCode(g: TenderAiGoodItem): boolean {
  return extractStructuralCodeSegment(g).length >= 4;
}

/**
 * Позиция с КТРУ/ОКПД и явным номером строки, но без цифры в quantity (часто печатная форма / чанк AI).
 * Без этого при regionScore ТЗ все мультипозиции с реестровым id схлопываются до одной «строгой» строки.
 */
function itemHasLooseTechPriorityRow(g: TenderAiGoodItem): boolean {
  if (itemHasCoreSpecificationFields(g)) return false;
  const name = (g.name ?? "").trim();
  const q = (g.quantity ?? "").trim();
  const hasQtyNum = g.quantityValue != null && Number.isFinite(g.quantityValue);
  const pid = (g.positionId ?? "").replace(/^№\s*/i, "").trim();
  const regPid = /^\d{8,14}$/.test(pid);
  const shortPid = /^\d{1,4}$/.test(pid);
  if (name.length < 2 && !regPid && !/^spec-missing-\d+$/i.test(pid)) return false;

  const hasCode = hasStructuralGoodsCode(g);

  if (
    regPid &&
    name.length >= 10 &&
    /картридж|тонер|фотобарабан|модел|состав|cf\s|ce\s|tn-|tk-|hp\b|canon|brother|kyocera|xerox|ricoh|sharp/i.test(
      name
    )
  ) {
    return true;
  }

  if (!hasCode && !regPid && !shortPid && !/^spec-missing-\d+$/i.test(pid)) return false;

  if (hasCode) {
    if (/\d/.test(q) || hasQtyNum) return true;
    if (shortPid || regPid) return true;
    if (
      name.length >= 10 &&
      /картридж|тонер|фотобарабан|модел|состав|cf\s|ce\s|tn-|tk-/i.test(name)
    ) {
      return true;
    }
  }

  if (regPid) return true;
  if (shortPid && (hasCode || name.length >= 6)) return true;
  return /^spec-missing-\d+$/i.test(pid);
}

/** Ниже этого порога имя часто только заголовок строки ЕИС («Картридж для»), без п/п — режем коллизии по quantity. */
const TECH_PRIORITY_SHORT_NAME_MAX = 40;

function techPriorityRowSignature(g: TenderAiGoodItem): string {
  const p = normWs((g.positionId ?? "").replace(/^№\s*/i, ""));
  const c = extractStructuralCodeSegment(g)
    .replace(/[^a-z0-9.\-]/gi, "")
    .slice(0, 48);
  const n = normWs(g.name ?? "").slice(0, 96);
  let sig = `${p}|${c}|${n}`;
  if (!p && n.length > 0 && n.length < TECH_PRIORITY_SHORT_NAME_MAX) {
    sig += `|q:${canonicalGoodsQtyForDedupe(g)}`;
  }
  return sig;
}

/** Строгие + ослабленные кандидаты, дедуп по positionId+codes+name (не схлопывать разные реестровые строки). */
function filterGoodsItemsTechPriorityRegion(items: TenderAiGoodItem[]): TenderAiGoodItem[] {
  const bySig = new Map<string, TenderAiGoodItem>();
  for (const g of items) {
    const keep =
      itemHasCoreSpecificationFields(g) || itemHasLooseTechPriorityRow(g);
    if (!keep) continue;
    const k = techPriorityRowSignature(g);
    if (!bySig.has(k)) bySig.set(k, g);
  }
  return Array.from(bySig.values());
}

function itemMentionedInRegion(g: TenderAiGoodItem, regionLower: string): boolean {
  const name = normWs(g.name ?? "").slice(0, 48);
  if (name.length >= 10 && regionLower.includes(name.slice(0, Math.min(36, name.length)))) {
    return true;
  }
  const codes = (g.codes ?? "").replace(/\s/g, "").toLowerCase();
  if (codes.length >= 8 && regionLower.includes(codes.slice(0, 14))) return true;
  const pid = (g.positionId ?? "").replace(/\s/g, "").toLowerCase();
  if (pid && /^\d+$/.test(pid)) {
    const re = new RegExp(`(?:^|\\n|\\s)${pid}\\s*[.)]`, "m");
    if (re.test(regionLower)) return true;
  }
  return false;
}

function filterGoodsItemsToWinningRegion(
  items: TenderAiGoodItem[],
  regionText: string,
  regionScore: number
): TenderAiGoodItem[] {
  if (!regionText || regionText.length < 80 || regionScore < 4) {
    return items.filter(itemHasCoreSpecificationFields);
  }
  if (regionScore >= TECH_REGION_PRIORITY_SCORE - 1) {
    return filterGoodsItemsTechPriorityRegion(items);
  }
  const regionLower = normWs(regionText);
  const kept: TenderAiGoodItem[] = [];
  for (const g of items) {
    if (!itemHasCoreSpecificationFields(g)) continue;
    if (itemMentionedInRegion(g, regionLower)) kept.push(g);
  }
  return kept.length > 0 ? kept : items.filter(itemHasCoreSpecificationFields);
}

function dedupeGoodsItemsByCodeQtyPrice(items: TenderAiGoodItem[]): TenderAiGoodItem[] {
  const seen = new Set<string>();
  const out: TenderAiGoodItem[] = [];
  for (const g of items) {
    const nk = normalizeGoodsMatchingKey(`${g.name ?? ""} ${g.codes ?? ""}`);
    const toks = extractModelTokens(nk);
    const modelKey = toks.sort().join("+") || nk.slice(0, 48);
    const code = normWs(g.codes ?? "").replace(/[^a-z0-9.\-]/gi, "");
    const q = canonicalGoodsQtyForDedupe(g);
    const up = normWs(g.unitPrice ?? "");
    const lt = normWs(g.lineTotal ?? "");
    const pid = normWs(g.positionId ?? "");
    const key =
      modelKey.length >= 4
        ? `${modelKey}|${q}|${code.slice(0, 40)}|${pid}|${up}|${lt}`
        : `${normWs(g.name ?? "").slice(0, 96)}|${q}|${code.slice(0, 40)}|${pid}|${up}|${lt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(g);
  }
  return out;
}

/** Дедуп только при совпадении сигнатуры модели+имени; общий КТРУ не схлопывает разные наименования. */
function dedupeGoodsItemsTechSpecStrict(items: TenderAiGoodItem[]): TenderAiGoodItem[] {
  const seen = new Set<string>();
  const out: TenderAiGoodItem[] = [];
  for (const g of items) {
    const nk = normalizeGoodsMatchingKey(`${g.name ?? ""} ${g.codes ?? ""}`);
    const tokPart = extractModelTokens(nk).sort().join("+");
    const nameSig = normWs(g.name ?? "").slice(0, 160);
    const code = normWs(g.codes ?? "").replace(/[^a-z0-9.\-]/gi, "");
    const q = canonicalGoodsQtyForDedupe(g);
    const up = normWs(g.unitPrice ?? "");
    const lt = normWs(g.lineTotal ?? "");
    const pid = normWs(g.positionId ?? "");
    const key = `${nameSig}|${tokPart}|${q}|${code.slice(0, 48)}|${pid}|${up}|${lt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(g);
  }
  return out;
}

/** Разные реестровые id позиций ЕИС в одном списке — типично печатная форма; не урезать по сумме НМЦК (иначе остаётся одна строка). */
function countDistinctRegistryPositionIds(items: TenderAiGoodItem[]): number {
  const s = new Set<string>();
  for (const g of items) {
    const p = (g.positionId ?? "").replace(/^№\s*/i, "").trim();
    if (/^\d{8,14}$/.test(p)) s.add(p);
  }
  return s.size;
}

/** Прокси «уверенности»: слабее — раньше убираем при перерасходе НМЦК. */
function itemStabilityScore(g: TenderAiGoodItem): number {
  let s = 0;
  if (g.codes && /\d{2}\.\d{2}/.test(g.codes)) s += 4;
  if ((g.name ?? "").trim().length >= 25) s += 2;
  if (parseRoughMoneyAmount(g.lineTotal ?? "") != null) s += 2;
  if ((g.positionId ?? "").trim()) s += 1;
  return s;
}

function trimGoodsItemsToNmckCeiling(items: TenderAiGoodItem[], nmckText: string): TenderAiGoodItem[] {
  const nmck = parseRoughMoneyAmount(nmckText);
  if (nmck == null || items.length === 0) return items;
  if (countDistinctRegistryPositionIds(items) >= 2) return items;
  const withLineTotal = items.filter((g) => parseRoughMoneyAmount(g.lineTotal ?? "") != null).length;
  const withUnit = items.filter((g) => parseRoughMoneyAmount(g.unitPrice ?? "") != null).length;
  if (withLineTotal + withUnit < items.length * 0.35) return items;

  const maxSum = nmck * 1.2;
  let sum = 0;
  for (const g of items) {
    sum += parseLineTotalAmount(g);
  }
  if (sum <= maxSum) return items;

  const ranked = items.map((g, i) => ({
    g,
    i,
    score: itemStabilityScore(g),
    amt: parseLineTotalAmount(g)
  }));
  ranked.sort((a, b) => a.score - b.score || a.i - b.i);
  const dropIdx = new Set<number>();
  let cur = sum;
  for (const row of ranked) {
    if (cur <= maxSum) break;
    dropIdx.add(row.i);
    if (row.amt > 0) cur -= row.amt;
  }
  return items.filter((_, idx) => !dropIdx.has(idx));
}

export type StabilizeGoodsItemsOptions = {
  /** Минимизированный/маскированный корпус тендера (как для delivery_place). */
  corpus: string;
  /** Значение поля nmck после sanitize верхних полей. */
  nmckText: string;
  /**
   * Режим ТЗ-таблицы: не отрезаем по «лучшему региону», не усечём по НМЦК при отсутствии цен,
   * дедуп по полной сигнатуре строки (разные модели при одном КТРУ не схлопываются).
   */
  techSpecDeterministicMode?: boolean;
};

export function stabilizeGoodsItems(
  items: TenderAiGoodItem[],
  options: StabilizeGoodsItemsOptions
): TenderAiGoodItem[] {
  if (!items.length) return items;
  if (options.techSpecDeterministicMode) {
    let out = filterGoodsItemsTechPriorityRegion(items);
    out = dedupeGoodsItemsTechSpecStrict(out);
    if (out.length === 0 && items.length > 0) {
      out = dedupeGoodsItemsTechSpecStrict(items);
    }
    return out;
  }
  const { text: regionText, score: regionScore } = pickBestGoodsListRegion(options.corpus ?? "");
  let out = filterGoodsItemsToWinningRegion(items, regionText, regionScore);
  out = dedupeGoodsItemsByCodeQtyPrice(out);
  out = trimGoodsItemsToNmckCeiling(out, options.nmckText ?? "");
  return out;
}

function dedupeGoodsItemsByNameAndQuantity(items: TenderAiGoodItem[]): TenderAiGoodItem[] {
  const seen = new Set<string>();
  const out: TenderAiGoodItem[] = [];
  for (const g of items) {
    const key = `${normWs((g.name ?? "").slice(0, 160))}|${canonicalGoodsQtyForDedupe(g)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(g);
  }
  return out;
}

/**
 * После reconcile/sanitize: не отдаём пустой список товаров для goods-like тендера.
 * Сначала строки из уже посчитанного бандла ТЗ, затем одна строка из корпуса (существующие эвристики региона).
 */
export function ensureGoodsItemsNonEmptyAfterPipeline(
  bundle: ExtractGoodsFromTechSpecResult | null | undefined,
  corpus: string
): TenderAiGoodItem[] {
  const fromBundle = dedupeGoodsItemsByNameAndQuantity(bundle?.items ?? []);
  if (fromBundle.length > 0) return fromBundle;

  const region = pickBestGoodsListRegion(corpus ?? "").text;
  for (const raw of region.split("\n")) {
    const line = raw.trim();
    if (!lineHasNameQtyAndPrice(line)) continue;
    const qtyRaw = extractTrustedQuantityFromItemBlock(line) || "";
    const name = line.length <= 320 ? line : line.slice(0, 320);
    return [
      {
        name,
        codes: "",
        unit: "шт",
        quantity: qtyRaw,
        positionId: "",
        unitPrice: "",
        lineTotal: "",
        sourceHint: "corpus_fallback_min_one",
        characteristics: [],
        quantityUnit: "",
        quantitySource: "unknown"
      }
    ];
  }

  const t = (corpus ?? "").replace(/\s+/g, " ").trim();
  if (t.length >= 40) {
    return [
      {
        name: t.slice(0, 320),
        codes: "",
        unit: "шт",
        quantity: "",
        positionId: "",
        unitPrice: "",
        lineTotal: "",
        sourceHint: "corpus_fallback_min_one",
        characteristics: [],
        quantityUnit: "",
        quantitySource: "unknown"
      }
    ];
  }

  return [
    {
      name: "Объект закупки",
      codes: "",
      unit: "шт",
      quantity: "",
      positionId: "",
      unitPrice: "",
      lineTotal: "",
      sourceHint: "corpus_fallback_min_one",
      characteristics: [],
      quantityUnit: "",
      quantitySource: "unknown"
    }
  ];
}
