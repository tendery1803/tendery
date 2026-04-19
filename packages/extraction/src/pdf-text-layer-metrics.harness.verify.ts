/**
 * Метрики текстового слоя PDF: заполнение для PDF, отсутствие для docx.
 * Запуск из apps/web: pnpm run verify:extraction-pdf-metrics
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getExtractionConfigFromEnv } from "./config.js";
import { extractFromBuffer } from "./index.js";
import { computePdfTextLayerMetrics } from "./pdf-text-layer-metrics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");
const SAMPLE_PDF = path.join(
  REPO_ROOT,
  "samples/tenders-batch/Тендеры/тендэксперемент 2/Печатная форма.pdf"
);
const SAMPLE_DOCX = path.join(
  REPO_ROOT,
  "samples/tenders-batch/Тендеры/тендэксперемент 2/Требования_к_содержанию_составу_заявки_и_инструкция.docx"
);

async function main() {
  const m = computePdfTextLayerMetrics("строка один\nстрока два\n\n\t\n");
  assert.equal(m.linesNonEmpty, 2);
  assert.ok(m.medianLineLen >= 10);
  assert.equal(m.hyphenLineBreaks, 0);

  const config = getExtractionConfigFromEnv();
  const pdfBuf = await readFile(SAMPLE_PDF);
  const pdfOut = await extractFromBuffer({
    buffer: pdfBuf,
    filename: "Печатная форма.pdf",
    mime: "application/pdf",
    config
  });
  assert.equal(pdfOut.kind, "ok");
  if (pdfOut.kind !== "ok") throw new Error("expected ok");
  assert.ok(pdfOut.pdfTextLayerMetrics, "PDF ok outcome must include pdfTextLayerMetrics");
  const pm = pdfOut.pdfTextLayerMetrics!;
  assert.ok(pm.linesNonEmpty > 100, "sample PDF has many lines");
  assert.ok(pm.medianLineLen > 0);
  assert.ok(typeof pm.gluedLetterDigitHitsPer10k === "number");
  assert.ok(typeof pm.hyphenLineBreaks === "number");
  assert.ok(typeof pm.maxConsecutiveShortLetterLines === "number");

  const docxBuf = await readFile(SAMPLE_DOCX);
  const docxOut = await extractFromBuffer({
    buffer: docxBuf,
    filename: "req.docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    config
  });
  assert.equal(docxOut.kind, "ok");
  if (docxOut.kind !== "ok") throw new Error("expected docx ok");
  assert.equal(
    docxOut.pdfTextLayerMetrics,
    undefined,
    "non-PDF extract must not attach pdfTextLayerMetrics"
  );

  console.log("pdf-text-layer-metrics.harness.verify: OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
