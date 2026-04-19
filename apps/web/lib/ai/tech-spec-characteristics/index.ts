/**
 * Точка входа: один формат — один парсер; детектор не включает «тяжёлые» парсеры без сигналов.
 *
 * Сопровождение на реальных тендерах: см. MAINTENANCE.md. Регрессия: `pnpm run verify:characteristics` (из apps/web).
 */

import type { TenderAiCharacteristicRow } from "@tendery/contracts";
import { CharacteristicsFormat } from "./types";
import { detectCharacteristicsFormat } from "./detect-format";
import { parseColonCharacteristics } from "./parse-colon";
import { parseSimpleTableCharacteristics } from "./parse-simple-table";
import { parseEisWideTableCharacteristics } from "./parse-eis-wide-table";

export { CharacteristicsFormat } from "./types";
export { detectCharacteristicsFormat } from "./detect-format";
export { parseColonCharacteristics } from "./parse-colon";
export { parseSimpleTableCharacteristics } from "./parse-simple-table";
export {
  parseEisWideTableCharacteristics,
  isEisServiceInstructionLine,
  isDocumentTailLine,
} from "./parse-eis-wide-table";
export { PROC_CHAR_JUNK } from "./constants";
export { canonicalCharacteristicName } from "./parse-colon";
/**
 * Доп. нарезка блоков по «Идентификатор:» + эвристика трудного ТЗ (мягкий fallback границ в extractGoodsFromTechSpec).
 * parseCharacteristicsForPositionBody внутри блока не заменяется.
 */
export {
  countPositionBlockAnchorLines,
  extractPositionBlocksFromTechSpec,
  LINE_CARTRIDGE_MODEL_EQUIV_ANCHOR,
  LINE_KTRU_COLON_ANCHOR,
  positionBlockHeaderIsKnownAnchor,
  type PositionBlock
} from "./position-blocks-from-tech-spec";
export {
  countTechSpecIdentifierLines,
  explainPositionBlockBackboneForSegment,
  shouldUsePositionBlockBackboneForSegment,
  type PositionBlockBackboneSegmentExplain
} from "./difficult-tech-spec-position-blocks";

export function parseCharacteristicsForPositionBody(bodyLines: string[]): {
  format: CharacteristicsFormat;
  rows: TenderAiCharacteristicRow[];
} {
  const format = detectCharacteristicsFormat(bodyLines);
  if (format === CharacteristicsFormat.EisWideTable) {
    return { format, rows: parseEisWideTableCharacteristics(bodyLines) };
  }
  if (format === CharacteristicsFormat.SimpleTable) {
    return { format, rows: parseSimpleTableCharacteristics(bodyLines) };
  }
  return { format, rows: parseColonCharacteristics(bodyLines) };
}
