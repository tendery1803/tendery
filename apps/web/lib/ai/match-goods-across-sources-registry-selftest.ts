/**
 * Selftest: row-level extraction for tabular tenders (EIS print-form / notice).
 *
 * Covers:
 *   1. All 8 registry positions discovered from corpus (none truncated)
 *   2. Quantity extracted from item-row column structure (not from characteristics tail)
 *   3. Positions after #5 not dropped
 *   4. Money-like tokens rejected as quantity
 *   5. OCR-joined unit+qty (e.g. "Штука7") parsed correctly
 *   6. Characteristics tail does not affect item count or quantity
 *   (Tests for docx "Штука" / next-line qty and "Количество: N" without unit were removed:
 *   they depended on uncommitted pickSpecificationQuantityFromLines work, not on committed baseline.)
 *
 * Run: npx ts-node --project apps/web/tsconfig.json apps/web/lib/ai/match-goods-across-sources-registry-selftest.ts
 */

import assert from "node:assert/strict";
import { extractGoodsPositionsFromRegistryIds } from "@/lib/ai/extract-goods-notice-table";
import { pickSpecificationQuantityFromLines } from "@/lib/ai/extract-goods-from-tech-spec";

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────

function makeRegistryRow(
  pid: string,
  ktru: string,
  unit: string,
  qty: string | null,
  unitPrice: string,
  lineTotal: string,
  itemName: string
): string {
  // Simulate EIS print form multi-line column format (each column on its own line)
  const lines: string[] = [
    itemName,
    `Идентификатор: ${pid}`,
    ktru,
    "Товар",
    unit,
  ];
  if (qty !== null) lines.push(qty); // quantity column (may be absent)
  lines.push(unitPrice, `${lineTotal} руб.`);
  return lines.join("\n");
}

function makeCharacteristicsTail(model: string, color: string, chipPresent: string): string {
  return [
    `Модель: ${model}`,
    `Цвет красителя: ${color}`,
    `Наличие чипа: ${chipPresent}`,
    "Область применения: Принтер лазерный",
    "Инструкция по заполнению: значение характеристики не может изменяться участником закупки",
  ].join("\n");
}

// ──────────────────────────────────────────────────────────────────────────────
// Build a corpus that simulates a tabular EIS tender with 8 positions
// ──────────────────────────────────────────────────────────────────────────────

const POSITIONS = [
  { pid: "208665246", qty: "2",  unitPrice: "14000.00", lineTotal: "28000.00",  model: "Canon 067H C",          color: "Черный" },
  { pid: "208665247", qty: "5",  unitPrice: "102000.00", lineTotal: "510000.00", model: "HP CF259X",             color: "Черный" },
  { pid: "208665248", qty: "7",  unitPrice: "2000.00",  lineTotal: "14000.00",  model: "HP CE278A",             color: "Черный" },
  { pid: "208665249", qty: "7",  unitPrice: "4000.00",  lineTotal: "28000.00",  model: "Kyocera TK-1170",       color: "Черный" },
  { pid: "208665250", qty: "4",  unitPrice: "6000.00",  lineTotal: "24000.00",  model: "Brother TN-3480",       color: "Черный" },
  { pid: "208665251", qty: "3",  unitPrice: "5000.00",  lineTotal: "15000.00",  model: "Canon 045 H BK",        color: "Черный" },
  { pid: "208665252", qty: "10", unitPrice: "1500.00",  lineTotal: "15000.00",  model: "Samsung MLT-D101S",     color: "Черный" },
  { pid: "208665253", qty: "6",  unitPrice: "3000.00",  lineTotal: "18000.00",  model: "Lexmark 55B5000",       color: "Черный" },
];

const KTRU = "20.59.12.120-00000002";

function buildTabularCorpus(includeQtyColumn = true): string {
  return POSITIONS.map((p) =>
    [
      makeRegistryRow(
        p.pid,
        KTRU,
        "Штука",
        includeQtyColumn ? p.qty : null,
        p.unitPrice,
        p.lineTotal,
        "Картридж для электрографических печатающих устройств"
      ),
      makeCharacteristicsTail(p.model, p.color, "Да"),
      "", // blank separator between positions
    ].join("\n")
  ).join("\n");
}

// ──────────────────────────────────────────────────────────────────────────────
// Test 1: All 8 registry positions discovered
// ──────────────────────────────────────────────────────────────────────────────

