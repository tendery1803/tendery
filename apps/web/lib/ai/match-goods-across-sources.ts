/**
 * ТЗ-first: базовый список из структурного извлечения ТЗ, цены/п/п только из извещения.
 */

import type { GoodsQuantitySource, TenderAiGoodItem } from "@tendery/contracts";
import {
  extractGoodsFromTechSpec,
  extractQuantityFromTabularGoodsLine,
  formatQuantityValueForStorage,
  parseRelaxedColonAndTabCharacteristicLines,
  shouldUseTechSpecBackbone,
  type ExtractGoodsFromTechSpecResult,
  type GoodsTechSpecParseAudit
} from "@/lib/ai/extract-goods-from-tech-spec";
import {
  isRegistryStylePositionId,
  REGISTRY_POSITION_ID_CAPTURE_RE,
  registryPidOccursOnlyInTovarShtukaPriceGlueCorpus
} from "@/lib/ai/registry-position-ids";
import {
  dedupeTechSpecBundleCrossSource,
  stripGlueOnlyRegistryPositionIdsFromTechSpecBundle
} from "@/lib/ai/deterministic-goods-merge";
import { stripDuplicateRegistryPidFromConsecutiveCanon067hColorVariantRows } from "@/lib/ai/strip-duplicate-registry-pid-canon067h-variant-run";
import { synthesizeGoodNameFromCharacteristicsWhenEisTovarShtukaGlued } from "@/lib/ai/synthesize-good-name-eis-tovar-shtuka-glue";
import { stripVerticalSpecTitleEchoFromCharacteristics } from "@/lib/ai/tech-spec-vertical-goods-layout";
import {
  stripCorpusRoutingMarkerFromTechSpecValue,
  truncateAppendedLegalBoilerplateFromDescriptionValue
} from "@/lib/ai/tech-spec-characteristics/parse-colon";
import {
  buildNoticeDeterministicRowsForGoodsMerge,
  extractMoneyStringsForGoodsRow,
  extractGoodsPositionsFromRegistryIds,
  isNoticeGoodsTableRowCandidate,
  normalizeGoodsInfoProductNameKey
} from "@/lib/ai/extract-goods-notice-table";
import { distinctRegistryPidsSharingCodes, normGoodsPositionId } from "@/lib/ai/goods-position-id-status";
import {
  positionIdMatchConfidenceForMergeFallbackLenient,
  positionIdMatchConfidenceForTechRowReconcile
} from "@/lib/ai/goods-position-id-match-confidence";
import { narrowPositionIdCandidatesForAmbiguousItem } from "@/lib/ai/narrow-position-id-candidates";
import { extractNameDisambiguationNeedles } from "@/lib/ai/extract-name-disambiguation-needles";
import { registryNoticeRowLinkedToGoods } from "@/lib/ai/goods-notice-registry-link";
import { tryExtractPfCharacteristicsByRegistryPositionId } from "@/lib/ai/notice-print-form-characteristics";
import {
  extractTend32OozDescriptionBody,
  tend32OozHasDetailBlockForName,
  tryExtractTend32OozVerticalCharacteristics
} from "@/lib/ai/tend32-ooz-vertical-characteristics";
import {
  buildGoodsCorpusClassification,
  type GoodsCorpusClassification
} from "@/lib/ai/masked-corpus-sources";

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
  /**
   * Небольшой «хвост» у модели относительно детерминированного ТЗ (чанки/дубли) не должен отключать
   * TZ-first: иначе уходим в mergeFallbackLenient и массово теряем строки, хотя парсер ТЗ уже полный.
   */
  const aiOverTzSlack = Math.max(5, Math.ceil(tz * 0.15));
  if (tz >= 2 && aiItemsCount > tz + aiOverTzSlack && aiItemsCount >= 2) return false;
  return true;
}

/**
 * Корпус Тенд32 (regression-goods): `Описание_объекта_закупки_на_поставку_картриджей_2026_итог.docx` в routed `logicalPath`.
 * Узкий гейт: не трогаем тендэксперемент 2/3 и прочие тендеры без этого файла.
 */
const TEND32_REGISTRY_PF_CHARACTERISTICS_CORPUS_MARKER =
  "Описание_объекта_закупки_на_поставку_картриджей_2026";

function tend32ResolveRegistryPidForPfCharacteristics(
  maskedFullCorpus: string,
  positionId: string,
  tz: TenderAiGoodItem,
  opts: { finalName: string; qtyFinal: string; unitPrice: string; lineTotal: string }
): string {
  let pidForPf = normGoodsPositionId(positionId);
  if (!isRegistryStylePositionId(pidForPf)) {
    const noticeRowsForPid = buildNoticeDeterministicRowsForGoodsMerge(maskedFullCorpus);
    const cands = distinctRegistryPidsSharingCodes(
      (tz.codes ?? "").trim(),
      noticeRowsForPid,
      (opts.finalName ?? tz.name ?? "").trim() || undefined
    );
    if (cands.length === 1) {
      pidForPf = cands[0]!;
    } else if (cands.length > 1) {
      const probeItem: TenderAiGoodItem = {
        ...tz,
        name: opts.finalName,
        positionId: "",
        quantity: opts.qtyFinal,
        unitPrice: opts.unitPrice,
        lineTotal: opts.lineTotal,
        characteristics: []
      };
      const { narrowed } = narrowPositionIdCandidatesForAmbiguousItem(
        maskedFullCorpus,
        probeItem,
        cands,
        noticeRowsForPid
      );
      if (narrowed.length === 1) pidForPf = narrowed[0]!;
    }
  }
  return pidForPf;
}

/** Сильнее «только КТРУ»: иглы/модельные токены товара в наименовании строки извещения с тем же реестровым pid. */
function disambiguationNoticeEvidenceScoreForPid(
  g: TenderAiGoodItem,
  noticeRows: TenderAiGoodItem[],
  sole: string
): number {
  const soleN = normGoodsPositionId(sole);
  if (!soleN) return 0;
  let best = 0;
  const needles = extractNameDisambiguationNeedles((g.name ?? "").trim());
  const nk = normalizeGoodsMatchingKey(`${g.name ?? ""} ${g.codes ?? ""}`);
  const toks = extractModelTokens(nk).filter((t) => !/^\d{2}\.\d{2}\.\d{2}/.test(t));
  for (const r of noticeRows) {
    const rp = normGoodsPositionId(r.positionId ?? "");
    if (rp !== soleN) continue;
    if (!registryNoticeRowLinkedToGoods(g.codes ?? "", (g.name ?? "").trim() || undefined, r)) continue;
    let sc = 0;
    const rn = (r.name ?? "").toLowerCase().replace(/\s/g, "");
    for (const nd of needles) {
      const n = nd.replace(/\s/g, "").toLowerCase();
      if (n.length >= 4 && rn.includes(n)) sc += 6;
    }
    for (const t of toks) {
      const c = t.replace(/\s/g, "").toLowerCase();
      if (c.length >= 4 && rn.includes(c)) sc += 4;
    }
    const rToks = extractModelTokens(normalizeGoodsMatchingKey(`${r.name ?? ""} ${r.codes ?? ""}`)).filter(
      (t) => !/^\d{2}\.\d{2}\.\d{2}/.test(t)
    );
    if (modelTokensOverlap(toks, rToks)) sc += 3;
    if (sc > best) best = sc;
  }
  return best;
}

/**
 * После основного reconcile: если реестровый pid всё ещё пуст, а по тем же codes в notice/PF
 * несколько реестровых pid — пробуем те же узкие слои сужения, что и для ambiguous в annotate
 * (кол-во/суммы из строки извещения, окна КТРУ-суффикса, окна артикула в корпусе).
 * Присваиваем pid только при ровно одном оставшемся кандидате; иначе не трогаем строку.
 */
