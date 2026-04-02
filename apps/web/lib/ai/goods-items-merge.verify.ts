/**
 * Самопроверка merge ключей товаров:
 *   pnpm -C apps/ai-gateway exec tsx --tsconfig ../web/tsconfig.json ../web/lib/ai/goods-items-merge.verify.ts
 */
import assert from "node:assert/strict";
import type { TenderAiGoodItem } from "@tendery/contracts";
import { mergeGoodsItemsListsWithDiagnostics } from "./goods-items-merge";

function makeGood(partial: Partial<TenderAiGoodItem>): TenderAiGoodItem {
  return {
    name: "",
    positionId: "",
    codes: "",
    unit: "",
    quantity: "",
    unitPrice: "",
    lineTotal: "",
    sourceHint: "",
    characteristics: [],
    ...partial
  };
}

/** Один и тот же короткий № п/п в разных таблицах: не должны схлопываться в одну позицию. */
const separate = mergeGoodsItemsListsWithDiagnostics(
  [
    makeGood({
      name: "Картридж лазерный черный",
      positionId: "1",
      codes: "26.20.40.120-00000001",
      quantity: "2",
      unit: "шт"
    })
  ],
  [
    makeGood({
      name: "Бумага офисная",
      positionId: "1",
      codes: "17.12.14.129-00000002",
      quantity: "20",
      unit: "пач"
    })
  ]
);
assert.equal(separate.merged.length, 2);

/** Одинаковая позиция в двух проходах должна продолжать merge в одну строку. */
const mergedSame = mergeGoodsItemsListsWithDiagnostics(
  [
    makeGood({
      name: "Перчатки медицинские",
      positionId: "2",
      codes: "22.19.60.113-00000012",
      quantity: "100",
      unit: "пар"
    })
  ],
  [
    makeGood({
      name: "Перчатки медицинские нитриловые",
      positionId: "2",
      codes: "22.19.60.113-00000012",
      quantity: "100",
      unit: "пар",
      characteristics: [{ name: "Размер", value: "M", sourceHint: "" }]
    })
  ]
);
assert.equal(mergedSame.merged.length, 1);
assert.equal(mergedSame.merged[0]?.characteristics.length, 1);

/** Для supplement: core-поля основной строки не должны перезаписываться. */
const protectedCore = mergeGoodsItemsListsWithDiagnostics(
  [
    makeGood({
      name: "Картридж Canon",
      positionId: "3",
      codes: "26.20.40.120-00000999",
      quantity: "8",
      unit: "шт"
    })
  ],
  [
    makeGood({
      name: "Картридж Canon (ошибочная вариация)",
      positionId: "3",
      codes: "26.20.40.120-00000999",
      quantity: "8",
      unit: "шт"
    })
  ],
  { preservePrimaryCoreFields: true }
);
assert.equal(protectedCore.merged.length, 1);
assert.equal(protectedCore.merged[0]?.name, "Картридж Canon");
assert.equal(protectedCore.merged[0]?.quantity, "8");

console.log("goods-items-merge.verify: OK");