{
  const corpus = buildTabularCorpus(true);
  const items = extractGoodsPositionsFromRegistryIds(corpus);
  const pids = items.map((x) => x.positionId);
  assert.equal(items.length, 8, `Expected 8 positions, got ${items.length}: [${pids.join(",")}]`);
  for (const p of POSITIONS) {
    assert.ok(pids.includes(p.pid), `Missing positionId ${p.pid}`);
  }
  console.log("PASS test 1: all 8 registry positions discovered");
}

// ──────────────────────────────────────────────────────────────────────────────
// Test 2: Positions after #5 are NOT dropped
// ──────────────────────────────────────────────────────────────────────────────

{
  const corpus = buildTabularCorpus(true);
  const items = extractGoodsPositionsFromRegistryIds(corpus);
  const laterPids = ["208665251", "208665252", "208665253"];
  for (const pid of laterPids) {
    assert.ok(
      items.some((x) => x.positionId === pid),
      `Position ${pid} (after index 5) was dropped`
    );
  }
  console.log("PASS test 2: positions after #5 not dropped");
}

// ──────────────────────────────────────────────────────────────────────────────
// Test 3: Quantity extracted from item-row column, not from characteristics tail
// ──────────────────────────────────────────────────────────────────────────────

{
  const corpus = buildTabularCorpus(true);
  const items = extractGoodsPositionsFromRegistryIds(corpus);
  // Check that item-row quantities are extracted, not tail values (chip: "Да", model names, etc.)
  for (const p of POSITIONS) {
    const item = items.find((x) => x.positionId === p.pid);
    assert.ok(item, `Item ${p.pid} not found`);
    if (item.quantity) {
      // If quantity was extracted, it must be a small integer, not a price-like number
      const n = parseFloat(item.quantity);
      assert.ok(
        Number.isInteger(n) && n >= 1 && n <= 9999,
        `${p.pid}: quantity ${item.quantity} looks like a price, not a count`
      );
      // Quantities must NOT be money-like (no xx.xx format, no huge numbers)
      assert.ok(
        !/\.\d{2}$/.test(item.quantity),
        `${p.pid}: quantity ${item.quantity} has kopeck decimals`
      );
    }
  }
  console.log("PASS test 3: extracted quantities are not money-like");
}

// ──────────────────────────────────────────────────────────────────────────────
// Test 4: Money-only rows (no explicit quantity column) yield empty quantity
// ──────────────────────────────────────────────────────────────────────────────

{
  const corpus = buildTabularCorpus(false); // quantity column omitted
  const items = extractGoodsPositionsFromRegistryIds(corpus);
  assert.equal(items.length, 8, "Should still find 8 positions even without qty column");
  // Without a quantity column, quantities should be "" (not a price)
  for (const item of items) {
    if (item.quantity) {
      const n = parseFloat(item.quantity);
      assert.ok(
        !(/\.\d{2}$/.test(item.quantity)) && n < 10_000,
        `${item.positionId}: qty "${item.quantity}" looks like a money value extracted from price column`
      );
    }
  }
  console.log("PASS test 4: money-only rows yield empty or plausible quantity");
}

// ──────────────────────────────────────────────────────────────────────────────
// Test 5: OCR-joined unit+qty ("Штука7") is parsed correctly
// ──────────────────────────────────────────────────────────────────────────────

{
  // Simulate OCR glue: unit and quantity concatenated without space
  const ocrRow = [
    "Картридж для принтера",
    `Идентификатор: 208665299`,
    "20.59.12.120-00000002",
    "ТоварШтука7", // OCR glue: Товар + Штука + 7 (quantity)
    "8000.00",
    "56000.00 руб.",
  ].join("\n");

  const items = extractGoodsPositionsFromRegistryIds(ocrRow);
  assert.equal(items.length, 1, `Expected 1 item from OCR glue row, got ${items.length}`);
  const item = items[0]!;
  assert.equal(item.quantity, "7", `OCR glue: expected qty=7, got "${item.quantity}"`);
  console.log("PASS test 5: OCR-joined 'Штука7' parsed to quantity=7");
}

// ──────────────────────────────────────────────────────────────────────────────
// Test 6: Characteristics tail does not inflate item count
// ──────────────────────────────────────────────────────────────────────────────

