/**
 * Самопроверка очистки характеристик товаров:
 *   pnpm -C apps/ai-gateway exec tsx --tsconfig ../web/tsconfig.json ../web/lib/ai/sanitize-tender-analysis-fields.verify.ts
 */
import assert from "node:assert/strict";
import type { TenderAiParseResult } from "@tendery/contracts";
import { sanitizeTenderAiParseResult } from "./sanitize-tender-analysis-fields";

function runSanitize(goodsChars: Array<{ name: string; value: string }>) {
  const input: TenderAiParseResult = {
    summary: "x",
    fields: [],
    procurementKind: "goods",
    procurementMethod: "",
    goodsItems: [
      {
        name: "Тестовый товар",
        positionId: "1",
        codes: "22.19.60.113-00000012",
        unit: "шт",
        quantity: "1",
        unitPrice: "",
        lineTotal: "",
        sourceHint: "",
        characteristics: goodsChars.map((c) => ({ ...c, sourceHint: "" }))
      }
    ],
    servicesOfferings: []
  };
  return sanitizeTenderAiParseResult(input).goodsItems[0]?.characteristics ?? [];
}

/** 1) Служебный/процедурный мусор должен удаляться. */
const cleanedJunk = runSanitize([
  {
    name: "Инструкция по заполнению",
    value: "Участник закупки указывает значение характеристики; обоснование включения дополнительной информации"
  },
  { name: "Материал", value: "Нитрил" }
]);
assert.equal(cleanedJunk.length, 1);
assert.equal(cleanedJunk[0]?.name, "Материал");

/** 2) Похожие ключи не должны схлопываться в один. */
const similarKeys = runSanitize([
  { name: "Цвет картриджа", value: "черный" },
  { name: "Цвет печати", value: "цветная" }
]);
assert.equal(similarKeys.length, 2);
assert.ok(similarKeys.some((c) => /картриджа/i.test(c.name) && /черн/i.test(c.value)));
assert.ok(similarKeys.some((c) => /печати/i.test(c.name) && /цветн/i.test(c.value)));

/** 3) Полезная нестандартная характеристика должна сохраняться даже при «тяжелом» списке. */
const nonStandard = runSanitize([
  { name: "Модель", value: "Модель X-1000 с расширенным ресурсом печати и поддержкой офисной техники" },
  { name: "Цвет картриджа", value: "Черный матовый с устойчивым пигментом для длительного хранения документов" },
  { name: "Класс энергоэффективности оборудования", value: "A++ (подтверждено протоколом испытаний)" },
  { name: "Параметр 1", value: "Очень длинное значение характеристики для имитации насыщенного блока спецификации 1" },
  { name: "Параметр 2", value: "Очень длинное значение характеристики для имитации насыщенного блока спецификации 2" },
  { name: "Параметр 3", value: "Очень длинное значение характеристики для имитации насыщенного блока спецификации 3" },
  { name: "Параметр 4", value: "Очень длинное значение характеристики для имитации насыщенного блока спецификации 4" },
  { name: "Параметр 5", value: "Очень длинное значение характеристики для имитации насыщенного блока спецификации 5" },
  { name: "Параметр 6", value: "Очень длинное значение характеристики для имитации насыщенного блока спецификации 6" },
  { name: "Параметр 7", value: "Очень длинное значение характеристики для имитации насыщенного блока спецификации 7" }
]);
assert.ok(nonStandard.some((c) => /класс энергоэффективности/i.test(c.name)));

/** 4) OCR-артефакт «30–500 С» (потерян ° у 50) — нормализация на пути sanitize → UI. */
const celsiusGarble = runSanitize([
  { name: "Температура хранения", value: "30-500 С" },
  { name: "Температура эксплуатации", value: "от 30 до 500 С" },
  { name: "Материал", value: "Нитрил" }
]);
const tempStore = celsiusGarble.find((c) => /хранен/i.test(c.name));
const tempUse = celsiusGarble.find((c) => /эксплуатац/i.test(c.name));
assert.equal(tempStore?.value, "30–50 °C");
assert.equal(tempUse?.value, "от 30 до 50 °C");
assert.ok(celsiusGarble.some((c) => c.name === "Материал"));

console.log("sanitize-tender-analysis-fields.verify: OK");
