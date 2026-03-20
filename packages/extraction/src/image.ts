import type { ExtractionOutcome } from "./types.js";

export async function extractImage(buffer: Buffer, ocrEnabled: boolean): Promise<ExtractionOutcome> {
  if (!ocrEnabled) {
    return { kind: "skipped", reason: "image_ocr_disabled" };
  }
  try {
    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker("rus+eng");
    try {
      const ret = await worker.recognize(buffer);
      const text = (ret.data.text ?? "").trim();
      if (!text) return { kind: "skipped", reason: "image_ocr_empty" };
      return { kind: "ok", text };
    } finally {
      await worker.terminate();
    }
  } catch (e) {
    return {
      kind: "error",
      message: `ocr: ${String(e)} (установите tesseract.js при EXTRACT_OCR_ENABLED=true)`
    };
  }
}
