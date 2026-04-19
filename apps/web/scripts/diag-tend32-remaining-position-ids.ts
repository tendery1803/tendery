/**
 * Одноразовая диагностика: пустые positionId по Тенд32 + кандидаты.
 * Запуск: cd apps/web && node ../ai-gateway/node_modules/tsx/dist/cli.mjs scripts/diag-tend32-remaining-position-ids.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import { buildNoticeDeterministicRowsForGoodsMerge } from "@/lib/ai/extract-goods-notice-table";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";
import { distinctRegistryPidsSharingCodes, normGoodsPositionId } from "@/lib/ai/goods-position-id-status";
import { extractNameDisambiguationNeedles } from "@/lib/ai/extract-name-disambiguation-needles";
import { loadTenderDocumentsFromDir, runGoodsDocumentFirstPipelineFromInputs } from "@/lib/ai/goods-regression-batch";
import { collectGoodsRegressionProblemPositions } from "@/lib/ai/goods-regression-metrics";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import { isRegistryStylePositionId } from "@/lib/ai/registry-position-ids";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

async function main() {
  const dir = path.join(repoRoot, "samples", "regression-goods", "Тенд32");
  const f = await loadTenderDocumentsFromDir(dir);
  const routing = buildGoodsSourceRoutingReport(f);
  const min = buildMinimizedTenderTextForAi(f, { routingReport: routing });
  const corpus = maskPiiForAi(min.fullRawCorpusForMasking);
  const noticeRows = buildNoticeDeterministicRowsForGoodsMerge(corpus);
  const pipe = runGoodsDocumentFirstPipelineFromInputs(f, null);
  const probs = collectGoodsRegressionProblemPositions(pipe.goodsItems);
  const emptyProbTitles = probs
    .filter((p) => p.problemType === "empty_position_id")
    .map((p) => p.titlePreview);

  const used = new Set(
    pipe.goodsItems
      .map((g) => normGoodsPositionId(g.positionId ?? ""))
      .filter((p) => p && isRegistryStylePositionId(p))
  );

  const rows: unknown[] = [];
  for (let i = 0; i < pipe.goodsItems.length; i++) {
    const g = pipe.goodsItems[i]!;
    const pid = normGoodsPositionId(g.positionId ?? "");
    if (pid && isRegistryStylePositionId(pid)) continue;

    const full = distinctRegistryPidsSharingCodes(g.codes ?? "", noticeRows, g.name ?? "").sort();
    const cand = (g.positionIdCandidates ?? []).map(String).sort();
    const needles = extractNameDisambiguationNeedles(g.name ?? "");
    const okFree = full.filter((c) => !used.has(c));

    rows.push({
      i,
      st: g.positionIdStatus,
      name: g.name ?? "",
      codes: g.codes ?? "",
      needles,
      candCount: cand.length,
      candidates: cand,
      fullCount: full.length,
      fullPids: full,
      okFreeCount: okFree.length,
      okFree
    });
  }

  const report = {
    goods: pipe.goodsItems.length,
    probCount: probs.length,
    emptyPid: probs.filter((p) => p.problemType === "empty_position_id").length,
    emptyProbTitles,
    counts: pipe.positionIdStatusCounts,
    uniq: new Set(pipe.goodsItems.map((g) => normGoodsPositionId(g.positionId ?? "")).filter(Boolean)).size,
    rows
  };

  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
