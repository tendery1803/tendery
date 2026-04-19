/**
 * Диагностика Тенд24 и Тенд32: glue lines из ПФ — структура имён.
 * cd apps/web && node ../ai-gateway/node_modules/tsx/dist/cli.mjs scripts/diag-tend24-notice-rows.ts
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

async function main() {
  for (const tid of ["Тенд24", "Тенд32"]) {
    const dir = path.resolve(__dirname, `../../../samples/regression-goods/${tid}`);
    const files = await loadTenderDocumentsFromDir(dir);
    const routing = buildGoodsSourceRoutingReport(files);
    const minimized = buildMinimizedTenderTextForAi(files, { routingReport: routing });
    const masked = maskPiiForAi(minimized.fullRawCorpusForMasking);
    const lines = masked.split("\n");
    const glueLines = buildEisPrintFormVerticalGlueLinesForTest(lines);
    console.log(`\n=== ${tid}: GLUE LINES ===`, glueLines.length);
    for (const gl of glueLines.slice(0, 3)) {
      const idx = gl.indexOf("Стоимость позиции");
      const show = idx >= 0 ? gl.slice(Math.max(0, idx - 20), idx + 150) : gl.slice(0, 250);
      console.log("GLUE SNIPPET:", show);
      console.log("---");
    }
    const noticeRows = buildNoticeDeterministicRowsForGoodsMerge(masked);
    console.log(`${tid}: NOTICE ROWS =`, noticeRows.length);
    for (const r of noticeRows.slice(0, 8)) {
      console.log(`  pid=${r.positionId} | codes=${r.codes} | qty=${r.quantity} | chars=${r.characteristics?.length} | name=${r.name?.slice(0, 80)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
