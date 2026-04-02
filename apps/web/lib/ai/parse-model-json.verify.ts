/**
 * Самопроверка parseTenderAiResult (запуск из корня монорепо):
 *   pnpm -C apps/ai-gateway exec tsx ../web/lib/ai/parse-model-json.verify.ts
 */
import assert from "node:assert/strict";
import { parseTenderAiResult } from "./parse-model-json";

const ok = parseTenderAiResult('{"summary":"x","fields":[]}');
assert.equal(ok.ok, true);
if (ok.ok) {
  assert.equal(ok.data.summary, "x");
  assert.deepEqual(ok.data.goodsItems, []);
  assert.equal(ok.data.procurementKind, "unknown");
}

const okFull = parseTenderAiResult(
  '{"summary":"s","fields":[],"procurementKind":"goods","goodsItems":[],"servicesOfferings":[]}'
);
assert.equal(okFull.ok, true);

const bad = parseTenderAiResult("not {]");
assert.equal(bad.ok, false);
if (!bad.ok) assert.equal(bad.error, "json_parse_failed");

const empty = parseTenderAiResult("  \n");
assert.equal(empty.ok, false);
if (!empty.ok) assert.equal(empty.error, "empty_output");

const mismatch = parseTenderAiResult('{"foo":1}');
assert.equal(mismatch.ok, false);
if (!mismatch.ok) assert.equal(mismatch.error, "schema_mismatch");

/** Корневой массив: первый кандидат (trim) — массив, Zod fail; затем balanced_object — объект внутри. */
const arrayRoot = '[{"summary":"in array","fields":[]}]';
const arr = parseTenderAiResult(arrayRoot);
assert.equal(arr.ok, true);

/** Допуск «почти-валидных» типов: confidence строкой, null/string-number в полях и товарах. */
const relaxed = parseTenderAiResult(
  JSON.stringify({
    summary: null,
    fields: [{ key: "nmck", label: "НМЦК", value: 12345, confidence: "0,84" }],
    procurementKind: "goods",
    procurementMethod: null,
    goodsItems: [
      {
        name: "Товар A",
        positionId: 1,
        codes: 123,
        unit: null,
        quantity: 10,
        unitPrice: null,
        lineTotal: 999,
        sourceHint: null,
        characteristics: [{ name: "Цвет", value: null, sourceHint: null }]
      }
    ]
  })
);
assert.equal(relaxed.ok, true);
if (relaxed.ok) {
  assert.equal(relaxed.data.summary, "");
  assert.equal(relaxed.data.procurementMethod, "");
  assert.equal(relaxed.data.fields[0]?.confidence, 0.84);
  assert.equal(relaxed.data.fields[0]?.value, "12345");
  assert.equal(relaxed.data.goodsItems[0]?.positionId, "1");
  assert.equal(relaxed.data.goodsItems[0]?.characteristics[0]?.value, "");
}

console.log("parse-model-json.verify: OK");
