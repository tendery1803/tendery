/**
 * Архив «тендэксперемент 2»: ожидаемое число позиций по источникам и потери по этапам пайплайна.
 * pnpm run verify:experiment2-positions-trace
 */
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import { dedupeTechSpecBundleCrossSource } from "@/lib/ai/deterministic-goods-merge";
import {
  extractGoodsFromTechSpec,
  getTechSpecSegmentPositionStats,
  splitStrictTechTextByLogicalPathSegments
} from "@/lib/ai/extract-goods-from-tech-spec";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";
import {
  buildGoodsCorpusClassification,
  extractPriorityLayersForGoodsTech
} from "@/lib/ai/masked-corpus-sources";
import { LINE_CARTRIDGE_MODEL_EQUIV_ANCHOR } from "@/lib/ai/tech-spec-characteristics/position-blocks-from-tech-spec";
import { extractFromBuffer, getExtractionConfigFromEnv } from "../../../../../packages/extraction/src/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../../../");
const EXPERIMENT2 = path.join(REPO_ROOT, "samples/tenders-batch/Тендеры/тендэксперемент 2");

/** Старты позиции как в extract-goods (кириллица без \\b). */
function countPositionLikeLines(text: string): number {
  const POSITION_START_RE =
    /^(?:\d{1,4}\s*[.)]\s*)?(Картридж|Тонер-туба|Тонер|Фотобарабан|СНПЧ|Барабан|Расходный\s+материал|Набор\s+(?:картридж|тонер)|Модуль|Чип\s+для)(?![а-яёА-ЯЁa-zA-Z0-9_])/i;
  const MODEL_FIRST_LINE_RE =
    /^(?:\d{1,4}\s*[.)]\s*)?(?:(?:Картридж|Тонер|Краска)\s+)?(?:HP|Hewlett|Canon|Brother|Kyocera|Lexmark|Samsung|OKI|Xerox|Ricoh|Sharp|Konica|Epson)(?![а-яёА-ЯЁa-zA-Z0-9_])/i;
  let n = 0;
  for (const line of text.split("\n")) {
    const L = line.trim();
    if (!L) continue;
    if (POSITION_START_RE.test(L) || MODEL_FIRST_LINE_RE.test(L)) n++;
  }
  return n;
}

async function main() {
  const paths: string[] = [];
  for (const name of await readdir(EXPERIMENT2)) {
    const p = path.join(EXPERIMENT2, name);
    if ((await stat(p)).isFile()) paths.push(p);
  }
  paths.sort();
  const config = getExtractionConfigFromEnv();
  const fileInputs: { originalName: string; extractedText: string }[] = [];
  let docxText = "";
  let pdfText = "";
  for (const p of paths) {
    const buf = await readFile(p);
    const base = path.basename(p);
    const r = await extractFromBuffer({ buffer: buf, filename: base, mime: "", config });
    const text = r.kind === "ok" ? r.text : "";
    fileInputs.push({ originalName: base, extractedText: text });
    if (/тех\.\s*задан/i.test(base.replace(/\\/g, "/").toLowerCase())) docxText = text;
    if (/печатн/i.test(base.toLowerCase()) && base.toLowerCase().endsWith(".pdf")) pdfText = text;
  }

  const docxLines = docxText.split("\n").map((l) => l.trim()).filter(Boolean);
  const cartAll = docxLines.filter((l) => LINE_CARTRIDGE_MODEL_EQUIV_ANCHOR.test(l));
  const expectedUniqueSkuFromDocx = new Set(cartAll.map((l) => l.toLowerCase())).size;
  const pdfPositionLikeLines = countPositionLikeLines(pdfText);

  const routing = buildGoodsSourceRoutingReport(fileInputs);
  const minimized = buildMinimizedTenderTextForAi(fileInputs, { routingReport: routing });
  const masked = maskPiiForAi(minimized.fullRawCorpusForMasking);
  const slice = extractPriorityLayersForGoodsTech(masked);
  let classification = buildGoodsCorpusClassification(slice.corpusForGoodsTechExtraction);
  let techText = classification.strictTechText;
  if (!techText.trim() && slice.usedPrioritySlice) {
    classification = buildGoodsCorpusClassification(masked);
    techText = classification.strictTechText;
  }

  const segments = splitStrictTechTextByLogicalPathSegments(techText);
  const segmentStats = segments.map((s) => getTechSpecSegmentPositionStats(s.lines, s.logicalPath));
  const exRaw = extractGoodsFromTechSpec(masked);
  const ex = dedupeTechSpecBundleCrossSource(exRaw) ?? exRaw;
  const charRows = ex.items.reduce((a, g) => a + (g.characteristics?.length ?? 0), 0);
  const tzModelItems = ex.items.filter((g) => /или эквивалент/i.test(g.name)).length;
  const backboneOn = ex.diagnostics.some((d) => d.startsWith("position_block_backbone:"));

  const table = {
    "1_источник_DOCX_уникальные_Картридж_или_эквивалент": expectedUniqueSkuFromDocx,
    "2_источник_PDF_строки_как_position_start_эвристика": pdfPositionLikeLines,
    "3_strictTech_сегментов": segments.length,
    "4a_ТЗ_docx_segment_normalParsedOk": segmentStats.find((s) =>
      /тех\.\s*задан/i.test(s.logicalPath.replace(/\\/g, "/").toLowerCase())
    )?.normalParsedOk,
    "4b_ТЗ_docx_segment_positionStarts": segmentStats.find((s) =>
      /тех\.\s*задан/i.test(s.logicalPath.replace(/\\/g, "/").toLowerCase())
    )?.positionStarts,
    "4c_ПФ_segment_normalParsedOk": segmentStats.find((s) => /печатн/i.test(s.logicalPath.toLowerCase()))?.normalParsedOk,
    "5_backbone_включён": backboneOn,
    "6_финальный_output_items": ex.items.length,
    "6b_из_них_модельные_Картридж_эквивалент": tzModelItems,
    charRows
  };

  assert.ok(expectedUniqueSkuFromDocx >= 8, "в архивном ТЗ ≥8 уникальных модельных строк");
  assert.strictEqual(
    ex.items.length,
    expectedUniqueSkuFromDocx,
    `после дедупа ПФ/ТЗ позиций должно быть столько же, сколько уникальных модельных строк в ТЗ.docx (${expectedUniqueSkuFromDocx}), получено ${ex.items.length}`
  );
  if (exRaw.items.length > expectedUniqueSkuFromDocx) {
    assert.ok(
      ex.diagnostics.some((d) => d.startsWith("cross_source_position_dedupe:")),
      "при лишних строках из ПФ ожидается маркер cross_source_position_dedupe в diagnostics"
    );
  }
  assert.ok(tzModelItems >= 8, "≥8 позиций с полным названием «…или эквивалент» из ТЗ");
  assert.ok(!backboneOn, "на этом кейсе backbone по-прежнему не обязателен");

  console.log(JSON.stringify({ expectedPrimaryFromDocx: expectedUniqueSkuFromDocx, stages: table, segmentStats }, null, 2));
  console.log("experiment2-positions-trace.harness.verify: OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
