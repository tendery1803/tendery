/**
 * Количество vs единица: отдельные колонки и перепутанные поля модели.
 *   pnpm verify:goods-quantity-extraction
 */
import assert from "node:assert/strict";
import { coerceGoodsQuantityUnitFields } from "./match-goods-across-sources";
import {
  lineLooksLikeTechSpecGoodsRow,
  pickSpecificationQuantityFromLines
} from "./extract-goods-from-tech-spec";

const blockSplitLines = [
  "1. Картридж HP 05A",
  "КТРУ 32.50.11.190-00000001",
  "Количество: 12",
  "Единица измерения: Штука"
];
const picked = pickSpecificationQuantityFromLines(blockSplitLines, { skipCharacteristicLines: false });
assert.ok(picked);
assert.equal(picked!.quantity, "12");
assert.match(picked!.unit, /штук/i);

assert.ok(
  lineLooksLikeTechSpecGoodsRow("Картридж для"),
  "граница «слова» для кириллицы: старт позиции «Картридж для»"
);

const eisGlued = pickSpecificationQuantityFromLines(
  ["Картридж для", "x", "x", "x", "x", "x", "x", "x", "x", "ТоварШтука4000.00"],
  { skipCharacteristicLines: true }
);
assert.ok(eisGlued);
assert.equal(eisGlued!.quantity, "4000");
assert.match(eisGlued!.unit, /штук/i);

const coercedSwap = coerceGoodsQuantityUnitFields("Штука", "24");
assert.equal(coercedSwap.quantity, "24");
assert.match(coercedSwap.unit, /^Штук/i);

const coercedOk = coerceGoodsQuantityUnitFields("3", "шт");
assert.equal(coercedOk.quantity, "3");
assert.ok(coercedOk.unit);

console.log("goods-quantity-extraction.harness.verify: OK");
