/**
 * Локальная проверка: top-level block в name + quantity с единицей измерения.
 * Запуск: pnpm -C apps/worker exec tsx ../web/lib/ai/parse-model-json-goods-selftest.ts
 */
import assert from "node:assert/strict";
import type { TenderAiGoodItem } from "@tendery/contracts";
import { finalizeGoodsItemsFromModelOutput } from "./parse-model-json";

function base(partial: Partial<TenderAiGoodItem> & Pick<TenderAiGoodItem, "name" | "quantity">): TenderAiGoodItem {
  return {
    positionId: "",
    codes: "",
    unit: "шт",
    unitPrice: "",
    lineTotal: "",
    sourceHint: "",
    characteristics: [],
    ...partial
  };
}

const singleCases: Array<{ label: string; item: TenderAiGoodItem; expectQty: string }> = [
  {
    label: "model put unit price as qty; header has N шт before характеристики с 3000/255",
    item: base({
      name: "1. HP CF259X 20.59.12.120-00000002 208665247 5 шт 255,00 руб\nХарактеристики\nРесурс 3000 стр\nЦена тонера 255",
      quantity: "255"
    }),
    expectQty: "5"
  },
  {
    label: "decimal price as qty; header has integer шт",
    item: base({
      name: "2. Kyocera TK-1170 ... 7 шт 94,50 руб\nХарактеристики\nОбъём 3000 отпечатков",
      quantity: "94.5"
    }),
    expectQty: "7"
  },
  {
    label: "wrong small integer from model; header 4 шт",
    item: base({
      name: "8. Brother TN-3480 ... 4 шт 24,00 руб\nХарактеристики\nРесурс 3000 стр",
      quantity: "24"
    }),
    expectQty: "4"
  },
  {
    label: "qty on second line within top block",
    item: base({
      name: "3. HP CE278A\n20.59.12.120-00000002 208665248 7 шт\nХарактеристики\n3000 страниц",
      quantity: "3000"
    }),
    expectQty: "7"
  }
];

for (const c of singleCases) {
  const [out] = finalizeGoodsItemsFromModelOutput([c.item]);
  assert.equal(out.quantity, c.expectQty, c.label);
  assert.ok(
    !/Характеристик/i.test(out.name),
    `${c.label}: name should not include characteristics section`
  );
}

const eight: TenderAiGoodItem[] = Array.from({ length: 8 }, (_, i) =>
  base({
    name: `${i + 1}. Картридж поз.${i + 1} 20.59.12.120-00000002 ${i + 2} шт 100,00 руб\nХарактеристики\nРесурс ${3000 + i} стр\nЛишнее число 255`,
    quantity: "255"
  })
);
const out8 = finalizeGoodsItemsFromModelOutput(eight);
assert.equal(out8.length, 8);
for (let i = 0; i < 8; i++) {
  assert.equal(out8[i]!.quantity, String(i + 2), `row ${i + 1} qty`);
  assert.ok(!/Характеристик/i.test(out8[i]!.name), `row ${i + 1} name trimmed`);
}

console.log("parse-model-json goods selftest: OK", singleCases.length + 1, "groups");
