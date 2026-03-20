import * as XLSX from "xlsx";
import type { ExtractionOutcome } from "./types.js";

export function extractSpreadsheet(buffer: Buffer): ExtractionOutcome {
  try {
    const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
    const parts: string[] = [];
    for (const name of wb.SheetNames) {
      const sheet = wb.Sheets[name];
      if (!sheet) continue;
      const csv = XLSX.utils.sheet_to_csv(sheet);
      if (csv.trim()) parts.push(`## ${name}\n${csv}`);
    }
    const text = parts.join("\n\n").trim();
    if (!text) return { kind: "skipped", reason: "spreadsheet_empty" };
    return { kind: "ok", text };
  } catch (e) {
    return { kind: "error", message: `spreadsheet: ${String(e)}` };
  }
}
