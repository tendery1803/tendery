/**
 * Диагностика Тенд25: notice rows из ПФ — коды, имена, характеристики.
 * cd apps/web && node ../ai-gateway/node_modules/tsx/dist/cli.mjs scripts/diag-tend25-notice-rows.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import {
  buildNoticeDeterministicRowsForGoodsMerge,
  buildEisPrintFormVerticalGlueLinesForTest
} from "@/lib/ai/extract-goods-notice-table";
import { loadTenderDocumentsFromDir } from "@/lib/ai/goods-regression-batch";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const T25 = path.resolve(__dirname, "../../../samples/regression-goods/Тенд25");

async function main() {
  const files = await loadTenderDocumentsFromDir(T25);
  const routing = buildGoodsSourceRoutingReport(files);
  const minimized = buildMinimizedTenderTextForAi(files, { routingReport: routing });
  const masked = maskPiiForAi(minimized.fullRawCorpusForMasking);

  const lines = masked.split("\n");
  const glueLines = buildEisPrintFormVerticalGlueLinesForTest(lines);
  console.log("=== GLUE LINES ===", glueLines.length);
  for (const gl of glueLines.slice(0, 5)) {
    console.log("GLUE:", gl.slice(0, 300));
    console.log("---");
  }

  const noticeRows = buildNoticeDeterministicRowsForGoodsMerge(masked);
  console.log("\n=== NOTICE ROWS ===", noticeRows.length);
  for (const r of noticeRows) {
    console.log(`  pid=${r.positionId} | codes=${r.codes} | qty=${r.quantity} | chars=${r.characteristics?.length} | name=${r.name?.slice(0,80)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
