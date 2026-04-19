/**
 * Трассировка goods по папке тендера: tech parse → notice rows → enhance → dedupe → reconcile (пустой AI).
 * Запуск: cd apps/web && node ../ai-gateway/node_modules/tsx/dist/cli.mjs scripts/diag-tend10-goods-pipeline-trace.ts [путь_к_папке]
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import {
  dedupeTechSpecBundleCrossSource,
  enhanceTechSpecBundleWithNoticeRows
} from "@/lib/ai/deterministic-goods-merge";
import { extractGoodsFromTechSpec } from "@/lib/ai/extract-goods-from-tech-spec";
import {
  buildNoticeDeterministicRowsForGoodsMerge,
  extractGoodsFromNoticeGoodsInfoSection,
  isNoticeGoodsInfoBlockRow
} from "@/lib/ai/extract-goods-notice-table";
import { loadTenderDocumentsFromDir } from "@/lib/ai/goods-regression-batch";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import { reconcileGoodsItemsWithDocumentSources } from "@/lib/ai/match-goods-across-sources";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";
import type { TenderAiGoodItem } from "@tendery/contracts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function rowLine(i: number, g: TenderAiGoodItem): string {
  return [
    `[${i}]`,
    `name=${JSON.stringify((g.name ?? "").slice(0, 120))}`,
    `qty=${JSON.stringify((g.quantity ?? "").trim())}`,
    `unit=${JSON.stringify((g.unit ?? "").trim())}`,
    `codes=${JSON.stringify((g.codes ?? "").slice(0, 80))}`,
    `hint=${JSON.stringify((g.sourceHint ?? "").slice(0, 100))}`
  ].join(" ");
}

function printBlock(title: string, rows: TenderAiGoodItem[]) {
  console.log(`\n=== ${title} (n=${rows.length}) ===`);
  rows.forEach((g, i) => console.log(rowLine(i, g)));
}

async function main() {
  const tenderDir =
    process.argv[2] ?? path.resolve(__dirname, "../../../samples/regression-goods/Тенд10");
  const files = await loadTenderDocumentsFromDir(tenderDir);
  const routing = buildGoodsSourceRoutingReport(files);
  const minimized = buildMinimizedTenderTextForAi(files, { routingReport: routing });
  const masked = maskPiiForAi(minimized.fullRawCorpusForMasking);

  const tech0 = extractGoodsFromTechSpec(masked);
  printBlock("1) После extractGoodsFromTechSpec", tech0.items);

  const noticeFull = buildNoticeDeterministicRowsForGoodsMerge(masked);
  const giOnly = extractGoodsFromNoticeGoodsInfoSection(masked);
  printBlock("2a) extractGoodsFromNoticeGoodsInfoSection (goods-info)", giOnly);
  console.log("\n2b) buildNoticeDeterministicRowsForGoodsMerge: goods-info subset");
  noticeFull.filter(isNoticeGoodsInfoBlockRow).forEach((g, i) => console.log(rowLine(i, g)));

  let bundle = tech0;
  bundle = enhanceTechSpecBundleWithNoticeRows(bundle, noticeFull);
  printBlock("3) После enhanceTechSpecBundleWithNoticeRows", bundle?.items ?? []);
  console.log("\n3d) diagnostics:", (bundle?.diagnostics ?? []).join("\n   "));

  bundle = dedupeTechSpecBundleCrossSource(bundle);
  printBlock("4) После dedupeTechSpecBundleCrossSource", bundle?.items ?? []);

  const rec = reconcileGoodsItemsWithDocumentSources([], masked, bundle ?? undefined);
  printBlock("5) После reconcileGoodsItemsWithDocumentSources (aiItems=[])", rec.items);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
