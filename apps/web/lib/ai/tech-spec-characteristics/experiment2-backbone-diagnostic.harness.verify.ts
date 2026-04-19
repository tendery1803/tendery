/**
 * Диагностика: почему на «тендэксперемент 2» не включается PositionBlock backbone.
 * pnpm run verify:experiment2-backbone-diagnostic
 */
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import {
  diagnosePositionBlockBackboneSegments,
  extractGoodsFromTechSpec
} from "@/lib/ai/extract-goods-from-tech-spec";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";
import {
  buildGoodsCorpusClassification,
  extractPriorityLayersForGoodsTech
} from "@/lib/ai/masked-corpus-sources";
import { extractFromBuffer, getExtractionConfigFromEnv } from "../../../../../packages/extraction/src/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../../../../");
const EXPERIMENT2 = path.join(REPO_ROOT, "samples/tenders-batch/Тендеры/тендэксперемент 2");

async function main() {
  const paths: string[] = [];
  for (const name of await readdir(EXPERIMENT2)) {
    const p = path.join(EXPERIMENT2, name);
    if ((await stat(p)).isFile()) paths.push(p);
  }
  paths.sort();
  const config = getExtractionConfigFromEnv();
  const fileInputs: { originalName: string; extractedText: string }[] = [];
  for (const p of paths) {
    const buf = await readFile(p);
    const base = path.basename(p);
    const r = await extractFromBuffer({ buffer: buf, filename: base, mime: "", config });
    const text =
      r.kind === "ok"
        ? r.text
        : `[extract:${r.kind}] ${"reason" in r ? r.reason : "message" in r ? r.message : ""}`;
    fileInputs.push({ originalName: base, extractedText: text });
  }
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

  const segments = diagnosePositionBlockBackboneSegments(techText);
  const ex = extractGoodsFromTechSpec(masked);

  const report = {
    strictTechChars: techText.length,
    segmentCount: segments.length,
    segments: segments.map((s) => ({
      logicalPath: s.logicalPath,
      lineCount: s.lineCount,
      positionBlockStarts: s.positionBlockStarts,
      normalParsedCount: s.normalParsedCount,
      ...s.explain
    })),
    extractSummary: {
      items: ex.items.length,
      charRows: ex.items.reduce((a, g) => a + (g.characteristics?.length ?? 0), 0),
      backbone: ex.diagnostics.some((d) => d.startsWith("position_block_backbone:"))
    }
  };

  const pdfSeg = segments.find((s) => /печатн/i.test(s.logicalPath));
  const tzSeg = segments.find((s) => /тех\.\s*задан/i.test(s.logicalPath.replace(/\\/g, "/").toLowerCase()));
  assert.ok(pdfSeg, "есть сегмент печатной формы");
  assert.equal(
    pdfSeg!.explain.failReason,
    "insufficient_anchor_lines",
    "ПФ: табличность видна, но нет ≥2 строк-якорей Идентификатор/КТРУ/Картридж…эквивалент в OCR"
  );
  assert.ok(pdfSeg!.explain.tableLike, "ПФ: признак таблицы (строка «Количество» / «Характеристики товара»)");
  assert.ok(tzSeg, "есть сегмент ТЕХ.ЗАДАНИЕ docx");
  assert.equal(
    tzSeg!.explain.wouldUseBackbone,
    false,
    "ТЗ.docx: backbone не включается (якорей > потолка и/или штатный parse уже даёт позиции)"
  );
  assert.ok(tzSeg!.explain.tableLike, "ТЗ.docx: заголовок «Техническое задание» даёт tableLike");
  assert.ok(tzSeg!.normalParsedCount >= 8, "ТЗ.docx: ≥8 успешных штатных позиций");
  assert.ok(report.extractSummary.items >= 8, "итоговый extract ≥8 позиций (ТЗ + ПФ)");
  assert.ok(report.extractSummary.charRows >= 5, "характеристики не ниже прежнего минимума");

  console.log(JSON.stringify(report, null, 2));
  console.log("experiment2-backbone-diagnostic.harness.verify: OK");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
