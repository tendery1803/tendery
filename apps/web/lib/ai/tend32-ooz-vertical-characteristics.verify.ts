/**
 * Узкая проверка парсера ООЗ Тенд32. Запуск:
 * node ../ai-gateway/node_modules/tsx/dist/cli.mjs lib/ai/tend32-ooz-vertical-characteristics.verify.ts
 */
import assert from "node:assert/strict";
import path from "node:path";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";
import { loadTenderDocumentsFromDir, runGoodsDocumentFirstPipelineFromInputs } from "@/lib/ai/goods-regression-batch";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import {
  extractTend32OozDescriptionBody,
  tend32OozHasDetailBlockForName,
  tryExtractTend32OozVerticalCharacteristics
} from "@/lib/ai/tend32-ooz-vertical-characteristics";

const REPO = path.resolve(process.cwd(), "../..");
const T32 = path.join(REPO, "samples", "regression-goods", "Тенд32");

void (async () => {
  const files = await loadTenderDocumentsFromDir(T32);
  const routing = buildGoodsSourceRoutingReport(files);
  const min = buildMinimizedTenderTextForAi(files, { routingReport: routing });
  const corpus = maskPiiForAi(min.fullRawCorpusForMasking);
  const ooz = extractTend32OozDescriptionBody(corpus);
  assert.ok(ooz && ooz.length > 10_000, "ooz body");

  assert.equal(tend32OozHasDetailBlockForName(ooz, "Барабан-картридж HP CF257A"), true);
  assert.equal(tend32OozHasDetailBlockForName(ooz, "Тонер-картридж Canon C-EVX60"), false);

  const rows = tryExtractTend32OozVerticalCharacteristics(ooz, "Барабан-картридж HP CF257A");
  if (rows.length < 4) console.log("cf257a", rows);
  assert.ok(rows.length >= 4, `cf257a rows ${rows.length}`);
  assert.ok(rows.some((r) => r.name === "Тип" && r.value.includes("Совместим")), JSON.stringify(rows.slice(0, 3)));

  const roller = tryExtractTend32OozVerticalCharacteristics(
    ooz,
    "Комплект роликов подачи автоподатчика Xerox 022N02894 26.20.40.180 -"
  );
  if (roller.length < 3) console.log("roller debug", roller);
  assert.ok(roller.length >= 3, `roller rows ${roller.length}`);

  const pipe = runGoodsDocumentFirstPipelineFromInputs(files, null);
  const cf = pipe.goodsItems.find((g) => (g.name ?? "").includes("CF257A"));
  assert.ok(cf && (cf.characteristics ?? []).length >= 4, "pipeline attaches for CF257A");

  console.log("tend32-ooz-vertical-characteristics.verify: OK");
})();
