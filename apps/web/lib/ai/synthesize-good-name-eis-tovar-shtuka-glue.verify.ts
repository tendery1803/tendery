/**
 * Тенд31: после reconcile имя не остаётся «ТоварШтука…»; кардинальность после merge/dedupe ПФ (целевое 13 по ПФ).
 * Запуск: node ../ai-gateway/node_modules/tsx/dist/cli.mjs lib/ai/synthesize-good-name-eis-tovar-shtuka-glue.verify.ts
 */
import assert from "node:assert/strict";
import path from "node:path";
import { loadTenderDocumentsFromDir, runGoodsDocumentFirstPipelineFromInputs } from "@/lib/ai/goods-regression-batch";

const REPO = path.resolve(process.cwd(), "../..");
const T31 = path.join(REPO, "samples", "regression-goods", "Тенд31");

(async () => {
  const files = await loadTenderDocumentsFromDir(T31);
  const r = runGoodsDocumentFirstPipelineFromInputs(files, null);
  /** После фикса dedupe при коллизии pid|qty|unit: ≥13 строк; 14 — если вместе с блоком ТЗ (ПВХ/полиакрил) как отдельные строки. */
  assert.ok(r.goodsItems.length >= 13, `expected at least 13 goodsItems, got ${r.goodsItems.length}`);

  const names = r.goodsItems.map((g) => (g.name ?? "").trim());
  assert.ok(!names.some((n) => /^ТоварШтука/i.test(n)), `unexpected glued title: ${JSON.stringify(names)}`);

  const ids = r.goodsItems.map((g) => (g.positionId ?? "").replace(/\s/g, "").trim());
  assert.ok(ids.includes("210964253"), "expect internal PF id for смесь");
  assert.ok(ids.filter((x) => x === "210964254").length >= 2, "expect two rows for сэндвич/доска (same wrong pid, split by codes+lineTotal)");
  assert.ok(ids.filter((x) => x === "210964257").length >= 2, "expect two rows for фурнитура (same wrong pid, split by lineTotal)");

  console.log("synthesize-good-name-eis-tovar-shtuka-glue.verify: OK", { goods: r.goodsItems.length });
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
