import { createRequire } from "node:module";
import type { ExtractionOutcome } from "./types.js";

const require = createRequire(import.meta.url);
// pdf-parse — CommonJS
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require("pdf-parse") as (buf: Buffer) => Promise<{ text?: string }>;

export async function extractPdf(buffer: Buffer): Promise<ExtractionOutcome> {
  try {
    const data = await pdfParse(buffer);
    const text = (data.text ?? "").trim();
    if (!text) return { kind: "skipped", reason: "pdf_empty" };
    return { kind: "ok", text };
  } catch (e) {
    return { kind: "error", message: `pdf_parse: ${String(e)}` };
  }
}
