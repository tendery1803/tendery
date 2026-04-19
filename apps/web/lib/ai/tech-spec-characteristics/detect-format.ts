import { CharacteristicsFormat } from "./types";
import { isEisServiceInstructionLine } from "./parse-eis-wide-table";

function isServiceOrInstructionLine(t: string): boolean {
  return isEisServiceInstructionLine(t);
}

function hasEisCharacteristicsTableHeader(lines: string[]): boolean {
  const nameHdr = /наименование\s+характеристик/i;
  const valueHdr = /значение\s+характеристик/i;
  for (const raw of lines) {
    const t = raw.trim();
    // Построчные ячейки печатной формы ЕИС
    if (/^наименование\s+характеристик/i.test(t) || /^значение\s+характеристик/i.test(t))
      return true;
    // Частый экспорт: обе подписи колонок в одной строке (| , таб, «склейка» без разделителя)
    if (t.length <= 260 && nameHdr.test(t) && valueHdr.test(t)) return true;
  }
  return false;
}

function countTabSeparatedPairs(lines: string[]): number {
  let n = 0;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t.includes("\t")) continue;
    const tabIdx = t.indexOf("\t");
    const left = t.slice(0, tabIdx).trim();
    const right = t.slice(tabIdx + 1).trim();
    if (left.length >= 2 && right.length >= 1) n++;
  }
  return n;
}

/**
 * Определяет формат блока характеристик (тело позиции без первой строки-заголовка товара).
 * При любой неуверенности возвращает Colon — текущий production baseline.
 */
export function detectCharacteristicsFormat(bodyLines: string[]): CharacteristicsFormat {
  const lines = bodyLines.map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return CharacteristicsFormat.Colon;

  let serviceHits = 0;
  for (const t of lines) {
    if (isServiceOrInstructionLine(t)) serviceHits++;
  }

  const charHeaders = hasEisCharacteristicsTableHeader(lines);

  // Строго: минимум две служебные ячейки и явные заголовки колонок характеристик ЕИС.
  if (lines.length >= 4 && serviceHits >= 2 && charHeaders) {
    return CharacteristicsFormat.EisWideTable;
  }

  const tabPairs = countTabSeparatedPairs(lines);
  if (tabPairs >= 2 && serviceHits < 2) {
    return CharacteristicsFormat.SimpleTable;
  }

  return CharacteristicsFormat.Colon;
}