function assignRegistryPidFromNoticeCollisionNarrowingWhenReconcilePidStillEmpty(
  items: TenderAiGoodItem[],
  maskedFullCorpus: string
): TenderAiGoodItem[] {
  const corpus = (maskedFullCorpus ?? "").trim();
  if (!corpus || items.length === 0) return items;
  const noticeRows = buildNoticeDeterministicRowsForGoodsMerge(corpus);
  const soleIsPfExternal21FamilyPid = (sole: string): boolean => /^2[01]\d{7,11}$/.test(normGoodsPositionId(sole));
  const pidHeldByDifferentRow = (work: TenderAiGoodItem[], sole: string, exceptIdx: number): boolean => {
    for (let j = 0; j < work.length; j++) {
      if (j === exceptIdx) continue;
      const p = normGoodsPositionId(work[j]!.positionId ?? "");
      if (p && p === sole) return true;
    }
    return false;
  };
  const work = items;
  const proposed: (string | null)[] = work.map(() => null);
  for (let i = 0; i < work.length; i++) {
    const g = work[i]!;
    const cur = normGoodsPositionId(g.positionId ?? "");
    if (cur && isRegistryStylePositionId(cur)) continue;
    const codes = (g.codes ?? "").trim();
    if (!codes) continue;
    const cands = distinctRegistryPidsSharingCodes(codes, noticeRows, (g.name ?? "").trim() || undefined);
    if (cands.length < 2) continue;
    const { narrowed } = narrowPositionIdCandidatesForAmbiguousItem(corpus, g, cands, noticeRows);
    if (narrowed.length !== 1) continue;
    const sole = normGoodsPositionId(narrowed[0]!);
    if (!sole || !isRegistryStylePositionId(sole)) continue;
    if (registryPidOccursOnlyInTovarShtukaPriceGlueCorpus(corpus, sole)) continue;
    proposed[i] = sole;
  }
  const bySole = new Map<string, number[]>();
  const rebuildBySole = () => {
    bySole.clear();
    for (let i = 0; i < proposed.length; i++) {
      const s = proposed[i];
      if (!s) continue;
      const arr = bySole.get(s) ?? [];
      arr.push(i);
      bySole.set(s, arr);
    }
  };
  /** Несколько строк сузились к одному pid (часто `corpus_ktru_suffix_window`); оставляем одну с максимумом по notice. */
  const MIN_NOTICE_EVIDENCE_SCORE = 4;
  const MIN_NOTICE_EVIDENCE_MARGIN = 3;
  const applySoleCollisionTieBreak = () => {
    rebuildBySole();
    for (const [soleStr, idxs] of [...bySole.entries()]) {
      if (idxs.length <= 1) continue;
      const scored = idxs.map((i) => ({
        i,
        sc: disambiguationNoticeEvidenceScoreForPid(work[i]!, noticeRows, soleStr)
      }));
      scored.sort((a, b) => b.sc - a.sc);
      const top = scored[0]!;
      const second = scored[1];
      const clearAll = () => {
        for (const idx of idxs) proposed[idx] = null;
      };
      if (top.sc < MIN_NOTICE_EVIDENCE_SCORE) {
        clearAll();
        continue;
      }
      if (second != null && top.sc - second.sc < MIN_NOTICE_EVIDENCE_MARGIN) {
        clearAll();
        continue;
      }
      for (const idx of idxs) {
        if (idx !== top.i) proposed[idx] = null;
      }
    }
    rebuildBySole();
  };
  applySoleCollisionTieBreak();

  const occupiedExternal21FromWorkAndProposed = (): Set<string> => {
    const s = new Set<string>();
    for (let j = 0; j < work.length; j++) {
      const p = normGoodsPositionId(work[j]!.positionId ?? "");
      if (p && soleIsPfExternal21FamilyPid(p)) s.add(p);
    }
    for (let j = 0; j < proposed.length; j++) {
      const p = proposed[j];
      if (p && soleIsPfExternal21FamilyPid(p)) s.add(normGoodsPositionId(p));
    }
    return s;
  };
  const takenExt = occupiedExternal21FromWorkAndProposed();
  const registryPidHeldElsewhere = (sole: string, exceptIdx: number): boolean => {
    const sn = normGoodsPositionId(sole);
    if (!sn || !isRegistryStylePositionId(sn)) return false;
    for (let j = 0; j < work.length; j++) {
      if (j === exceptIdx) continue;
      const p = normGoodsPositionId(work[j]!.positionId ?? "");
      if (p && p === sn) return true;
    }
    for (let j = 0; j < proposed.length; j++) {
      if (j === exceptIdx) continue;
      const p = proposed[j];
      if (p && normGoodsPositionId(p) === sn) return true;
    }
    return false;
  };
  const gapSole: (string | null)[] = work.map(() => null);
  for (let i = 0; i < work.length; i++) {
    if (proposed[i]) continue;
    const g = work[i]!;
    const cur = normGoodsPositionId(g.positionId ?? "");
    if (cur && isRegistryStylePositionId(cur)) continue;
    const codes = (g.codes ?? "").trim();
    if (!codes) continue;
    let cands = distinctRegistryPidsSharingCodes(codes, noticeRows, (g.name ?? "").trim() || undefined);
    cands = cands.filter((raw) => {
      const c = normGoodsPositionId(raw);
      if (!soleIsPfExternal21FamilyPid(c)) return true;
      return !takenExt.has(c);
    });
    if (cands.length < 2) continue;
    const { narrowed } = narrowPositionIdCandidatesForAmbiguousItem(corpus, g, cands, noticeRows);
    if (narrowed.length !== 1) continue;
    const sole = normGoodsPositionId(narrowed[0]!);
    if (!sole || !isRegistryStylePositionId(sole)) continue;
    if (registryPidOccursOnlyInTovarShtukaPriceGlueCorpus(corpus, sole)) continue;
    if (registryPidHeldElsewhere(sole, i)) continue;
    gapSole[i] = sole;
  }
  const byGap = new Map<string, number[]>();
  for (let i = 0; i < gapSole.length; i++) {
    const s = gapSole[i];
    if (!s) continue;
    const arr = byGap.get(s) ?? [];
    arr.push(i);
    byGap.set(s, arr);
  }
  for (const idxs of byGap.values()) {
    if (idxs.length > 1) {
      for (const idx of idxs) gapSole[idx] = null;
    }
  }
  for (let i = 0; i < proposed.length; i++) {
    if (gapSole[i]) proposed[i] = gapSole[i];
  }
  applySoleCollisionTieBreak();

  const acceptIdx = new Set<number>();
  for (const idxs of bySole.values()) {
    if (idxs.length !== 1) continue;
    const i = idxs[0]!;
    const sole = proposed[i]!;
    if (soleIsPfExternal21FamilyPid(sole) && pidHeldByDifferentRow(work, sole, i)) continue;
    acceptIdx.add(i);
  }
  let any = false;
  const next = work.map((g, i) => {
    if (!acceptIdx.has(i)) return g;
    const sole = proposed[i]!;
    any = true;
    return {
      ...g,
      positionId: sole,
      positionIdMatchConfidence: positionIdMatchConfidenceForMergeFallbackLenient(sole)
    };
  });
  return any ? next : items;
}

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

export type PositionMatchMethod =
  | "registry_id"
  | "name_token_overlap"
  | "name_normalized_prefix"
  | "fallback_corpus_evidence"
  | "unmatched";

export type QuantityConfidence = "high" | "medium" | "low" | "none";

export type GoodsSourceAuditRow = {
  matchedKey: string;
  acceptedFromTechSpec: boolean;
  acceptedFromNotice: boolean;
  quantitySource: "tech_spec" | "notice" | "ai_fallback" | "registry" | "unknown";
  priceSource: "notice" | "other_doc" | "missing";
  wasRejectedAsUntrusted: boolean;
  rejectionReason?: string;
  noticeMatchMethod?: PositionMatchMethod;
  aiMatchMethod?: PositionMatchMethod;
  quantityConfidence?: QuantityConfidence;
  quantityGuardReason?: string;
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

export type GoodsQualityDiagnostic = {
  totalPositions: number;
  withQty: number;
  withoutQty: number;
  suppressedByGuard: number;
  bySource: Record<GoodsSourceAuditRow["quantitySource"], number>;
  byConfidence: Record<QuantityConfidence, number>;
  problematicPositions: Array<{
    positionId: string;
    name: string;
    quantity: string;
    quantitySource: GoodsSourceAuditRow["quantitySource"];
    quantityConfidence: QuantityConfidence;
    noticeMatchMethod: PositionMatchMethod;
    aiMatchMethod: PositionMatchMethod;
    quantityGuardReason: string;
  }>;
};

export type ReconcileGoodsDocumentSourcesResult = {
  items: TenderAiGoodItem[];
  goodsSourceAudit: GoodsSourceAuditRow[];
  goodsSourceSummary: GoodsSourceAuditSummary;
  /** Детерминированный разбор ТЗ-таблицы (строки accepted/rejected). */
  goodsTechSpecParseAudit?: GoodsTechSpecParseAudit;
  goodsBackboneSourceAudit?: GoodsBackboneSourceAudit;
  goodsQualityDiagnostic?: GoodsQualityDiagnostic;
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
    /\bq\d{3,4}[a-z]\b/gi,
    /\bw\d{3,5}x\b/gi,
    /\b006r\d{4,}\b/gi,
    /\b008r\d{4,}\b/gi,
    /\b101r\d{5,}\b/gi,
    /\b106r\d{5,}\b/gi,
    /\b108r\d{5,}\b/gi,
    /\b113r\d{5,}\b/gi,
    /\b842\d{3}\b/gi,
    /\bjc\d{2}-\d{5,}\b/gi,
    /\bcet\d{6,}\b/gi,
    /\bry\d-\d{4,}\b/gi,
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
  const unique = [...new Set(out)];
  // If a more specific token subsumes a shorter one (e.g. "067hbk" subsumes "067h"),
  // drop the shorter to prevent ambiguous matches across color variants.
  return unique.filter(
    (t) => !unique.some((longer) => longer !== t && longer.length > t.length && longer.startsWith(t))
  );
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
  // Pattern 1: explicit "N шт/ед/упак" on same line
  if (/(?:\d+(?:[.,]\d+)?\s*(?:шт|ед\.?\s*изм|упак|компл|комплект))/i.test(t)) return true;
  // Pattern 2: KTRU code + quantity keyword + numeric value
  if (
    /\d{2}\.\d{2}\.\d{2}/.test(t) &&
    /\d+(?:[.,]\d+)?/.test(t) &&
    /(?:наименован|модел|картридж|тонер|состав|характеристик)/i.test(t)
  ) {
    return true;
  }
  // Pattern 3: explicit "Количество: N" label (unit may be on separate line or column)
  if (/количеств[^\s:,;|]*\s*[:\s|]\s*\d{1,6}\b/i.test(t)) return true;
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
  const tabular = extractQuantityFromTabularGoodsLine(line);
  if (tabular) return tabular;
  // Fallback: "Количество: N" or "Количество N" where unit is not on the same line
  const labeled = line.match(/количеств[^\s:,;|]*\s*[:\s|]\s*(\d{1,6}(?:[.,]\d{1,3})?)/i);
  if (labeled?.[1]) {
    const q = labeled[1]!.replace(",", ".");
    const n = parseFloat(q);
    if (Number.isFinite(n) && n > 0 && n < 100_000 && !looksLikeMoneyValueByShape(q)) return q;
  }
  return undefined;
}

function looksLikeMoneyOrPercent(raw: string): boolean {
  const t = raw.trim();
  if (!t) return false;
  if (/%/.test(t)) return true;
  if (/(?:руб|₽)/i.test(t)) return true;
  return false;
}

function normalizeQuantityCandidate(raw: string): string {
  return raw.replace(/\s/g, "").replace(",", ".").trim();
}

function extractExplicitHeaderQuantity(block: string): string {
  if (!block.trim()) return "";
  const lines = block.split("\n");
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (!/(?:кол-?во|количество)/i.test(t)) continue;
    const m = t.match(/(?:кол-?во|количество)[^0-9]{0,20}(\d{1,6}(?:[.,]\d{1,3})?)\s*(шт|пач|упак|компл|комплект|кг|л|м2|м3|усл\.?\s*ед)\b/i);
    if (!m?.[1]) continue;
    return normalizeQuantityCandidate(m[1]);
  }
  return "";
}

function looksLikeMoneyValueByShape(raw: string): boolean {
  const t = normalizeQuantityCandidate(raw);
  const n = Number(t);
  if (!Number.isFinite(n)) return false;
  const m = t.match(/^\d+(?:\.(\d{1,3}))?$/);
  const frac = m?.[1] ?? "";
  if (frac.length === 2 && n >= 50) return true;
  if (frac === "000" && n >= 50) return true;
  if (!frac && n >= 100000) return true;
  return false;
}

