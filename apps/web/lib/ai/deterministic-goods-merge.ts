/**
 * Слияние детерминированных строк ТЗ и печатной формы.
 *
 * **Иерархия источников** (`enhanceTechSpecBundleWithNoticeRows`): при «авторитетном» notice
 * (goods-info с замком качества, либо таблица ПФ при слабом ТЗ / не большем числе строк ТЗ) кардинальность
 * задаётся notice, в ТЗ подмешиваются только поля строк с явным совпадением по коду или нормализованному имени;
 * иначе сохраняются строки ТЗ и только детерминированное обогащение п/п из notice (без смены числа позиций).
 *
 * **Cross-source dedupe** (`dedupeTechSpecBundleCrossSource`): для класса тендеров «ТЗ.docx + ПФ.pdf»
 * с укороченными строками из ПФ («Картридж для») при наличии полной модельной строки из ТЗ
 * (см. `isPoorPrintedFormDuplicateCandidate` / `isLikelyRichTechSpecCounterpart`). Срабатывает на
 * **бандле** после `extractGoodsFromTechSpec`, до reconcile — см. `tender-ai-analyze.ts`.
 * Регрессия на архивах: `verify:goods-docs-tz-pf-archetype`; в общем наборе — `verify:ai-goods` / корень `verify:web-ai-goods`.
 */

import type { PositionIdMatchConfidence, TenderAiGoodItem } from "@tendery/contracts";
import type { ExtractGoodsFromTechSpecResult } from "@/lib/ai/extract-goods-from-tech-spec";
import {
  formatQuantityValueForStorage,
  parseDeterministicQuantityNumberFragment
} from "@/lib/ai/extract-goods-from-tech-spec";
import {
  goodsInfoHasTwoDistinctClassificationCodes,
  goodsInfoRowsPassQualityGateForNoticeMerge,
  isNoticeGoodsInfoBlockRow,
  isNoticePrintFormRow,
  isNoticePrintFormTovarUnitQtyGlueRowWithoutProductTitle,
  normalizeGoodsInfoProductNameKey,
  pickAuthoritativeNoticeRowsForGoodsCardinality
} from "@/lib/ai/extract-goods-notice-table";
import {
  isRegistryStylePositionId,
  REGISTRY_POSITION_ID_CAPTURE_RE,
  registryPidOccursOnlyInTovarShtukaPriceGlueCorpus
} from "@/lib/ai/registry-position-ids";
import { polishGoodsDisplayName } from "@/lib/ai/polish-goods-display-name";
import { stripDuplicateRegistryPidFromConsecutiveCanon067hColorVariantRows } from "@/lib/ai/strip-duplicate-registry-pid-canon067h-variant-run";

const KTRU_SUFFIX_FOR_MERGE_RE = /\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{3,5}(?!\d)/g;

/** Склейка колонок ПФ ЕИС «Товар»+«Штука»+число — не должна перебивать читаемое наименование из ТЗ только длиной. */
function isEisPfGluedColumnProductName(s: string): boolean {
  return /^ТоварШтука/i.test((s ?? "").replace(/\s+/g, " ").trim());
}

function pickMergedDeterministicProductName(techName: string, noticeName: string): string {
  const t = (techName ?? "").trim();
  const n = (noticeName ?? "").trim();
  if (isEisPfGluedColumnProductName(n) && t.length >= 6 && !isEisPfGluedColumnProductName(t)) return t;
  return t.length > n.length ? t : n;
}

function ktruSuffixKeysFromCodesField(codes: string): string[] {
  const t = (codes ?? "").trim();
  if (!t) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const seg of t.split(/\s*;\s*/)) {
    const s = seg.trim();
    if (!s) continue;
    const r = new RegExp(KTRU_SUFFIX_FOR_MERGE_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = r.exec(s)) !== null) {
      const k = m[0]!.replace(/\s/g, "").toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(m[0]!);
    }
  }
  out.sort((a, b) => b.length - a.length);
  return out;
}

/** Короткий п/п из ТЗ не блокирует детерминированное восстановление реестрового id из ПФ/извещения. */
function hasAuthoritativeRegistryPositionId(pidRaw: string): boolean {
  const t = (pidRaw ?? "").replace(/\s/g, "").trim();
  return Boolean(t && isRegistryStylePositionId(t));
}

/**
 * Подстановка реестрового pid из детерминированных notice-строк по совпадению КТРУ-суффикса в `codes`
 * (только tech_spec_deterministic, только без реестрового pid; при конфликте суффикса — не менять).
 */
function applyRegistryPidFromNoticeRowsByKtruSuffix(
  merged: TenderAiGoodItem[],
  noticeItems: TenderAiGoodItem[],
  /** Строки ТЗ с уже известным реестровым pid и полным КТРУ в `codes` (суффикс часто есть только в strict-tech). */
  techPidAnchorItems: TenderAiGoodItem[] = []
): TenderAiGoodItem[] {
  const pidAnchors = [...noticeItems, ...techPidAnchorItems];
  if (pidAnchors.length === 0) return merged;
  const AMBIG = "__AMBIGUOUS__";
  const suffixToPid = new Map<string, string>();
  for (const n of pidAnchors) {
    const pid = (n.positionId ?? "").replace(/\s/g, "").trim();
    if (!isRegistryStylePositionId(pid)) continue;
    for (const raw of ktruSuffixKeysFromCodesField(n.codes ?? "")) {
      const key = raw.replace(/\s/g, "").toLowerCase();
      if (key.length < 12) continue;
      const prev = suffixToPid.get(key);
      if (prev === AMBIG) continue;
      if (prev && prev !== pid) {
        suffixToPid.set(key, AMBIG);
        continue;
      }
      suffixToPid.set(key, pid);
    }
  }
  for (const k of [...suffixToPid.keys()]) {
    if (suffixToPid.get(k) === AMBIG) suffixToPid.delete(k);
  }

  return merged.map((g) => {
    const cur = (g.positionId ?? "").replace(/\s/g, "").trim();
    if (isRegistryStylePositionId(cur)) return g;
    if (!(g.sourceHint ?? "").toLowerCase().includes("tech_spec_deterministic")) return g;
    for (const raw of ktruSuffixKeysFromCodesField(g.codes ?? "")) {
      const key = raw.replace(/\s/g, "").toLowerCase();
      const pid = suffixToPid.get(key);
      if (pid) return { ...g, positionId: pid };
    }
    return g;
  });
}

/**
 * После merge ТЗ↔ПФ два разных наименования не должны делить один длинный реестровый id из notice —
 * иначе dupPid при полном корпусе ПФ. Оставляем pid у первой строки по порядку, у остальных сбрасываем
 * (reconcile дотянет из других якорей при возможности).
 */