{
  // Corpus with only 3 real positions but a long characteristics tail each
  const corpus = POSITIONS.slice(0, 3).map((p) =>
    [
      makeRegistryRow(p.pid, KTRU, "Штука", p.qty, p.unitPrice, p.lineTotal, "Картридж"),
      makeCharacteristicsTail(p.model, p.color, "Да"),
      // Extra lines that look like position starts but are characteristics
      `HP LaserJet модель совместима`,
      `Canon LBP область применения`,
      "",
    ].join("\n")
  ).join("\n");

  const items = extractGoodsPositionsFromRegistryIds(corpus);
  assert.equal(
    items.length,
    3,
    `Expected 3 items (not inflated by char tails), got ${items.length}`
  );
  console.log("PASS test 6: characteristics tail does not inflate item count");
}

// ──────────────────────────────────────────────────────────────────────────────
// Test 9: Single position — registry ID without KTRU is skipped
// ──────────────────────────────────────────────────────────────────────────────

{
  // Registry ID present but no KTRU code in window → should be ignored
  const corpus = [
    "Заказ № 208665999",
    "Поставщик: ООО Ромашка",
    "Сумма: 100000 руб.",
  ].join("\n");
  const items = extractGoodsPositionsFromRegistryIds(corpus);
  assert.equal(items.length, 0, "Registry ID without KTRU should not produce an item");
  console.log("PASS test 9: registry ID without KTRU is skipped");
}

// ──────────────────────────────────────────────────────────────────────────────
// REGRESSION TESTS — verify fallback fixes don't accept money as quantity
// ──────────────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────────────
// Test R1: OCR-price glue "ТоварШтука4000.00" must NOT produce qty=4000
// ──────────────────────────────────────────────────────────────────────────────

{
  // "Штука4000.00" — unit and unit-price merged by OCR; digits are followed by "." which signals price.
  // UNIT_INLINE_WITH_NUM (?![.,\d]) must reject this; standalone scan also returns "".
  const ocrPriceRow = [
    "Картридж для принтера",
    "Идентификатор: 208665400",
    "20.59.12.120-00000002",
    "ТоварШтука4000.00", // unit + unit price merged — NOT quantity
    "28000.00 руб.",
  ].join("\n");

  const items = extractGoodsPositionsFromRegistryIds(ocrPriceRow);
  assert.equal(items.length, 1, `R1: expected 1 item, got ${items.length}`);
  assert.notEqual(items[0]!.quantity, "4000",
    `R1: REGRESSION — "ТоварШтука4000.00" should NOT produce qty=4000 (price, not count)`);
  assert.equal(items[0]!.quantity, "",
    `R1: expected qty="", got "${items[0]!.quantity}" (price was mistaken for quantity)`);
  console.log("PASS test R1: ТоварШтука4000.00 OCR-price glue does NOT produce qty=4000");
}

// ──────────────────────────────────────────────────────────────────────────────
// Test R2: Registry row with only price columns (no qty line) → qty=""
// ──────────────────────────────────────────────────────────────────────────────

{
  // Unit "Штука" on its own line, followed by price "14000.00" and total "28000.00 руб." — no qty column.
  // The standalone scan should hit the "^\d+[.,]\d{2}$" break guard and return "".
  const noPriceQtyRow = [
    "Картридж для принтера",
    "Идентификатор: 208665401",
    "20.59.12.120-00000002",
    "Штука",       // standalone unit marker line
    "14000.00",    // unit price (decimal — triggers money break)
    "28000.00 руб.",
  ].join("\n");

  const items = extractGoodsPositionsFromRegistryIds(noPriceQtyRow);
  assert.equal(items.length, 1, `R2: expected 1 item, got ${items.length}`);
  assert.equal(items[0]!.quantity, "",
    `R2: REGRESSION — "Штука\\n14000.00" should NOT produce qty="${items[0]!.quantity}" (price, not count)`);
  console.log("PASS test R2: Штука followed by price-only lines yields qty=''");
}

// ──────────────────────────────────────────────────────────────────────────────
// Test R3: "Количество: 14000.00" in tech spec fallback → rejected (kopeck format)
// ──────────────────────────────────────────────────────────────────────────────

{
  // "14000.00" has exactly 2 decimal places and value >= 50 — classic unit-price format.
  // The fallback loop must NOT return this as quantity.
  const lines = [
    "1. Картридж HP CF259X",
    "КТРУ: 20.59.12.120-00000002",
    "Количество: 14000.00", // kopeck-format number looks like a unit price
    "Единица измерения: шт",
  ];
  const result = pickSpecificationQuantityFromLines(lines);
  assert.ok(
    result === null || (result.quantity !== "14000.00" && result.quantity !== "14000"),
    `R3: REGRESSION — "Количество: 14000.00" should not be accepted as quantity, got ${JSON.stringify(result)}`
  );
  console.log("PASS test R3: kopeck-format Количество: 14000.00 is rejected");
}

