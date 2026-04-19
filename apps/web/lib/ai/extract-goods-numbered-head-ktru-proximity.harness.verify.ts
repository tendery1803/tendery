/**
 * Регрессия: нумерованные позиции ТЗ/ООЗ, где первая строка — только наименование товара
 * (бытовая химия и т.п.), без слов «товар», «КТРУ» в заголовке; КТРУ/ОКПД ниже по блоку.
 *   pnpm run verify:extract-goods-numbered-head-ktru-proximity
 */
import assert from "node:assert/strict";
import { extractGoodsFromTechSpec } from "@/lib/ai/extract-goods-from-tech-spec";

function segmentTechCorpus(body: string): string {
  return `--- Техническое задание на поставку бытовой химии.docx ---
${body}`;
}

const householdLikeTz = [
  "Наименование товара: наименование",
  "КТРУ: код",
  "Количество: кол-во",
  "Единица измерения: шт",
  "",
  "1. Пятновыводитель и отбеливатель концентрированный",
  "КТРУ 20.41.32.125-00000001",
  "Количество: 84 шт",
  "Срок годности: не более 12 мес",
  "",
  "2. Гель для мытья посуды универсальный",
  "20.41.32.119",
  "Количество: 990 шт",
  "",
  "3. Стиральный порошок автомат",
  "ОКПД 20.41.32.119",
  "Количество: 1 шт"
].join("\n");

const r = extractGoodsFromTechSpec(segmentTechCorpus(householdLikeTz));
assert.equal(
  r.items.length,
  3,
  `ожидаем три позиции по нумерации + КТРУ/ОКПД рядом, без хардкода номеров в логике; получено ${r.items.length}`
);
const names = r.items.map((g) => g.name.toLowerCase());
assert.ok(names.some((n) => n.includes("пятновыводитель")), "первая позиция по формату наименования");
assert.ok(names.some((n) => n.includes("гель")), "вторая позиция");
assert.ok(names.some((n) => n.includes("стиральн")), "третья позиция");
assert.ok(
  !r.diagnostics.some((d) => d.startsWith("position_block_backbone:")),
  "синтетика без якорей Идентификатор — backbone не обязателен"
);

console.log("extract-goods-numbered-head-ktru-proximity.harness.verify: OK");