function splitDuplicateLongRegistryPidWhenDistinctNormalizedNames(items: TenderAiGoodItem[]): TenderAiGoodItem[] {
  const normPid = (s: string) => (s ?? "").replace(/^№\s*/i, "").replace(/\s/g, "").trim();
  const byPid = new Map<string, number[]>();
  for (let i = 0; i < items.length; i++) {
    const p = normPid(items[i]!.positionId ?? "");
    if (!p || !isRegistryStylePositionId(p) || p.length < 13) continue;
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

function positionSortKey(g: TenderAiGoodItem): number {
  const p = (g.positionId ?? "").trim();
  if (/^\d{1,4}$/.test(p)) {
    const n = parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function allShortPositionIds(items: TenderAiGoodItem[]): boolean {
  return (
    items.length > 0 &&
    items.every((g) => /^\d{1,4}$/.test((g.positionId ?? "").trim()))
  );
}

function goodsInfoNoticeRowsOnly(noticeItems: TenderAiGoodItem[]): TenderAiGoodItem[] {
  return noticeItems.filter(isNoticeGoodsInfoBlockRow);
}

function normalizeNoticeCodeSegmentsForMerge(codes: string): string[] {
  return (codes ?? "")
    .split(/\s*;\s*/)
    .map((x) => x.replace(/\s/g, "").toLowerCase())
    .filter(Boolean);
}

function noticeCodesShareSegmentWithTech(noticeCodes: string, techCodes: string): boolean {
  const A = normalizeNoticeCodeSegmentsForMerge(noticeCodes);
  const B = normalizeNoticeCodeSegmentsForMerge(techCodes);
  for (const a of A) {
    for (const b of B) {
      if (a === b) return true;
      if (a.length >= 8 && b.length >= 8 && (a.startsWith(b) || b.startsWith(a))) return true;
    }
  }
  return false;
}

/** Слияние notice→tech только при явном совпадении кода или нормализованного наименования. */
function strictNoticeTechEnrichmentMatch(n: TenderAiGoodItem, t: TenderAiGoodItem): boolean {
  if (noticeCodesShareSegmentWithTech(n.codes ?? "", t.codes ?? "")) return true;
  const ka = normalizeGoodsInfoProductNameKey(n.name ?? "");
  const kb = normalizeGoodsInfoProductNameKey(t.name ?? "");
  return ka.length >= 8 && kb.length >= 8 && ka === kb;
}

/**
 * ПФ «Информация о товаре»: кардинальность по notice (≥2 позиций), ТЗ — уточнение имён/характеристик.
 * Срабатывает только на строках с `notice_goods_info_block` (см. extractGoodsFromNoticeGoodsInfoSection).
 */
function mergeGoodsInfoNoticeRowsOverTech(
  goodsInfoRows: TenderAiGoodItem[],
  techItems: TenderAiGoodItem[],
  allNoticeForPid: TenderAiGoodItem[]
): TenderAiGoodItem[] {
  const ti = [...techItems];
  const ni = [...goodsInfoRows];
  const out: TenderAiGoodItem[] = [];
  const usedTech = new Set<number>();

  for (let i = 0; i < ni.length; i++) {
    const n = ni[i]!;
    let bestJ = -1;
    for (let j = 0; j < ti.length; j++) {
      if (usedTech.has(j)) continue;
      if (strictNoticeTechEnrichmentMatch(n, ti[j]!)) {
        bestJ = j;
        break;
      }
    }
    const t = bestJ >= 0 ? ti[bestJ]! : undefined;
    if (t && bestJ >= 0) usedTech.add(bestJ);
    out.push({
      ...n,
      name: t ? pickMergedDeterministicProductName(t.name, n.name) : n.name,
      characteristics:
        t?.characteristics && t.characteristics.length > 0 ? t.characteristics : n.characteristics ?? [],
      codes: (n.codes ?? "").trim() || (t?.codes ?? "").trim(),
      quantity: (n.quantity ?? "").trim() || (t?.quantity ?? "").trim(),
      unit: (n.unit ?? "").trim() || (t?.unit ?? "").trim() || "шт",
      unitPrice: (n.unitPrice ?? "").trim() || (t?.unitPrice ?? "").trim(),
      lineTotal: (n.lineTotal ?? "").trim() || (t?.lineTotal ?? "").trim(),
      positionId: (n.positionId ?? "").trim() || (t?.positionId ?? "").trim(),
      sourceHint: [t?.sourceHint, n.sourceHint].filter(Boolean).join("; ") || "merged_deterministic_goods_info"
    });
  }
  return splitDuplicateLongRegistryPidWhenDistinctNormalizedNames(
    applyRegistryPidFromNoticeRowsByKtruSuffix(out, allNoticeForPid, ti)
  );
}

/**
 * Сшиваем по индексу порядка строк в документе. Сортировка п/п — только если в обоих списках
 * короткие номера; длинные реестровые id не гоняем через parseInt (иначе порядок ломается).
 */
export function mergeTechAndNoticeDeterministicRows(
  techItems: TenderAiGoodItem[],
  noticeItems: TenderAiGoodItem[]
): TenderAiGoodItem[] {
  const sortBoth = allShortPositionIds(techItems) && allShortPositionIds(noticeItems);
  const ti = sortBoth
    ? [...techItems].sort((a, b) => positionSortKey(a) - positionSortKey(b))
    : [...techItems];
  const ni = sortBoth
    ? [...noticeItems].sort((a, b) => positionSortKey(a) - positionSortKey(b))
    : [...noticeItems];

  if (noticeItems.length === 0) {
    return splitDuplicateLongRegistryPidWhenDistinctNormalizedNames(
      applyRegistryPidFromNoticeRowsByKtruSuffix(techItems, [], ti)
    );
  }

  const goodsInfoOnly = goodsInfoNoticeRowsOnly(noticeItems);
  if (goodsInfoOnly.length >= 2 && techItems.length > goodsInfoOnly.length) {
    return mergeGoodsInfoNoticeRowsOverTech(goodsInfoOnly, techItems, noticeItems);
  }

  if (noticeItems.length >= 2 && noticeItems.length >= techItems.length) {
    const out: TenderAiGoodItem[] = [];
    for (let i = 0; i < ni.length; i++) {
      const n = ni[i]!;
      const t = ti[i];
      out.push({
        ...n,
        name: t ? pickMergedDeterministicProductName(t.name, n.name) : n.name,
        characteristics:
          t?.characteristics && t.characteristics.length > 0 ? t.characteristics : n.characteristics ?? [],
        codes: n.codes || t?.codes || "",
        quantity: n.quantity || t?.quantity || "",
        unit: n.unit || t?.unit || "шт",
        unitPrice: n.unitPrice || t?.unitPrice || "",
        lineTotal: n.lineTotal || t?.lineTotal || "",
        positionId: n.positionId || t?.positionId || "",
        sourceHint: [t?.sourceHint, n.sourceHint].filter(Boolean).join("; ") || "merged_deterministic"
      });
    }
    return splitDuplicateLongRegistryPidWhenDistinctNormalizedNames(
      applyRegistryPidFromNoticeRowsByKtruSuffix(out, noticeItems, ti)
    );
  }

  if (techItems.length > noticeItems.length) {
    return splitDuplicateLongRegistryPidWhenDistinctNormalizedNames(
      applyRegistryPidFromNoticeRowsByKtruSuffix(techItems, noticeItems, ti)
    );
  }
  return noticeItems;
}

/**
 * Строки `notice_goods_info_block` опциональны: не подмешиваем к валидному ТЗ без «замка» качества
 * (≥2 разных кода ИЛИ ≥2 имён и ≥2 разных количеств), кроме случая пустого/анемичного ТЗ.
 */
function stripOptionalGoodsInfoNoticeRowsIfPolicy(
  base: ExtractGoodsFromTechSpecResult | null,
  noticeItems: TenderAiGoodItem[]
): { rows: TenderAiGoodItem[]; strippedGoodsInfo: boolean } {
  const goodsInfo = noticeItems.filter(isNoticeGoodsInfoBlockRow);
  if (goodsInfo.length < 2) return { rows: noticeItems, strippedGoodsInfo: false };
  const rest = noticeItems.filter((n) => !isNoticeGoodsInfoBlockRow(n));

  const techItems = base?.items ?? [];
  const techEmpty = techItems.length === 0;
  const techAllAnemic =
    techItems.length > 0 &&
    techItems.every((g) => {
      const n = (g.name ?? "").trim().length;
      const c = (g.codes ?? "").trim().length;
      const q = (g.quantity ?? "").trim().length;
      return n < 6 && c === 0 && q === 0;
    });
  const allowBecauseTechWeak = techEmpty || techAllAnemic;
  const allowBecauseConfirmed = goodsInfoRowsPassQualityGateForNoticeMerge(goodsInfo);
  if (!allowBecauseTechWeak && !allowBecauseConfirmed) {
    return { rows: rest, strippedGoodsInfo: true };
  }
  return { rows: noticeItems, strippedGoodsInfo: false };
}

function techBundleWeakForNoticeAuthority(base: ExtractGoodsFromTechSpecResult | null): boolean {
  const techItems = base?.items ?? [];
  if (techItems.length === 0) return true;
  return techItems.every((g) => {
    const n = (g.name ?? "").trim().length;
    const c = (g.codes ?? "").trim().length;
    const q = (g.quantity ?? "").trim().length;
    return n < 6 && c === 0 && q === 0;
  });
}

/** Дубли с одинаковым нормализованным именем и количеством — одна строка (dupPid/двойники). */
function dedupeGoodsItemsByNormalizedNameAndQuantity(items: TenderAiGoodItem[]): TenderAiGoodItem[] {
  const seen = new Set<string>();
  const out: TenderAiGoodItem[] = [];
  for (const g of items) {
    const nk = normalizeGoodsInfoProductNameKey(g.name ?? "");
    const q =
      g.quantityValue != null && Number.isFinite(g.quantityValue)
        ? formatQuantityValueForStorage(g.quantityValue)
        : (g.quantity ?? "").trim().replace(/\s+/g, " ").toLowerCase();
    const u = (g.unit ?? "").trim().toLowerCase();
    const key = `${nk}|${q}|${u}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(g);
  }
  return out;
}

/**
 * После merge ПФ+ТЗ: не схлопывать разные позиции с одинаковым «шумным» именем (Тенд31).
 * Если у двух строк с внутренним id `210…` совпали `positionId|qty|unit`, но это разные позиции ПФ — разводим по
 * `codes` и `lineTotal`. Для остальных случаев оставляем короткий ключ, чтобы не менять Тенд25 и др.
 */
function dedupeGoodsItemsByNormalizedNameAndQuantityPfCardinalityMerge(items: TenderAiGoodItem[]): TenderAiGoodItem[] {
  const shortPfKey = (g: TenderAiGoodItem): string | null => {
    const pid = (g.positionId ?? "").replace(/\s/g, "").trim();
    if (!/^2\d{7,11}$/.test(pid)) return null;
    const q =
      g.quantityValue != null && Number.isFinite(g.quantityValue)
        ? formatQuantityValueForStorage(g.quantityValue)
        : (g.quantity ?? "").trim().replace(/\s+/g, " ").toLowerCase();
    const u = (g.unit ?? "").trim().toLowerCase();
    return `${pid}|${q}|${u}`;
  };
  const shortKeyCounts = new Map<string, number>();
  for (const g of items) {
    const sk = shortPfKey(g);
    if (!sk) continue;
    shortKeyCounts.set(sk, (shortKeyCounts.get(sk) ?? 0) + 1);
  }

  const seen = new Set<string>();
  const out: TenderAiGoodItem[] = [];
  for (const g of items) {
    const pid = (g.positionId ?? "").replace(/\s/g, "").trim();
    const nk = normalizeGoodsInfoProductNameKey(g.name ?? "");
    const q =
      g.quantityValue != null && Number.isFinite(g.quantityValue)
        ? formatQuantityValueForStorage(g.quantityValue)
        : (g.quantity ?? "").trim().replace(/\s+/g, " ").toLowerCase();
    const u = (g.unit ?? "").trim().toLowerCase();
    const sk = shortPfKey(g);
    const collision = sk != null && (shortKeyCounts.get(sk) ?? 0) > 1;
    const codesKey = (g.codes ?? "").replace(/\s/g, "").toLowerCase();
    const ltKey = (g.lineTotal ?? "").replace(/\s/g, "").replace(",", ".").toLowerCase();
    const key =
      /^2\d{7,11}$/.test(pid) && collision ? `${pid}|${q}|${u}|${codesKey}|${ltKey}` : /^2\d{7,11}$/.test(pid) ? `${pid}|${q}|${u}` : `${nk}|${q}|${u}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(g);
  }
  return out;
}

/** Фрагмент графика/адреса поставки — не отдельная номенклатура (Тенд1). */
function techRowReadsLikeDeliveryOrScheduleSlice(name: string): boolean {
  const n = (name ?? "").toLowerCase().replace(/\s+/g, " ");
  return (
    /(?:^|\s)(?:график|этап|очередь)\s+(?:поставк|доставк)/i.test(n) ||
    /(?:^|\s)(?:адрес|пункт)\s+(?:поставк|доставк|получен)/i.test(n) ||
    /дол[яи]\s+поставк/i.test(n) ||
    /адрес\s*\d|пункт\s*\d\s*поставк/i.test(n)
  );
}

/** Маркировка / контроль без номенклатуры топлива — частая лишняя строка рядом с дизель/бензин (Тенд10). */
function techRowLooksLikeMarkingOrAuxComplianceLine(name: string): boolean {
  const n = (name ?? "").toLowerCase();
  if (/топлив|бензин|дизел|аи-\d{2}/i.test(n)) return false;
  return /маркиров|акцизн\w*\s+марок|контрольн\w*\s+марок|номер\s+партии|серийн\w*\s+номер/i.test(n);
}

export type NonProductRequirementLineContext = {
  /** Индекс строки в списке `allItems`. */
  index: number;
  /** Все позиции того же шага (для проверки «продолжает предыдущий товар»). */
  allItems: TenderAiGoodItem[];
};

function longestNormSubstringOverlap(a: string, b: string, minLen: number): boolean {
  const A = normalizeGoodsInfoProductNameKey(a);
  const B = normalizeGoodsInfoProductNameKey(b);
  if (A.length < minLen || B.length < minLen) return false;
  for (let len = Math.min(A.length, B.length); len >= minLen; len--) {
    for (let i = 0; i + len <= A.length; i++) {
      const sub = A.slice(i, i + len);
      if (B.includes(sub)) return true;
    }
  }
  return false;
}

/** Снимает ведущий «1. » / «2) » из строки наименования (подпункты ТЗ). */
function stripLeadingOrderedListPrefix(line: string): string {
  const t = (line ?? "").trim().replace(/\s+/g, " ");
  return t.replace(/^\d+[.)]\s+/i, "").trim();
}

/** Начало строки как у заголовка требований/оформления ТЗ (узко: без «качественные», «соответствующий»). */
function startsAsRequirementLikePrefix(line: string): boolean {
  const low = (line ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!low) return false;
  if (/^(маркировк|требован|упаковк|сертификат)/i.test(low)) return true;
  if (/^качество\s|^качеству\s|^качеством\s|^качества\s/i.test(low)) return true;
  return /^соответствие\b|^соответствии\b|^соответствию\b|^соответствия\b/i.test(low);
}

/**
 * Строка пересекается с более ранней позицией, которая **не** выглядит как заголовок требований
 * (якорь — обычная номенклатура в том же списке). Без привязки к `tech_spec_deterministic`.
 * 9 символов в нормализованном ключе — тот же порог, что для пары «топливо дизельное» / «дизельного топлива» (Тенд10).
 */
function continuesEarlierAnchoredProductLine(line: string, context: NonProductRequirementLineContext): boolean {
  for (let j = 0; j < context.index; j++) {
    const prev = context.allItems[j]!;
    if (startsAsRequirementLikePrefix(stripLeadingOrderedListPrefix(prev.name ?? ""))) continue;
    if (longestNormSubstringOverlap(prev.name ?? "", line, 9)) return true;
  }
  return false;
}

function qtyKeyForNonProductGuard(g: TenderAiGoodItem): string {
  const q = (g.quantity ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  const u = (g.unit ?? "").trim().toLowerCase();
  /** Unit without a numeric quantity is not a meaningful «unique qty» — treat as empty to prevent false guard. */
  if (!q) return "";
  return `${q}|${u}`;
}

function nameKeyForNonProductGuard(g: TenderAiGoodItem): string {
  const nk = normalizeGoodsInfoProductNameKey(g.name ?? "");
  return nk.length >= 6 ? nk : "";
}

/** Строка выглядит как отдельная товарная позиция (п/п, код, модель, товарное начало). */
function hasStandaloneProductStyleLine(line: string): boolean {
  const low = (line ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!low) return false;
  if (/^\d+[.)]\s*\S/.test(low)) return true;
  if (/\d{2}\.\d{2}\.\d{2}/.test(line.slice(0, 55))) return true;
  if (/\bcf\d+[a-z0-9]*|tk-\d|tn-\d|w\d{4}[a-z]/i.test(low)) return true;
  const head = low.split(/[,;–—]/)[0]!.trim();
  return /^(картридж|тонер|барабан|модел|молок|сыр|масл|бумаг|устройств|аппарат|насос|двигатель|топлив|бензин|дизельн|дизел)\b/.test(
    head
  );
}

/**
 * Строка наименования — не отдельный товар, а требование / условие / описание (подпункт к спецификации).
 * Снятие таких строк из бандла — в `stripNonProductRequirementTechDeterministicRows` (ветка tech_spec в enhance).
 */
export function looksLikeNonProductRequirementLine(
  line: string,
  context: NonProductRequirementLineContext
): boolean {
  const t = (line ?? "").trim().replace(/\s+/g, " ");
  if (!t) return false;

  const body = stripLeadingOrderedListPrefix(t);

  /**
   * Заголовок «Наименование и характеристики согласно КТРУ: XX.XX.XX...» — не товарная позиция,
   * а строка-шапка из ТЗ. Код КТРУ в теле ложно срабатывает в hasStandaloneProductStyleLine,
   * поэтому проверяем явно до общего пути.
   */
  if (/^наименование\s+и\s+характеристики\s+согласно\s+ктру\s*:/i.test(body)) return true;

  if (!startsAsRequirementLikePrefix(body)) return false;

  /** Нумерация «5. » не делает заголовок товаром; товарный якорь смотрим по телу без п/п. */
  const standalone = hasStandaloneProductStyleLine(body);

  const continuesEarlierAnchored = continuesEarlierAnchoredProductLine(t, context);

  /** (Б) нет товарного «якоря» ИЛИ текст пересекается с более ранней номенклатурой в списке. */
  return !standalone || continuesEarlierAnchored;
}

/**
 * Снимает строки, распознанные как требования/условия (`looksLikeNonProductRequirementLine`), если это безопасно:
 * в списке есть хотя бы одна «нормальная» позиция (не под этот фильтр); остаётся ≥1 строка;
 * снимаем только если нет одновременно уникального количества и уникального имени и нет «продолжения»
 * более ранней номенклатуры (пересечение нормализованных имён).
 */
/**
 * Строка «Картриджи + ОКПД/КТРУ …» без конкретной модели — часто шапка к списку SKU,
 * детерминированный split даёт ей тот же п/п, что и первой реальной позиции (дубликат pid).
 * Узко: требуем совпадение п/п со следующей строкой и явный SKU в следующей.
 */
const CARTRIDGE_SKU_HEAD_RE =
  /\b(?:PFI-\d{3,4}[A-Z]{0,5}|CLI-\d|PGI-\d|CF\d{2,4}[A-Z]?|TN-\d{2,4}[A-Z]?|TK-\d{2,4}|W\d{3,6}[A-Z]?|MC[-\s]?\d{1,3}\b|CE\d{3,5}[A-Z]?|EP-\d|IT\d{2,5})\b/i;

function looksLikePluralAggregateGoodsClassHeaderLine(name: string): boolean {
  const t = (name ?? "").trim().replace(/\s+/g, " ");
  if (t.length < 28 || t.length > 520) return false;
  if (!/^Картриджи(?!\s+для\b)/i.test(t)) return false;
  if (!/(?:ОКПД2?\b|КТРУ\b|\d{2}\.\d{2}\.\d{2}\.\d{2})/i.test(t.slice(0, 140))) return false;
  if (CARTRIDGE_SKU_HEAD_RE.test(t)) return false;
  return true;
}

function normShortPositionIdForHeaderStrip(g: TenderAiGoodItem): string {
  return (g.positionId ?? "").replace(/^№\s*/i, "").trim();
}

function stripPluralAggregateClassHeaderTechDeterministicRows(items: TenderAiGoodItem[]): {
  items: TenderAiGoodItem[];
  dropped: string[];
} {
  if (items.length < 2) return { items, dropped: [] };
  const dropped: string[] = [];
  const removable = new Set<number>();
  for (let i = 0; i < items.length - 1; i++) {
    const cur = items[i]!;
    const nxt = items[i + 1]!;
    if (!looksLikePluralAggregateGoodsClassHeaderLine(cur.name ?? "")) continue;
    const p0 = normShortPositionIdForHeaderStrip(cur);
    const p1 = normShortPositionIdForHeaderStrip(nxt);
    if (!p0 || p0 !== p1) continue;
    if (!CARTRIDGE_SKU_HEAD_RE.test(nxt.name ?? "")) continue;
    removable.add(i);
    dropped.push(`duplicate_pid_class_header|pid=${p0}|${(cur.name ?? "").slice(0, 72)}`);
  }
  if (removable.size === 0) return { items, dropped: [] };
  const out = items.filter((_, i) => !removable.has(i));
  if (out.length === 0) return { items, dropped: [] };
  return { items: out, dropped };
}

function stripNonProductRequirementTechDeterministicRows(items: TenderAiGoodItem[]): TenderAiGoodItem[] {
  if (items.length < 2) return items;

  const reqLike = items.map((g, j) =>
    looksLikeNonProductRequirementLine(g.name ?? "", { index: j, allItems: items })
  );
  if (!reqLike.some((v) => !v)) return items;

  const qtyCounts = new Map<string, number>();
  for (const g of items) {
    const k = qtyKeyForNonProductGuard(g);
    if (!k) continue;
    qtyCounts.set(k, (qtyCounts.get(k) ?? 0) + 1);
  }
  const nameCounts = new Map<string, number>();
  for (const g of items) {
    const k = nameKeyForNonProductGuard(g);
    if (!k) continue;
    nameCounts.set(k, (nameCounts.get(k) ?? 0) + 1);
  }

  const removable = new Set<number>();
  for (let i = 0; i < items.length; i++) {
    if (!reqLike[i]) continue;
    const hasNormalPeerElsewhere = items.some((_, j) => j !== i && !reqLike[j]!);
    if (!hasNormalPeerElsewhere) continue;

    const g = items[i]!;
    const ctx: NonProductRequirementLineContext = { index: i, allItems: items };

    const qk = qtyKeyForNonProductGuard(g);
    const nk = nameKeyForNonProductGuard(g);
    const uniqueQty = qk !== "" && (qtyCounts.get(qk) ?? 0) === 1;
    const uniqueName = nk !== "" && (nameCounts.get(nk) ?? 0) === 1;
    const cont = continuesEarlierAnchoredProductLine(g.name ?? "", ctx);

    if (!uniqueQty || !uniqueName || cont) {
      removable.add(i);
    }
  }

  if (removable.size === 0 || removable.size >= items.length) return items;
  return items.filter((_, i) => !removable.has(i));
}

function injectiveStrictTechMatchIndices(
  gi: TenderAiGoodItem[],
  tech: TenderAiGoodItem[]
): { ok: true; techUsed: number[] } | { ok: false } {
  const usedT = new Set<number>();
  const techUsed: number[] = [];
  for (let i = 0; i < gi.length; i++) {
    let jFound = -1;
    for (let j = 0; j < tech.length; j++) {
      if (usedT.has(j)) continue;
      if (strictNoticeTechEnrichmentMatch(gi[i]!, tech[j]!)) {
        jFound = j;
        break;
      }
    }
    if (jFound < 0) return { ok: false };
    usedT.add(jFound);
    techUsed.push(jFound);
  }
  return { ok: true, techUsed };
}

/**
 * Две строки goods-info с разными кодами + каждая имеет пару в ТЗ → кардинальность по извещению,
 * даже если парсер ТЗ добавил служебную строку (Тенд10).
 */
function pickStrongGoodsInfoNoticeAuthority(
  giPreStrip: TenderAiGoodItem[],
  techItems: TenderAiGoodItem[],
  techWeak: boolean
): TenderAiGoodItem[] | null {
  if (giPreStrip.length < 2 || !goodsInfoRowsPassQualityGateForNoticeMerge(giPreStrip)) return null;
  const sorted = [...giPreStrip].sort(
    (a, b) =>
      ((b.codes ?? "").trim().length - (a.codes ?? "").trim().length) ||
      (a.name ?? "").localeCompare(b.name ?? "", "ru")
  );
  if (techWeak || techItems.length <= sorted.length) return sorted;
  const distinctQtyUnit = new Set(
    sorted.map((r) => `${(r.quantity ?? "").trim()}|${(r.unit ?? "").trim()}`)
  );
  const strongEnoughForTechExtras =
    goodsInfoHasTwoDistinctClassificationCodes(sorted) || distinctQtyUnit.size >= 2;
  if (!strongEnoughForTechExtras) return null;
  const inj = injectiveStrictTechMatchIndices(sorted, techItems);
  if (!inj.ok) return null;
  return sorted;
}

function collapseTechBundleSameProductScheduleDuplicates(items: TenderAiGoodItem[]): {
  items: TenderAiGoodItem[];
  dropped: string[];
} {
  if (items.length < 2) return { items, dropped: [] };
  const dropped: string[] = [];
  const byKey = new Map<string, TenderAiGoodItem[]>();
  const orphans: TenderAiGoodItem[] = [];
  for (const g of items) {
    const k = normalizeGoodsInfoProductNameKey(g.name ?? "");
    if (k.length < 6) {
      orphans.push(g);
      continue;
    }
    const arr = byKey.get(k) ?? [];
    arr.push(g);
    byKey.set(k, arr);
  }
  const out: TenderAiGoodItem[] = [...orphans];
  for (const [, group] of byKey) {
    if (group.length < 2) {
      out.push(...group);
      continue;
    }
    const sched = group.filter((g) => techRowReadsLikeDeliveryOrScheduleSlice(g.name ?? ""));
    const normal = group.filter((g) => !techRowReadsLikeDeliveryOrScheduleSlice(g.name ?? ""));
    if (sched.length >= 1 && normal.length >= 1) {
      normal.sort(
        (a, b) =>
          (b.characteristics?.length ?? 0) - (a.characteristics?.length ?? 0) ||
          (b.name ?? "").length - (a.name ?? "").length
      );
      const keep = normal[0]!;
      out.push(keep);
      for (const g of group) {
        if (g !== keep) {
          dropped.push(
            `schedule_or_dup_same_product|${(g.name ?? "").slice(0, 72)}|hint=${(g.sourceHint ?? "").slice(0, 48)}`
          );
        }
      }
      continue;
    }
    out.push(...group);
  }
  return { items: out, dropped };
}

function dropAuxiliaryTechRowsWhenDualCodeGoodsInfoPresent(
  items: TenderAiGoodItem[],
  giPreStrip: TenderAiGoodItem[]
): { items: TenderAiGoodItem[]; dropped: string[] } {
  const giQtyKeys = new Set(giPreStrip.map((r) => `${(r.quantity ?? "").trim()}|${(r.unit ?? "").trim()}`));
  const strongGi =
    giPreStrip.length >= 2 &&
    goodsInfoRowsPassQualityGateForNoticeMerge(giPreStrip) &&
    (goodsInfoHasTwoDistinctClassificationCodes(giPreStrip) || giQtyKeys.size >= 2);
  if (items.length < 3 || !strongGi) {
    return { items, dropped: [] };
  }
  const dropped: string[] = [];
  const out = items.filter((g) => {
    if (!techRowLooksLikeMarkingOrAuxComplianceLine(g.name ?? "")) return true;
    dropped.push(
      `aux_marking_or_compliance|${(g.name ?? "").slice(0, 72)}|codes=${(g.codes ?? "").slice(0, 40)}|hint=${(g.sourceHint ?? "").slice(0, 48)}`
    );
    return false;
  });
  return { items: out, dropped };
}

function applyDeterministicPidEnrichmentToTechRows(
  baseItems: TenderAiGoodItem[],
  noticeRows: TenderAiGoodItem[]
): { items: TenderAiGoodItem[]; diag: string[] } {
  let cur = applyRegistryPidFromNoticeRowsByKtruSuffix([...baseItems], noticeRows, baseItems);
  const diag: string[] = [];
  const baseIndex = applyIndexAlignedNoticePositionIdFallback(cur, baseItems, noticeRows);
  cur = baseIndex.items;
  if (baseIndex.restored > 0) diag.push(`index_notice_position_id_restore=${baseIndex.restored}`);
  const baseCodeCluster = applyNoticePositionIdByExactCodesClusterFallback(cur, noticeRows);
  cur = baseCodeCluster.items;
  diag.push(`code_cluster_notice_position_id_restore=${baseCodeCluster.restored}`);
  const baseCodeQty = applyNoticePositionIdByExactCodeAndQuantityFallback(cur, noticeRows);
  cur = baseCodeQty.items;
  diag.push(`code_qty_notice_position_id_restore=${baseCodeQty.restored}`);
  const baseCodeQtyPrice = applyNoticePositionIdByExactCodeQuantityAndPriceFallback(cur, noticeRows);
  cur = baseCodeQtyPrice.items;
  diag.push(`code_qty_price_notice_position_id_restore=${baseCodeQtyPrice.restored}`);
  const baseBestMatch = applyControlledBestMatchNoticePidFallback(cur, noticeRows);
  cur = baseBestMatch.items;
  diag.push(`best_match_pid_restore=${baseBestMatch.restored}`);
  const canon067Strip = stripDuplicateRegistryPidFromConsecutiveCanon067hColorVariantRows(cur);
  cur = canon067Strip.items;
  if (canon067Strip.cleared > 0) diag.push(`strip_dup_pid_canon067h_variants=${canon067Strip.cleared}`);
  return { items: cur, diag };
}

/**
 * Иерархия источников: (A) авторитетный notice задаёт число позиций; (B) иначе строки ТЗ + детерминированное
 * обогащение п/п из notice без смены кардинальности; (C) иначе только notice или пусто (см. ensure после reconcile).
 */
export function enhanceTechSpecBundleWithNoticeRows(
  base: ExtractGoodsFromTechSpecResult | null,
  noticeItems: TenderAiGoodItem[]
): ExtractGoodsFromTechSpecResult | null {
  const techWeak = techBundleWeakForNoticeAuthority(base);
  const { rows: noticeForMerge, strippedGoodsInfo } = stripOptionalGoodsInfoNoticeRowsIfPolicy(base, noticeItems);
  const stripDiag = strippedGoodsInfo ? (["notice_goods_info_stripped_policy"] as const) : [];
  const techCount = base?.items?.length ?? 0;
  const giPreStrip = noticeItems.filter(isNoticeGoodsInfoBlockRow);
  const authorityGi = pickStrongGoodsInfoNoticeAuthority(giPreStrip, base?.items ?? [], techWeak);
  const authorityPf = pickAuthoritativeNoticeRowsForGoodsCardinality(noticeForMerge, techCount, techWeak);
  /**
   * Блок goods-info не должен «перебивать» ПФ, если в ПФ больше позиций, чем в ТЗ (Тенд31: 13 в ПФ vs 9 в приложении).
   * Иначе mergeGoodsInfoNoticeRowsOverTech режет кардинальность до числа строк goods-info.
   */
  const preferPfAuthority =
    !!authorityPf &&
    (techCount === 0 || authorityPf.length > techCount) &&
    (!authorityGi || authorityPf.length > authorityGi.length);
  const authority = preferPfAuthority ? authorityPf : authorityGi ?? authorityPf;
  const usedGoodsInfoAuthority = !preferPfAuthority && authorityGi != null && authority === authorityGi;

  if (authority && authority.length > 0) {
    const techItems = base?.items ?? [];
    const techBefore = techItems.length;
    const glueAuthorityCount = authorityPf?.filter(isNoticePrintFormTovarUnitQtyGlueRowWithoutProductTitle).length ?? 0;
    const authorityForMerge =
      authorityPf != null &&
      authority === authorityPf &&
      glueAuthorityCount > 0 &&
      authorityPf.length <= 8
        ? expandNoticePfAuthorityReplacingTovarGlueWithPoolRows(authorityPf, noticeForMerge)
        : authority;
    const merged =
      techItems.length > 0
        ? usedGoodsInfoAuthority
          ? mergeGoodsInfoNoticeRowsOverTech(authorityForMerge, techItems, noticeItems)
          : mergeTechAndNoticeDeterministicRows(techItems, authorityForMerge)
        : authorityForMerge;
    let items = usedGoodsInfoAuthority
      ? dedupeGoodsItemsByNormalizedNameAndQuantity(merged)
      : dedupeGoodsItemsByNormalizedNameAndQuantityPfCardinalityMerge(merged);
    const canon067Authority = stripDuplicateRegistryPidFromConsecutiveCanon067hColorVariantRows(items);
    items = canon067Authority.items;
    const sourceTag = usedGoodsInfoAuthority ? "notice_goods_info_injective" : "notice_print_form_table";
    const cardDiag: string[] = [
      `goods_source_hierarchy=notice_authority(n=${authority.length},${sourceTag})`,
      `goods_cardinality_audit source=${sourceTag} tech_before=${techBefore} notice_auth=${authority.length} after_merge=${items.length} reason=${usedGoodsInfoAuthority ? "goods_info_each_matched_distinct_tech_row" : "pf_rows_not_exceed_tech_or_weak_tech"}`
    ];
    if (usedGoodsInfoAuthority && authorityGi && techBefore > items.length) {
      const inj = injectiveStrictTechMatchIndices(authorityGi, techItems);
      if (inj.ok) {
        for (let i = 0; i < inj.techUsed.length; i++) {
          const j = inj.techUsed[i]!;
          cardDiag.push(
            `goods_cardinality_notice_tech_pair notice_line=${i} tech_idx=${j} tech_name=${(techItems[j]?.name ?? "").slice(0, 72)}`
          );
        }
        for (let j = 0; j < techBefore; j++) {
          if (!inj.techUsed.includes(j)) {
            cardDiag.push(
              `goods_cardinality_dropped_tech_row idx=${j} name=${(techItems[j]?.name ?? "").slice(0, 72)} hint=${(techItems[j]?.sourceHint ?? "").slice(0, 48)}`
            );
          }
        }
      }
    }
    const hierDiag = [
      ...cardDiag,
      ...stripDiag,
      ...(canon067Authority.cleared > 0 ? [`strip_dup_pid_canon067h_variants=${canon067Authority.cleared}`] : [])
    ];
    if (!base) {
      return {
        items,
        techBlockText: "",
        techSpecExtractedCount: items.length,
        diagnostics: [`notice_authority_rows=${items.length}`, ...hierDiag],
        parseAudit: {
          techSpecTableDetected: true,
          techSpecClusterCount: items.length,
          techSpecExtractedCount: items.length,
          techSpecRowsParsed: items.map((g) => g.name.slice(0, 80)),
          techSpecRowsRejected: [],
          rejectionReasons: [],
          finalRetainedFromTechSpecCount: items.length
        },
        strictTechCorpusChars: 0
      };
    }
    return {
      ...base,
      items,
      techSpecExtractedCount: items.length,
      diagnostics: [...base.diagnostics, ...hierDiag],
      parseAudit: {
        ...base.parseAudit,
        techSpecExtractedCount: items.length,
        finalRetainedFromTechSpecCount: items.length
      }
    };
  }

  if (base?.items?.length) {
    let items = dedupeGoodsItemsByNormalizedNameAndQuantity([...base.items]);
    const afterDedup = items.length;
    items = stripNonProductRequirementTechDeterministicRows(items);
    const afterNonProductStrip = items.length;
    const headerStrip = stripPluralAggregateClassHeaderTechDeterministicRows(items);
    items = headerStrip.items;
    const afterPluralHeaderStrip = items.length;
    const aux = dropAuxiliaryTechRowsWhenDualCodeGoodsInfoPresent(items, giPreStrip);
    items = aux.items;
    const afterAux = items.length;
    const sched = collapseTechBundleSameProductScheduleDuplicates(items);
    items = sched.items;
    const afterSched = items.length;
    const { items: enriched, diag } = applyDeterministicPidEnrichmentToTechRows(items, noticeForMerge);
    items = enriched;
    const techDiag: string[] = [
      "goods_source_hierarchy=tech_spec",
      `goods_cardinality_audit source=tech_spec after_dedupe=${afterDedup} after_non_product_req_strip=${afterNonProductStrip} after_plural_class_header_strip=${afterPluralHeaderStrip} after_aux_drop=${afterAux} after_schedule_collapse=${afterSched} after_pid_enrich=${items.length} reason=tech_spec_priority_no_short_notice_authority`
    ];
    if (afterNonProductStrip < afterDedup) {
      techDiag.push(
        "goods_tech_spec_strip=removed_non_product_requirement_lines (looksLikeNonProductRequirementLine, normal_peer+overlap_anchor, safe_unique_guard)"
      );
    }
    if (afterPluralHeaderStrip < afterNonProductStrip) {
      techDiag.push("goods_plural_class_header_strip=removed_duplicate_pid_aggregate_line");
    }
    for (const d of headerStrip.dropped) techDiag.push(`goods_plural_class_header|${d}`);
    for (const d of aux.dropped) techDiag.push(`goods_cardinality_aux_drop|${d}`);
    for (const d of sched.dropped) techDiag.push(`goods_cardinality_schedule_collapse|${d}`);
    return {
      ...base,
      items,
      diagnostics: [...base.diagnostics, ...techDiag, ...diag, ...stripDiag],
      parseAudit: {
        ...base.parseAudit,
        finalRetainedFromTechSpecCount: items.length
      }
    };
  }

  if (noticeForMerge.length >= 2) {
    const items = dedupeGoodsItemsByNormalizedNameAndQuantity(noticeForMerge);
    return {
      items,
      techBlockText: "",
      techSpecExtractedCount: items.length,
      diagnostics: [
        `notice_only_deterministic_rows=${items.length}`,
        "goods_source_hierarchy=notice_only",
        ...stripDiag
      ],
      parseAudit: {
        techSpecTableDetected: true,
        techSpecClusterCount: items.length,
        techSpecExtractedCount: items.length,
        techSpecRowsParsed: items.map((g) => g.name.slice(0, 80)),
        techSpecRowsRejected: [],
        rejectionReasons: [],
        finalRetainedFromTechSpecCount: items.length
      },
      strictTechCorpusChars: 0
    };
  }
  if (noticeForMerge.length === 1) {
    const g = noticeForMerge[0]!;
    return {
      items: [g],
      techBlockText: "",
      techSpecExtractedCount: 1,
      diagnostics: ["notice_only_deterministic_rows=1", "goods_source_hierarchy=notice_only", ...stripDiag],
      parseAudit: {
        techSpecTableDetected: true,
        techSpecClusterCount: 1,
        techSpecExtractedCount: 1,
        techSpecRowsParsed: [(g.name ?? "").slice(0, 80)],
        techSpecRowsRejected: [],
        rejectionReasons: [],
        finalRetainedFromTechSpecCount: 1
      },
      strictTechCorpusChars: 0
    };
  }

  return strippedGoodsInfo && base
    ? { ...base, diagnostics: [...base.diagnostics, ...stripDiag] }
    : base;
}

function allLogicalPathsFromSourceHint(h: string): string[] {
  const paths: string[] = [];
  for (const part of h.split(";").map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/\|lp:(.+)$/);
    const p = m?.[1]?.trim();
    if (p) paths.push(p);
  }
  if (paths.length === 0) {
    const m2 = h.match(/\|lp:([^|]+)/);
    const p2 = m2?.[1]?.trim();
    if (p2) paths.push(p2);
  }
  return paths;
}

function looksLikePrintedFormLogicalPath(lp: string): boolean {
  const x = lp.replace(/\\/g, "/").toLowerCase();
  return /печатн/i.test(x) || /\.pdf\b/i.test(x);
}

function looksLikeTechSpecDocLogicalPath(lp: string): boolean {
  const x = lp.replace(/\\/g, "/").toLowerCase();
  return (
    /тех\.\s*задан|техническ(?:ое|ая)\s+задан/i.test(x) ||
    /тз[\s._-]/i.test(x) ||
    /\.docx\b/i.test(x)
  );
}

/** Буквы+цифры вроде CF259X, TK-1170, 067H. */
function hasProductModelToken(name: string): boolean {
  const t = name.replace(/\s+/g, " ");
  return /\b(?:[A-Z]{1,4}\d{2,}[A-Z0-9]*|TK-\d+|TN-\d+|CF\d+[A-Z]*|CE\d+[A-Z]*|\d{2,3}H\b|W\d{4}[A-Z]*)\b/i.test(
    t
  );
}

function normAuthorityMergePid(s: string): string {
  return (s ?? "").replace(/^№\s*/i, "").replace(/\s/g, "").trim();
}

function poolPickScoreForPfAuthorityFill(g: TenderAiGoodItem): number {
  const n = (g.name ?? "").trim();
  let s = Math.min(n.length, 240);
  if (/^значение\s+характеристик/i.test(n)) s -= 35;
  if (hasProductModelToken(n)) s += 40;
  if (isNoticePrintFormRow(g)) s += 12;
  return s;
}

/**
 * В authority ПФ строки «ТоварШтука»+число с тем же registry id, что у нормальной строки, не являются отдельной
 * позицией; если после отброса glue остаётся «дыра» по id, подставляем лучшую не-glue строку из полного пула notice.
 */
function expandNoticePfAuthorityReplacingTovarGlueWithPoolRows(
  authorityPf: TenderAiGoodItem[],
  noticePool: TenderAiGoodItem[]
): TenderAiGoodItem[] {
  const bestNonGlueByPid = new Map<string, TenderAiGoodItem>();
  for (const g of noticePool) {
    const p = normAuthorityMergePid(g.positionId ?? "");
    if (!p || !isRegistryStylePositionId(p)) continue;
    if (isNoticePrintFormTovarUnitQtyGlueRowWithoutProductTitle(g)) continue;
    const prev = bestNonGlueByPid.get(p);
    if (!prev || poolPickScoreForPfAuthorityFill(g) > poolPickScoreForPfAuthorityFill(prev)) {
      bestNonGlueByPid.set(p, g);
    }
  }
  const out: TenderAiGoodItem[] = [];
  const havePid = new Set<string>();
  for (const g of authorityPf) {
    if (isNoticePrintFormTovarUnitQtyGlueRowWithoutProductTitle(g)) continue;
    out.push(g);
    const p = normAuthorityMergePid(g.positionId ?? "");
    if (p && isRegistryStylePositionId(p)) havePid.add(p);
  }
  for (const g of authorityPf) {
    if (!isNoticePrintFormTovarUnitQtyGlueRowWithoutProductTitle(g)) continue;
    const p = normAuthorityMergePid(g.positionId ?? "");
    if (!p || !isRegistryStylePositionId(p) || havePid.has(p)) continue;
    const rep = bestNonGlueByPid.get(p);
    if (rep) {
      const glue = authorityPf.find(
        (x) =>
          isNoticePrintFormTovarUnitQtyGlueRowWithoutProductTitle(x) &&
          normAuthorityMergePid(x.positionId ?? "") === p
      );
      const withChars =
        (rep.characteristics?.length ?? 0) > 0
          ? rep
          : glue && (glue.characteristics?.length ?? 0) > 0
            ? { ...rep, characteristics: glue.characteristics }
            : rep;
      out.push({ ...withChars });
      havePid.add(p);
    }
  }
  return out.length > 0 ? out : [...authorityPf];
}

function normalizeUnitComparable(u: string): string {
  const x = u.trim().toLowerCase().replace(/\./g, "").replace(/\s+/g, "");
  if (!x) return "шт";
  if (x.startsWith("шт") || x.startsWith("ед")) return "шт";
  return x;
}

function normalizedQuantityComparableKey(g: TenderAiGoodItem): string {
  let numStr = "";
  if (g.quantityValue != null && Number.isFinite(g.quantityValue)) {
    numStr = formatQuantityValueForStorage(g.quantityValue);
  } else {
    const qRaw = (g.quantity ?? "").trim().replace(/\s/g, "").replace(",", ".");
    const n = parseDeterministicQuantityNumberFragment(qRaw);
    numStr = n != null ? formatQuantityValueForStorage(n) : qRaw;
  }
  const u = normalizeUnitComparable(g.quantityUnit || g.unit || "");
  return `${numStr}|${u}`;
}

function quantityComparableKeyIsUsable(g: TenderAiGoodItem): boolean {
  if (g.quantityValue != null && Number.isFinite(g.quantityValue)) return true;
  const qRaw = (g.quantity ?? "").trim().replace(/\s/g, "").replace(",", ".");
  return parseDeterministicQuantityNumberFragment(qRaw) != null;
}

function codesCompatible(rich: TenderAiGoodItem, poor: TenderAiGoodItem): boolean {
  const a = (rich.codes ?? "").replace(/\s/g, "").toLowerCase();
  const b = (poor.codes ?? "").replace(/\s/g, "").toLowerCase();
  if (a && b) return a === b || a.includes(b) || b.includes(a);
  if (!a && !b) return true;
  const filled = a || b;
  return filled.length >= 8 && /^[\d.]/.test(filled);
}

function foldNameForIndexPid(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Узкая проверка «та же товарная строка» по индексу: префикс наименования или общий модельный токен.
 * При сомнении — false (не подставлять pid).
 */
const MODEL_TOKENS_FOR_INDEX_PID_RESTORE_RE =
  /\b(?:CF|CE|CB|CC|TK-|TN-|W\d{4}|006R\d{5,}|008R\d{5,}|101R\d{5,}|106R\d{5,}|108R\d{5,}|113R\d{5,}|842\d{3})\w*\b/gi;

/** Только для index fallback: одинаковый класс позиции при уже совпавших codes (Тенд32 / ПФ). */
const CARTRIDGE_FAMILY_FOR_INDEX_PID_RESTORE_RE = /(?:картридж|тонер|барабан)/i;

function longTokenSetForIndexPidRestore(raw: string): Set<string> {
  const out = new Set<string>();
  for (const m of raw.toLowerCase().matchAll(/[\p{L}\p{N}]{2,}(?:-[\p{L}\p{N}]{2,})?/gu)) {
    const x = m[0]!;
    if (x.length > 5 && !/^\d+$/u.test(x)) out.add(x);
  }
  return out;
}

function namesLooselyCompatibleForIndexNoticePidRestore(techName: string, noticeName: string): boolean {
  const a = foldNameForIndexPid(techName);
  const b = foldNameForIndexPid(noticeName);
  const head = (x: string) => x.slice(0, Math.min(28, x.length));
  if (a.length >= 10 && b.length >= 10 && (a.includes(head(b)) || b.includes(head(a)))) return true;

  const ta = techName.toUpperCase();
  const tb = noticeName.toUpperCase();
  const toksA = [...ta.matchAll(MODEL_TOKENS_FOR_INDEX_PID_RESTORE_RE)].map((m) => m[0]!);
  for (const tok of toksA) {
    if (tb.includes(tok)) return true;
  }
  const toksB = [...tb.matchAll(MODEL_TOKENS_FOR_INDEX_PID_RESTORE_RE)].map((m) => m[0]!);
  for (const tok of toksB) {
    if (ta.includes(tok)) return true;
  }

  const la = longTokenSetForIndexPidRestore(techName);
  for (const x of longTokenSetForIndexPidRestore(noticeName)) {
    if (la.has(x)) return true;
  }

  if (
    CARTRIDGE_FAMILY_FOR_INDEX_PID_RESTORE_RE.test(techName) &&
    CARTRIDGE_FAMILY_FOR_INDEX_PID_RESTORE_RE.test(noticeName)
  ) {
    return true;
  }
  return false;
}

/**
 * Fallback: при tech.length === notice.length >= 10 подставить реестровый positionId из notice по индексу i,
 * если у tech пусто, у merged пусто, строки согласованы по codes/name. Не меняет codes/qty/остальное.
 *
 * Если у ni[i] пустой pid, смотрим только ni[i±1] (Тенд32: id на соседней строке ПФ).
 */
function applyIndexAlignedNoticePositionIdFallback(
  merged: TenderAiGoodItem[],
  techItems: TenderAiGoodItem[],
  noticeItems: TenderAiGoodItem[]
): { items: TenderAiGoodItem[]; restored: number } {
  const nTech = techItems.length;
  if (nTech !== noticeItems.length || nTech < 10 || merged.length !== nTech) {
    return { items: merged, restored: 0 };
  }
  const sortBoth = allShortPositionIds(techItems) && allShortPositionIds(noticeItems);
  const ti = sortBoth
    ? [...techItems].sort((a, b) => positionSortKey(a) - positionSortKey(b))
    : [...techItems];
  const ni = sortBoth
    ? [...noticeItems].sort((a, b) => positionSortKey(a) - positionSortKey(b))
    : [...noticeItems];

  let restored = 0;
  const out = merged.map((row, i) => {
    const t = ti[i]!;
    const n = ni[i]!;
    const pidM = (row.positionId ?? "").replace(/\s/g, "").trim();
    const pidT = (t.positionId ?? "").replace(/\s/g, "").trim();
    if (hasAuthoritativeRegistryPositionId(pidM)) return row;
    if (hasAuthoritativeRegistryPositionId(pidT)) return row;

    let pidN = (n.positionId ?? "").replace(/\s/g, "").trim();
    let nForPid: TenderAiGoodItem = n;
    if (!pidN) {
      for (const dj of [-1, 1]) {
        const j = i + dj;
        if (j < 0 || j >= ni.length) continue;
        const nx = ni[j]!;
        const p = (nx.positionId ?? "").replace(/\s/g, "").trim();
        if (!p || !isRegistryStylePositionId(p)) continue;
        if (!codesCompatible(t, nx)) continue;
        pidN = p;
        nForPid = nx;
        break;
      }
    }

    if (!pidN) return row;
    /** Короткие п/п вроде «1» по индексу не переносим — высокий риск неверной привязки. */
    if (!isRegistryStylePositionId(pidN)) return row;
    if (!codesCompatible(t, nForPid)) return row;
    if (!namesLooselyCompatibleForIndexNoticePidRestore(t.name ?? "", nForPid.name ?? "")) return row;
    restored++;
    const byOrder = "matched_by_order" as const satisfies PositionIdMatchConfidence;
    return { ...row, positionId: pidN, positionIdMatchConfidence: byOrder };
  });
  return { items: out, restored };
}

function normalizeClusterCodeKey(seg: string): string {
  return seg.replace(/\s/g, "").toLowerCase();
}

/** Уникальные сегменты поля codes (разделитель «;»), ключ для карты — нормализованный код с суффиксом КТРУ. */
function uniqueCodeSegmentsFromCodesField(codes: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of (codes ?? "").split(";")) {
    const seg = raw.trim();
    if (!seg) continue;
    const k = normalizeClusterCodeKey(seg);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(seg);
  }
  return out;
}

function buildNoticeCodeKeyToRowsWithRegistryPid(
  noticeItems: TenderAiGoodItem[]
): Map<string, TenderAiGoodItem[]> {
  const map = new Map<string, TenderAiGoodItem[]>();
  for (const n of noticeItems) {
    const pid = (n.positionId ?? "").replace(/\s/g, "").trim();
    if (!pid || !isRegistryStylePositionId(pid)) continue;
    for (const seg of uniqueCodeSegmentsFromCodesField(n.codes ?? "")) {
      const k = normalizeClusterCodeKey(seg);
      if (!k) continue;
      const arr = map.get(k) ?? [];
      if (!arr.includes(n)) arr.push(n);
      map.set(k, arr);
    }
  }
  return map;
}

/**
 * Fallback после index: для строк tech_spec_deterministic без реестрового pid (в т.ч. короткий п/п из ТЗ)
 * — один notice-ряд с тем же сегментом codes (точное совпадение нормализованного ключа). Без индекса, имён и fuzzy.
 */
function applyNoticePositionIdByExactCodesClusterFallback(
  items: TenderAiGoodItem[],
  noticeItems: TenderAiGoodItem[]
): { items: TenderAiGoodItem[]; restored: number } {
  if (noticeItems.length < 2) return { items, restored: 0 };
  const map = buildNoticeCodeKeyToRowsWithRegistryPid(noticeItems);
  let restored = 0;
  const out = items.map((row) => {
    const pidCur = (row.positionId ?? "").replace(/\s/g, "").trim();
    if (hasAuthoritativeRegistryPositionId(pidCur)) return row;
    if (!(row.sourceHint ?? "").toLowerCase().includes("tech_spec_deterministic")) return row;

    const segments = uniqueCodeSegmentsFromCodesField(row.codes ?? "");
    if (segments.length === 0) return row;

    const matchedPids = new Map<string, TenderAiGoodItem>();
    let hadMatch = false;

    for (const seg of segments) {
      const arr = map.get(normalizeClusterCodeKey(seg)) ?? [];
      if (arr.length === 0) continue;
      if (arr.length > 1) return row;
      const n = arr[0]!;
      const p = (n.positionId ?? "").replace(/\s/g, "").trim();
      if (!isRegistryStylePositionId(p)) return row;
      hadMatch = true;
      matchedPids.set(p, n);
    }

    if (!hadMatch || matchedPids.size !== 1) return row;
    const pid = [...matchedPids.keys()][0]!;
    restored++;
    return { ...row, positionId: pid };
  });
  return { items: out, restored };
}

function buildNoticeCodeAndQuantityKeyToRowsWithRegistryPid(
  noticeItems: TenderAiGoodItem[]
): Map<string, TenderAiGoodItem[]> {
  const map = new Map<string, TenderAiGoodItem[]>();
  for (const n of noticeItems) {
    const pid = (n.positionId ?? "").replace(/\s/g, "").trim();
    if (!pid || !isRegistryStylePositionId(pid)) continue;
    if (!quantityComparableKeyIsUsable(n)) continue;
    const qk = normalizedQuantityComparableKey(n);
    for (const seg of uniqueCodeSegmentsFromCodesField(n.codes ?? "")) {
      const ck = normalizeClusterCodeKey(seg);
      if (!ck) continue;
      const key = `${ck}|${qk}`;
      const arr = map.get(key) ?? [];
      if (!arr.includes(n)) arr.push(n);
      map.set(key, arr);
    }
  }
  return map;
}

/**
 * Fallback после code cluster: пустой pid + tech_spec_deterministic; совпадение сегмента codes и quantity
 * с ровно одной notice-строкой с реестровым pid. Только чтение/сравнение quantity, поля не меняются.
 */
function applyNoticePositionIdByExactCodeAndQuantityFallback(
  items: TenderAiGoodItem[],
  noticeItems: TenderAiGoodItem[]
): { items: TenderAiGoodItem[]; restored: number } {
  if (noticeItems.length < 2) return { items, restored: 0 };
  const map = buildNoticeCodeAndQuantityKeyToRowsWithRegistryPid(noticeItems);
  let restored = 0;
  const out = items.map((row) => {
    const pidCur = (row.positionId ?? "").replace(/\s/g, "").trim();
    if (hasAuthoritativeRegistryPositionId(pidCur)) return row;
    if (!(row.sourceHint ?? "").toLowerCase().includes("tech_spec_deterministic")) return row;
    if (!quantityComparableKeyIsUsable(row)) return row;

    const segments = uniqueCodeSegmentsFromCodesField(row.codes ?? "");
    if (segments.length === 0) return row;

    const qtyKey = normalizedQuantityComparableKey(row);
    const matchedPids = new Map<string, TenderAiGoodItem>();
    let hadMatch = false;

    for (const seg of segments) {
      const ck = normalizeClusterCodeKey(seg);
      const lookupKey = `${ck}|${qtyKey}`;
      const arr = map.get(lookupKey) ?? [];
      if (arr.length === 0) continue;
      if (arr.length > 1) return row;
      const n = arr[0]!;
      const p = (n.positionId ?? "").replace(/\s/g, "").trim();
      if (!isRegistryStylePositionId(p)) return row;
      hadMatch = true;
      matchedPids.set(p, n);
    }

    if (!hadMatch || matchedPids.size !== 1) return row;
    const pid = [...matchedPids.keys()][0]!;
    restored++;
    return { ...row, positionId: pid };
  });
  return { items: out, restored };
}

/** Сравнение lineTotal / unitPrice без эвристик: только пробелы и запятая как десятичный разделитель. */
function normalizedPriceComparableKeyForNoticePidRestore(g: TenderAiGoodItem): string | null {
  const lt = (g.lineTotal ?? "").replace(/\s/g, "").replace(",", ".").trim().toLowerCase();
  if (lt) return `lt|${lt}`;
  const up = (g.unitPrice ?? "").replace(/\s/g, "").replace(",", ".").trim().toLowerCase();
  if (up) return `up|${up}`;
  return null;
}

function buildNoticeCodeQuantityAndPriceKeyToRowsWithRegistryPid(
  noticeItems: TenderAiGoodItem[]
): Map<string, TenderAiGoodItem[]> {
  const map = new Map<string, TenderAiGoodItem[]>();
  for (const n of noticeItems) {
    const pid = (n.positionId ?? "").replace(/\s/g, "").trim();
    if (!pid || !isRegistryStylePositionId(pid)) continue;
    if (!quantityComparableKeyIsUsable(n)) continue;
    const pk = normalizedPriceComparableKeyForNoticePidRestore(n);
    if (!pk) continue;
    const qk = normalizedQuantityComparableKey(n);
    for (const seg of uniqueCodeSegmentsFromCodesField(n.codes ?? "")) {
      const ck = normalizeClusterCodeKey(seg);
      if (!ck) continue;
      const key = `${ck}|${qk}|${pk}`;
      const arr = map.get(key) ?? [];
      if (!arr.includes(n)) arr.push(n);
      map.set(key, arr);
    }
  }
  return map;
}

/**
 * Fallback после code+qty: пустой pid + tech_spec_deterministic; совпадение сегмента codes, quantity и
 * lineTotal (иначе unitPrice) с ровно одной notice-строкой с реестровым pid. Ценовые поля не меняются.
 */
function applyNoticePositionIdByExactCodeQuantityAndPriceFallback(
  items: TenderAiGoodItem[],
  noticeItems: TenderAiGoodItem[]
): { items: TenderAiGoodItem[]; restored: number } {
  if (noticeItems.length < 2) return { items, restored: 0 };
  const map = buildNoticeCodeQuantityAndPriceKeyToRowsWithRegistryPid(noticeItems);
  let restored = 0;
  const out = items.map((row) => {
    const pidCur = (row.positionId ?? "").replace(/\s/g, "").trim();
    if (hasAuthoritativeRegistryPositionId(pidCur)) return row;
    if (!(row.sourceHint ?? "").toLowerCase().includes("tech_spec_deterministic")) return row;
    if (!quantityComparableKeyIsUsable(row)) return row;
    const pk = normalizedPriceComparableKeyForNoticePidRestore(row);
    if (!pk) return row;

    const segments = uniqueCodeSegmentsFromCodesField(row.codes ?? "");
    if (segments.length === 0) return row;

    const qtyKey = normalizedQuantityComparableKey(row);
    const matchedPids = new Map<string, TenderAiGoodItem>();
    let hadMatch = false;

    for (const seg of segments) {
      const ck = normalizeClusterCodeKey(seg);
      const lookupKey = `${ck}|${qtyKey}|${pk}`;
      const arr = map.get(lookupKey) ?? [];
      if (arr.length === 0) continue;
      if (arr.length > 1) return row;
      const n = arr[0]!;
      const p = (n.positionId ?? "").replace(/\s/g, "").trim();
      if (!isRegistryStylePositionId(p)) return row;
      hadMatch = true;
      matchedPids.set(p, n);
    }

    if (!hadMatch || matchedPids.size !== 1) return row;
    const pid = [...matchedPids.keys()][0]!;
    restored++;
    return { ...row, positionId: pid };
  });
  return { items: out, restored };
}

function noticeSharesExactCodeSegmentWithBestMatchRow(row: TenderAiGoodItem, notice: TenderAiGoodItem): boolean {
  const keys = new Set(
    uniqueCodeSegmentsFromCodesField(row.codes ?? "").map((s) => normalizeClusterCodeKey(s)).filter(Boolean)
  );
  if (keys.size === 0) return false;
  for (const seg of uniqueCodeSegmentsFromCodesField(notice.codes ?? "")) {
    const k = normalizeClusterCodeKey(seg);
    if (k && keys.has(k)) return true;
  }
  return false;
}

function hasSharedModelTokenForBestMatchPidRestore(techName: string, noticeName: string): boolean {
  const ta = techName.toUpperCase();
  const tb = noticeName.toUpperCase();
  const fromA = new Set<string>();
  for (const m of ta.matchAll(MODEL_TOKENS_FOR_INDEX_PID_RESTORE_RE)) {
    fromA.add(m[0]!.toUpperCase());
  }
  if (fromA.size === 0) return false;
  for (const m of tb.matchAll(MODEL_TOKENS_FOR_INDEX_PID_RESTORE_RE)) {
    if (fromA.has(m[0]!.toUpperCase())) return true;
  }
  return false;
}

function scoreNoticeForControlledBestMatchPidRestore(tech: TenderAiGoodItem, notice: TenderAiGoodItem): number {
  let s = 0;
  if (
    quantityComparableKeyIsUsable(tech) &&
    quantityComparableKeyIsUsable(notice) &&
    normalizedQuantityComparableKey(tech) === normalizedQuantityComparableKey(notice)
  ) {
    s += 3;
  }
  const pt = normalizedPriceComparableKeyForNoticePidRestore(tech);
  const pn = normalizedPriceComparableKeyForNoticePidRestore(notice);
  if (pt && pn && pt === pn) s += 3;
  if (hasSharedModelTokenForBestMatchPidRestore(tech.name ?? "", notice.name ?? "")) s += 2;
  if (
    CARTRIDGE_FAMILY_FOR_INDEX_PID_RESTORE_RE.test(tech.name ?? "") &&
    CARTRIDGE_FAMILY_FOR_INDEX_PID_RESTORE_RE.test(notice.name ?? "")
  ) {
    s += 1;
  }
  return s;
}

/**
 * После строгих fallback: пустой pid + tech_spec_deterministic; кандидаты из notice с тем же сегментом codes
 * и реестровым pid; выбор по score при пороге и зазоре от второго места.
 */
function applyControlledBestMatchNoticePidFallback(
  items: TenderAiGoodItem[],
  noticeItems: TenderAiGoodItem[]
): { items: TenderAiGoodItem[]; restored: number } {
  if (noticeItems.length < 1) return { items, restored: 0 };
  let restored = 0;
  const out = items.map((row) => {
    const pidCur = (row.positionId ?? "").replace(/\s/g, "").trim();
    if (hasAuthoritativeRegistryPositionId(pidCur)) return row;
    if (!(row.sourceHint ?? "").toLowerCase().includes("tech_spec_deterministic")) return row;

    const scored: { notice: TenderAiGoodItem; score: number }[] = [];
    const seen = new Set<TenderAiGoodItem>();
    for (const n of noticeItems) {
      const p = (n.positionId ?? "").replace(/\s/g, "").trim();
      if (!p || !isRegistryStylePositionId(p)) continue;
      if (!noticeSharesExactCodeSegmentWithBestMatchRow(row, n)) continue;
      if (seen.has(n)) continue;
      seen.add(n);
      scored.push({ notice: n, score: scoreNoticeForControlledBestMatchPidRestore(row, n) });
    }
    if (scored.length === 0) return row;

    scored.sort((a, b) => b.score - a.score);
    const top = scored[0]!;
    if (top.score < 5) return row;
    if (scored.length >= 2 && scored[1]!.score === top.score) return row;
    const second = scored.length >= 2 ? scored[1]!.score : 0;
    if (top.score - second < 2) return row;

    const pid = (top.notice.positionId ?? "").replace(/\s/g, "").trim();
    if (!isRegistryStylePositionId(pid)) return row;
    restored++;
    return { ...row, positionId: pid };
  });
  return { items: out, restored };
}

/** «Картридж для» из ПФ без модели — заголовок-фантом; число часто тянется из ресурса/цены, не из объёма закупки. */
function isExtremelyGenericCartridgeHeading(name: string): boolean {
  const t = name.trim();
  return /^картридж\s+для\.?$/i.test(t) || (t.length <= 18 && /^картридж\s+для\b/i.test(t));
}

function poorQuantityLooksMisextracted(poor: TenderAiGoodItem): boolean {
  const v = poor.quantityValue;
  if (v != null && Number.isFinite(v) && v >= 100) return true;
  const q = (poor.quantity ?? "").trim().replace(/\s/g, "").replace(",", ".");
  const n = parseDeterministicQuantityNumberFragment(q);
  return n != null && n >= 100;
}

function richnessScore(g: TenderAiGoodItem): number {
  const name = (g.name ?? "").trim();
  let s = Math.min(name.length / 22, 5);
  if (/или\s+эквивалент|или\s+аналог/i.test(name)) s += 4;
  if (hasProductModelToken(name)) s += 3;
  s += Math.min((g.characteristics?.length ?? 0) * 0.45, 8);
  if ((g.codes ?? "").trim().length >= 10) s += 0.5;
  return s;
}

/** Строка из ПФ: короткое «Картридж …» без модели и без «или эквивалент». */
function isPoorPrintedFormDuplicateCandidate(item: TenderAiGoodItem): boolean {
  const name = (item.name ?? "").trim().replace(/\s+/g, " ");
  if (!name) return false;
  if (/или\s+эквивалент|или\s+аналог/i.test(name)) return false;
  if (hasProductModelToken(name)) return false;
  const lps = allLogicalPathsFromSourceHint(item.sourceHint ?? "");
  if (!lps.some(looksLikePrintedFormLogicalPath)) return false;
  // \b в JS только для ASCII — для кириллицы «Картридж для» граница не срабатывает.
  if (!/^картридж\s/i.test(name)) return false;
  if (name.length > 80) return false;
  return true;
}

/** Более полная позиция (ТЗ.docx или явная модельная формулировка). */
function isLikelyRichTechSpecCounterpart(item: TenderAiGoodItem): boolean {
  const name = (item.name ?? "").trim();
  const lps = allLogicalPathsFromSourceHint(item.sourceHint ?? "");
  if (lps.some(looksLikeTechSpecDocLogicalPath)) return true;
  if (/или\s+эквивалент|или\s+аналог/i.test(name)) return true;
  return hasProductModelToken(name) && name.length >= 18;
}

const RICH_DOMINANCE_MARGIN = 1.5;

/** Реестровый id в строке ПФ до снятия дублей: переносим на полную строку ТЗ (qty или «фантомный» qty у ПФ). */
function transferRegistryPositionIdsFromPoorPdfRowsBeforeCrossDedupe(items: TenderAiGoodItem[]): void {
  const usedPoor = new Set<number>();
  for (let j = 0; j < items.length; j++) {
    const rich = items[j]!;
    if (!isLikelyRichTechSpecCounterpart(rich)) continue;
    const rPid = (rich.positionId ?? "").replace(/\s/g, "").trim();
    if (rPid && isRegistryStylePositionId(rPid)) continue;
    if (rPid) continue;
    if (!quantityComparableKeyIsUsable(rich)) continue;
    const rk = normalizedQuantityComparableKey(rich);
    for (let i = 0; i < items.length; i++) {
      if (i === j || usedPoor.has(i)) continue;
      const poor = items[i]!;
      if (!isPoorPrintedFormDuplicateCandidate(poor)) continue;
      const skipQty =
        isExtremelyGenericCartridgeHeading(poor.name) && poorQuantityLooksMisextracted(poor);
      if (!skipQty) {
        if (!quantityComparableKeyIsUsable(poor)) continue;
        if (normalizedQuantityComparableKey(poor) !== rk) continue;
      }
      const codesOk =
        codesCompatible(rich, poor) ||
        (!(rich.codes ?? "").trim() &&
          !(poor.codes ?? "").trim() &&
          /картридж/i.test(rich.name ?? "") &&
          /картридж/i.test(poor.name ?? ""));
      if (!codesOk) continue;
      let poorPid = (poor.positionId ?? "").replace(/\s/g, "").trim();
      if (!isRegistryStylePositionId(poorPid)) {
        const blob = `${poor.name ?? ""} ${poor.codes ?? ""}`;
        poorPid = REGISTRY_POSITION_ID_CAPTURE_RE.exec(blob)?.[1] ?? "";
      }
      if (!isRegistryStylePositionId(poorPid)) continue;
      items[j]!.positionId = poorPid;
      usedPoor.add(i);
      break;
    }
  }
}

/**
 * Удаляет дубликаты между ПФ (PDF) и ТЗ: оставляет более информативную строку при совпадении количества и кодов.
 */
export function dedupeCrossSourceTechSpecGoodsItems(items: TenderAiGoodItem[]): {
  items: TenderAiGoodItem[];
  diagnostics: string[];
} {
  if (items.length < 2) return { items, diagnostics: [] };

  transferRegistryPositionIdsFromPoorPdfRowsBeforeCrossDedupe(items);

  const drop = new Set<number>();
  for (let i = 0; i < items.length; i++) {
    const poor = items[i]!;
    if (!isPoorPrintedFormDuplicateCandidate(poor)) continue;
    const poorScore = richnessScore(poor);
    const skipQtyBecausePhantom =
      isExtremelyGenericCartridgeHeading(poor.name) && poorQuantityLooksMisextracted(poor);
    if (!skipQtyBecausePhantom && !quantityComparableKeyIsUsable(poor)) continue;
    const poorKey = normalizedQuantityComparableKey(poor);

    for (let j = 0; j < items.length; j++) {
      if (i === j) continue;
      const rich = items[j]!;
      if (!isLikelyRichTechSpecCounterpart(rich)) continue;
      if (!skipQtyBecausePhantom) {
        if (!quantityComparableKeyIsUsable(rich)) continue;
        if (normalizedQuantityComparableKey(rich) !== poorKey) continue;
      }
      if (!codesCompatible(rich, poor)) continue;
      if (richnessScore(rich) <= poorScore + RICH_DOMINANCE_MARGIN) continue;
      drop.add(i);
      break;
    }
  }

  if (drop.size === 0) return { items, diagnostics: [] };

  const out = items.filter((_, i) => !drop.has(i));
  return {
    items: out,
    diagnostics: [`cross_source_position_dedupe:dropped=${drop.size}`]
  };
}

/** Сначала хвост закупки в конце, затем сужение перегруженной строки, затем очень длинные смешанные (без смены числа позиций). */
function mapPostDedupeNameCleaning(before: TenderAiGoodItem[]): TenderAiGoodItem[] {
  return before.map((g) => {
    const n = polishGoodsDisplayName(g.name);
    return n === (g.name ?? "") ? g : { ...g, name: n };
  });
}

const GOODS_NAME_TAIL_TRIM_DIAG =
  "goods_name_post_dedupe_clean=procurement_tail_trim_then_mixed_product_head";

/**
 * После merge ТЗ+notice: снять `positionId`, если id во всём маскированном корпусе встречается
 * только внутри денежной склейки `КТРУ…ТоварШтука…` (ложный `20…`, Тенд32).
 */
export function stripGlueOnlyRegistryPositionIdsFromTechSpecBundle(
  bundle: ExtractGoodsFromTechSpecResult | null,
  maskedFullCorpus: string
): ExtractGoodsFromTechSpecResult | null {
  if (!bundle?.items.length || !maskedFullCorpus.trim()) return bundle;
  let stripped = 0;
  const items = bundle.items.map((g) => {
    const p = (g.positionId ?? "").replace(/\s/g, "").trim();
    if (!p || !registryPidOccursOnlyInTovarShtukaPriceGlueCorpus(maskedFullCorpus, p)) return g;
    stripped++;
    return { ...g, positionId: "" };
  });
  if (stripped === 0) return bundle;
  return {
    ...bundle,
    items,
    diagnostics: [...bundle.diagnostics, `strip_glue_only_registry_pid_post_merge=${stripped}`],
    parseAudit: {
      ...bundle.parseAudit,
      techSpecExtractedCount: items.length,
      finalRetainedFromTechSpecCount: items.length,
      techSpecRowsParsed: items.map((g) => (g.name ?? "").slice(0, 80))
    }
  };
}

export function dedupeTechSpecBundleCrossSource(
  bundle: ExtractGoodsFromTechSpecResult | null
): ExtractGoodsFromTechSpecResult | null {
  if (!bundle) return bundle;

  const patchParseAudit = (rows: TenderAiGoodItem[]) => ({
    ...bundle.parseAudit,
    techSpecExtractedCount: rows.length,
    finalRetainedFromTechSpecCount: rows.length,
    techSpecRowsParsed: rows.map((g) => (g.name ?? "").slice(0, 80))
  });

  if (bundle.items.length < 2) {
    const before = bundle.items;
    let rows = mapPostDedupeNameCleaning(before);
    const canon067 = stripDuplicateRegistryPidFromConsecutiveCanon067hColorVariantRows(rows);
    rows = canon067.items;
    const tailChanged = rows.some((g, i) => (g.name ?? "") !== (before[i]!.name ?? ""));
    if (!tailChanged && canon067.cleared === 0) return bundle;
    return {
      ...bundle,
      items: rows,
      techSpecExtractedCount: rows.length,
      diagnostics: [
        ...bundle.diagnostics,
        ...(tailChanged ? [GOODS_NAME_TAIL_TRIM_DIAG] : []),
        ...(canon067.cleared > 0 ? [`tech_bundle_strip_dup_pid_canon067h_variants=${canon067.cleared}`] : [])
      ],
      parseAudit: patchParseAudit(rows)
    };
  }

  const { items: deduped, diagnostics: dd } = dedupeCrossSourceTechSpecGoodsItems(bundle.items);
  let rows = mapPostDedupeNameCleaning(deduped);
  const canon067Main = stripDuplicateRegistryPidFromConsecutiveCanon067hColorVariantRows(rows);
  rows = canon067Main.items;
  const tailChanged = rows.some((g, i) => (g.name ?? "") !== (deduped[i]!.name ?? ""));

  if (dd.length === 0 && !tailChanged && canon067Main.cleared === 0) return bundle;

  return {
    ...bundle,
    items: rows,
    techSpecExtractedCount: rows.length,
    diagnostics: [
      ...bundle.diagnostics,
      ...(tailChanged ? [GOODS_NAME_TAIL_TRIM_DIAG] : []),
      ...dd,
      ...(canon067Main.cleared > 0 ? [`tech_bundle_strip_dup_pid_canon067h_variants=${canon067Main.cleared}`] : [])
    ],
    parseAudit: patchParseAudit(rows)
  };
}
