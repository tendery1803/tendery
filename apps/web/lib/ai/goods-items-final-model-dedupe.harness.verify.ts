/**
 * Регрессия: финальная дедупликация goodsItems по модельному ключу и generic ПФ.
 * pnpm run verify:goods-final-model-dedupe
 */
import assert from "node:assert/strict";
import type { TenderAiGoodItem } from "@tendery/contracts";
import {
  computeGoodsItemModelDedupeKey,
  normalizeFinalGoodsItemsByModelDedupe,
  shouldApplyFinalCartridgeTzPfArchetypeLayer
} from "@/lib/ai/goods-items-final-model-dedupe";

function mk(over: Partial<TenderAiGoodItem> & Pick<TenderAiGoodItem, "name">): TenderAiGoodItem {
  return {
    positionId: "",
    codes: "",
    unit: "шт",
    quantity: "",
    unitPrice: "",
    lineTotal: "",
    sourceHint: "",
    characteristics: [],
    quantitySource: "unknown",
    ...over
  };
}

assert.equal(computeGoodsItemModelDedupeKey(mk({ name: "Картридж HP CF259X или эквивалент" })), "cf259x");
assert.equal(computeGoodsItemModelDedupeKey(mk({ name: "Картридж Kyocera TK-1170 или эквивалент" })), "tk1170"); // дефисы снимаются
assert.notEqual(
  computeGoodsItemModelDedupeKey(mk({ name: "Картридж Canon 067H Bk или эквивалент" })),
  computeGoodsItemModelDedupeKey(mk({ name: "Картридж Canon 067H C или эквивалент" })),
  "разные варианты 067H не должны схлопываться в один ключ"
);

const rich = mk({
  name: "Картридж HP CF259X или эквивалент",
  positionId: "208665240",
  codes: "20.59.12.120-00000002",
  quantity: "5",
  quantityValue: 5,
  quantitySource: "tech_spec",
  sourceHint: "tech_spec_deterministic|lp:ТЕХ.ЗАДАНИЕ картриджи 2026.docx",
  characteristics: [
    { name: "Цвет", value: "чёрный", sourceHint: "" },
    { name: "Ресурс", value: "3000 стр", sourceHint: "" }
  ]
});

const lite = mk({
  name: "HP CF259X",
  positionId: "1",
  codes: "",
  quantity: "5",
  quantityValue: 5,
  sourceHint: "notice|lp:Печатная форма.pdf",
  characteristics: []
});

const genericElectro = mk({
  name: "Картридж для электрографических печатающих устройств",
  positionId: "99",
  codes: "20.59.12.120",
  quantity: "1",
  sourceHint: "merged|lp:Печатная форма.pdf",
  characteristics: []
});

const otherModel = mk({
  name: "Картридж Brother TN-3480 или эквивалент",
  positionId: "208665241",
  codes: "",
  quantity: "4",
  quantityValue: 4,
  quantitySource: "tech_spec",
  sourceHint: "tech_spec_deterministic|lp:ТЕХ.ЗАДАНИЕ картриджи 2026.docx",
  characteristics: [{ name: "Цвет", value: "чёрный", sourceHint: "" }]
});

{
  const r = normalizeFinalGoodsItemsByModelDedupe([rich, lite, otherModel, genericElectro]);
  assert.equal(r.items.length, 2, "CF259: один лучший + TN-3480; generic убран");
  assert.ok(r.items.some((g) => (g.name ?? "").includes("TN-3480")));
  const cf = r.items.find((g) => (g.name ?? "").includes("CF259"));
  assert.ok(cf && (cf.characteristics?.length ?? 0) >= 2, "осталась rich-строка с характеристиками");
  assert.ok(r.droppedModelDuplicates >= 1);
  assert.ok(r.droppedGenericPf >= 1);
}

{
  const r = normalizeFinalGoodsItemsByModelDedupe([rich, lite]);
  assert.equal(r.items.length, 1);
  assert.ok((r.items[0]!.characteristics?.length ?? 0) >= 2);
}

