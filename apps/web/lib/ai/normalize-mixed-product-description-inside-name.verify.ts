/**
 * Реальные фрагменты из regression-goods: Тенд3, тендэксперемент 3.
 * Запуск: cd apps/web && node ../ai-gateway/node_modules/tsx/dist/cli.mjs lib/ai/normalize-mixed-product-description-inside-name.verify.ts
 */
import assert from "node:assert/strict";
import { normalizeMixedProductDescriptionInsideName } from "@/lib/ai/normalize-mixed-product-description-inside-name";

const накидка = "Накидка для парикмахера Практичный и удобный пеньюар";
const пятна =
  'Пятновыводитель и отбеливатель "БОС плюс Maximum" 600 гр, кислородный, без хлора, для всех видов тканей';
const сода =
  "Сода кальцинированная моющее водосмягчающее средство. Объём – 600 г. В бумажной упаковке.";
const прожектор =
  "Прожектор сценического освещения, Тип 1 27.40.33.190-00000002 Тип прожектора PAR";

assert.equal(normalizeMixedProductDescriptionInsideName(накидка), "Накидка для парикмахера");
assert.equal(
  normalizeMixedProductDescriptionInsideName(пятна),
  'Пятновыводитель и отбеливатель "БОС плюс Maximum" 600 гр'
);
assert.equal(
  normalizeMixedProductDescriptionInsideName(сода),
  "Сода кальцинированная моющее водосмягчающее средство"
);
assert.equal(normalizeMixedProductDescriptionInsideName(прожектор), прожектор);

console.log("normalize-mixed-product-description-inside-name.verify: ok");
