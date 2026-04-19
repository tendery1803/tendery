import { detectFormat } from "./detect.js";
import { dispatchByFormat } from "./dispatch.js";
import { extractZip } from "./zip.js";
import { extractSevenFamilyArchive } from "./seven-archive.js";
import {
  createArchiveWalkState,
  extractDiagnosticsFooter,
  formatArchiveDiagnosticsBlock,
  type ArchiveWalkState
} from "./archive-walk.js";
import type { ExtractInput, ExtractionConfig, ExtractionOutcome } from "./types.js";

export type { ExtractionConfig, ExtractionOutcome, ExtractInput, PdfTextLayerMetrics } from "./types.js";
export { computePdfTextLayerMetrics } from "./pdf-text-layer-metrics.js";
export { getExtractionConfigFromEnv } from "./config.js";

function attachArchiveDiagnostics(
  outcome: ExtractionOutcome,
  state: ArchiveWalkState,
  config: ExtractionConfig
): ExtractionOutcome {
  const footer = formatArchiveDiagnosticsBlock(state, config);
  if (!footer) return outcome;
  switch (outcome.kind) {
    case "ok":
      return {
        kind: "ok",
        text: outcome.text + footer,
        ...(outcome.pdfTextLayerMetrics
          ? { pdfTextLayerMetrics: outcome.pdfTextLayerMetrics }
          : {})
      };
    case "skipped":
      return { kind: "skipped", reason: outcome.reason + footer };
    case "quarantined":
      return { kind: "quarantined", reason: outcome.reason + footer };
    case "error":
      return { kind: "error", message: outcome.message + footer };
    default: {
      const _e: never = outcome;
      return _e;
    }
  }
}

function truncateOutcome(outcome: ExtractionOutcome, maxChars: number): ExtractionOutcome {
  if (outcome.kind !== "ok") return outcome;
  const pdfMetrics = outcome.pdfTextLayerMetrics;
  const { main, footer } = extractDiagnosticsFooter(outcome.text);
  const sep = footer ? "\n\n" : "";
  const budget = Math.max(0, maxChars - footer.length - sep.length);
  if (main.length <= budget) {
    return {
      kind: "ok",
      text: main + (footer ? `${sep}${footer}` : ""),
      ...(pdfMetrics ? { pdfTextLayerMetrics: pdfMetrics } : {})
    };
  }
  const mainTrunc = `${main.slice(0, budget)}\n\n...[truncated by EXTRACT_TEXT_MAX_CHARS]`;
  return {
    kind: "ok",
    text: mainTrunc + (footer ? `${sep}${footer}` : ""),
    ...(pdfMetrics ? { pdfTextLayerMetrics: pdfMetrics } : {})
  };
}

/**
 * Извлечение текста из буфера файла закупки (worker / тесты).
 */
export async function extractFromBuffer(input: ExtractInput): Promise<ExtractionOutcome> {
  const format = detectFormat(input.filename, input.mime);

  if (format === "zip") {
    const state = createArchiveWalkState();
    const z = await extractZip(input.buffer, input.config, state, 0, "");
    return truncateOutcome(attachArchiveDiagnostics(z, state, input.config), input.config.textMaxChars);
  }

  if (format === "rar" || format === "7z") {
    const state = createArchiveWalkState();
    const z = await extractSevenFamilyArchive(
      input.buffer,
      input.filename,
      input.config,
      state,
      0,
      "",
      format === "rar" ? "rar" : "7z"
    );
    return truncateOutcome(attachArchiveDiagnostics(z, state, input.config), input.config.textMaxChars);
  }

  const r = await dispatchByFormat(format, input.buffer, input.filename, input.mime, input.config);
  return truncateOutcome(r, input.config.textMaxChars);
}
