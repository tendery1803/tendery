/**
 * Диагностика тендэксперемент 2: notice rows + bundle items.
 * cd apps/web && node ../ai-gateway/node_modules/tsx/dist/cli.mjs scripts/diag-exp2-bundle.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import {
  dedupeTechSpecBundleCrossSource,
  enhanceTechSpecBundleWithNoticeRows
} from "@/lib/ai/deterministic-goods-merge";
import {
  extractGoodsFromNoticePriceTable,
  buildEisPrintFormVerticalGlueLinesForTest
} from "@/lib/ai/extract-goods-notice-table";
import { extractGoodsFromTechSpec } from "@/lib/ai/extract-goods-from-tech-spec";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";
import { loadTenderDocumentsFromDir } from "@/lib/ai/goods-regression-batch";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.resolve(__dirname, "../../../samples/tenders-batch/Тендеры/тендэксперемент 2");

async function main() {
  const fileInputs = await loadTenderDocumentsFromDir(DIR);
  const routing = buildGoodsSourceRoutingReport(fileInputs);
  const minimized = buildMinimizedTenderTextForAi(fileInputs, { routingReport: routing });
  const masked = maskPiiForAi(minimized.fullRawCorpusForMasking);

  const lines = masked.split("\n");
  const glueLines = buildEisPrintFormVerticalGlueLinesForTest(lines);
  console.log("=== GLUE LINES ===", glueLines.length);
  for (const gl of glueLines.slice(0, 5)) {
    const idx = gl.indexOf("Стоимость позиции");
    const show = idx >= 0 ? gl.slice(Math.max(0, idx - 10), idx + 100) : gl.slice(0, 150);
    console.log("GLUE:", show);
    console.log("---");
  }

  const noticeRows = extractGoodsFromNoticePriceTable(masked);
  console.log("\n=== NOTICE ROWS ===", noticeRows.length);
  for (const r of noticeRows) {
    console.log(`  src=${r.sourceHint?.slice(0,30)} | pid=${r.positionId} | qty=${r.quantity} | name=${r.name?.slice(0, 60)}`);
  }

  let bundle = extractGoodsFromTechSpec(masked);
  const techItems = bundle.items.length;
  bundle = enhanceTechSpecBundleWithNoticeRows(bundle, noticeRows);
  const beforeDedupe = bundle.items.length;
  bundle = dedupeTechSpecBundleCrossSource(bundle);
  const afterDedupe = bundle.items.length;
  console.log(`\n=== BUNDLE: tech=${techItems} after_notice_merge=${beforeDedupe} after_cross_dedupe=${afterDedupe} ===`);
  for (const g of bundle.items) {
    console.log(`  pid=${g.positionId} | src=${g.sourceHint?.slice(0,40)} | name=${g.name?.slice(0,60)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