/** Как после mergeFallbackLenient: модельные строки без |lp:…docx, generic из ПФ с реестровыми id. */
{
  const ch = [{ name: "п", value: "1", sourceHint: "" }];
  const fallbackModels = [
    mk({
      name: "Картридж HP CF259X или эквивалент",
      positionId: "208665240",
      sourceHint: "",
      quantity: "5",
      quantityValue: 5,
      characteristics: ch
    }),
    mk({
      name: "Картридж HP CE278A или эквивалент",
      positionId: "208665241",
      sourceHint: "",
      quantity: "7",
      quantityValue: 7,
      characteristics: ch
    }),
    mk({
      name: "Картридж Kyocera TK-1170 или эквивалент",
      positionId: "208665242",
      sourceHint: "",
      quantity: "7",
      quantityValue: 7,
      characteristics: ch
    }),
    mk({
      name: "Картридж Brother TN-3480 или эквивалент",
      positionId: "208665243",
      sourceHint: "",
      quantity: "4",
      quantityValue: 4,
      characteristics: ch
    }),
    mk({
      name: "Картридж Canon 067H Bk или эквивалент",
      positionId: "208665244",
      sourceHint: "",
      quantity: "2",
      quantityValue: 2,
      characteristics: ch
    }),
    mk({
      name: "Картридж Canon 067H C или эквивалент",
      positionId: "208665245",
      sourceHint: "",
      quantity: "2",
      quantityValue: 2,
      characteristics: ch
    }),
    mk({
      name: "Картридж Canon 067H M или эквивалент",
      positionId: "208665250",
      sourceHint: "",
      quantity: "2",
      quantityValue: 2,
      characteristics: ch
    }),
    mk({
      name: "Картридж Canon 067H Y или эквивалент",
      positionId: "208665251",
      sourceHint: "",
      quantity: "2",
      quantityValue: 2,
      characteristics: ch
    })
  ];
  const genericPf = ["208665246", "208665247", "208665248", "208665249"].map((pid) =>
    mk({
      name: "Картридж для электрографических печатающих устройств",
      positionId: pid,
      sourceHint: "",
      codes: "20.59.12.120-00000002",
      quantity: "1",
      quantityValue: 1,
      characteristics: []
    })
  );
  const r = normalizeFinalGoodsItemsByModelDedupe([...fallbackModels, ...genericPf]);
  assert.equal(r.items.length, 8, "12 → 8: убрать 4 generic electro при модельных строках без TZ hint");
  assert.equal(r.droppedGenericPf, 4);
  assert.ok(r.items.every((g) => !/электрографическ/i.test(g.name ?? "")));
}

{
  const weakModel = mk({
    name: "HP CF259X",
    positionId: "1",
    codes: "",
    quantity: "",
    characteristics: [],
    quantitySource: "unknown"
  });
  const fourGen = ["208665246", "208665247", "208665248", "208665249"].map((pid) =>
    mk({
      name: "Картридж для электрографических печатающих устройств",
      positionId: pid,
      codes: "20.59.12.120",
      quantity: "1",
      quantityValue: 1,
      characteristics: [],
      quantitySource: "unknown"
    })
  );
  const r = normalizeFinalGoodsItemsByModelDedupe([weakModel, ...fourGen]);
  assert.equal(r.items.length, 5, "guard: одна слабая модель — generic electro не снимаем");
  assert.equal(r.droppedGenericPf, 0);
  assert.ok(
    r.diagnostics.some((d) => d.includes("generic_pf_cleanup_skipped")),
    "ожидаем маркер пропуска агрессивного generic cleanup"
  );
}

