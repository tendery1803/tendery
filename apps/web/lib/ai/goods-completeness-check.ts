/**
 * Контроль полноты извлечения товаров по главному блоку спецификации (после stabilize/sanitize).
 * Не дублирует merge/chunk — только сравнение ожиданий с фактом и узкий recheck.
 * В analyze вызывается после reconcile по ТЗ/извещению — goodsItems уже отфильтрованы по якорям.
 */

import type { TenderAiGoodItem } from "@tendery/contracts";
import {
  countGoodsLikeSpecificationLines,
  pickBestGoodsListRegion
} from "@/lib/ai/stabilize-goods-items";
import {
  extractedPositionIdSet,
  inferExpectedGoodsCoverage,
  normalizeGoodsPositionIdForMatch,
  type GoodsExpectedCoverage,
  type GoodsExpectedCoverageDiagnostics
} from "@/lib/ai/goods-expected-items";

export type GoodsCompletenessStatus = "complete" | "partial" | "unknown";

export type GoodsCompletenessDiagnosticsInput = {
  /** Диагностика expected coverage по полному корпусу (как в пайплайне) — только для reasons/audit. */
  fullCorpusCoverage?: GoodsExpectedCoverage | null;
  expectedCoverageDiagnostics?: GoodsExpectedCoverageDiagnostics | null;
};

export type GoodsCompletenessCheckInput = {
  corpus: string;
  goodsItems: TenderAiGoodItem[];
  /** НМЦК (для контракта helper’а; усечение по потолку — в stabilize). */
  nmckText: string;
  diagnostics?: GoodsCompletenessDiagnosticsInput | null;
};

/** В meta AuditLog рядом с goodsCoverageAudit. */
export type GoodsCompletenessAudit = {
  expectedCount: number | null;
  expectedIds: string[];
  extractedIdsBeforeRecheck: string[];
  missingIdsBeforeRecheck: string[];
  extractedIdsAfterRecheck: string[];
  missingIdsAfterRecheck: string[];
  completenessStatusBeforeRecheck: string;
  completenessStatusAfterRecheck: string;
  selectedPrimaryGoodsBlockScore: number | null;
  selectedPrimaryGoodsBlockReason: string[];
  targetedRecheckTriggered: boolean;
  targetedRecheckReason: string[];
  acceptedRecoveredItemsCount: number;
};

export type GoodsCompletenessCheckResult = {
  expectedCount: number | null;
  expectedIds: string[];
  extractedCount: number;
  extractedIds: string[];
  missingIds: string[];
  completenessStatus: GoodsCompletenessStatus;
  confidence: number;
  reasons: string[];
  selectedPrimaryGoodsBlockScore: number | null;
  selectedPrimaryGoodsBlockReason: string[];
};

function uniqSortedNumericIds(ids: string[]): string[] {
  const set = new Set<string>();
  for (const raw of ids) {
    const k = normalizeGoodsPositionIdForMatch(raw);
    if (k) set.add(k);
  }
  return [...set].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
}

function maxNumericId(ids: string[]): number {
  let m = 0;
  for (const id of ids) {
    const n = parseInt(id, 10);
    if (Number.isFinite(n) && n > m) m = n;
  }
  return m;
}

/**
 * Ожидания только по выбранному главному блоку спецификации (как stabilizeGoodsItems).
 */
export function inferPrimaryBlockGoodsExpectations(corpus: string): {
  regionText: string;
  regionScore: number;
  blockCoverage: GoodsExpectedCoverage;
  dataLineCount: number;
  blockReason: string[];
} {
  const { text: regionText, score: regionScore } = pickBestGoodsListRegion(corpus ?? "");
  const blockCoverage = inferExpectedGoodsCoverage(regionText);
  const dataLineCount = countGoodsLikeSpecificationLines(regionText);
  const blockReason = [
    `primary_block_score=${regionScore}`,
    `primary_block_chars=${regionText.length}`,
    `block_expected_source=${blockCoverage.detectionSource}`,
    `block_data_lines_qty_price=${dataLineCount}`
  ];
  return { regionText, regionScore, blockCoverage, dataLineCount, blockReason };
}