function normalizeOcrJoinedBlock(block: string): string {
  return block
    .replace(/\u00A0/g, " ")
    .replace(/([A-Za-zА-Яа-яЁё])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-zА-Яа-яЁё])/g, "$1 $2")
    .replace(/([а-яё])([А-ЯЁ])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * OCR/PDF-склейка вида «ТоварШтука4000.00»: ищем quantity рядом с unit-marker,
 * но отсеиваем money-like числа (обычно xx.xx / xxx.00).
 */
function extractQuantityFromOcrJoinedBlock(block: string): string {
  const t = normalizeOcrJoinedBlock(block);
  if (!t) return "";

  const byQtyLabel = t.match(/(?:кол-?во|количество)\s*[:\-]?\s*(\d{1,6}(?:[.,]\d{1,3})?)/i);
  if (byQtyLabel?.[1]) {
    const q = normalizeQuantityCandidate(byQtyLabel[1]);
    if (isPlausibleTopLevelQuantity(q) && !looksLikeMoneyValueByShape(q)) return q;
  }

  const unitBefore =
    /(?:штука|штук(?:а|и)?|шт|ед\.?\s*изм|упак|компл|комплект|кг|л|м2|м3|усл\.?\s*ед)\s*(\d{1,6}(?:[.,]\d{1,3})?)/gi;
  for (const m of t.matchAll(unitBefore)) {
    const q = normalizeQuantityCandidate(m[1] ?? "");
    if (isPlausibleTopLevelQuantity(q) && !looksLikeMoneyValueByShape(q)) return q;
  }

  const numberBefore =
    /(\d{1,6}(?:[.,]\d{1,3})?)\s*(?:штука|штук(?:а|и)?|шт|ед\.?\s*изм|упак|компл|комплект|кг|л|м2|м3|усл\.?\s*ед)\b/gi;
  for (const m of t.matchAll(numberBefore)) {
    const q = normalizeQuantityCandidate(m[1] ?? "");
    if (isPlausibleTopLevelQuantity(q) && !looksLikeMoneyValueByShape(q)) return q;
  }

  return "";
}

export function extractTrustedQuantityFromItemBlock(block: string): string {
  const explicit = extractExplicitHeaderQuantity(block);
  if (isPlausibleTopLevelQuantity(explicit) && !looksLikeMoneyValueByShape(explicit)) {
    return normalizeQuantityCandidate(explicit);
  }
  const tabular = extractQuantityFromTabularGoodsLine(block) ?? "";
  if (isPlausibleTopLevelQuantity(tabular) && !looksLikeMoneyValueByShape(tabular)) {
    return normalizeQuantityCandidate(tabular);
  }
  const joined = extractQuantityFromOcrJoinedBlock(block);
  if (isPlausibleTopLevelQuantity(joined) && !looksLikeMoneyValueByShape(joined)) {
    return normalizeQuantityCandidate(joined);
  }
  return "";
}

function isPlausibleTopLevelQuantity(raw: string): boolean {
  if (!raw) return false;
  if (looksLikeMoneyOrPercent(raw)) return false;
  const q = normalizeQuantityCandidate(raw);
  if (!/^\d{1,6}(?:\.\d{1,3})?$/.test(q)) return false;
  const n = Number(q);
  if (!Number.isFinite(n)) return false;
  if (n <= 0 || n > 999_999) return false;
  return true;
}

/** Только слова единицы (число ошибочно попало в quantity / unit наоборот). */
const UNIT_LABEL_ONLY_RE =
  /^(?:штук(?:а|и|ой|е|ами)?|шт\.?|упак(?:овк\w*)?|компл(?:ект\w*)?|ед(?:иниц\w*)?\s*измерен\w*|ед\.?\s*изм\.?)$/i;

/**
 * Разделяет quantity (только число) и unit после парсеров/модели: исправляет перепутанные колонки.
 * Экспорт для нормализации ответа модели в parse-model-json (до merge/reconcile).
 */
export function coerceGoodsQuantityUnitFields(
  quantityRaw: string,
  unitRaw: string
): { quantity: string; unit: string } {
  return coerceQuantityUnitPair(quantityRaw, unitRaw);
}

function coerceQuantityUnitPair(quantityRaw: string, unitRaw: string): { quantity: string; unit: string } {
  const q0 = (quantityRaw ?? "").trim();
  const u0 = (unitRaw ?? "").trim();
  const qNorm = normalizeQuantityCandidate(q0);
  const uNorm = normalizeQuantityCandidate(u0);
  const qIsNum = isPlausibleTopLevelQuantity(qNorm) && !looksLikeMoneyValueByShape(qNorm);
  const uIsNum = isPlausibleTopLevelQuantity(uNorm) && !looksLikeMoneyValueByShape(uNorm);
  const qIsUnitLbl = UNIT_LABEL_ONLY_RE.test(q0);
  const uIsUnitLbl = UNIT_LABEL_ONLY_RE.test(u0);

  if (qIsNum && !qIsUnitLbl) {
    return { quantity: qNorm, unit: u0 && !uIsNum ? u0 : u0 || "шт" };
  }
  if (qIsUnitLbl && uIsNum) {
    return { quantity: uNorm, unit: q0 };
  }
  if (qIsUnitLbl && u0 && !uIsNum) {
    const m = u0.match(/^(\d{1,6}(?:[.,]\d{1,3})?)\b/);
    if (m && isPlausibleTopLevelQuantity(normalizeQuantityCandidate(m[1]!))) {
      return { quantity: normalizeQuantityCandidate(m[1]!), unit: q0 };
    }
  }
  if (!qIsNum && uIsNum && !uIsUnitLbl) {
    return { quantity: uNorm, unit: q0 && qIsUnitLbl ? q0 : "шт" };
  }
  return { quantity: "", unit: u0 };
}

function extractAiQuantityForReconcile(ai: TenderAiGoodItem | null | undefined): string {
  if (!ai) return "";
  const c = coerceQuantityUnitPair(ai.quantity ?? "", ai.unit ?? "");
  if (c.quantity && isPlausibleTopLevelQuantity(c.quantity) && !looksLikeMoneyValueByShape(c.quantity)) {
    return normalizeQuantityCandidate(c.quantity);
  }
  const blob = `${ai.quantity ?? ""}\t${ai.unit ?? ""}\n${ai.name ?? ""}`;
  const fromBlock = extractTrustedQuantityFromItemBlock(blob);
  if (fromBlock) return fromBlock;
  return "";
}

export function matchMethodStrength(m: PositionMatchMethod): "strong" | "medium" | "weak" | "none" {
  switch (m) {
    case "registry_id":
    case "name_token_overlap":
      return "strong";
    case "name_normalized_prefix":
      return "medium";
    case "fallback_corpus_evidence":
      return "weak";
    case "unmatched":
      return "none";
  }
}

/**
 * Compute quantity confidence from quantitySource, the match methods used to find
 * the cross-source anchor, and whether the quantity is self-sourced (tz item's own field).
 *
 * Rules:
 * - tech_spec quantity from the tz item's own block → always "high" (self-sourced, no cross-matching).
 * - notice/ai_fallback quantity via strong match → "high"
 * - notice/ai_fallback quantity via medium match → "medium"
 * - notice/ai_fallback quantity via weak match → "low"
 * - any quantity via unmatched → "none" (suppressed)
 * - empty quantity → "none"
 */
export function computeQuantityConfidence(args: {
  quantitySource: GoodsSourceAuditRow["quantitySource"];
  qtyValue: string;
  noticeMatchMethod: PositionMatchMethod;
  aiMatchMethod: PositionMatchMethod;
  isSelfSourcedTz: boolean;
}): { confidence: QuantityConfidence; reason: string } {
  if (!args.qtyValue) return { confidence: "none", reason: "qty_empty" };

  if (args.quantitySource === "tech_spec" && args.isSelfSourcedTz) {
    return { confidence: "high", reason: "self_sourced_from_tz_block" };
  }

  const relevantMethod =
    args.quantitySource === "notice"
      ? args.noticeMatchMethod
      : args.quantitySource === "tech_spec"
        ? args.aiMatchMethod
        : args.quantitySource === "ai_fallback"
          ? args.aiMatchMethod
          : "unmatched" as PositionMatchMethod;

  const strength = matchMethodStrength(relevantMethod);
  switch (strength) {
    case "strong":
      return { confidence: "high", reason: `cross_source_${args.quantitySource}_via_${relevantMethod}` };
    case "medium":
      return { confidence: "medium", reason: `cross_source_${args.quantitySource}_via_${relevantMethod}` };
    case "weak":
      return { confidence: "low", reason: `weak_match_${args.quantitySource}_via_${relevantMethod}` };
    case "none":
      return { confidence: "none", reason: `unmatched_${args.quantitySource}_via_${relevantMethod}` };
  }
}

/**
 * Guard: suppress quantity if confidence is too low to prevent silent mis-assignment.
 * Returns the original qty if confidence >= "medium", empty string otherwise.
 */
export function applyQuantityGuard(
  qty: string,
  confidence: QuantityConfidence
): string {
  if (confidence === "high" || confidence === "medium") return qty;
  return "";
}

/**
 * Build an aggregated quality diagnostic from a completed reconcile result.
 * Pure function — no side effects, no mutations.
 */
export function buildGoodsQualityDiagnostic(
  items: TenderAiGoodItem[],
  audit: GoodsSourceAuditRow[]
): GoodsQualityDiagnostic {
  const nonRejected = audit.filter((r) => !r.wasRejectedAsUntrusted);

  const bySource: GoodsQualityDiagnostic["bySource"] = {
    tech_spec: 0, notice: 0, ai_fallback: 0, registry: 0, unknown: 0
  };
  const byConfidence: GoodsQualityDiagnostic["byConfidence"] = {
    high: 0, medium: 0, low: 0, none: 0
  };
  let suppressedByGuard = 0;

  for (const r of nonRejected) {
    bySource[r.quantitySource]++;
    const conf: QuantityConfidence = r.quantityConfidence ?? "none";
    byConfidence[conf]++;
    if (r.quantityGuardReason && (conf === "low" || conf === "none") && r.quantitySource !== "unknown") {
      suppressedByGuard++;
    }
  }

  const withQty = items.filter((it) => (it.quantity ?? "").trim() !== "").length;

  const problematicPositions = nonRejected
    .map((r, i) => ({ r, item: items[i] }))
    .filter(({ r, item }) => {
      const conf: QuantityConfidence = r.quantityConfidence ?? "none";
      const noQty = !(item?.quantity ?? "").trim();
      const isLowConf = conf === "low" || conf === "none";
      const isUnmatched =
        matchMethodStrength(r.noticeMatchMethod ?? "unmatched") === "none" &&
        matchMethodStrength(r.aiMatchMethod ?? "unmatched") === "none";
      const wasGuardSuppressed =
        isLowConf && (conf !== "none" || r.quantitySource !== "unknown");
      return noQty || isLowConf || isUnmatched || wasGuardSuppressed;
    })
    .map(({ r, item }) => ({
      positionId: (item?.positionId ?? "").trim(),
      name: (item?.name ?? r.matchedKey).slice(0, 80),
      quantity: (item?.quantity ?? "").trim(),
      quantitySource: r.quantitySource,
      quantityConfidence: (r.quantityConfidence ?? "none") as QuantityConfidence,
      noticeMatchMethod: (r.noticeMatchMethod ?? "unmatched") as PositionMatchMethod,
      aiMatchMethod: (r.aiMatchMethod ?? "unmatched") as PositionMatchMethod,
      quantityGuardReason: r.quantityGuardReason ?? ""
    }));

  return {
    totalPositions: items.length,
    withQty,
    withoutQty: items.length - withQty,
    suppressedByGuard,
    bySource,
    byConfidence,
    problematicPositions
  };
}

/**
 * Human-readable debug string for a GoodsQualityDiagnostic.
 * Suitable for tmp-run-analyze logs, selftest output, diagnostic runs.
 */
export function formatGoodsQualityDiagnostic(d: GoodsQualityDiagnostic): string {
  const lines: string[] = [
    "── goods quality diagnostic ──────────────────────────────────────────",
    `  total positions : ${d.totalPositions}`,
    `  with qty        : ${d.withQty}`,
    `  without qty     : ${d.withoutQty}`,
    `  suppressed guard: ${d.suppressedByGuard}`,
    "",
    "  qty by source:",
    `    tech_spec  : ${d.bySource.tech_spec}`,
    `    notice     : ${d.bySource.notice}`,
    `    ai_fallback: ${d.bySource.ai_fallback}`,
    `    registry   : ${d.bySource.registry}`,
    `    unknown    : ${d.bySource.unknown}`,
    "",
    "  qty by confidence:",
    `    high  : ${d.byConfidence.high}`,
    `    medium: ${d.byConfidence.medium}`,
    `    low   : ${d.byConfidence.low}`,
    `    none  : ${d.byConfidence.none}`
  ];
  if (d.problematicPositions.length > 0) {
    lines.push("", "  problematic positions:");
    for (const p of d.problematicPositions) {
      lines.push(`    [${p.positionId || "—"}] "${p.name}"`);
      lines.push(`      qty="${p.quantity}" src=${p.quantitySource} conf=${p.quantityConfidence}`);
      lines.push(`      notice=${p.noticeMatchMethod} ai=${p.aiMatchMethod}`);
      if (p.quantityGuardReason) lines.push(`      reason: ${p.quantityGuardReason}`);
    }
  }
  lines.push("──────────────────────────────────────────────────────────────────");
  return lines.join("\n");
}

/**
 * Priority: tech_spec (docx/xlsx) → notice (PDF) → ai_fallback.
 * Tech spec is the most reliable deterministic source; notice PDF may have OCR gaps;
 * AI quantity is only used as a last resort when both deterministic sources are empty.
 */
export function chooseTrustedQuantity(args: {
  noticeQty: string;
  tzQty: string;
  aiQty?: string;
  /** Числовое количество из детерминированного парсера ТЗ (приоритет над строкой tzQty). */
  tzNumericQuantity?: number | null;
}): { value: string; source: GoodsSourceAuditRow["quantitySource"] } {
  const tzNum = args.tzNumericQuantity;
  if (
    tzNum != null &&
    Number.isFinite(tzNum) &&
    tzNum > 0 &&
    tzNum <= 999_999 &&
    !looksLikeMoneyValueByShape(formatQuantityValueForStorage(tzNum))
  ) {
    return { value: formatQuantityValueForStorage(tzNum), source: "tech_spec" };
  }
  if (isPlausibleTopLevelQuantity(args.tzQty) && !looksLikeMoneyValueByShape(args.tzQty)) {
    return { value: normalizeQuantityCandidate(args.tzQty), source: "tech_spec" };
  }
  if (isPlausibleTopLevelQuantity(args.noticeQty) && !looksLikeMoneyValueByShape(args.noticeQty)) {
    return { value: normalizeQuantityCandidate(args.noticeQty), source: "notice" };
  }
  if (isPlausibleTopLevelQuantity(args.aiQty ?? "") && !looksLikeMoneyValueByShape(args.aiQty ?? "")) {
    return { value: normalizeQuantityCandidate(args.aiQty ?? ""), source: "ai_fallback" };
  }
  return { value: "", source: "unknown" };
}

function mapAuditGoodsQuantitySourceToContract(s: GoodsSourceAuditRow["quantitySource"]): GoodsQuantitySource {
  if (s === "tech_spec") return "tech_spec";
  if (s === "notice") return "notice";
  if (s === "ai_fallback") return "ai";
  return "unknown";
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
    const regPos = line.match(REGISTRY_POSITION_ID_CAPTURE_RE)?.[1];
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

const KTRU_OKPD_RE = /^\d{2}\.\d{2}\.\d{2}/;
function isCodeToken(tok: string): boolean {
  return KTRU_OKPD_RE.test(tok);
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

/**
 * Returns true only if A and B share at least one non-KTRU/OKPD model token
 * (e.g. "cf259x", "tk-1170"). Shared classification codes alone don't count.
 */
function modelTokensOverlap(a: string[], b: string[]): boolean {
  const modelA = new Set(a.filter((t) => !isCodeToken(t)).map((x) => x.toLowerCase()));
  if (modelA.size === 0) return false;
  for (const x of b) {
    if (isCodeToken(x)) continue;
    if (modelA.has(x.toLowerCase())) return true;
  }
  for (const ta of a) {
    if (isCodeToken(ta)) continue;
    for (const tb of b) {
      if (isCodeToken(tb)) continue;
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
  return findBestAnchorWithMethod(itemTokens, anchors, itemNameNorm, minScore).anchor;
}

function corpusAnchorDedupeKey(a: { rawLine: string; positionId?: string }): string {
  const pid = (a.positionId ?? "").replace(/\s/g, "");
  const head = normalizeGoodsMatchingKey((a.rawLine ?? "").slice(0, 360));
  return `${pid}|${head}`;
}

function findBestAnchorWithMethod(
  itemTokens: string[],
  anchors: CorpusAnchor[],
  itemNameNorm: string,
  minScore = 4
): AnchorMatchResult {
  let best: CorpusAnchor | null = null;
  let bestScore = 0;
  let hasTokenOverlap = false;
  let hasPrefixMatch = false;
  for (const a of anchors) {
    let sc = 0;
    const tokenHit = tokensOverlap(a.tokens, itemTokens);
    if (tokenHit) sc += 5;
    const prefixHit =
      itemNameNorm.length >= 12 &&
      normalizeGoodsMatchingKey(a.rawLine).includes(itemNameNorm.slice(0, 28));
    if (prefixHit) sc += 3;
    if (itemTokens.some((t) => t.length >= 5 && normalizeGoodsMatchingKey(a.rawLine).includes(t))) {
      sc += 2;
    }
    if (sc > bestScore) {
      bestScore = sc;
      best = a;
      hasTokenOverlap = tokenHit;
      hasPrefixMatch = prefixHit;
    }
  }
  if (bestScore < minScore) return { anchor: null, method: "unmatched" };
  const method: PositionMatchMethod = hasTokenOverlap
    ? "name_token_overlap"
    : hasPrefixMatch
      ? "name_normalized_prefix"
      : "unmatched";
  return { anchor: best, method };
}

function lineIndexContainingRegistryId(lines: string[], pid: string): number {
  const compactPid = pid.replace(/\s/g, "");
  return lines.findIndex((ln) => {
    if (ln.includes(pid)) return true;
    return compactPid.length >= 8 && ln.replace(/\s/g, "").includes(compactPid);
  });
}

/**
 * ПФ ЕИС: модель позиции часто идёт на десятки строк *после* строки с реестровым id (вертикальная вёрстка).
 * Для сопоставления картриджей с коротким id `20…` используется удлинённое «хвостовое» окно; для прочих
 * вызовов сохраняем прежний радиус (+18).
 */
const PF_REGISTRY_CARTRIDGE_MODEL_TAIL_LINES = 72;

function buildRegistryWindowTextWithTail(corpus: string, pid: string, tailLines: number): string {
  if (!corpus.trim() || !pid) return "";
  const lines = corpus.split("\n");
  const i = lineIndexContainingRegistryId(lines, pid);
  if (i < 0) return "";
  const from = Math.max(0, i - 4);
  const to = Math.min(lines.length, i + Math.max(8, tailLines));
  return lines
    .slice(from, to)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Окно строк вокруг реестрового id: в OCR/извлечении КТРУ, кол-во и суммы часто на соседних строках. */
function buildRegistryWindowText(corpus: string, pid: string): string {
  return buildRegistryWindowTextWithTail(corpus, pid, 18);
}

function isPfCartridgeTailShort20RemapRow(g: TenderAiGoodItem): boolean {
  const n = (g.name ?? "").trim();
  if (!n || !/картридж/i.test(n)) return false;
  if (/наименование и характеристики/i.test(n)) return false;
  return true;
}

/** Картриджи + прочие позиции с модельными токенами: тот же механизм уникального окна ПФ по `20…` id. */
function isPfTailShort20RemapEligibleRow(g: TenderAiGoodItem): boolean {
  if (isPfCartridgeTailShort20RemapRow(g)) return true;
  const n = (g.name ?? "").trim();
  if (!n || n.length < 10) return false;
  if (/наименование и характеристики/i.test(n)) return false;
  const nk = normalizeGoodsMatchingKey(`${g.name ?? ""} ${g.codes ?? ""}`);
  const base = extractModelTokens(nk).filter((t) => !/^\d{2}\.\d{2}\.\d{2}/.test(t));
  const loose = looseHyphenatedModelTokensFromDisplayName(g.name ?? "");
  const toks = [...base, ...loose];
  if (!toks.some((t) => t.replace(/\s/g, "").length >= 4)) return false;
  return true;
}

/**
 * Внешние реестровые id ПФ в форме `2[01]…` (в т.ч. `210211…`), встречающиеся внутри длинных строк
 * (`Идентификатор:|…|`, склейки «ТоварШтука…»). `REGISTRY_POSITION_ID_CAPTURE_RE` здесь не подходит: он ловит только
 * префикс `20…`, из‑за чего пул кандидатов для tail-remap не содержал типичные `210211…` из 223‑ФЗ ПФ.
 */
function standaloneShort20RegistryPidsInCorpus(corpus: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /(?<!\d)(2[01]\d{7,11})(?!\d)/g;
  for (const m of corpus.matchAll(re)) {
    const id = (m[1] ?? "").replace(/\s/g, "").trim();
    if (!id || !isRegistryStylePositionId(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Модель «буквы-цифры» / «буквы-дефис-цифры» в наименовании (SPK-170 → spk170) — узкое дополнение к extractModelTokens. */
function looseHyphenatedModelTokensFromDisplayName(rawName: string): string[] {
  const name = (rawName ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!name) return [];
  const merged = new Set<string>();
  for (const m of name.matchAll(/([a-zа-яё]{2,})-(\d{3,})/gi)) {
    const glue = (m[1]! + m[2]!).replace(/\s/g, "");
    if (glue.length >= 5) merged.add(glue);
  }
  for (const m of name.matchAll(/([a-zа-яё]{2,})(\d{3,})\b/gi)) {
    const glue = (m[1]! + m[2]!).replace(/\s/g, "");
    if (glue.length >= 5) merged.add(glue);
  }
  return [...merged];
}

function compactNonSpaceIndexOf(haystack: string, needleCompact: string): number {
  const c = haystack.replace(/\s/g, "").toLowerCase();
  return c.indexOf(needleCompact.toLowerCase());
}

/** Окно в `rawLine` вокруг вхождения pid (по индексу в строке без пробелов), чтобы не смешивать соседние товары в одной длинной строке ПФ. */
function neighborhoodAroundCompactPidIndex(
  rawLine: string,
  compactIdx: number,
  compactLen: number,
  radiusChars: number
): string {
  let cn = 0;
  let startChar = 0;
  for (let i = 0; i < rawLine.length; i++) {
    if (/\s/.test(rawLine[i]!)) continue;
    if (cn === compactIdx) {
      startChar = i;
      break;
    }
    cn++;
  }
  cn = 0;
  let endCharExclusive = rawLine.length;
  const targetEnd = compactIdx + compactLen;
  for (let i = 0; i < rawLine.length; i++) {
    if (/\s/.test(rawLine[i]!)) continue;
    cn++;
    if (cn === targetEnd) {
      endCharExclusive = i + 1;
      break;
    }
  }
  return rawLine.slice(Math.max(0, startChar - radiusChars), Math.min(rawLine.length, endCharExclusive + radiusChars));
}

function registryPidNeighborhoodAnchorsTechTokens(tzEff: string[], rawLine: string, registryPid: string): boolean {
  const pid = registryPid.replace(/\s/g, "").trim();
  const cidx = compactNonSpaceIndexOf(rawLine, pid);
  if (cidx < 0) return true;
  const win = neighborhoodAroundCompactPidIndex(rawLine, cidx, pid.length, 200);
  const nk = normalizeGoodsMatchingKey(win);
  const toks = [
    ...extractModelTokens(nk),
    ...looseHyphenatedModelTokensFromDisplayName(win)
  ];
  const uniq = [...new Set(toks.map((x) => x.replace(/\s/g, "").toLowerCase()))].filter(
    (x) => x.length >= 3 && !isCodeToken(x)
  );
  return uniq.length > 0 && modelTokensOverlap(tzEff, uniq);
}

/**
 * Строка ПФ с реестровым id действительно соответствует товарной строке ТЗ по «сильным» якорям
 * (модельные токены без КТРУ), с учётом вертикальной вёрстки ПФ (окно вокруг id).
 */
function noticeRegistryLineAnchorsTechRow(tzTokens: string[], anchor: CorpusAnchor, registryPid: string): boolean {
  const pid = registryPid.replace(/\s/g, "").trim();
  if (!anchor?.rawLine?.trim() || !pid) return false;
  const tzEff = tzTokens.filter((t) => !isCodeToken(t));
  /** Нет модельных якорей у строки ТЗ — не режем привязку (узкие запчасти/кабели без паттерна). */
  if (tzEff.length === 0) return true;

  const nk = normalizeGoodsMatchingKey(anchor.rawLine);
  const directToks = [
    ...anchor.tokens.filter((t) => !isCodeToken(t)),
    ...extractModelTokens(nk),
    ...looseHyphenatedModelTokensFromDisplayName(anchor.rawLine)
  ];
  const uniq = [...new Set(directToks.map((x) => x.replace(/\s/g, "").toLowerCase()))].filter(
    (x) => x.length >= 3 && !isCodeToken(x)
  );
  const baseOk = uniq.length > 0 && modelTokensOverlap(tzEff, uniq);
  if (!baseOk) return false;
  const lineFlat = anchor.rawLine.replace(/\s/g, "").toLowerCase();
  if (lineFlat.includes(pid.toLowerCase())) {
    return registryPidNeighborhoodAnchorsTechTokens(tzEff, anchor.rawLine, pid);
  }
  return true;
}

function modelTokensForPfCartridgeTailMatch(g: TenderAiGoodItem): string[] {
  const charVals = (g.characteristics ?? []).map((c) => (c.value ?? "").trim());
  const nk = normalizeGoodsMatchingKey(`${g.name ?? ""} ${g.codes ?? ""} ${charVals.join(" ")}`);
  const toks = new Set(extractModelTokens(nk).filter((t) => !/^\d{2}\.\d{2}\.\d{2}/.test(t)));
  for (const t of looseHyphenatedModelTokensFromDisplayName(g.name ?? "")) toks.add(t);
  const name = (g.name ?? "").toLowerCase();
  const cm = name.match(/\b067h\s*([bcmky])\b/);
  if (cm?.[1]) {
    const ch = cm[1].toLowerCase();
    const glue = `067h${ch}`;
    toks.add(glue);
  }
  return [...toks].filter((t) => t.replace(/\s/g, "").length >= 3);
}

function foldedPfCartridgeTailHaystack(win: string): string {
  return normalizeGoodsMatchingKey(win).replace(/\s+/g, "");
}

function pfTailWindowSupportsCartridgeModelTokens(win: string, toks: string[]): boolean {
  if (!win.trim() || toks.length === 0) return false;
  const hay = foldedPfCartridgeTailHaystack(win);
  const hayNoHyphen = hay.replace(/-/g, "");
  const compact = win.toLowerCase().replace(/\s/g, "");
  const compactNoHyphen = compact.replace(/-/g, "");
  for (const t of toks) {
    const c = t.replace(/\s/g, "").toLowerCase();
    if (c.length < 3) return false;
    if (
      !hay.includes(c) &&
      !compact.includes(c) &&
      !hayNoHyphen.includes(c) &&
      !compactNoHyphen.includes(c)
    ) {
      return false;
    }
  }
  return true;
}

function pickUniquePfShortPidForCartridgeTokens(
  windows: Map<string, string>,
  toks: string[],
  exclude: Set<string>
): string | null {
  const hits: string[] = [];
  for (const [pid, win] of windows) {
    if (exclude.has(pid)) continue;
    if (pfTailWindowSupportsCartridgeModelTokens(win, toks)) hits.push(pid);
  }
  if (hits.length !== 1) return null;
  return hits[0]!;
}

function isExternal21FamilyRegistryPositionId(pid: string): boolean {
  return Boolean(pid && isRegistryStylePositionId(pid) && /^2[01]\d{7,11}$/.test(pid));
}

/** Pid семейства `2[01]…`, уже занятые на других строках (чтобы вторичный добор не дублировал существующий id). */
function otherRowsOccupiedExternal21FamilyPids(out: TenderAiGoodItem[], exceptIdx: number): Set<string> {
  const s = new Set<string>();
  for (let j = 0; j < out.length; j++) {
    if (j === exceptIdx) continue;
    const p = normGoodsPositionId(out[j]!.positionId ?? "");
    if (isExternal21FamilyRegistryPositionId(p)) s.add(p);
  }
  return s;
}

function allOccupiedExternal21FamilyPids(out: TenderAiGoodItem[]): Set<string> {
  const s = new Set<string>();
  for (const g of out) {
    const p = normGoodsPositionId(g.positionId ?? "");
    if (isExternal21FamilyRegistryPositionId(p)) s.add(p);
  }
  return s;
}

/**
 * Два разных наименования не должны делить один внешний реестровый id из ПФ-хвоста (`2[01]…`) —
 * зеркало `splitDuplicateLongRegistryPidWhenDistinctNormalizedNames` для короткого внешнего семейства.
 */
function splitDuplicateExternal21FamilyRegistryPidWhenDistinctNormalizedNames(
  items: TenderAiGoodItem[]
): TenderAiGoodItem[] {
  const byPid = new Map<string, number[]>();
  for (let i = 0; i < items.length; i++) {
    const p = normGoodsPositionId(items[i]!.positionId ?? "");
    if (!isExternal21FamilyRegistryPositionId(p)) continue;
    if (!byPid.has(p)) byPid.set(p, []);
    byPid.get(p)!.push(i);
  }
  const out = items.map((g) => ({ ...g }));
  for (const idxs of byPid.values()) {
    if (idxs.length < 2) continue;
    const nameKeys = idxs.map((i) => normalizeGoodsInfoProductNameKey(out[i]!.name ?? ""));
    if (nameKeys.some((k) => k.length < 8)) continue;
    if (new Set(nameKeys).size !== idxs.length) continue;
    for (let k = 1; k < idxs.length; k++) {
      const i = idxs[k]!;
      out[i] = { ...out[i]!, positionId: "" };
    }
  }
  return out;
}

/**
 * Узкий пост-проход: короткий реестровый `20…` из ТЗ иногда не совпадает с блоком ПФ (модель ниже id).
 * Переназначаем только при ровно одном кандидате по расширенному окну ПФ и неизменном числе позиций.
 */
function reassignShort20RegistryPidsFromPfCartridgeTailWindows(
  items: TenderAiGoodItem[],
  maskedFullCorpus: string
): TenderAiGoodItem[] {
  const corpus = (maskedFullCorpus ?? "").trim();
  if (!corpus || items.length === 0) return items;

  const pids = standaloneShort20RegistryPidsInCorpus(corpus);
  if (pids.length === 0) return items;

  const windows = new Map<string, string>();
  for (const pid of pids) {
    windows.set(pid, buildRegistryWindowTextWithTail(corpus, pid, PF_REGISTRY_CARTRIDGE_MODEL_TAIL_LINES));
  }

  const eligibleIdx = items
    .map((g, idx) => ({ g, idx }))
    .filter(({ g }) => isPfTailShort20RemapEligibleRow(g))
    .map(({ idx }) => idx);

  const tokByIdx = new Map<number, string[]>();
  for (const idx of eligibleIdx) {
    const g = items[idx]!;
    tokByIdx.set(idx, modelTokensForPfCartridgeTailMatch(g));
  }

  let out = items.map((g) => ({ ...g }));

  for (const idx of eligibleIdx) {
    const toks = tokByIdx.get(idx) ?? [];
    if (toks.length === 0) continue;
    const cur = normGoodsPositionId(out[idx]!.positionId ?? "");
    if (!cur || !isExternal21FamilyRegistryPositionId(cur)) continue;
    if (pfTailWindowSupportsCartridgeModelTokens(windows.get(cur) ?? "", toks)) continue;
    const exclude = otherRowsOccupiedExternal21FamilyPids(out, idx);
    const pick = pickUniquePfShortPidForCartridgeTokens(windows, toks, exclude);
    if (!pick) continue;
    out[idx] = { ...out[idx]!, positionId: pick };
  }

  const fillEmptyTailPid = () => {
    for (const idx of eligibleIdx) {
      const toks = tokByIdx.get(idx) ?? [];
      if (toks.length === 0) continue;
      const cur = normGoodsPositionId(out[idx]!.positionId ?? "");
      if (cur && isRegistryStylePositionId(cur)) continue;
      const exclude = allOccupiedExternal21FamilyPids(out);
      const pick = pickUniquePfShortPidForCartridgeTokens(windows, toks, exclude);
      if (!pick) continue;
      out[idx] = { ...out[idx]!, positionId: pick };
    }
  };

  fillEmptyTailPid();

  out = splitDuplicateExternal21FamilyRegistryPidWhenDistinctNormalizedNames(out);

  fillEmptyTailPid();

  return out;
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

function extractQuantityFromLabeledValue(block: string): string {
  return extractTrustedQuantityFromItemBlock(block);
}

/** Якорь без предварительного попадания строки в noticeAnchors (разорванная таблица, нет «руб» в строке и т.д.). */
function syntheticNoticeAnchorFromRegistry(corpus: string, pid: string): CorpusAnchor | null {
  const block = buildRegistryWindowText(corpus, pid);
  if (!block.includes(pid)) return null;
  const qtyTab = extractQuantityFromTabularGoodsLine(block)?.trim() ?? "";
  const qtySh = extractQuantityAfterRegistryShPt(block, pid)?.trim() ?? "";
  const qtyLbl = extractQuantityFromLabeledValue(block);
  const qty = extractTrustedQuantityFromItemBlock(block) || qtyTab || qtySh || qtyLbl;
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
type AnchorMatchResult = { anchor: CorpusAnchor | null; method: PositionMatchMethod };

function resolveNoticeAnchorForGoodsItem(
  g: TenderAiGoodItem,
  itemTokens: string[],
  itemNameNorm: string,
  noticeAnchors: CorpusAnchor[],
  maskedFullCorpus: string
): AnchorMatchResult {
  const pid = (g.positionId ?? "").replace(/^№\s*/i, "").trim();
  if (isRegistryStylePositionId(pid)) {
    const byReg = noticeAnchors.find((a) => a.rawLine.includes(pid));
    if (byReg) return { anchor: byReg, method: "registry_id" };
    const syn = syntheticNoticeAnchorFromRegistry(maskedFullCorpus, pid);
    if (syn) return { anchor: syn, method: "registry_id" };
  }
  const hit = findBestAnchorWithMethod(itemTokens, noticeAnchors, itemNameNorm, 3);
  return hit;
}

function resolveNoticeHitForTechRow(
  tzPid: string,
  tzTokens: string[],
  tzNorm: string,
  noticeAnchors: CorpusAnchor[],
  maskedFullCorpus: string,
  usedNoticeAnchorKeys?: Set<string>
): AnchorMatchResult {
  const pid = tzPid.replace(/^№\s*/i, "").trim();
  const excluded = (a: CorpusAnchor) =>
    usedNoticeAnchorKeys?.has(corpusAnchorDedupeKey(a)) ?? false;
  if (isRegistryStylePositionId(pid)) {
    const tzEff = tzTokens.filter((t) => !isCodeToken(t));
    const byReg = noticeAnchors.find((a) => a.rawLine.includes(pid) && !excluded(a));
    if (byReg && (tzEff.length === 0 || noticeRegistryLineAnchorsTechRow(tzTokens, byReg, pid))) {
      return { anchor: byReg, method: "registry_id" };
    }
    const syn = syntheticNoticeAnchorFromRegistry(maskedFullCorpus, pid);
    if (
      syn &&
      !excluded(syn) &&
      (tzEff.length === 0 || noticeRegistryLineAnchorsTechRow(tzTokens, syn, pid))
    ) {
      return { anchor: syn, method: "registry_id" };
    }
  }
  const pool = usedNoticeAnchorKeys?.size
    ? noticeAnchors.filter((a) => !excluded(a))
    : noticeAnchors;
  return findBestAnchorWithMethod(tzTokens, pool, tzNorm, 3);
}

function registryPositionIdFromLine(line: string): string {
  return REGISTRY_POSITION_ID_CAPTURE_RE.exec(line)?.[1]?.trim() ?? "";
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

/** Позиция из детерминированного разбора блока ТЗ/спецификации (источник истины для карточки). */
function techSpecRowIsDocumentDeterministic(tz: TenderAiGoodItem): boolean {
  return (tz.sourceHint ?? "").toLowerCase().includes("tech_spec_deterministic");
}

export type AiMatchResult = { item: TenderAiGoodItem | null; method: PositionMatchMethod };

export function pickBestAiForTechRow(
  tz: TenderAiGoodItem,
  aiItems: TenderAiGoodItem[],
  tzTokens: string[],
  tzNorm: string
): AiMatchResult {
  let best: TenderAiGoodItem | null = null;
  let bestSc = 0;
  let hasModelTokenOverlap = false;
  let hasPrefixMatch = false;
  for (const ai of aiItems) {
    const nk = normalizeGoodsMatchingKey(`${ai.name} ${ai.codes}`);
    const toks = extractModelTokens(nk);
    let sc = 0;
    const modelHit = modelTokensOverlap(tzTokens, toks);
    if (modelHit) sc += 8;
    else if (tokensOverlap(tzTokens, toks)) sc += 2;
    const prefixHit = tzNorm.length >= 10 && nk.includes(tzNorm.slice(0, Math.min(28, tzNorm.length)));
    if (prefixHit) sc += 4;
    if (toks.some((t) => !isCodeToken(t) && tzNorm.includes(t) && t.length >= 4)) sc += 3;
    if (sc > bestSc) {
      bestSc = sc;
      best = ai;
      hasModelTokenOverlap = modelHit;
      hasPrefixMatch = prefixHit;
    }
  }
  if (bestSc < 4) return { item: null, method: "unmatched" };
  const method: PositionMatchMethod = hasModelTokenOverlap
    ? "name_token_overlap"
    : hasPrefixMatch
      ? "name_normalized_prefix"
      : "unmatched";
  return { item: best, method };
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
    const noticeMatch = resolveNoticeAnchorForGoodsItem(g, toks, nk, noticeAnchors, maskedFullCorpus);
    const noticeHit = noticeMatch.anchor;
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
        rejectionReason: "not_confirmed_in_strict_tz_or_notice",
        noticeMatchMethod: "unmatched",
        aiMatchMethod: "unmatched"
      });
      continue;
    }

    if (!acceptedTech && acceptedNotice) positionsAcceptedFromNoticeOnly++;

    const noticeQtyFromLine = noticeHit ? extractTrustedQuantityFromItemBlock(noticeHit.rawLine) : "";
    const techQtyFromLine = extractTrustedQuantityFromItemBlock(techHit?.rawLine ?? "");
    const techQtyFromField =
      techHit?.quantity?.trim() ? coerceQuantityUnitPair(techHit.quantity, "").quantity : "";
    const tzQty = techQtyFromLine || techQtyFromField;
    const aiQtyFallback =
      extractAiQuantityForReconcile(g) || extractTrustedQuantityFromItemBlock(g.name ?? "");
    const qtyChoice = chooseTrustedQuantity({
      noticeQty: noticeQtyFromLine,
      tzQty,
      aiQty: aiQtyFallback
    });
    const pidNorm = (g.positionId ?? "").replace(/^№\s*/i, "").trim();

    const { unitPrice, lineTotal, priceSource } = attachNoticePrices(noticeHit, g);

    const quantitySource: GoodsSourceAuditRow["quantitySource"] = qtyChoice.source;

    const noticeMethodForAudit = noticeMatch.method;
    const aiMethodForAudit: PositionMatchMethod = distinct
      ? "fallback_corpus_evidence"
      : acceptedTech
        ? "name_token_overlap"
        : "unmatched";

    const fbQtyConf = computeQuantityConfidence({
      quantitySource,
      qtyValue: qtyChoice.value,
      noticeMatchMethod: noticeMethodForAudit,
      aiMatchMethod: aiMethodForAudit,
      isSelfSourcedTz: false
    });
    let qty = applyQuantityGuard(qtyChoice.value, fbQtyConf.confidence);
    // Same as tech_rows_first: merge-fallback has no parsed tz.quantityValue; if chooseTrustedQuantity
    // picked ai_fallback and guard cleared it on weak/none match, keep the AI qty (avoid "— <unit>" only).
    if (
      !qty.trim() &&
      qtyChoice.value.trim() &&
      qtyChoice.source === "ai_fallback"
    ) {
      qty = qtyChoice.value.trim();
    }

    audit.push({
      matchedKey: toks[0] ?? nk.slice(0, 40),
      acceptedFromTechSpec: acceptedTech || distinct,
      acceptedFromNotice: acceptedNotice,
      quantitySource,
      priceSource,
      wasRejectedAsUntrusted: false,
      noticeMatchMethod: noticeMethodForAudit,
      aiMatchMethod: aiMethodForAudit,
      quantityConfidence: fbQtyConf.confidence,
      quantityGuardReason: fbQtyConf.reason
    });

    const positionIdOut =
      (isRegistryStylePositionId(pidNorm) ? (g.positionId ?? "").trim() : "") ||
      (noticeHit?.positionId?.trim() || "") ||
      (g.positionId ?? "").trim() ||
      "";

    out.push({
      ...g,
      quantity: qty,
      unitPrice,
      lineTotal,
      positionId: positionIdOut,
      positionIdMatchConfidence: positionIdMatchConfidenceForMergeFallbackLenient(positionIdOut)
    });
  }

  /**
   * Registry-ID supplement: scan corpus for all EIS registry IDs and add any positions
   * not yet covered by the AI items. This recovers positions the AI truncated or missed.
   * Only fires when techSpec also failed to find them (techSpecExtractedCount=0 or low).
   */
  if (bundle.techSpecExtractedCount === 0 || bundle.techSpecExtractedCount < out.length) {
    const registryPositions = extractGoodsPositionsFromRegistryIds(maskedFullCorpus);
    const coveredPids = new Set(
      out
        .map((g) => (g.positionId ?? "").replace(/^№\s*/i, "").replace(/\s/g, "").trim())
        .filter((p) => isRegistryStylePositionId(p))
    );
    for (const rp of registryPositions) {
      const pidNorm = (rp.positionId ?? "").replace(/\s/g, "").trim();
      if (!pidNorm || coveredPids.has(pidNorm)) continue;
      out.push({ ...rp, positionIdMatchConfidence: "matched_exact" });
      coveredPids.add(pidNorm);
      positionsAcceptedFromNoticeOnly++;
      const regQtyConf = computeQuantityConfidence({
        quantitySource: rp.quantity ? "registry" : "unknown",
        qtyValue: rp.quantity ?? "",
        noticeMatchMethod: "registry_id",
        aiMatchMethod: "unmatched",
        isSelfSourcedTz: false
      });
      audit.push({
        matchedKey: `registry_scan_${pidNorm}`,
        acceptedFromTechSpec: false,
        acceptedFromNotice: true,
        quantitySource: rp.quantity ? "registry" : "unknown",
        priceSource: rp.unitPrice || rp.lineTotal ? "notice" : "missing",
        wasRejectedAsUntrusted: false,
        noticeMatchMethod: "registry_id",
        aiMatchMethod: "unmatched",
        quantityConfidence: regQtyConf.confidence,
        quantityGuardReason: regQtyConf.reason
      });
    }
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

  const tailRemapped = reassignShort20RegistryPidsFromPfCartridgeTailWindows(out, maskedFullCorpus);
  const stripMerged = stripDuplicateRegistryPidFromConsecutiveCanon067hColorVariantRows(tailRemapped);
  return {
    items: stripMerged.items,
    goodsSourceAudit: audit,
    goodsSourceSummary: summary,
    goodsTechSpecParseAudit: bundle.parseAudit,
    goodsBackboneSourceAudit,
    goodsQualityDiagnostic: buildGoodsQualityDiagnostic(stripMerged.items, audit)
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
  const bundleBase = precomputedTechSpec ?? extractGoodsFromTechSpec(maskedFullCorpus);
  let bundle = dedupeTechSpecBundleCrossSource(bundleBase) ?? bundleBase;
  bundle = stripGlueOnlyRegistryPositionIdsFromTechSpecBundle(bundle, maskedFullCorpus) ?? bundle;
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

  const usedNoticeAnchorKeys = new Set<string>();

  const hasLetterToken = (s: string) => /[а-яёa-z]{3,}/i.test((s ?? "").replace(/\s+/g, " ").trim());
  const looksLikePlaceholderTitleForUi = (name: string) => {
    const t = (name ?? "").replace(/\s+/g, " ").trim();
    if (!t) return true;
    if (t.length < 8) return true;
    if (!hasLetterToken(t)) return true;
    return false;
  };
  const isGenericCharacteristicKeyForUi = (key: string) => {
    const k = (key ?? "").replace(/\s+/g, " ").trim().toLowerCase();
    if (!k) return true;
    if (k === "описание товара") return true;
    if (k === "описание" || k === "примечание") return true;
    return false;
  };
  const buildTitleSuffixFromCharacteristics = (rows: TenderAiCharacteristicRow[]): string => {
    const candidates = (rows ?? [])
      .map((r) => ({
        k: ((r as any)?.key ?? (r as any)?.name ?? "").replace(/\s+/g, " ").trim(),
        v: ((r as any)?.value ?? "").replace(/\s+/g, " ").trim()
      }))
      .filter((r) => r.k.length >= 2 && r.v.length >= 1)
      .filter((r) => !isGenericCharacteristicKeyForUi(r.k))
      .filter((r) => !/^(?:да|нет)$/i.test(r.v))
      .map((r) => {
        let score = 0;
        if (/\d/.test(r.v)) score += 3;
        if (/%|°/.test(r.v)) score += 1;
        if (r.v.length >= 6 && r.v.length <= 44) score += 2;
        if (r.v.length <= 80) score += 1;
        return { ...r, score };
      })
      .sort((a, b) => b.score - a.score);
    const top = candidates[0];
    if (!top) return "";
    const v = top.v.length > 60 ? `${top.v.slice(0, 60)}…` : top.v;
    const k = top.k.length > 32 ? `${top.k.slice(0, 32)}…` : top.k;
    if (/\d/.test(v) && v.length <= 18) return v;
    return `${k}: ${v}`.slice(0, 72);
  };
  const enrichPlaceholderTitleFromCharacteristics = (name: string, rows: TenderAiCharacteristicRow[]): string => {
    const t = (name ?? "").replace(/\s+/g, " ").trim();
    if (!looksLikePlaceholderTitleForUi(t)) return t;
    const suffix = buildTitleSuffixFromCharacteristics(rows);
    if (!suffix) return t;
    return `${t} (${suffix})`.replace(/\s+/g, " ").trim();
  };

  for (const tz of bundle.items) {
    const tzNorm = normalizeGoodsMatchingKey(`${tz.name} ${tz.codes}`);
    const tzTokens = extractModelTokens(tzNorm);
    const aiMatch = pickBestAiForTechRow(tz, aiItems, tzTokens, tzNorm);
    const bestAi = aiMatch.item;
    const tzPid = (tz.positionId ?? "").replace(/^№\s*/i, "").trim();
    const noticeMatch = resolveNoticeHitForTechRow(
      tzPid,
      tzTokens,
      tzNorm,
      noticeAnchors,
      maskedFullCorpus,
      usedNoticeAnchorKeys
    );
    const noticeHit = noticeMatch.anchor;
    if (noticeHit) usedNoticeAnchorKeys.add(corpusAnchorDedupeKey(noticeHit));

    const { unitPrice, lineTotal, priceSource } = attachNoticePrices(noticeHit, bestAi);

    if (noticeHit && (unitPrice || lineTotal)) matchedWithNotice++;
    if (!unitPrice && !lineTotal) missingPrice++;

    const coercedTz = coerceQuantityUnitPair(tz.quantity ?? "", tz.unit ?? "");
    const coercedAi = bestAi
      ? coerceQuantityUnitPair(bestAi.quantity ?? "", bestAi.unit ?? "")
      : { quantity: "", unit: "" };

    const noticeQtyFromLine = noticeHit ? extractTrustedQuantityFromItemBlock(noticeHit.rawLine) : "";
    const aiQtyFallback =
      extractAiQuantityForReconcile(bestAi) || extractTrustedQuantityFromItemBlock(bestAi?.name ?? "");
    const tzQtyForTrusted =
      tz.quantityValue != null ? formatQuantityValueForStorage(tz.quantityValue) : coercedTz.quantity;
    const qtyChoice = chooseTrustedQuantity({
      noticeQty: noticeQtyFromLine,
      tzQty: tzQtyForTrusted,
      aiQty: aiQtyFallback,
      tzNumericQuantity: tz.quantityValue ?? null
    });
    const quantitySource: GoodsSourceAuditRow["quantitySource"] = qtyChoice.source;

    const isSelfSourcedTz =
      quantitySource === "tech_spec" &&
      (Boolean(coercedTz.quantity.trim()) || tz.quantityValue != null);
    const qtyConf = computeQuantityConfidence({
      quantitySource,
      qtyValue: qtyChoice.value,
      noticeMatchMethod: noticeMatch.method,
      aiMatchMethod: aiMatch.method,
      isSelfSourcedTz
    });
    let qtyFinal = applyQuantityGuard(qtyChoice.value, qtyConf.confidence);
    if (
      tz.quantitySource === "tech_spec" &&
      tz.quantityValue != null &&
      (!qtyFinal.trim() || qtyConf.confidence === "low" || qtyConf.confidence === "none")
    ) {
      qtyFinal = formatQuantityValueForStorage(tz.quantityValue);
    }

    // applyQuantityGuard clears low/none cross-source qty; when tech spec has no numeric quantityValue
    // and the only trusted chooser was ai_fallback, keep the AI string so we do not show "— <unit>" only.
    if (
      !qtyFinal.trim() &&
      qtyChoice.value.trim() &&
      qtyChoice.source === "ai_fallback" &&
      tz.quantityValue == null
    ) {
      qtyFinal = qtyChoice.value.trim();
    }

    /** П/п из детерминированной строки ТЗ (1–35) не перетираем positionId из ошибочно сматченной AI-строки. */
    const shortOrdinalPid = Boolean(tzPid && /^\d{1,4}$/.test(tzPid));
    const pidCompact = tzPid.replace(/\s/g, "");
    const noticePidCompact = (noticeHit?.positionId ?? "").replace(/\s/g, "").trim();
    const regKeyForNoticeAnchor = (tzPid || noticePidCompact).replace(/\s/g, "").trim();
    const noticeLineAnchored =
      Boolean(noticeHit) &&
      noticeRegistryLineAnchorsTechRow(
        tzTokens,
        noticeHit!,
        regKeyForNoticeAnchor || "\u0001__no_registry_pid__"
      );

    /** Не держим реестровый pid из ТЗ, если якорь ПФ/извещения указывает на другую позицию (сдвиг по индексу/КТРУ). */
    const registryTzAnchored =
      !isRegistryStylePositionId(tzPid) ||
      !noticeHit ||
      (noticeLineAnchored &&
        (noticePidCompact === pidCompact ||
          ((!noticePidCompact || !isRegistryStylePositionId(noticePidCompact)) &&
            noticeHit.rawLine.replace(/\s/g, "").includes(pidCompact))));

    /** Не подставлять pid с «чужой» строки ПФ/извещения без сильного якоря (общий КТРУ/порядок). */
    const noticePidIfAnchored = noticeLineAnchored ? (noticeHit?.positionId ?? "").trim() : "";

    let positionId =
      (isRegistryStylePositionId(tzPid) && registryTzAnchored ? (tz.positionId ?? "").trim() : "") ||
      (shortOrdinalPid ? (tz.positionId ?? "").trim() : "") ||
      noticePidIfAnchored ||
      (bestAi?.positionId ?? "").trim() ||
      (!isRegistryStylePositionId(tzPid) ? (tz.positionId ?? "").trim() : "") ||
      "";
    if (!positionId.trim() && noticeLineAnchored && noticeHit?.rawLine) {
      const fromLine = registryPositionIdFromLine(noticeHit.rawLine);
      if (fromLine) positionId = fromLine;
    }

    const positionIdFinal = (
      positionId ||
      (bestAi?.positionId ?? "").trim() ||
      (!isRegistryStylePositionId(tzPid) || registryTzAnchored ? (tz.positionId ?? "").trim() : "") ||
      ""
    ).trim();
    const positionIdMatchConfidence = positionIdMatchConfidenceForTechRowReconcile({
      finalPositionId: positionIdFinal,
      tz,
      tzPid
    });

    const tzChars = (tz.characteristics ?? []).filter((c) => (c.name ?? "").trim() || (c.value ?? "").trim());
    const aiChars = (bestAi?.characteristics ?? []).filter(
      (c) => (c.name ?? "").trim() || (c.value ?? "").trim()
    );
    const docDeterministic = techSpecRowIsDocumentDeterministic(tz);
    const tzNameTrim = (tz.name ?? "").trim();
    const finalName =
      docDeterministic && tzNameTrim.length >= 6 ? tzNameTrim : preferLonger(tz.name, bestAi?.name ?? "");
    let characteristics = tzChars.length > 0 ? tzChars : aiChars;
    if (
      characteristics.length === 0 &&
      docDeterministic &&
      noticeHit?.rawLine &&
      (noticeHit.rawLine.includes("\t") || /:\s*\S/.test(noticeHit.rawLine))
    ) {
      const fromNotice = parseRelaxedColonAndTabCharacteristicLines([noticeHit.rawLine]).filter(
        (c) => (c.name ?? "").trim() && (c.value ?? "").trim()
      );
      if (fromNotice.length > 0) characteristics = fromNotice;
    }
    /**
     * Тенд32: характеристики в ПФ по `regNumber=<pid>`; pid часто появляется в итоге только после annotate.
     * До того — как у `annotateGoodsItemsWithPositionIdStatus`: кандидаты по codes из notice + сужение.
     */
    if (
      characteristics.length === 0 &&
      maskedFullCorpus.includes(TEND32_REGISTRY_PF_CHARACTERISTICS_CORPUS_MARKER)
    ) {
      const pidForPf = tend32ResolveRegistryPidForPfCharacteristics(maskedFullCorpus, positionId, tz, {
        finalName,
        qtyFinal,
        unitPrice,
        lineTotal
      });
      if (isRegistryStylePositionId(pidForPf)) {
        const fromPfRegistry = tryExtractPfCharacteristicsByRegistryPositionId(maskedFullCorpus, pidForPf);
        if (fromPfRegistry.length > 0) characteristics = fromPfRegistry;
      }
    }
    if (characteristics.length === 0 && maskedFullCorpus.includes(TEND32_REGISTRY_PF_CHARACTERISTICS_CORPUS_MARKER)) {
      const oozBody = extractTend32OozDescriptionBody(maskedFullCorpus);
      if (oozBody) {
        const fromOoz = tryExtractTend32OozVerticalCharacteristics(oozBody, finalName);
        if (fromOoz.length > 0) characteristics = fromOoz;
      }
    }
    if (docDeterministic) {
      characteristics = stripVerticalSpecTitleEchoFromCharacteristics(finalName, characteristics);
    }

    let characteristicsStatus: "not_present" | undefined;
    if (
      characteristics.length === 0 &&
      maskedFullCorpus.includes(TEND32_REGISTRY_PF_CHARACTERISTICS_CORPUS_MARKER)
    ) {
      const pidForPresence = tend32ResolveRegistryPidForPfCharacteristics(maskedFullCorpus, positionId, tz, {
        finalName,
        qtyFinal,
        unitPrice,
        lineTotal
      });
      const pfProbe =
        isRegistryStylePositionId(pidForPresence)
          ? tryExtractPfCharacteristicsByRegistryPositionId(maskedFullCorpus, pidForPresence)
          : [];
      const oozBody = extractTend32OozDescriptionBody(maskedFullCorpus);
      const oozDetail = oozBody ? tend32OozHasDetailBlockForName(oozBody, finalName) : false;
      /**
       * C: в ООЗ нет второго блока с вертикальными характеристиками для наименования — по структуре
       * закупки характеристик в описании нет. Если блок в ООЗ есть, а строк пусто — это B (парсер/ПФ).
       * При реестровом pid дополнительно требуем пустой срез ПФ, чтобы не пометить при необнаруженном блоке ПФ.
       */
      const pfEmptyOrUnscoped = !isRegistryStylePositionId(pidForPresence) || pfProbe.length === 0;
      if (oozBody && !oozDetail && pfEmptyOrUnscoped) {
        characteristicsStatus = "not_present";
      }
    }

    characteristics = characteristics.map((r) => {
      const k = (r.name ?? "").toLowerCase().replace(/\s+/g, " ").trim();
      if (k !== "описание товара") return r;
      return {
        ...r,
        value: stripCorpusRoutingMarkerFromTechSpecValue(
          truncateAppendedLegalBoilerplateFromDescriptionValue(r.name ?? "", r.value ?? "")
        )
      };
    });

    let outName = finalName;
    const glueSyn = synthesizeGoodNameFromCharacteristicsWhenEisTovarShtukaGlued(outName, characteristics);
    if (glueSyn) outName = glueSyn;
    outName = enrichPlaceholderTitleFromCharacteristics(outName, characteristics);

    const techWonQty = qtyChoice.source === "tech_spec";
    const tzPreferredUnit = ((tz.quantityUnit || "").trim() || (techWonQty ? (tz.unit || "").trim() : "")).trim();
    const unitMerged =
      (qtyFinal && techWonQty && tzPreferredUnit ? tzPreferredUnit : "") ||
      (qtyFinal && !techWonQty && coercedTz.quantity && coercedTz.unit ? coercedTz.unit : "") ||
      (qtyFinal &&
      qtyChoice.source === "ai_fallback" &&
      coercedAi.quantity &&
      coercedAi.unit
        ? coercedAi.unit
        : "") ||
      (tz.unit || "").trim() ||
      (bestAi?.unit || "").trim() ||
      "шт";

    const itemQtySource = mapAuditGoodsQuantitySourceToContract(quantitySource);
    let outQuantityValue: number | undefined;
    let outQuantityUnit = "";
    if (quantitySource === "tech_spec" && tz.quantityValue != null) {
      outQuantityValue = tz.quantityValue;
      outQuantityUnit = ((tz.quantityUnit || "").trim() || (tz.unit || "").trim()).trim();
    } else if (quantitySource === "ai_fallback" && bestAi?.quantityValue != null) {
      outQuantityValue = bestAi.quantityValue;
      outQuantityUnit = (bestAi.quantityUnit || "").trim();
    }

    out.push({
      name: outName,
      codes: (tz.codes || "").trim() || (bestAi?.codes ?? "").trim(),
      unit: unitMerged.trim() || "шт",
      quantity: qtyFinal,
      positionId: positionIdFinal,
      positionIdMatchConfidence,
      unitPrice,
      lineTotal,
      sourceHint: tz.sourceHint || bestAi?.sourceHint || "",
      characteristics,
      quantityUnit: outQuantityUnit,
      quantitySource: itemQtySource,
      ...(outQuantityValue != null ? { quantityValue: outQuantityValue } : {}),
      ...(characteristicsStatus ? { characteristicsStatus } : {})
    });

    audit.push({
      matchedKey: tzTokens[0] ?? tzNorm.slice(0, 40),
      acceptedFromTechSpec: true,
      acceptedFromNotice: Boolean(noticeHit),
      quantitySource,
      priceSource,
      wasRejectedAsUntrusted: false,
      noticeMatchMethod: noticeMatch.method,
      aiMatchMethod: aiMatch.method,
      quantityConfidence: qtyConf.confidence,
      quantityGuardReason: qtyConf.reason
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

  const tailRemappedReconciled = reassignShort20RegistryPidsFromPfCartridgeTailWindows(out, maskedFullCorpus);
  const stripReconciled = stripDuplicateRegistryPidFromConsecutiveCanon067hColorVariantRows(tailRemappedReconciled);
  const itemsOut = assignRegistryPidFromNoticeCollisionNarrowingWhenReconcilePidStillEmpty(
    stripReconciled.items,
    maskedFullCorpus
  );

  return {
    items: itemsOut,
    goodsSourceAudit: audit,
    goodsSourceSummary: summary,
    goodsTechSpecParseAudit: {
      ...bundle.parseAudit,
      finalRetainedFromTechSpecCount: itemsOut.length
    },
    goodsBackboneSourceAudit,
    goodsQualityDiagnostic: buildGoodsQualityDiagnostic(itemsOut, audit)
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