{
  const oneStrong = mk({
    name: "Картридж HP CF259X или эквивалент",
    positionId: "208665240",
    quantity: "5",
    quantityValue: 5,
    quantitySource: "tech_spec",
    characteristics: [
      { name: "Цвет", value: "чёрный", sourceHint: "" },
      { name: "Ресурс", value: "3000", sourceHint: "" }
    ]
  });
  const fourGen = ["208665246", "208665247", "208665248", "208665249"].map((pid) =>
    mk({
      name: "Картридж для электрографических печатающих устройств",
      positionId: pid,
      codes: "20.59.12.120",
      quantity: "1",
      quantityValue: 1,
      characteristics: [],
      quantitySource: "unknown"
    })
  );
  const r = normalizeFinalGoodsItemsByModelDedupe([oneStrong, ...fourGen]);
  assert.equal(r.items.length, 1, "одна сильная модель + 4 generic → остаётся одна позиция");
  assert.equal(r.droppedGenericPf, 4);
}

/** Регрессия: бытовая химия / прочие товары — слой в проде не включается без архетипа; прямой вызов normalize всё ещё может CE-схлопывать (документируем риск). */
{
  const householdLike = [
    mk({
      name: "Пятновыводитель и отбеливатель",
      positionId: "1",
      codes: "20.41.32.125",
      quantity: "84",
      quantityValue: 84,
      characteristics: [{ name: "Срок годности", value: "не более 12 мес", sourceHint: "" }]
    }),
    mk({
      name: "Кислородный отбеливатель и пятновыводитель",
      positionId: "2",
      codes: "20.41.32.125",
      quantity: "84",
      quantityValue: 84,
      characteristics: [{ name: "Срок годности", value: "24 мес", sourceHint: "" }]
    }),
    mk({
      name: "Чистящее средство для сантехники",
      positionId: "3",
      codes: "20.41.32.119",
      quantity: "990",
      quantityValue: 990,
      characteristics: []
    }),
    mk({
      name: "Стиральный порошок АРИЭЛЬ автомат",
      positionId: "4",
      codes: "20.41.32.119",
      quantity: "1",
      quantityValue: 1,
      characteristics: [{ name: "Масса", value: "3 кг", sourceHint: "" }]
    })
  ];
  assert.equal(
    shouldApplyFinalCartridgeTzPfArchetypeLayer(householdLike, []),
    false,
    "бытовая химия: нет картриджных наименований и не было cross_source dedupe в бандле"
  );
  assert.equal(
    shouldApplyFinalCartridgeTzPfArchetypeLayer(householdLike, ["notice_det=2,merged_deterministic=2"]),
    false,
    "посторонние diagnostics не считаются архетипом"
  );
}

{
  const ceMarkingDupes = [
    mk({
      name: "Чистящее средство А",
      positionId: "1",
      characteristics: [{ name: "Маркировка", value: "соответствие CE 1935", sourceHint: "" }]
    }),
    mk({
      name: "Чистящее средство Б",
      positionId: "2",
      characteristics: [{ name: "Маркировка", value: "соответствие CE 1935", sourceHint: "" }]
    })
  ];
  assert.equal(shouldApplyFinalCartridgeTzPfArchetypeLayer(ceMarkingDupes, []), false);
  const collapsed = normalizeFinalGoodsItemsByModelDedupe(ceMarkingDupes);
  assert.equal(
    collapsed.items.length,
    1,
    "без gate одинаковый CE-токен в характеристиках даёт ложное схлопывание"
  );
}

assert.equal(shouldApplyFinalCartridgeTzPfArchetypeLayer([rich, lite], []), true, "картридж в наименовании");
assert.equal(
  shouldApplyFinalCartridgeTzPfArchetypeLayer(
    [
      mk({ name: "HP CF259X", positionId: "1", quantity: "5", quantityValue: 5 }),
      mk({ name: "HP CF259X", positionId: "2", quantity: "5", quantityValue: 5 })
    ],
    ["cross_source_position_dedupe:dropped=1"]
  ),
  true,
  "имя без «Картридж», но в бандле сработал cross-source dedupe ПФ↔ТЗ"
);

console.log("goods-items-final-model-dedupe.harness.verify: OK");