export function checkGoodsCompleteness(input: GoodsCompletenessCheckInput): GoodsCompletenessCheckResult {
  const { corpus, goodsItems } = input;
  const { regionText, regionScore, blockCoverage, dataLineCount, blockReason } =
    inferPrimaryBlockGoodsExpectations(corpus);

  const reasons: string[] = [...blockReason];
  if (input.diagnostics?.fullCorpusCoverage) {
    reasons.push(
      `full_corpus_expected_count=${input.diagnostics.fullCorpusCoverage.expectedItemsCount ?? "null"}`
    );
  }
  if (input.diagnostics?.expectedCoverageDiagnostics?.expectedCountDerivation) {
    reasons.push(
      `pipeline_derivation=${input.diagnostics.expectedCoverageDiagnostics.expectedCountDerivation}`
    );
  }

  const extractedSet = extractedPositionIdSet(goodsItems);
  const extractedIds = [...extractedSet].sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  const extractedCount = goodsItems.length;

  let expectedIds: string[] = [];
  if (blockCoverage.expectedPositionIds.length >= 2) {
    expectedIds = uniqSortedNumericIds(blockCoverage.expectedPositionIds);
  } else if (blockCoverage.expectedPositionIds.length === 1) {
    const one = normalizeGoodsPositionIdForMatch(blockCoverage.expectedPositionIds[0] ?? "");
    if (one) expectedIds = [one];
  }

  let expectedCount: number | null = null;

  if (expectedIds.length >= 2) {
    const maxId = maxNumericId(expectedIds);
    const fromDeclared = blockCoverage.expectedItemsCount ?? 0;
    expectedCount = Math.max(maxId, fromDeclared, dataLineCount >= 2 ? dataLineCount : 0);
    reasons.push(`expected_ids_from_block:n=${expectedIds.length},max_id=${maxId}`);
  } else if (blockCoverage.detectionSource === "declared_count" && blockCoverage.expectedItemsCount != null) {
    expectedCount = Math.max(blockCoverage.expectedItemsCount, dataLineCount >= 2 ? dataLineCount : 0);
    reasons.push("expected_from_declared_phrases_in_block");
  } else if (dataLineCount >= 2 && blockCoverage.detectionSource === "table_max_position") {
    expectedCount = Math.max(blockCoverage.expectedItemsCount ?? 0, dataLineCount);
    reasons.push("expected_reinforced_by_data_lines_in_block");
  } else if (dataLineCount >= 2) {
    expectedCount = dataLineCount;
    reasons.push("expected_from_data_lines_only_in_block");
  } else if (blockCoverage.expectedItemsCount != null && blockCoverage.expectedItemsCount >= 1) {
    expectedCount = blockCoverage.expectedItemsCount;
    reasons.push("expected_from_weak_block_signal");
  } else {
    expectedCount = null;
    reasons.push("expected_not_reliable");
  }

  const missingIds =
    expectedIds.length > 0
      ? expectedIds.filter((id) => !extractedSet.has(normalizeGoodsPositionIdForMatch(id)))
      : [];

  let completenessStatus: GoodsCompletenessStatus = "unknown";
  if (expectedIds.length > 0) {
    completenessStatus = missingIds.length === 0 ? "complete" : "partial";
  } else if (expectedCount != null) {
    if (extractedCount === expectedCount) completenessStatus = "complete";
    else if (extractedCount < expectedCount) completenessStatus = "partial";
    else completenessStatus = "complete";
    reasons.push(
      extractedCount > expectedCount
        ? "extracted_count_exceeds_expected_line_estimate"
        : "count_compare_no_position_ids"
    );
  } else {
    completenessStatus = "unknown";
  }

  let confidence = blockCoverage.confidence;
  if (regionScore >= 8) confidence = Math.min(1, confidence + 0.06);
  if (regionScore < 4) confidence = Math.max(0, confidence - 0.12);
  if (expectedIds.length >= 2) confidence = Math.min(1, confidence + 0.08);
  if (completenessStatus === "unknown") confidence = Math.min(confidence, 0.45);

  return {
    expectedCount,
    expectedIds,
    extractedCount,
    extractedIds,
    missingIds,
    completenessStatus,
    confidence,
    reasons,
    selectedPrimaryGoodsBlockScore: regionText.length > 0 ? regionScore : null,
    selectedPrimaryGoodsBlockReason: blockReason
  };
}

export type TargetedCompletenessRecheckMode = "missing_ids" | "tail_count";

