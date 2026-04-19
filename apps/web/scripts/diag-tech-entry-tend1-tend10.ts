/**
 * Диагностика входа в ТЗ для regression-тендеров с goods=0 (Тенд1, Тенд10).
 * Запуск: cd apps/web && node ../ai-gateway/node_modules/tsx/dist/cli.mjs scripts/diag-tech-entry-tend1-tend10.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";
import {
  extractGoodsFromTechSpec,
  getTechSpecSegmentPositionStats,
  splitStrictTechTextByLogicalPathSegments
} from "@/lib/ai/extract-goods-from-tech-spec";
import { loadTenderDocumentsFromDir } from "@/lib/ai/goods-regression-batch";
import { buildGoodsCorpusClassification, extractPriorityLayersForGoodsTech } from "@/lib/ai/masked-corpus-sources";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "../../..");

/** Строки похожие на позицию спецификации, но не обязательно с POSITION_START */
const GOODSISH_LINE_RE =
  /(?:^|\s)(?:\d{2}\.\d{2}\.\d{2}\.\d{3}|ОКПД2|КТРУ|№\s*п\/п|п\/п|Наименование|Товар|литр|тонн|кг|шт\.?|АИ-92|АИ-95|ДТ|бензин|дизель)/i;

function pickGoodsishLines(text: string, max = 20): { line: string; reason: string }[] {
  const lines = text.split("\n");
  const out: { line: string; reason: string }[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length < 12 || line.length > 220) continue;
    if (!GOODSISH_LINE_RE.test(line)) continue;
    let reason = "goodsish_pattern";
    if (!/\d/.test(line)) reason += ";no_digit";
    if (/^#{1,6}\s/.test(line)) reason += ";markdown_heading";
    if (/^\d{1,2}[.)]\s+[А-ЯЁ]/.test(line)) reason += ";numbered_section_not_position";
    out.push({ line: line.slice(0, 200), reason });
    if (out.length >= max) break;
  }
  return out;
}

async function main() {
  const names = ["Тенд1", "Тенд10"];
  for (const name of names) {
    const tenderDir = path.join(REPO, "samples/regression-goods", name);
    const fileInputs = await loadTenderDocumentsFromDir(tenderDir);
    const routing = buildGoodsSourceRoutingReport(fileInputs);
    const minimized = buildMinimizedTenderTextForAi(fileInputs, { routingReport: routing });
    const corpus = maskPiiForAi(minimized.fullRawCorpusForMasking);
    const slice = extractPriorityLayersForGoodsTech(corpus);
    const classification = buildGoodsCorpusClassification(slice.corpusForGoodsTechExtraction);
    const techText = classification.strictTechText;
    const segments = splitStrictTechTextByLogicalPathSegments(techText);
    const ext = extractGoodsFromTechSpec(corpus);

    console.log("\n========", name, "========");
    console.log(
      JSON.stringify(
        {
          files: fileInputs.map((f) => f.originalName),
          corpusChars: corpus.length,
          usedPrioritySlice: slice.usedPrioritySlice,
          logicalPathsInPriority: slice.logicalPathsInPriority.slice(0, 12),
          strictTechChars: techText.length,
          strictNoticeChars: (classification.strictNoticeText ?? "").length,
          ancillaryExcluded: classification.ancillaryExcludedFileIndexes,
          blocks: classification.blocks.map((b) => ({
            fileIndex: b.fileIndex,
            role: b.role,
            techScore: b.techScore,
            noticeScore: b.noticeScore,
            headline: b.headline.slice(0, 100)
          })),
          segments: segments.map((s) => ({
            logicalPath: s.logicalPath,
            lines: s.lines.length,
            headPreview: s.lines.slice(0, 5).join(" | ").slice(0, 200)
          })),
          extract: {
            items: ext.items.length,
            diagnosticsTail: ext.diagnostics.slice(-8),
            rejectionReasons: ext.parseAudit.rejectionReasons.slice(0, 15),
            tableDetected: ext.parseAudit.techSpecTableDetected,
            clusterCount: ext.parseAudit.techSpecClusterCount
          }
        },
        null,
        2
      )
    );

    for (const seg of segments) {
      const st = getTechSpecSegmentPositionStats(seg.lines, seg.logicalPath);
      console.log("segment_stats", st);
    }

    const goodsish = pickGoodsishLines(techText || corpus, 18);
    console.log("goodsish_sample_lines (strict-tech or full corpus if empty):");
    for (const g of goodsish) console.log(" -", g.reason, "|", g.line);

    if (!techText.trim()) {
      const fromFull = pickGoodsishLines(corpus, 12);
      console.log("(strict-tech empty) goodsish from FULL masked corpus sample:");
      for (const g of fromFull) console.log(" -", g.reason, "|", g.line);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
