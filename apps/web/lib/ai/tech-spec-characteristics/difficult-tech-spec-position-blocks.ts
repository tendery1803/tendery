/**
 * Эвристика «трудного» товарного ТЗ: несколько устойчивых якорей позиции (архив samples),
 * но штатная нарезка даёт меньше позиций. Только мягкий fallback через PositionBlock.
 */

import {
  countPositionBlockAnchorLines,
  extractPositionBlocksFromTechSpec,
  LINE_CARTRIDGE_MODEL_EQUIV_ANCHOR,
  positionBlockHeaderIsKnownAnchor
} from "./position-blocks-from-tech-spec";

/**
 * Признак табличного товарного фрагмента для эвристики backbone (уже в extract-goods — TABLE_HEADER_RE).
 * Дополнения по архиву «тендэксперемент 2»:
 * — Печатная форма.pdf: отдельная строка «Количество» без двоеточия; «Характеристики товара, работы…»;
 * — ТЕХ.ЗАДАНИЕ …docx: строка-заголовок «Техническое задание».
 */
function lineLooksLikeTableHeaderForBackboneGate(line: string): boolean {
  const t = line.trim();
  if (
    /^(Наименование\s+товара|КТРУ|ОКПД|Единица\s+измерения|№\s*п\/п|п\/п)\s*[:\s|]/i.test(t)
  ) {
    return true;
  }
  if (/^Количеств\w*\s*[:\s|]/i.test(t)) return true;
  /**
   * Печатная форма: короткая строка-колонка «Количество» / «Наименование» без «:» в OCR.
   * Ограничение по длине, чтобы не цеплять длинные предложения.
   */
  if (t.length <= 48 && /^Количеств\w*\s*$/i.test(t)) return true;
  if (t.length <= 48 && /^Наименовани[ея]?\s*$/i.test(t)) return true;
  /** Печатная форма / ЕИС: «Характеристики товара, работы, услуги …». */
  if (/^Характеристик\w*\s+товара\b/i.test(t)) return true;
  if (/^Техническое\s+задан(?:ие|ия)?\s*$/i.test(t)) return true;
  return false;
}

/** Максимум якорных блоков backbone на сегмент: дубликаты строк в docx дают ложные 10+ «позиций». */
const POSITION_BLOCK_BACKBONE_MAX_ANCHORED_BLOCKS = 8;

export function countTechSpecIdentifierLines(lines: string[]): number {
  let n = 0;
  for (const line of lines) {
    if (/^\s*Идентификатор\s*:/i.test(line)) n++;
  }
  return n;
}

function firstTableLikeLineSample(lines: string[]): string | undefined {
  for (const l of lines) {
    if (lineLooksLikeTableHeaderForBackboneGate(l)) return l.trim().slice(0, 120);
  }
  return undefined;
}

export type PositionBlockBackboneSegmentExplain = {
  tableLike: boolean;
  tableLikeSampleLine?: string;
  anchorCounts: {
    identifierNonEmpty: number;
    ktruColon: number;
    cartridgeModelEquiv: number;
  };
  positionBlocksTotal: number;
  positionBlockHeadersPreview: string[];
  anchoredBlockCount: number;
  anchoredHeadersPreview: string[];
  normalParsedPositionCount: number;
  wouldUseBackbone: boolean;
  /**
   * Архив «тендэксперемент 2»: штатная нарезка даёт столько же позиций, сколько блоков по якорю
   * «Картридж…эквивалент», но без backbone характеристики хуже; при полном совпадении счётчиков
   * включаем тот же split через backbone (узкий tie-break, только если все якорные заголовки — картриджные).
   */
  cartridgeTieEqualCounts: boolean;
  /** На каком шаге эвристика отсекает сегмент (для отладки архивных кейсов). */
  failReason:
    | "ok"
    | "no_table_like_header"
    | "insufficient_anchor_lines"
    | "anchored_position_blocks_lt_2"
    | "normal_parsed_gte_anchored_blocks"
    | "anchored_blocks_over_cap";
};

/**
 * Пошаговое объяснение решения по сегменту (тот же контракт, что и shouldUsePositionBlockBackboneForSegment).
 */
export function explainPositionBlockBackboneForSegment(
  segmentLines: string[],
  normalParsedPositionCount: number
): PositionBlockBackboneSegmentExplain {
  const tableLikeSampleLine = firstTableLikeLineSample(segmentLines);
  const tableLike = Boolean(tableLikeSampleLine);
  const anchorCounts = countPositionBlockAnchorLines(segmentLines);
  const anchorsOk =
    anchorCounts.identifierNonEmpty >= 2 ||
    anchorCounts.ktruColon >= 2 ||
    anchorCounts.cartridgeModelEquiv >= 2;

  const blocks = extractPositionBlocksFromTechSpec(segmentLines);
  let anchoredBlocks = blocks.filter((b) => positionBlockHeaderIsKnownAnchor(b.headerLine));

  let failReason: PositionBlockBackboneSegmentExplain["failReason"] = "ok";
  if (!tableLike) failReason = "no_table_like_header";
  else if (!anchorsOk) failReason = "insufficient_anchor_lines";
  else if (anchoredBlocks.length < 2) failReason = "anchored_position_blocks_lt_2";
  else if (anchoredBlocks.length > POSITION_BLOCK_BACKBONE_MAX_ANCHORED_BLOCKS)
    failReason = "anchored_blocks_over_cap";
  else if (normalParsedPositionCount >= anchoredBlocks.length) failReason = "normal_parsed_gte_anchored_blocks";

  /** Только ≥3 картриджных якоря (архив «тендэксперемент 2»); при 2=2 backbone не включаем. */
  const cartridgeAnchoredBlocks =
    anchoredBlocks.length >= 3 &&
    anchoredBlocks.length <= POSITION_BLOCK_BACKBONE_MAX_ANCHORED_BLOCKS &&
    anchoredBlocks.every((b) => LINE_CARTRIDGE_MODEL_EQUIV_ANCHOR.test(b.headerLine.trim()));

  const cartridgeTieEqualCounts =
    tableLike &&
    failReason === "normal_parsed_gte_anchored_blocks" &&
    normalParsedPositionCount === anchoredBlocks.length &&
    cartridgeAnchoredBlocks;

  const wouldUseBackbone = failReason === "ok" || cartridgeTieEqualCounts;

  return {
    tableLike,
    tableLikeSampleLine,
    anchorCounts,
    positionBlocksTotal: blocks.length,
    positionBlockHeadersPreview: blocks.map((b) => b.headerLine.trim().slice(0, 100)),
    anchoredBlockCount: anchoredBlocks.length,
    anchoredHeadersPreview: anchoredBlocks.map((b) => b.headerLine.trim().slice(0, 100)),
    normalParsedPositionCount,
    wouldUseBackbone,
    cartridgeTieEqualCounts,
    failReason: wouldUseBackbone ? "ok" : failReason
  };
}

/**
 * Включать backbone только если:
 * - фрагмент похож на таблицу ТЗ;
 * - есть ≥2 устойчивых якоря одного из типов (Идентификатор с pid / КТРУ: / Картридж…эквивалент);
 * - из extractPositionBlocksFromTechSpec получается ≥2 блоков с известным якорем в headerLine;
 * - штатный разбор дал меньше позиций, чем таких блоков.
 */
export function shouldUsePositionBlockBackboneForSegment(
  segmentLines: string[],
  normalParsedPositionCount: number
): boolean {
  return explainPositionBlockBackboneForSegment(segmentLines, normalParsedPositionCount).wouldUseBackbone;
}
