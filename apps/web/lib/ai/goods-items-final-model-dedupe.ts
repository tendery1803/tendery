/**
 * Пост-обработка финального списка goodsItems: одна позиция на модель (rich vs rich-lite),
 * удаление generic-строк ПФ при **достаточном** наборе модельных доказательств.
 *
 * ## Класс документов (архив `samples/tenders-batch/Тендеры/*`)
 * Типичный кейс: **ТЗ (docx) с модельными наименованиями** + **ПФ (pdf) с общими строками**
 * («Картридж для…», «…электрографических…»), дубли rich/rich-lite/generic между источниками,
 * иногда вертикальная вёрстка количества в ЕИС (разбирается **раньше**, в extract-goods / quantity).
 *
 * Этот слой **не** включает backbone/quantity/cross-source — только финальный список после reconcile:
 * - **Модельный дедуп**: один ключ `extractModelTokens` → одна строка с лучшим quality score.
 * - **Generic PF cleanup**: только если есть ≥2 различных модельных ключа **или** ≥1 «сильная»
 *   модельная строка (эквивалент/аналог, ≥2 характеристик, tech_spec qty, либо высокий score);
 *   иначе cleanup пропускается (защита от переудаления при одной слабой строке).
 *
 * См. также: `dedupeTechSpecBundleCrossSource` (cross-source в бандле ТЗ),
 * `shouldReconcileViaTechSpecRowsFirst` / `mergeFallbackLenient` (reconcile),
 * вертикальный qty и backbone — в `extract-goods-from-tech-spec` и `difficult-tech-spec-position-blocks`.
 * Регрессия на архивах: `verify:goods-docs-tz-pf-archetype`; общий набор: `verify:ai-goods` / `verify:web-ai-goods`.
 *
 * **В проде** (`tender-ai-analyze`) пост-обработка вызывается только если
 * `shouldApplyFinalCartridgeTzPfArchetypeLayer` — иначе ложные совпадения токенов
 * (CE/TN/… в характеристиках, общие фразы) схлопывают разные позиции вне архетипа.
 */

import type { TenderAiGoodItem } from "@tendery/contracts";
import {
  extractModelTokens,
  normalizeGoodsMatchingKey
} from "@/lib/ai/match-goods-across-sources";

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

function isPrintedFormSourceHint(sourceHint: string): boolean {
  return allLogicalPathsFromSourceHint(sourceHint).some(looksLikePrintedFormLogicalPath);
}

/** Текст name+codes+характеристики → нормализация как в match-goods. */
function normalizedHaystackForModelKey(g: TenderAiGoodItem): string {
  const parts = [
    g.name,
    g.codes,
    ...(g.characteristics ?? []).map((c) => `${c.value ?? ""}`)
  ].join("\n");
  return normalizeGoodsMatchingKey(parts);
}

/**
 * Канонический ключ модели: самый длинный не-КТРУ токен из extractModelTokens
 * (CF259X, CE278A, TK-1170, TN-3480, 067HBK, …).
 */
export function computeGoodsItemModelDedupeKey(g: TenderAiGoodItem): string | null {
  const nk = normalizedHaystackForModelKey(g);
  const toks = extractModelTokens(nk);
  const modelToks = toks.filter((t) => !/^\d{2}\.\d{2}\.\d{2}/.test(t));
  if (modelToks.length === 0) return null;
  modelToks.sort((a, b) => b.length - a.length);
  return modelToks[0]!
    .replace(/\s/g, "")
    .toLowerCase()
    .replace(/[-_]/g, "");
}

