/**
 * Harness: `positionIdMatchConfidence` после annotate; Тенд32 — снимок счётчиков status (обновлять при смене корпуса ПФ/merge).
 * Запуск: cd apps/web && node ../ai-gateway/node_modules/tsx/dist/cli.mjs lib/ai/goods-position-id-match-confidence.verify.ts
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
import { positionIdMatchConfidenceForTechRowReconcile } from "@/lib/ai/goods-position-id-match-confidence";
import type { TenderAiGoodItem } from "@tendery/contracts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../../..");

function summarizeConfidence(
  items: Array<{ positionId?: string; positionIdMatchConfidence?: string }>
) {
  const exact = items.filter((g) => g.positionIdMatchConfidence === "matched_exact").length;
  const byOrder = items.filter((g) => g.positionIdMatchConfidence === "matched_by_order").length;
  const notFound = items.filter((g) => g.positionIdMatchConfidence === "not_found").length;
  const reg = items.filter((g) => {
    const p = normGoodsPositionId(g.positionId ?? "");
    return Boolean(p && isRegistryStylePositionId(p));
  }).length;
  return { exact, byOrder, notFound, reg, total: items.length };
}

async function main() {
  /** Длина суффикса после «20» в пределах `registry-position-ids` (7–11 цифр). */
  const pid20 = "20123456789";
  const byOrder = positionIdMatchConfidenceForTechRowReconcile({
    finalPositionId: pid20,
    tz: {
      name: "",
      positionId: pid20,
      positionIdMatchConfidence: "matched_by_order",
      codes: "",
      unit: "",
      quantity: "",
      unitPrice: "",
      lineTotal: "",
      characteristics: []
    } as TenderAiGoodItem,
    tzPid: pid20
  });
  if (byOrder !== "matched_by_order") {
    throw new Error(`expected matched_by_order from tz tag, got ${byOrder}`);
  }
  const exact = positionIdMatchConfidenceForTechRowReconcile({
    finalPositionId: pid20,
    tz: {
      name: "",
      positionId: pid20,
      codes: "",
      unit: "",
      quantity: "",
      unitPrice: "",
      lineTotal: "",
      characteristics: []
    } as TenderAiGoodItem,
    tzPid: pid20
  });
  if (exact !== "matched_exact") {
    throw new Error(`expected matched_exact without tag, got ${exact}`);
  }

  const rg = path.join(repoRoot, "samples", "regression-goods");
  const tenderDir = path.join(rg, "Тенд32");
  const fileInputs = await loadTenderDocumentsFromDir(tenderDir);
  const pipe = runGoodsDocumentFirstPipelineFromInputs(fileInputs, null);

  const c = pipe.positionIdStatusCounts;
  if (!c) throw new Error("expected positionIdStatusCounts");
  const sum = c.resolved + c.resolved_auto + (c.resolved_manual ?? 0) + c.ambiguous + c.missing;
  if (sum !== 74) {
    throw new Error(`Тенд32 positionIdStatusCounts sum≠74: ${JSON.stringify(c)}`);
  }

  const probs = collectGoodsRegressionProblemPositions(pipe.goodsItems);
  const emptyPidProblems = probs.filter((p) => p.problemType === "empty_position_id").length;
  if (emptyPidProblems >= 6) {
    throw new Error(
      `Тенд32: expected <6 empty_position_id problems, got ${emptyPidProblems}: ${JSON.stringify(probs.filter((p) => p.problemType === "empty_position_id"))}`
    );
  }
  const qm = computeGoodsRegressionQualityMetrics(pipe.goodsItems);
  if (qm.uniquePositionIdCount < 68) {
    throw new Error(`Тенд32: uniquePositionIdCount must stay ≥68, got ${qm.uniquePositionIdCount}`);
  }
  if (qm.duplicatePositionIds !== 0) {
    throw new Error(`Тенд32: duplicate positionId regression: ${qm.duplicatePositionIds}`);
  }
  if (emptyPidProblems < 6 && qm.uniquePositionIdCount < 69) {
    throw new Error(
      `Тенд32: fewer empty pids should increase uniquePositionIdCount (expect ≥69), got emptyProblems=${emptyPidProblems} unique=${qm.uniquePositionIdCount}`
    );
  }

  const row006 = pipe.goodsItems.find((g) => /\b006R04368\b/i.test(g.name ?? ""));
  const row257 = pipe.goodsItems.find(
    (g) => /\bCF257A\b/i.test(g.name ?? "") && /\bHP\b/i.test(g.name ?? "")
  );
  if (row006 && row257) {
    const p006 = normGoodsPositionId(row006.positionId ?? "");
    const p257 = normGoodsPositionId(row257.positionId ?? "");
    if (p006 && p257 && p006 === p257) {
      throw new Error("Тенд32: Xerox 006R04368 and HP CF257A must not share the same registry pid");
    }
  }

  const s = summarizeConfidence(pipe.goodsItems);
  if (s.exact + s.byOrder + s.notFound !== s.total) {
    throw new Error(`confidence buckets don't sum: ${JSON.stringify(s)}`);
  }
  if (s.reg !== s.exact + s.byOrder) {
    throw new Error(`registry rows should be matched_exact+matched_by_order: ${JSON.stringify(s)}`);
  }

  const indexRestoreDiag = pipe.techSpecBundleDiagnostics.find((d) => d.startsWith("index_notice_position_id_restore="));
  if (indexRestoreDiag) {
    const n = parseInt(indexRestoreDiag.split("=")[1] ?? "0", 10);
    if (n > 0 && s.byOrder < 1) {
      throw new Error(`tech bundle restored ${n} pids by index but no matched_by_order in output: ${JSON.stringify(s)}`);
    }
  }

  for (const g of pipe.goodsItems) {
    const pid = normGoodsPositionId(g.positionId ?? "");
    const reg = Boolean(pid && isRegistryStylePositionId(pid));
    if (reg && g.positionIdMatchConfidence === "not_found") {
      throw new Error("registry pid must not be not_found");
    }
    if (!reg && g.positionIdMatchConfidence !== "not_found") {
      throw new Error("non-registry pid must be not_found");
    }
  }

  console.log("Тенд32 positionIdMatchConfidence:", JSON.stringify(s));
  console.log("OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
