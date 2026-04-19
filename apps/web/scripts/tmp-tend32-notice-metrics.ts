import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import { enhanceTechSpecBundleWithNoticeRows } from "@/lib/ai/deterministic-goods-merge";
import { extractGoodsFromTechSpec } from "@/lib/ai/extract-goods-from-tech-spec";
import {
  buildNoticeDeterministicRowsForGoodsMerge,
  extractGoodsFromNoticePriceTable
} from "@/lib/ai/extract-goods-notice-table";
import { runGoodsDocumentFirstPipelineFromInputs, loadTenderDocumentsFromDir } from "@/lib/ai/goods-regression-batch";
import { collectGoodsRegressionProblemPositions } from "@/lib/ai/goods-regression-metrics";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";
import { isRegistryStylePositionId } from "@/lib/ai/registry-position-ids";

async function main() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const tenderDir = path.resolve(__dirname, "../../../samples/regression-goods/Тенд32");
  const inputs = await loadTenderDocumentsFromDir(tenderDir);
  const routing = buildGoodsSourceRoutingReport(inputs);
  const minimized = buildMinimizedTenderTextForAi(inputs, { routingReport: routing });
  const masked = maskPiiForAi(minimized.fullRawCorpusForMasking);
  const notice = buildNoticeDeterministicRowsForGoodsMerge(masked);
  const noticeWithRegistryPid = notice.filter((g) =>
    isRegistryStylePositionId((g.positionId ?? "").replace(/\s/g, "").trim())
  ).length;
  const tableOnly = extractGoodsFromNoticePriceTable(masked);
  const tableKeys = tableOnly.map(
    (g) => `${(g.positionId ?? "").trim()}|${(g.codes ?? "").replace(/\s/g, "")}|${g.quantity}|${(g.lineTotal ?? "").trim()}`
  );
  const tech = extractGoodsFromTechSpec(masked);
  const bundle = enhanceTechSpecBundleWithNoticeRows(tech, notice);
  const pipe = runGoodsDocumentFirstPipelineFromInputs(inputs, null);
  const probs = collectGoodsRegressionProblemPositions(pipe.goodsItems);
  const emptyPid = probs.filter((p) => p.problemType === "empty_position_id").length;
  const nonEmptyPid = pipe.goodsItems.filter((g) => (g.positionId ?? "").trim().length > 0).length;
  const uniq = new Set(pipe.goodsItems.map((g) => (g.positionId ?? "").trim()).filter(Boolean)).size;
  const idx = bundle?.diagnostics?.find((d) => d.includes("index_notice_position_id_restore=") && !d.includes("skipped"));
  const codeCluster = bundle?.diagnostics?.find((d) => d.includes("code_cluster_notice_position_id_restore="));
  const codeQty = bundle?.diagnostics?.find((d) => d.includes("code_qty_notice_position_id_restore="));
  const codeQtyPrice = bundle?.diagnostics?.find((d) => d.includes("code_qty_price_notice_position_id_restore="));
  const bestMatchPid = bundle?.diagnostics?.find((d) => d.includes("best_match_pid_restore="));
  const sk = bundle?.diagnostics?.find((d) => d.includes("index_notice_position_id_restore_skipped"));
  const mergeDiag = bundle?.diagnostics?.filter((d) => d.includes("notice_det") || d.includes("merged_deterministic"));
  console.log(
    JSON.stringify(
      {
        noticeItems: notice.length,
        noticeWithRegistryPid,
        noticeTableOnly: tableOnly.length,
        techItems: tech.items.length,
        lengthsEqual: notice.length === tech.items.length,
        indexFallbackDiag: idx ?? null,
        codeClusterFallbackDiag: codeCluster ?? null,
        codeQtyFallbackDiag: codeQty ?? null,
        codeQtyPriceFallbackDiag: codeQtyPrice ?? null,
        bestMatchPidRestoreDiag: bestMatchPid ?? null,
        indexSkippedDiag: sk ?? null,
        mergeDiagnostics: mergeDiag?.length ? mergeDiag : null,
        bundleDiagnosticsTail: bundle?.diagnostics?.slice(-6) ?? null,
        nonEmptyPid,
        emptyPidProblems: emptyPid,
        uniquePid: uniq,
        positionIdStatusCounts: pipe.positionIdStatusCounts,
        tableKeysSample: tableKeys.slice(0, 25)
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
