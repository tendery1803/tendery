/**
 * Harness: тендэксперемент 2 — 8 позиций, 8 уникальных реестровых pid после order-restore (Canon 067H + sole unused 20…).
 * Запуск: cd apps/web && node ../ai-gateway/node_modules/tsx/dist/cli.mjs lib/ai/experiment2-goods-order-registry-restore.harness.verify.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTenderDocumentsFromDir, runGoodsDocumentFirstPipelineFromInputs } from "@/lib/ai/goods-regression-batch";
import { computeGoodsRegressionQualityMetrics, collectGoodsRegressionProblemPositions } from "@/lib/ai/goods-regression-metrics";
import { isRegistryStylePositionId } from "@/lib/ai/registry-position-ids";
import { normGoodsPositionId } from "@/lib/ai/goods-position-id-status";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");

async function main() {
  const tenderDir = path.join(repoRoot, "samples", "regression-goods", "тендэксперемент 2");
  const fileInputs = await loadTenderDocumentsFromDir(tenderDir);
  const pipe = runGoodsDocumentFirstPipelineFromInputs(fileInputs, null);

  if (pipe.goodsItems.length !== 8) {
    throw new Error(`expected 8 goods, got ${pipe.goodsItems.length}`);
  }
  const m = computeGoodsRegressionQualityMetrics(pipe.goodsItems);
  if (m.uniquePositionIdCount !== 8 || m.duplicatePositionIds !== 0) {
    throw new Error(`expected uniqPid=8 dup=0, got ${JSON.stringify(m)}`);
  }
  const prob = collectGoodsRegressionProblemPositions(pipe.goodsItems);
  if (prob.length !== 0) {
    throw new Error(`expected 0 problems, got ${JSON.stringify(prob)}`);
  }

  for (const g of pipe.goodsItems) {
    const p = normGoodsPositionId(g.positionId ?? "");
    if (!p || !isRegistryStylePositionId(p)) {
      throw new Error(`missing registry pid on row: ${(g.name ?? "").slice(0, 60)}`);
    }
  }

  console.log("name / positionId / positionIdMatchConfidence");
  for (const g of pipe.goodsItems) {
    console.log(
      `${(g.name ?? "").slice(0, 56)}\t${g.positionId}\t${g.positionIdMatchConfidence ?? "—"}`
    );
  }
  console.log("OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
