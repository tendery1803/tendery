/**
 * Harness: Тенд32 — сужение кандидатов + безопасное resolved_auto; кардинальность эталонов.
 * Запуск: cd apps/web && node ../ai-gateway/node_modules/tsx/dist/cli.mjs lib/ai/goods-position-id-narrow.harness.verify.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTenderDocumentsFromDir, runGoodsDocumentFirstPipelineFromInputs } from "@/lib/ai/goods-regression-batch";
import {
  collectGoodsRegressionProblemPositions,
  computeGoodsRegressionQualityMetrics
} from "@/lib/ai/goods-regression-metrics";
import { isRegistryStylePositionId } from "@/lib/ai/registry-position-ids";
import { normGoodsPositionId } from "@/lib/ai/goods-position-id-status";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");

async function main() {
  const rg = path.join(repoRoot, "samples", "regression-goods");

  const cardinality: Record<string, number> = {
    Тенд1: 1,
    Тенд10: 2,
    Тенд14: 8,
    Тенд32: 74,
    Тенд3: 12,
    "тендэксперемент 3": 35
  };

  for (const [name, expectN] of Object.entries(cardinality)) {
    const dir = path.join(rg, name);
    const fileInputs = await loadTenderDocumentsFromDir(dir);
    const pipe = runGoodsDocumentFirstPipelineFromInputs(fileInputs, null);
    if (pipe.goodsItems.length !== expectN) {
      throw new Error(`${name}: expected ${expectN} goods, got ${pipe.goodsItems.length}`);
    }
    if (!pipe.goodsCardinalityCheck.ok) {
      throw new Error(`${name}: cardinality check failed: ${pipe.goodsCardinalityCheck.diagnostic}`);
    }
  }

  const tenderDir = path.join(rg, "Тенд32");
  const fileInputs = await loadTenderDocumentsFromDir(tenderDir);
  const pipe32 = runGoodsDocumentFirstPipelineFromInputs(fileInputs, null);
  const c = pipe32.positionIdStatusCounts;
  if (!c) throw new Error("expected positionIdStatusCounts");

  const sum =
    c.resolved + c.resolved_auto + (c.resolved_manual ?? 0) + c.ambiguous + c.missing;
  if (sum !== 74) {
    throw new Error(`Тенд32 status sum mismatch: ${JSON.stringify(c)}`);
  }

  const probs = collectGoodsRegressionProblemPositions(pipe32.goodsItems);
  const emptyPidProblems = probs.filter((p) => p.problemType === "empty_position_id").length;
  if (emptyPidProblems >= 6) {
    throw new Error(
      `Тенд32: expected fewer than 6 empty_position_id problems, got ${emptyPidProblems}: ${JSON.stringify(probs.filter((p) => p.problemType === "empty_position_id"))}`
    );
  }

  const uniqPid = new Set(
    pipe32.goodsItems
      .map((g) => normGoodsPositionId(g.positionId ?? ""))
      .filter((p) => p && isRegistryStylePositionId(p))
  ).size;
  if (uniqPid < 68) {
    throw new Error(`Тенд32: uniqPid must stay ≥ baseline 68, got ${uniqPid}`);
  }
  const qm = computeGoodsRegressionQualityMetrics(pipe32.goodsItems);
  if (qm.duplicatePositionIds !== 0) {
    throw new Error(`Тенд32: duplicate positionId regression: ${qm.duplicatePositionIds}`);
  }
  if (emptyPidProblems < 6 && qm.uniquePositionIdCount < 69) {
    throw new Error(
      `Тенд32: fewer empty pids should increase uniquePositionIdCount (expect ≥69), got emptyProblems=${emptyPidProblems} unique=${qm.uniquePositionIdCount}`
    );
  }

  const row006 = pipe32.goodsItems.find((g) => /\b006R04368\b/i.test(g.name ?? ""));
  const row257 = pipe32.goodsItems.find(
    (g) => /\bCF257A\b/i.test(g.name ?? "") && /\bHP\b/i.test(g.name ?? "")
  );
  if (row006 && row257) {
    const p006 = normGoodsPositionId(row006.positionId ?? "");
    const p257 = normGoodsPositionId(row257.positionId ?? "");
    if (p006 && p257 && p006 === p257) {
      throw new Error("Тенд32: Xerox 006R04368 and HP CF257A must not share the same registry pid");
    }
  }

  const autoRows = pipe32.goodsItems.filter((g) => g.positionIdStatus === "resolved_auto");
  if (autoRows.length !== c.resolved_auto) throw new Error(`resolved_auto rows: ${autoRows.length} vs ${c.resolved_auto}`);

  for (const g of autoRows) {
    if (!g.positionIdAutoAssigned) throw new Error("resolved_auto without positionIdAutoAssigned");
    const pid = normGoodsPositionId(g.positionId ?? "");
    if (!pid || !isRegistryStylePositionId(pid)) throw new Error("resolved_auto invalid pid");
    if ((g.positionIdCandidates?.length ?? 0) > 0) {
      throw new Error("resolved_auto should not carry positionIdCandidates");
    }
  }

  const pidFreq = new Map<string, number>();
  for (const g of pipe32.goodsItems) {
    const p = normGoodsPositionId(g.positionId ?? "");
    if (!p) continue;
    pidFreq.set(p, (pidFreq.get(p) ?? 0) + 1);
  }
  const dupPid = [...pidFreq.entries()].filter(([, n]) => n > 1);
  if (dupPid.length) {
    throw new Error(`duplicate positionId across goods: ${JSON.stringify(dupPid.slice(0, 5))}`);
  }

  console.log("Тенд32 positionIdStatusCounts:", JSON.stringify(c));
  console.log("Примеры resolved_auto (до: pid пустой) → после:");
  for (const g of autoRows.slice(0, 5)) {
    console.log(
      `  ${(g.name ?? "").slice(0, 44)}\t→\tpid=${g.positionId}\tauto=${g.positionIdAutoAssigned}`
    );
  }
  console.log("OK");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