function finalGoodsItemQualityScore(g: TenderAiGoodItem): number {
  let s = 0;
  s += (g.characteristics?.length ?? 0) * 14;
  const qv = g.quantityValue;
  if (qv != null && Number.isFinite(qv)) s += 28;
  else if ((g.quantity ?? "").trim().length > 0) s += 20;
  const pid = (g.positionId ?? "").trim();
  if (/^\d{8,}$/.test(pid)) s += 18;
  else if (/^\d{1,4}$/.test(pid)) s += 8;
  else if (pid.length >= 4) s += 5;
  const codes = (g.codes ?? "").replace(/\s/g, "");
  if (codes.length >= 14) s += 22;
  else if (codes.length >= 8) s += 12;
  const name = (g.name ?? "").trim();
  s += Math.min(name.length, 160) * 0.32;
  if (/или\s+эквивалент|или\s+аналог/i.test(name)) s += 10;
  if (g.quantitySource === "tech_spec") s += 6;
  if ((g.unitPrice ?? "").trim() || (g.lineTotal ?? "").trim()) s += 4;
  return s;
}

function isBetterQualityCandidate(a: TenderAiGoodItem, b: TenderAiGoodItem): boolean {
  const sa = finalGoodsItemQualityScore(a);
  const sb = finalGoodsItemQualityScore(b);
  if (sa !== sb) return sa > sb;
  const ca = a.characteristics?.length ?? 0;
  const cb = b.characteristics?.length ?? 0;
  if (ca !== cb) return ca > cb;
  const la = (a.name ?? "").length;
  const lb = (b.name ?? "").length;
  if (la !== lb) return la > lb;
  const pa = (a.positionId ?? "").trim().length;
  const pb = (b.positionId ?? "").trim().length;
  if (pa !== pb) return pa > pb;
  return false;
}

function rowHasModelTokenInNameOnly(name: string): boolean {
  const nk = normalizeGoodsMatchingKey(name);
  const toks = extractModelTokens(nk);
  return toks.some((t) => !/^\d{2}\.\d{2}\.\d{2}/.test(t));
}

/** Достаточно уверенная модельная строка, чтобы безопасно снимать generic ПФ при одном SKU. */
function isStrongModelEvidenceRow(g: TenderAiGoodItem): boolean {
  if (computeGoodsItemModelDedupeKey(g) == null) return false;
  const name = (g.name ?? "").trim();
  if (/или\s+эквивалент|или\s+аналог/i.test(name)) return true;
  if ((g.characteristics?.length ?? 0) >= 2) return true;
  if (g.quantitySource === "tech_spec") return true;
  return finalGoodsItemQualityScore(g) >= 42;
}

/**
 * Generic PF не трогаем, если в списке одна слабая модельная строка без подтверждённого ТЗ-контекста:
 * нужно ≥2 разных модельных ключа или одна «сильная» строка при единственном ключе.
 */
export function allowGenericPfCleanupByModelEvidence(rows: TenderAiGoodItem[]): boolean {
  const keys = new Set<string>();
  let strong = 0;
  for (const g of rows) {
    const k = computeGoodsItemModelDedupeKey(g);
    if (k) keys.add(k);
    if (isStrongModelEvidenceRow(g)) strong++;
  }
  if (keys.size >= 2) return true;
  if (keys.size === 1 && strong >= 1) return true;
  return false;
}

/**
 * Удалять generic, если в списке уже есть позиции с модельным ключом (CF259X, TK-1170, …).
 * Не требуем |lp:…docx в sourceHint: при reconcile через mergeFallbackLenient модельные строки
 * часто приходят с пустым/AI hint, иначе ворота generic-pass не открываются.
 */
function shouldDropGenericPfWhenModelRowsExist(g: TenderAiGoodItem): boolean {
  const name = (g.name ?? "").trim();
  if (!name) return false;
  if (/или\s+эквивалент|или\s+аналог/i.test(name)) return false;
  if (rowHasModelTokenInNameOnly(name)) return false;
  if (/картридж\s+для\s+электрографическ/i.test(name)) return true;
  if (/^картридж\s+для\b/i.test(name) && name.length >= 36) {
    return isPrintedFormSourceHint(g.sourceHint ?? "") || (g.characteristics?.length ?? 0) <= 1;
  }
  return false;
}

export type FinalGoodsModelDedupeResult = {
  items: TenderAiGoodItem[];
  droppedModelDuplicates: number;
  droppedGenericPf: number;
  diagnostics: string[];
};

