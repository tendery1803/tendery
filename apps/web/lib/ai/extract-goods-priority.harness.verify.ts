/**
 * Устойчивый разбор характеристик (merge + relaxed) без БД.
 *   pnpm verify:extract-goods-priority
 */
import assert from "node:assert/strict";
import {
  mergeContinuationLinesForCharacteristics,
  parseRelaxedColonAndTabCharacteristicLines
} from "./extract-goods-from-tech-spec";

const body = [
  "Цвет:",
  "  красный",
  "  металлик",
  "Размер\tXL",
  "Описание: очень длинное значение " + "x".repeat(500)
];
const merged = mergeContinuationLinesForCharacteristics(body);
assert.ok(merged.some((l) => l.includes("красный") && l.includes("металлик")));
const rows = parseRelaxedColonAndTabCharacteristicLines(merged);
const colors = rows.filter((r) => /цвет/i.test(r.name));
assert.ok(colors.length >= 1);
assert.match(colors[0]!.value, /красный.*металлик|металлик.*красный/);
const desc = rows.find((r) => /описание/i.test(r.name));
assert.ok(desc && desc.value.length > 40);
const tab = rows.find((r) => r.name.toLowerCase().includes("размер"));
assert.ok(tab && tab.value === "XL");

console.log("extract-goods-priority.harness.verify: OK");
