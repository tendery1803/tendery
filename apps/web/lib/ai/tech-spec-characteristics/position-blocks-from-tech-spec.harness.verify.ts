/**
 * Регрессия только для extractPositionBlocksFromTechSpec (не трогает основной разбор характеристик).
 *   pnpm run verify:position-blocks-from-tech-spec
 */
import assert from "node:assert/strict";
import {
  extractPositionBlocksFromTechSpec,
  type PositionBlock
} from "./position-blocks-from-tech-spec";

/** Несколько позиций с якорем «Идентификатор:». */
const multiIdLines = [
  "Шапка таблицы (преамбула)",
  "Колонки: наименование, характеристики",
  "",
  "Идентификатор: 208665246",
  "Наименование: Картридж для печати",
  "Количество закупки: 4000",
  "",
  "Идентификатор: 208665247",
  "Наименование: Бумага офисная",
  "Ед. изм.: пачка"
];

const multiBlocks = extractPositionBlocksFromTechSpec(multiIdLines);
assert.equal(multiBlocks.length, 3, "преамбула + две позиции по Идентификатору");

const preamble = multiBlocks[0] as PositionBlock;
assert.equal(preamble.pid, undefined);
assert.ok(preamble.headerLine.includes("Шапка"));
assert.ok(preamble.lines.some((l) => l.includes("Колонки")));

const posA = multiBlocks[1] as PositionBlock;
assert.equal(posA.pid, "208665246");
assert.equal(posA.headerLine.trim(), "Идентификатор: 208665246");
assert.ok(posA.lines.some((l) => l.includes("Картридж")));
assert.ok(posA.lines.some((l) => l.includes("4000")));

const posB = multiBlocks[2] as PositionBlock;
assert.equal(posB.pid, "208665247");
assert.ok(posB.lines.some((l) => l.includes("Бумага")));

/** Длинные строки характеристик не должны разрывать блок (нет второго якоря внутри). */
const longTail = "значение_характеристики_".repeat(25);
const longLines = [
  "Идентификатор: 0138300000126000170",
  "Наименование: сложное изделие",
  `Требование к поставке: ${longTail}`,
  `Дополнительное условие без переноса и очень длинная строка: ${longTail}`,
  "Ещё одна длинная строка в том же блоке: " + "x".repeat(180),
  "",
  "Идентификатор: 0138300000126000171",
  "Короткая следующая позиция"
];

const longBlocks = extractPositionBlocksFromTechSpec(longLines);
assert.equal(longBlocks.length, 2);
const first = longBlocks[0] as PositionBlock;
assert.equal(first.pid, "0138300000126000170");
assert.equal(first.lines.length, 5, "все длинные строки остаются в первом блоке");
assert.ok(first.lines.every((l) => !/^\s*Идентификатор\s*:/i.test(l)));
assert.ok(first.lines.some((l) => l.length > 150));
const second = longBlocks[1] as PositionBlock;
assert.equal(second.pid, "0138300000126000171");
assert.equal(second.lines.length, 1);

/** Архив Тенд6 «ТЗ расходники стом.docx»: повторяющиеся строки «КТРУ: …». */
const ktruLines = [
  "Наименование товара: x",
  "Количество: z",
  "1. Расходные материалы",
  "КТРУ: 32.50.50.190-00000655",
  "Количество: 10 шт",
  "КТРУ: 32.50.50.190-00000610",
  "Количество: 5 шт",
  "КТРУ: 32.50.50.190-00000191",
  "Количество: 3 шт"
];
const ktruBlocks = extractPositionBlocksFromTechSpec(ktruLines);
assert.ok(ktruBlocks.length >= 3, "преамбула + три блока по КТРУ:");
const kAnchored = ktruBlocks.filter((b) => b.headerLine.includes("КТРУ:"));
assert.equal(kAnchored.length, 3);
assert.equal(kAnchored[0]!.pid, "32.50.50.190-00000655");

/** Архив тендэксперемент 2 «ТЕХ.ЗАДАНИЕ картриджи 2026.docx»: «Картридж … или эквивалент». */
const cartLines = [
  "Наименование товара: колонка",
  "КТРУ: код",
  "1. Наименование и характеристики согласно КТРУ: 20.59.12.120-00000002.",
  "Картридж HP CF259X или эквивалент",
  "Количество: 5 шт",
  "Картридж HP CE278A или эквивалент",
  "Количество: 7 шт",
  "Картридж Kyocera TK-1170 или эквивалент",
  "Количество: 2 шт"
];
const cartBlocks = extractPositionBlocksFromTechSpec(cartLines);
const cAnchored = cartBlocks.filter((b) => /или эквивалент/i.test(b.headerLine));
assert.equal(cAnchored.length, 3, "три модельные строки картриджа");
assert.ok(cAnchored[0]!.headerLine.includes("CF259X"));

console.log("position-blocks-from-tech-spec.harness.verify: OK");
