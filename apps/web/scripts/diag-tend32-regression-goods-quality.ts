/**
 * Диагностика Тенд32 в regression-goods: имена, длины, positionId, типы проблем регрессии.
 * Не меняет данные. Запуск: cd apps/web && node ../ai-gateway/node_modules/tsx/dist/cli.mjs scripts/diag-tend32-regression-goods-quality.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadTenderDocumentsFromDir,
  runGoodsDocumentFirstPipelineFromInputs
} from "@/lib/ai/goods-regression-batch";
import {
  collectGoodsRegressionProblemsByItemIndex,
  computeGoodsRegressionQualityMetrics
} from "@/lib/ai/goods-regression-metrics";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function normPid(pid: string): string {
  return (pid ?? "").replace(/^№\s*/i, "").trim();
}

async function main() {
  const repoRoot = path.resolve(__dirname, "../../..");
  const tenderDir = path.join(repoRoot, "samples", "regression-goods", "Тенд32");
  const fileInputs = await loadTenderDocumentsFromDir(tenderDir);
  const pipe = runGoodsDocumentFirstPipelineFromInputs(fileInputs, null);
  const items = pipe.goodsItems;
  const metrics = computeGoodsRegressionQualityMetrics(items);
  const byIdx = collectGoodsRegressionProblemsByItemIndex(items);

  const freq = new Map<string, number>();
  for (const g of items) {
    const p = normPid(g.positionId ?? "");
    if (!p) continue;
    freq.set(p, (freq.get(p) ?? 0) + 1);
  }
  const dupExamples: string[] = [];
  for (const [p, c] of freq) {
    if (c > 1) dupExamples.push(`${p} ×${c}`);
  }

  console.log("=== Тенд32 regression-goods ===");
  console.log("cardinality:", items.length, "techBundle rows:", pipe.techBundleItemCount);
  console.log("cardinality check:", pipe.goodsCardinalityCheck.diagnostic);
  console.log("metrics:", metrics);
  console.log("non-empty pid unique:", freq.size, "dupPid strings:", dupExamples.length ? dupExamples.join("; ") : "(none)");

  const sampleIdx = [0, 1, 2, 3, 4, 10, 15, 20, 25, 28].filter((i) => i < items.length);
  console.log("\n--- 10 фиксированных индексов (имя, длина, pid, статус, проблемы) ---");
  for (const i of sampleIdx) {
    const g = items[i]!;
    const name = g.name ?? "";
    const probs = byIdx.get(i) ?? [];
    console.log(
      `\n#${i + 1} len=${name.length} pid=${JSON.stringify(g.positionId)} status=${g.positionIdStatus ?? "—"}`
    );
    console.log(" problems:", probs.join(", ") || "(none)");
    console.log(" name:", name);
  }

  const longest = items
    .map((g, i) => ({ i, len: (g.name ?? "").length, name: g.name ?? "" }))
    .sort((a, b) => b.len - a.len)
    .slice(0, 5);
  console.log("\n--- 5 самых длинных name ---");
  for (const x of longest) {
    console.log(`#${x.i + 1} len=${x.len}`, x.name);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
