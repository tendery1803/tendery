/**
 * Самопроверка trusted table_max_position detection:
 *   pnpm -C apps/ai-gateway exec tsx --tsconfig ../web/tsconfig.json ../web/lib/ai/goods-expected-items.verify.ts
 */
import assert from "node:assert/strict";
import { inferExpectedGoodsCoverage } from "./goods-expected-items";

const corpus = `
1. Картридж 26.20.40.120-00000001 8 шт
2. Картридж 26.20.40.120-00000002 8 шт
3. Картридж 26.20.40.120-00000003 8 шт
4. Картридж 26.20.40.120-00000004 8 шт
5. Картридж 26.20.40.120-00000005 8 шт
6. Картридж 26.20.40.120-00000006 8 шт
7. Картридж 26.20.40.120-00000007 8 шт
8. Картридж 26.20.40.120-00000008 8 шт

Характеристики товара:
20. Значение характеристики не может изменяться участником закупки
24. Обоснование включения дополнительной информации
25. Инструкция по заполнению заявки
`;

const got = inferExpectedGoodsCoverage(corpus);
assert.equal(got.detectionSource, "table_max_position");
assert.equal(got.expectedItemsCount, 8);
assert.deepEqual(got.expectedPositionIds, ["1", "2", "3", "4", "5", "6", "7", "8"]);

const noisyBareOrdinals = `
1. Позиция
2. Позиция
3. Позиция
4. Позиция
20. Дополнительная информация
24. Обоснование включения
25. Инструкция по заполнению
`;
const gotNoisy = inferExpectedGoodsCoverage(noisyBareOrdinals);
assert.equal(gotNoisy.detectionSource, "none");
assert.deepEqual(gotNoisy.expectedPositionIds, []);

console.log("goods-expected-items.verify: OK");
