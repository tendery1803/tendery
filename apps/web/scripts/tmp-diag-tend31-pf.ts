/**
 * Локальная диагностика Тенд31: склейка ПФ, extract notice table, merge notice, итог pipeline.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractFromBuffer, getExtractionConfigFromEnv } from "../../../packages/extraction/src/index.ts";
import {
  buildEisPrintFormVerticalGlueLinesForTest,
  buildNoticeDeterministicRowsForGoodsMerge,
  extractGoodsFromNoticePriceTable,
  isNoticeGoodsTableRowCandidate,
  isNoticePrintFormRow,
  pickAuthoritativeNoticeRowsForGoodsCardinality
} from "@/lib/ai/extract-goods-notice-table";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import { loadTenderDocumentsFromDir, runGoodsDocumentFirstPipelineFromInputs } from "@/lib/ai/goods-regression-batch";
import { readFile } from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pdf = path.join(__dirname, "../../../samples/regression-goods/Тенд31/Печатная форма.pdf");

async function main() {
  const tend31 = path.join(__dirname, "../../../samples/regression-goods/Тенд31");
  const fileInputs = await loadTenderDocumentsFromDir(tend31);
  const routing = buildGoodsSourceRoutingReport(fileInputs);
  const minimized = buildMinimizedTenderTextForAi(fileInputs, { routingReport: routing });
  const fullMasked = maskPiiForAi(minimized.fullRawCorpusForMasking);
  const linesF = fullMasked.split("\n");
  const gl = buildEisPrintFormVerticalGlueLinesForTest(linesF);
  console.log("glue lines", gl.length, "glue has 253", gl.filter((x) => x.includes("210964253")).length);
  for (const chunk of gl) {
    if (!chunk.includes("210964253")) continue;
    console.log("glue253 cand", isNoticeGoodsTableRowCandidate(chunk), "len", chunk.length);
  }
  const fromTableOnly = extractGoodsFromNoticePriceTable(fullMasked);
  console.log("extractGoodsFromNoticePriceTable", fromTableOnly.length);
  const merged = buildNoticeDeterministicRowsForGoodsMerge(fullMasked);
  const pfRows = merged.filter(isNoticePrintFormRow);
  console.log("buildNoticeDeterministicRows", merged.length, "PF rows", pfRows.length);
  console.log("pickAuthoritative tech=9 weak=false", pickAuthoritativeNoticeRowsForGoodsCardinality(merged, 9, false)?.length ?? null);
  const pipe = runGoodsDocumentFirstPipelineFromInputs(fileInputs, null);
  console.log("pipeline goods", pipe.goodsItems.length);

  const buf = await readFile(pdf);
  const r = await extractFromBuffer({
    buffer: buf,
    filename: "Печатная форма.pdf",
    mime: "application/pdf",
    config: getExtractionConfigFromEnv()
  });
  const text = r.kind === "ok" ? r.text : "";
  const masked = maskPiiForAi(text);
  const lines = masked.split("\n");
  const rows = extractGoodsFromNoticePriceTable(masked);
  console.log("PDF-only lines", lines.length, "extracted", rows.length);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