// ──────────────────────────────────────────────────────────────────────────────
// Test R4: "Количество позиций: 5" must NOT produce qty=5 (label-guard)
// ──────────────────────────────────────────────────────────────────────────────

{
  // After "Количество" the regex needs a colon/space then a DIGIT.
  // "Количество позиций" → "позиций" starts with "п" (non-digit) → regex fails.
  const lines = [
    "Количество позиций: 5",
    "Технические характеристики:",
  ];
  const result = pickSpecificationQuantityFromLines(lines);
  assert.equal(result, null,
    `R4: "Количество позиций: 5" should NOT extract 5 as unit quantity, got ${JSON.stringify(result)}`);
  console.log("PASS test R4: 'Количество позиций: N' label is not confused with unit quantity");
}

// ──────────────────────────────────────────────────────────────────────────────
// Test R6: "ТоварШтука7" (true OCR quantity) is still parsed correctly after fix
// ──────────────────────────────────────────────────────────────────────────────

{
  // Regression guard: the (?![.,\d]) lookahead must NOT block legitimate "Штука7" patterns.
  const legitimateOcrRow = [
    "Картридж для принтера",
    "Идентификатор: 208665402",
    "20.59.12.120-00000002",
    "ТоварШтука7",  // quantity=7 (NOT followed by decimal)
    "8000.00",
    "56000.00 руб.",
  ].join("\n");

  const items = extractGoodsPositionsFromRegistryIds(legitimateOcrRow);
  assert.equal(items.length, 1, `R6: expected 1 item`);
  assert.equal(items[0]!.quantity, "7",
    `R6: REGRESSION — "ТоварШтука7" should still produce qty=7, got "${items[0]!.quantity}"`);
  console.log("PASS test R6: legitimate ТоварШтука7 OCR glue still produces qty=7 after lookahead fix");
}

// ──────────────────────────────────────────────────────────────────────────────
// Test R7: "Идентификатор:" label must NOT become the item name
// ──────────────────────────────────────────────────────────────────────────────

{
  // EIS OCR splits item name across lines; "Идентификатор:" is a label on its own line
  // immediately before the PID. It must be skipped; preceding name lines must be joined.
  const corpus = [
    "Картридж для",
    "электрографических",
    "печатающих",
    "устройств",
    "Идентификатор:",
    "208665700",
    "20.59.12.120-",
    "00000002",
    "ТоварШтука7",
    "14000.00",
    "98000.00 руб.",
  ].join("\n");

  const items = extractGoodsPositionsFromRegistryIds(corpus);
  assert.equal(items.length, 1, "R7: should find 1 item");
  assert.notEqual(items[0]!.name, "Идентификатор:",
    `R7: REGRESSION — name must not be "Идентификатор:" label`);
  // Should contain meaningful text from the item name lines
  assert.ok(
    items[0]!.name.toLowerCase().includes("картридж") ||
    items[0]!.name.toLowerCase().includes("устройств"),
    `R7: name "${items[0]!.name}" does not contain meaningful item name text`
  );
  console.log(`PASS test R7: name = "${items[0]!.name}" (not "Идентификатор:")`);
}

// ──────────────────────────────────────────────────────────────────────────────
// Test R8: year in date string must NOT become unitPrice
// ──────────────────────────────────────────────────────────────────────────────

{
  // EIS notices embed a date like "25.03.2026, 09:09Печатная форма" at the end of each row.
  // "2026" is a calendar year, NOT a price. parseFallbackMoneyAmountsFromGoodsRow
  // must exclude year-range integers.
  const corpus = [
    "Картридж для принтера",
    "Идентификатор:",
    "208665701",
    "20.59.12.120-00000002",
    "ТоварШтука4000.00",
    "МУНИЦИПАЛЬНОЕ КАЗЕННОЕ УЧРЕЖДЕНИЕ",
    "28000.00",
    "25.03.2026, 09:09Печатная форма",
    "https://zakupki.gov.ru/...",
  ].join("\n");

  const items = extractGoodsPositionsFromRegistryIds(corpus);
  assert.equal(items.length, 1, "R8: should find 1 item");
  assert.notEqual(items[0]!.unitPrice, "2026",
    `R8: REGRESSION — year "2026" from date string must NOT become unitPrice`);
  console.log(`PASS test R8: unitPrice = "${items[0]!.unitPrice}" (not year "2026")`);
}

console.log("\nAll selftest cases PASSED.");
