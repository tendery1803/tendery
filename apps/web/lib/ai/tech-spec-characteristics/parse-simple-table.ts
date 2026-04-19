import type { TenderAiCharacteristicRow } from "@tendery/contracts";
import { PROC_CHAR_JUNK } from "./constants";
import { canonicalCharacteristicName } from "./parse-colon";

/**
 * Type B: строки с ровно одним разделителем колонок TAB (метка \t значение).
 * Не смешивается с colon и с ЕИС-wide.
 */
export function parseSimpleTableCharacteristics(bodyLines: string[]): TenderAiCharacteristicRow[] {
  const rows: TenderAiCharacteristicRow[] = [];
  for (const raw of bodyLines) {
    const t = raw.trim();
    if (!t.includes("\t")) continue;
    const tabIdx = t.indexOf("\t");
    const name = t.slice(0, tabIdx).trim();
    const value = t.slice(tabIdx + 1).trim().replace(/\t/g, " ");
    if (name.length < 2 || value.length < 1) continue;
    if (PROC_CHAR_JUNK.test(name) || PROC_CHAR_JUNK.test(value)) continue;
    rows.push({ name: canonicalCharacteristicName(name), value, sourceHint: "tech_spec" });
  }
  return rows;
}
