/**
 * Без БД: парсер diagnostics, классификация, приоритеты.
 *   pnpm verify:goods-source-routing
 */
import assert from "node:assert/strict";
import {
  EXTRACTION_DIAG_END,
  EXTRACTION_DIAG_START,
  buildGoodsSourceRoutingReport,
  classifyDocumentByLogicalPath,
  formatGoodsSourceRoutingReportHumanReadable,
  goodsPriorityForCategory,
  parseExtractionArchiveDiagnostics,
  scoreGoodsContentSignalsForRescue
} from "./goods-source-routing";

const sampleBlock = `${EXTRACTION_DIAG_START}
limits: nest_max=3
discovered_paths (3):
  - docs/Описание_объекта_закупки.xlsx
  - docs/Техническое_задание.pdf
  - docs/Печатная_форма_договора.docx
events (1):
  - docs/Техническое_задание.pdf [text_ok]
${EXTRACTION_DIAG_END}`;

const parsed = parseExtractionArchiveDiagnostics(`preamble\n${sampleBlock}\ntail`);
assert.ok(parsed);
assert.deepEqual(parsed!.discoveredPaths, [
  "docs/Описание_объекта_закупки.xlsx",
  "docs/Техническое_задание.pdf",
  "docs/Печатная_форма_договора.docx"
]);

assert.equal(classifyDocumentByLogicalPath("x/Описание объекта закупки.docx"), "description_of_object");
assert.equal(classifyDocumentByLogicalPath("приложение_к_ТЗ_1.pdf"), "appendix_to_spec");
assert.equal(classifyDocumentByLogicalPath("ТЗ.docx"), "technical_spec");
assert.equal(
  classifyDocumentByLogicalPath("ТЕХ.ЗАДАНИЕ картриджи 2026.docx"),
  "technical_spec",
  "аббревиатура ТЕХ.ЗАДАНИЕ в имени файла (архив тендэксперемент 2)"
);
assert.equal(classifyDocumentByLogicalPath("техническая часть.doc"), "technical_part");
assert.equal(classifyDocumentByLogicalPath("печатная форма контракта.pdf"), "printed_form");
assert.equal(classifyDocumentByLogicalPath("договор поставки.docx"), "contract");
assert.equal(classifyDocumentByLogicalPath("требования к заявке.pdf"), "application_requirements");
assert.equal(goodsPriorityForCategory("technical_spec"), "highest");
assert.equal(goodsPriorityForCategory("appendix_to_spec"), "medium");
assert.equal(goodsPriorityForCategory("printed_form"), "low");
assert.equal(goodsPriorityForCategory("contract"), "excluded");

const routing = buildGoodsSourceRoutingReport([
  { originalName: "lot.zip", extractedText: `--- a ---\n${sampleBlock}` }
]);
assert.equal(routing.diagnostics.rootsWithArchiveDiagnostics, 1);
assert.ok(routing.preferredGoodsSourcePaths.some((p) => p.includes("Описание_объекта")));
assert.ok(routing.preferredGoodsSourcePaths.some((p) => p.includes("Техническое_задание")));
assert.ok(routing.primaryGoodsSourcePaths.length >= 2);

const rootOnly = buildGoodsSourceRoutingReport([
  { originalName: "Описание объекта закупки.pdf", extractedText: "no diagnostics block" }
]);
assert.equal(rootOnly.entries.length, 1);
assert.equal(rootOnly.entries[0]!.fromArchiveDiagnostics, false);
assert.equal(rootOnly.entries[0]!.category, "description_of_object");

function bigOtherDocText(): string {
  const ktru = "12.34.56.789-01234\n".repeat(80);
  const rows = Array.from({ length: 12 }, (_, i) => `${i + 1}. Наименование товарной позиции деталь\n`).join("");
  return `${"спецификация закупки\n".repeat(40)}${ktru}${rows}${"x".repeat(4200)}`;
}

const weakNameFile = "Документация АЭФ поставка запчастей.docx";
const weakNameRescue = buildGoodsSourceRoutingReport([
  {
    originalName: weakNameFile,
    extractedText: bigOtherDocText()
  }
]);
assert.equal(classifyDocumentByLogicalPath(weakNameFile), "other");
assert.equal(weakNameRescue.diagnostics.contentRescueCount, 1);
assert.equal(weakNameRescue.entries[0]!.goodsPriority, "medium");
assert.equal(weakNameRescue.entries[0]!.category, "appendix_to_spec");
assert.ok((weakNameRescue.entries[0]!.contentRescueReason ?? "").startsWith("content_rescue:"));

const instructionNotRescued = buildGoodsSourceRoutingReport([
  { originalName: "Инструкция участникам закупки.docx", extractedText: bigOtherDocText() }
]);
assert.equal(instructionNotRescued.diagnostics.contentRescueCount, 0);
assert.equal(instructionNotRescued.entries[0]!.goodsPriority, "excluded");

const projectContractNotRescued = buildGoodsSourceRoutingReport([
  { originalName: "Приложение_1_Проект_договора_Хозка.docx", extractedText: bigOtherDocText() }
]);
assert.equal(projectContractNotRescued.diagnostics.contentRescueCount, 0);

const zkSmepNotRescued = buildGoodsSourceRoutingReport([
  { originalName: "ЗК_для_СМСП_хозка_АУСО_РБ_ХОРИНСКИЙ_СДИ.docx", extractedText: bigOtherDocText() }
]);
assert.equal(zkSmepNotRescued.diagnostics.contentRescueCount, 0);

assert.ok(scoreGoodsContentSignalsForRescue(bigOtherDocText()).pass);

// sanity: human-readable formatter runs
assert.ok(formatGoodsSourceRoutingReportHumanReadable(routing).includes("preferred goods sources"));

console.log("goods-source-routing.harness.verify: OK");
