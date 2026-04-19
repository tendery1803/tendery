/**
 * Регресс: печатная форма ЕИС — короткое имя, пустой п/п, один ОКПД, разные quantity.
 * filterGoodsItemsTechPriorityRegion не должен схлопывать в одну строку.
 *   pnpm verify:stabilize-goods-tech-priority
 */
import assert from "node:assert/strict";
import type { TenderAiGoodItem } from "@tendery/contracts";
import { stabilizeGoodsItems } from "./stabilize-goods-items";

function eisLikeRow(qty: number): TenderAiGoodItem {
  return {
    name: "Картридж для",
    positionId: "",
    codes: "20.59.12.120",
    unit: "шт",
    quantity: String(qty),
    unitPrice: "",
    lineTotal: "",
    sourceHint: "tech_spec_deterministic|test",
    characteristics: [],
    quantityValue: qty,
    quantityUnit: "шт",
    quantitySource: "tech_spec"
  };
}

const three = [eisLikeRow(4000), eisLikeRow(2000), eisLikeRow(800)];
const out = stabilizeGoodsItems(three, {
  corpus: "",
  nmckText: "",
  techSpecDeterministicMode: true
});
assert.equal(out.length, 3, "три разных количества — три позиции после stabilize");

console.log("stabilize-goods-items-tech-priority.harness.verify: OK");
