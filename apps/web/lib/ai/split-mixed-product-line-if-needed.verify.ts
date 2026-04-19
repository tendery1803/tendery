/**
 * Запуск: cd apps/web && node ../ai-gateway/node_modules/tsx/dist/cli.mjs lib/ai/split-mixed-product-line-if-needed.verify.ts
 */
import assert from "node:assert/strict";
import { splitMixedProductLineIfNeeded } from "@/lib/ai/split-mixed-product-line-if-needed";

const longTwoProducts =
  "Поставка офисных стульев с подлокотниками, регулировкой высоты и наклона спинки, обивка ткань огнестойкая, " +
  "цвет серый, колёса для твёрдых покрытий, нагрузка до 120 кг, " +
  "поставка офисных кресел руководителя из натуральной кожи, высокая спинка, хромированное основание, цвет чёрный";

const r = splitMixedProductLineIfNeeded(longTwoProducts);
assert.ok(r.name.length < longTwoProducts.length);
assert.ok(r.candidates);
assert.equal(r.candidates![0], r.name);

const short = "Стол подкатной для парикмахерской";
assert.deepEqual(splitMixedProductLineIfNeeded(short), { name: short, candidates: null });

console.log("split-mixed-product-line-if-needed.verify: ok");
