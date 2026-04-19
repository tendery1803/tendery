/**
 * Узкие проверки на строках из regression-goods (Тенд3, тендэксперемент 3, Тенд14).
 * Запуск: cd apps/web && node ../ai-gateway/node_modules/tsx/dist/cli.mjs lib/ai/extract-clean-product-name-from-mixed-line.verify.ts
 */
import assert from "node:assert/strict";
import { extractCleanProductNameFromMixedLine } from "@/lib/ai/extract-clean-product-name-from-mixed-line";
import { trimNonProductRequirementTailFromName } from "@/lib/ai/trim-non-product-requirement-tail-from-name";

const chair =
  "Кресло для парикмахерской Размеры (ВхШхД): 460 - 570x600x510 мм (+/- 50мм), Внутренние размеры (ВхШхГ): 450x460x450 мм (+/- 50мм)";
const cape =
  "Накидка для парикмахера Практичный и удобный пеньюар, для защиты одежды в процессе стрижки, окрашивания, мытья головы. Изделие выполнено из водоотталкивающего полиэстера. Стандартный размер не менее 128 х 150 см,";
const stain =
  'Пятновыводитель и отбеливатель "БОС плюс Maximum" 600 гр, кислородный, без хлора, для всех видов тканей. Средство отбеливающее порошкообразное предназначено для отбеливания хлопчатобумажных, льняных, смесовых,';

const par =
  "Прожектор сценического освещения, Тип 1 27.40.33.190-00000002 Тип прожектора PAR Значение характеристики не может изменяться участником закупки";

function clean(n: string): string {
  return extractCleanProductNameFromMixedLine(trimNonProductRequirementTailFromName(n));
}

assert.equal(clean(chair), "Кресло для парикмахерской");
assert.equal(
  clean(cape),
  "Накидка для парикмахера Практичный и удобный пеньюар"
);
assert.equal(
  clean(stain),
  'Пятновыводитель и отбеливатель "БОС плюс Maximum" 600 гр, кислородный, без хлора, для всех видов тканей'
);

const parTrimmed = trimNonProductRequirementTailFromName(par);
assert.ok(parTrimmed.endsWith("PAR"));
assert.equal(extractCleanProductNameFromMixedLine(parTrimmed), parTrimmed);

console.log("extract-clean-product-name-from-mixed-line.verify: ok");
