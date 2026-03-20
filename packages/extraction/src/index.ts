import { detectFormat } from "./detect.js";
import { dispatchByFormat } from "./dispatch.js";
import { extractZip } from "./zip.js";
import type { ExtractInput, ExtractionOutcome } from "./types.js";

export type { ExtractionConfig, ExtractionOutcome, ExtractInput } from "./types.js";
export { getExtractionConfigFromEnv } from "./config.js";

function truncateOutcome(outcome: ExtractionOutcome, maxChars: number): ExtractionOutcome {
  if (outcome.kind !== "ok") return outcome;
  if (outcome.text.length <= maxChars) return outcome;
  return {
    kind: "ok",
    text: `${outcome.text.slice(0, maxChars)}\n\n...[truncated by EXTRACT_TEXT_MAX_CHARS]`
  };
}

/**
 * Извлечение текста из буфера файла закупки (worker / тесты).
 */
export async function extractFromBuffer(input: ExtractInput): Promise<ExtractionOutcome> {
  const format = detectFormat(input.filename, input.mime);
  if (format === "zip") {
    const z = await extractZip(input.buffer, input.config);
    return truncateOutcome(z, input.config.textMaxChars);
  }
  const r = await dispatchByFormat(format, input.buffer, input.filename, input.mime, input.config);
  return truncateOutcome(r, input.config.textMaxChars);
}
