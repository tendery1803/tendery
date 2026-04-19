import type { ExtractionConfig, ExtractionOutcome, DetectedFormat } from "./types.js";
import { extractPdf } from "./pdf.js";
import { extractDocx } from "./docx.js";
import { extractDoc } from "./doc.js";
import { extractSpreadsheet } from "./xlsx.js";
import { extractImage } from "./image.js";

export async function dispatchByFormat(
  format: DetectedFormat,
  buffer: Buffer,
  _filename: string,
  _mime: string,
  config: ExtractionConfig
): Promise<ExtractionOutcome> {
  switch (format) {
    case "pdf":
      return extractPdf(buffer);
    case "docx":
      return extractDocx(buffer);
    case "doc":
      return extractDoc(buffer);
    case "spreadsheet": {
      const r = extractSpreadsheet(buffer);
      return r;
    }
    case "image":
      return extractImage(buffer, config.ocrEnabled);
    case "zip":
      return { kind: "error", message: "zip_should_use_extractZip" };
    case "rar":
    case "7z":
      return { kind: "error", message: "seven_archive_should_use_extractSevenFamilyArchive" };
    case "unknown":
      return { kind: "skipped", reason: "unsupported_format" };
    default: {
      const _exhaustive: never = format;
      return { kind: "skipped", reason: `unknown:${String(_exhaustive)}` };
    }
  }
}