/**
 * Достаточные признаки архетипа «ТЗ + ПФ + картридж / generic PF», чтобы включать финальный слой
 * в общем pipeline. Без этого слой остаётся дополнительным и не трогает прочие закупки.
 *
 * Условия (достаточно одного):
 * - в финальном списке есть наименование, начинающееся с «Картридж», или фраза «картридж для электрографических…»;
 * - в диагностике бандла ТЗ после `dedupeTechSpecBundleCrossSource` есть `cross_source_position_dedupe:` (снят дубль ПФ↔ТЗ).
 */
export function shouldApplyFinalCartridgeTzPfArchetypeLayer(
  items: TenderAiGoodItem[],
  techBundleDiagnostics: string[] | undefined
): boolean {
  if (items.length < 2) return false;
  const nameCartridge = items.some((g) => {
    const n = (g.name ?? "").trim();
    if (/^картридж/i.test(n)) return true;
    return /картридж\s+для\s+электрографическ/i.test(n);
  });
  const crossDedupeFired = (techBundleDiagnostics ?? []).some((d) =>
    d.startsWith("cross_source_position_dedupe:")
  );
  return nameCartridge || crossDedupeFired;
}

/**
 * Убирает дубли одной модели (оставляет запись с лучшим quality score) и generic «Картридж для…»
 * при наличии хотя бы одной позиции с модельным ключом в name/codes/characteristics.
 */
export function normalizeFinalGoodsItemsByModelDedupe(
  items: TenderAiGoodItem[]
): FinalGoodsModelDedupeResult {
  if (items.length < 2) {
    return { items, droppedModelDuplicates: 0, droppedGenericPf: 0, diagnostics: [] };
  }

  const drop = new Set<number>();
  const keyToIndices = new Map<string, number[]>();

  for (let i = 0; i < items.length; i++) {
    const key = computeGoodsItemModelDedupeKey(items[i]!);
    if (!key) continue;
    const list = keyToIndices.get(key) ?? [];
    list.push(i);
    keyToIndices.set(key, list);
  }

  let droppedModel = 0;
  for (const indices of keyToIndices.values()) {
    if (indices.length < 2) continue;
    let bestIdx = indices[0]!;
    for (const idx of indices.slice(1)) {
      if (isBetterQualityCandidate(items[idx]!, items[bestIdx]!)) bestIdx = idx;
    }
    for (const idx of indices) {
      if (idx !== bestIdx) {
        drop.add(idx);
        droppedModel++;
      }
    }
  }

  const survivorsPreGeneric = items
    .map((g, i) => ({ g, i }))
    .filter((x) => !drop.has(x.i));
  const survivorGoods = survivorsPreGeneric.map((x) => x.g);
  const hasModelKeyedRow = survivorGoods.some((g) => computeGoodsItemModelDedupeKey(g) != null);
  const allowGenericCleanup =
    hasModelKeyedRow && allowGenericPfCleanupByModelEvidence(survivorGoods);

  let droppedGeneric = 0;
  if (allowGenericCleanup) {
    for (const { g, i } of survivorsPreGeneric) {
      if (!shouldDropGenericPfWhenModelRowsExist(g)) continue;
      drop.add(i);
      droppedGeneric++;
    }
  }

  const diagnostics: string[] = [];
  if (hasModelKeyedRow && !allowGenericCleanup) {
    diagnostics.push("final_goods_model_dedupe:generic_pf_cleanup_skipped:insufficient_model_evidence");
  }

  if (drop.size === 0) {
    return {
      items,
      droppedModelDuplicates: 0,
      droppedGenericPf: 0,
      diagnostics: diagnostics.length > 0 ? diagnostics : []
    };
  }

  const out = items.filter((_, i) => !drop.has(i));
  diagnostics.push(
    `final_goods_model_dedupe:dropped_total=${drop.size},model_dupes=${droppedModel},generic_pf=${droppedGeneric}`
  );
  return {
    items: out,
    droppedModelDuplicates: droppedModel,
    droppedGenericPf: droppedGeneric,
    diagnostics
  };
}