export function buildTargetedCompletenessRecheckPrompt(args: {
  primaryBlockText: string;
  fieldsJson: string;
  procurementKind: string;
  procurementMethod: string;
  servicesJson: string;
  missingPositionIds: string[];
  expectedCount: number | null;
  currentGoodsCount: number;
  mode: TargetedCompletenessRecheckMode;
}): string {
  const header =
    args.mode === "missing_ids"
      ? `Извлеки ТОЛЬКО позиции с номерами (п/п): ${args.missingPositionIds.join(", ")}.`
      : `В фрагменте ниже проверь хвост таблицы/спецификации: ожидается около ${args.expectedCount ?? "?"} позиций, в системе уже ${args.currentGoodsCount}. Добавь только недостающие товарные строки из ЭТОГО фрагмента, без дублирования уже покрытых номеров.`;

  return `Узкий добор полноты спецификации (один проход). Ответ — один JSON-объект по схеме API, без markdown.

${header}
Правила:
• Новый goodsItem только если в строке/блоке одновременно есть: наименование (name), код в codes (КТРУ/ОКПД/ид. из таблицы), quantity; unitPrice/lineTotal — если в фрагменте есть рубли, иначе "".
• Не подставляй бренды и модели (Samsung, Xerox и т.д.), которых нет в тексте фрагмента.
• Не создавай позиции из заголовков, «Характеристики товара», инструкций и юридических абзацев.
• Используй ТОЛЬКО текст фрагмента ниже — не переноси позиции из других частей документа.
• Если позиции в тексте нет — не выдумывай.

• summary: коротко: «Узкий добор полноты спецификации».
• fields: ТОЧНО массив:
${args.fieldsJson}
• procurementKind: ${JSON.stringify(args.procurementKind)}
• procurementMethod: ${JSON.stringify(args.procurementMethod)}
• servicesOfferings: ${args.servicesJson}

--- ГЛАВНЫЙ БЛОК СПЕЦИФИКАЦИИ (только он) ---
${args.primaryBlockText}`;
}

export function buildGoodsCompletenessChecklistNote(cc: GoodsCompletenessCheckResult): string {
  if (cc.completenessStatus === "complete") {
    return cc.expectedCount != null
      ? `Полнота: по эвристике согласуется с документом (ожид. ~${cc.expectedCount}, извлечено ${cc.extractedCount}).`
      : `Полнота: явных признаков неполноты по главному блоку спецификации нет (извлечено ${cc.extractedCount}).`;
  }
  if (cc.completenessStatus === "partial") {
    if (cc.missingIds.length > 0) {
      const head = cc.missingIds.slice(0, 10).join(", ");
      const tail = cc.missingIds.length > 10 ? "…" : "";
      return `Частично: не найдены позиции с номерами ${head}${tail} (извлечено ${cc.extractedCount}).`;
    }
    if (cc.expectedCount != null) {
      return `Частично выполнено (найдено ${cc.extractedCount} из ~${cc.expectedCount}).`;
    }
    return `Частично: извлечено ${cc.extractedCount} поз.; сверьте со спецификацией в файлах.`;
  }
  return `Полноту по спецификации автоматически не подтвердить; извлечено ${cc.extractedCount} поз. — сверьте вручную.`;
}

export type CompletenessRecheckAcceptOptions = {
  /** Не уменьшать число позиций ниже этого порога (защита ТЗ-first списка). */
  minGoodsCount?: number;
};

export function shouldAcceptCompletenessRecheck(
  before: GoodsCompletenessCheckResult,
  after: GoodsCompletenessCheckResult,
  options?: CompletenessRecheckAcceptOptions
): boolean {
  if (options?.minGoodsCount != null && after.extractedCount < options.minGoodsCount) return false;
  if (after.missingIds.length > before.missingIds.length) return false;
  if (after.extractedCount < before.extractedCount) return false;
  if (after.completenessStatus === "complete" && before.completenessStatus !== "complete") return true;
  if (before.missingIds.length > 0 && after.missingIds.length < before.missingIds.length) return true;
  if (
    before.expectedIds.length === 0 &&
    before.expectedCount != null &&
    after.extractedCount > before.extractedCount &&
    after.extractedCount <= before.expectedCount
  ) {
    return true;
  }
  if (
    before.completenessStatus === "partial" &&
    after.completenessStatus === "complete" &&
    before.expectedIds.length === 0
  ) {
    return true;
  }
  if (before.missingIds.length > 0 && after.missingIds.length === before.missingIds.length) {
    if (after.extractedCount > before.extractedCount) return false;
  }
  return false;
}
