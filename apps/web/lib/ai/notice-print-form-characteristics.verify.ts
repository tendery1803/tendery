/**
 * Узкая регрессия: Тенд25 — характеристики из блока ПФ после «ТоварШтука».
 * Запуск: node ../ai-gateway/node_modules/tsx/dist/cli.mjs lib/ai/notice-print-form-characteristics.verify.ts
 */
import assert from "node:assert/strict";
import path from "node:path";
import { loadTenderDocumentsFromDir, runGoodsDocumentFirstPipelineFromInputs } from "@/lib/ai/goods-regression-batch";
import { computeGoodsRegressionQualityMetrics } from "@/lib/ai/goods-regression-metrics";

const REPO = path.resolve(process.cwd(), "../..");
const T25 = path.join(REPO, "samples", "regression-goods", "Тенд25");

(async () => {
  const files = await loadTenderDocumentsFromDir(T25);
  const r = runGoodsDocumentFirstPipelineFromInputs(files, null);
  const m = computeGoodsRegressionQualityMetrics(r.goodsItems);

  assert.equal(m.goodsCount, 13);
  // Только позиции с ТоварШтука-блоками имеют характеристики (210964254, 210964262, 210964264).
  const withChars = r.goodsItems.filter((g) => (g.characteristics ?? []).length >= 1);
  assert.ok(withChars.length >= 3, `expected ≥3 items with characteristics, got ${withChars.length}`);

  console.log("notice-print-form-characteristics.verify: OK");
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
