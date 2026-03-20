import type { ExtractionConfig } from "./types.js";

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
}

/**
 * Читает лимиты из env (используется в worker). Значения по умолчанию — безопасные для MVP.
 */
export function getExtractionConfigFromEnv(): ExtractionConfig {
  return {
    textMaxChars: intEnv("EXTRACT_TEXT_MAX_CHARS", 500_000),
    zipMaxFiles: intEnv("EXTRACT_ZIP_MAX_FILES", 200),
    zipMaxTotalUncompressedBytes: intEnv("EXTRACT_ZIP_MAX_TOTAL_BYTES", 100 * 1024 * 1024),
    zipMaxDepth: intEnv("EXTRACT_ZIP_MAX_DEPTH", 4),
    zipMaxNestLevel: intEnv("EXTRACT_ZIP_MAX_NEST_LEVEL", 3),
    zipMaxEntryBytes: intEnv("EXTRACT_ZIP_MAX_ENTRY_BYTES", 25 * 1024 * 1024),
    ocrEnabled: boolEnv("EXTRACT_OCR_ENABLED", false)
  };
}
