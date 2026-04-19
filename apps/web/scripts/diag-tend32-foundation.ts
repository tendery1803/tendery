/**
 * Основа для следующего шага по Тенд32 (без изменения парсера).
 *
 * Запуск: cd apps/web && node ../ai-gateway/node_modules/tsx/dist/cli.mjs scripts/diag-tend32-foundation.ts
 *
 * Печатает:
 * - метрики goods / uniquePid / problemPositions (как в goods-regression);
 * - распределение problemType;
 * - примеры строк с «Тип» + «х» / model-only после полной строки картриджа в strict-tech (контекст из корпуса).
 *
 * Post-filter matrix-rows: см. `applyTechSpecMatrixCharacteristicRowPostFilter` в extract-goods-from-tech-spec (узкий гейт).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import { loadTenderDocumentsFromDir, runGoodsDocumentFirstPipelineFromInputs } from "@/lib/ai/goods-regression-batch";
import {
  collectGoodsRegressionProblemPositions,
  computeGoodsRegressionQualityMetrics
} from "@/lib/ai/goods-regression-metrics";
import { buildGoodsCorpusClassification, extractPriorityLayersForGoodsTech } from "@/lib/ai/masked-corpus-sources";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const T32 = path.resolve(__dirname, "../../../samples/regression-goods/Тенд32");

function normKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .slice(0, 96)
    .trim();
}

async function main() {
  const files = await loadTenderDocumentsFromDir(T32);
  const routing = buildGoodsSourceRoutingReport(files);
  const minimized = buildMinimizedTenderTextForAi(files, { routingReport: routing });
  const masked = maskPiiForAi(minimized.fullRawCorpusForMasking);
  const pipe = runGoodsDocumentFirstPipelineFromInputs(files, null);
  const met = computeGoodsRegressionQualityMetrics(pipe.goodsItems);
  const problems = collectGoodsRegressionProblemPositions(pipe.goodsItems);

  console.log("=== pipeline goods (Тенд32) ===");
  console.log("goodsCount", met.goodsCount, "uniquePid", met.uniquePositionIdCount, "dupPid", met.duplicatePositionIds);
  console.log("problemPositions", problems.length);

  const byType = new Map<string, number>();
  for (const p of problems) {
    byType.set(p.problemType, (byType.get(p.problemType) ?? 0) + 1);
  }
  console.log("\n=== problemType counts ===");
  for (const [k, v] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }

  console.log("\n=== sample goods rows (name, positionId, sourceHint tail) ===");
  for (const g of pipe.goodsItems.slice(0, 18)) {
    const hint = (g.sourceHint ?? "").replace(/\s+/g, " ").trim().slice(-80);
    console.log(
      `  pid=${JSON.stringify((g.positionId ?? "").trim())} name=${JSON.stringify((g.name ?? "").slice(0, 72))} … ${hint}`
    );
  }

  const slice = extractPriorityLayersForGoodsTech(masked);
  const c = buildGoodsCorpusClassification(slice.corpusForGoodsTechExtraction);
  const lines = c.strictTechText.split("\n");
  console.log("\n=== strict-tech: «Тонер-картридж» then next lines (first 2 hits) ===");
  let hits = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!/Тонер-картридж|Барабан-картридж/i.test(lines[i] ?? "")) continue;
    console.log(`--- idx ${i}: ${JSON.stringify((lines[i] ?? "").slice(0, 100))}`);
    for (let j = i + 1; j < Math.min(lines.length, i + 10); j++) {
      console.log(`   ${j}: ${JSON.stringify((lines[j] ?? "").slice(0, 80))}`);
    }
    if (++hits >= 2) break;
  }

  console.log("\n=== strict-tech: голый «1» + «Тип» + «х»… (first hit) ===");
  for (let i = 0; i < lines.length - 8; i++) {
    if ((lines[i] ?? "").trim() !== "1") continue;
    if (!/^тип$/i.test((lines[i + 2] ?? "").trim())) continue;
    console.log(`ordinal at ${i}`);
    for (let j = i; j < Math.min(lines.length, i + 14); j++) {
      console.log(`  ${j}: ${JSON.stringify((lines[j] ?? "").slice(0, 90))}`);
    }
    break;
  }

  console.log("\n=== name-key clusters (count>=2) ===");
  const m = new Map<string, number>();
  for (const g of pipe.goodsItems) {
    const k = normKey(g.name ?? "");
    if (!k) continue;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  const top = [...m.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]);
  for (const [k, n] of top.slice(0, 12)) {
    console.log(`  ${n}x ${k.slice(0, 88)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
