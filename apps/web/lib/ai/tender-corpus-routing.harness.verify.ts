/**
 * Без БД: сегменты --- path --- и порядок routed corpus.
 *   pnpm verify:tender-corpus-routing
 */
import assert from "node:assert/strict";
import {
  buildGoodsSourceRoutingReport,
  EXTRACTION_DIAG_END,
  EXTRACTION_DIAG_START
} from "./goods-source-routing";
import {
  buildRoutedFullRawCorpus,
  splitExtractedTextIntoLogicalSegments,
  stripArchiveDiagnosticsBlock
} from "./tender-corpus-routing";

const archBody = `--- docs/Техническое_задание.pdf ---
содержимое тз
--- docs/проект_договора.pdf ---
содержимое договора

${EXTRACTION_DIAG_START}
discovered_paths (2):
  - docs/Техническое_задание.pdf
  - docs/проект_договора.pdf
events (0):
${EXTRACTION_DIAG_END}
`;

const segs = splitExtractedTextIntoLogicalSegments(stripArchiveDiagnosticsBlock(archBody), "fallback.zip");
assert.equal(segs.length, 2);
assert.equal(segs[0]!.logicalPath, "docs/Техническое_задание.pdf");

const bare = "преамбула до диагностики\n";
const withDiag = `${bare}\n${EXTRACTION_DIAG_START}\ndiscovered_paths (1):\n  - x\n${EXTRACTION_DIAG_END}`;
const stripped = stripArchiveDiagnosticsBlock(withDiag);
assert.ok(!stripped.includes("ARCHIVE_UNPACK"));
assert.ok(stripped.includes("преамбула"));

const files = [{ originalName: "archive.zip", extractedText: archBody }];
const report = buildGoodsSourceRoutingReport(files);
const routed = buildRoutedFullRawCorpus(files, report);
const iTz = routed.rawCorpus.indexOf("содержимое тз");
const iDog = routed.rawCorpus.indexOf("содержимое договора");
assert.ok(iTz >= 0 && iDog >= 0 && iTz < iDog, "primary (ТЗ) должен идти раньше fallback (договор)");
assert.ok(routed.diagnostics.pathsPrimary.some((p) => p.includes("Техническое")));
assert.ok(routed.diagnostics.pathsFallback.some((p) => p.includes("договор")));

// Fallback budget: крупный договор не должен вытеснять печатную форму (категория раньше rootIndex).
const prevFallbackMax = process.env.TENDER_AI_CORPUS_FALLBACK_MAX_CHARS;
process.env.TENDER_AI_CORPUS_FALLBACK_MAX_CHARS = "32000";
try {
  const conflictFiles = [
    { originalName: "Мун.контракт .doc", extractedText: "x".repeat(40_000) },
    {
      originalName: "Печатная форма.pdf",
      extractedText: "UNIQUE_PRINT_FORM_ROUTING_MARKER"
    }
  ];
  const conflictReport = buildGoodsSourceRoutingReport(conflictFiles);
  const conflictRouted = buildRoutedFullRawCorpus(conflictFiles, conflictReport);
  assert.ok(
    conflictRouted.rawCorpus.includes("UNIQUE_PRINT_FORM_ROUTING_MARKER"),
    "printed_form must stay in corpus before contract consumes fallback budget"
  );
} finally {
  if (prevFallbackMax === undefined) delete process.env.TENDER_AI_CORPUS_FALLBACK_MAX_CHARS;
  else process.env.TENDER_AI_CORPUS_FALLBACK_MAX_CHARS = prevFallbackMax;
}

console.log("tender-corpus-routing.harness.verify: OK");
