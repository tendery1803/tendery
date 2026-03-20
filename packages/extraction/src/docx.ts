import * as mammoth from "mammoth";
import type { ExtractionOutcome } from "./types.js";

export async function extractDocx(buffer: Buffer): Promise<ExtractionOutcome> {
  try {
    const res = await mammoth.extractRawText({ buffer });
    const text = (res.value ?? "").trim();
    if (!text) return { kind: "skipped", reason: "docx_empty" };
    return { kind: "ok", text };
  } catch (e) {
    return { kind: "error", message: `docx: ${String(e)}` };
  }
}
