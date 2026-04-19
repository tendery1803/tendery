/**
 * Развязка корпусов analyze: wide для основного промпта, routed для goods pipeline.
 *   pnpm verify:corpus-split-analyze
 */
import assert from "node:assert/strict";
import { buildMinimizedTenderTextForAi } from "./build-minimized-tender-text-for-ai";
import { buildGoodsSourceRoutingReport } from "./goods-source-routing";

const fileInputs = [
  {
    originalName: "notice/izveshchenie.txt",
    extractedText:
      "Извещение. Заказчик ООО Тест. НМЦК 100 000 руб. Реестровый номер 32000000000000000001. ЭТП РТС-тендер."
  },
  {
    originalName: "spec/tz.txt",
    extractedText:
      "Техническое задание. Позиция 1. Картридж HP 05A. КТРУ 123. Количество 5 шт. Характеристики: Цвет: чёрный."
  }
];

const report = buildGoodsSourceRoutingReport(fileInputs);
const wide = buildMinimizedTenderTextForAi(fileInputs, null);
const routed = buildMinimizedTenderTextForAi(fileInputs, { routingReport: report });

assert.equal(wide.stats.routing.enabled, false, "top-fields corpus must not use goods routing");
assert.equal(routed.stats.routing.enabled, true, "goods corpus must use routing");

assert.ok(wide.text.includes("32000000000000000001") || wide.text.includes("РТС"), "wide prompt should retain notice anchors");
assert.ok(routed.text.includes("Картридж") || routed.text.includes("КТРУ"), "routed goods corpus should retain spec");

console.log("corpus-split-analyze.harness.verify: OK");
