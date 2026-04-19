/**
 * Шаг 2: где в strict-tech сегменте Тенд32 теряются строки «Тонер/Барабан-картридж…».
 *
 * cd apps/web && node ../ai-gateway/node_modules/tsx/dist/cli.mjs scripts/diag-tend32-real-product-loss.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import { loadTenderDocumentsFromDir } from "@/lib/ai/goods-regression-batch";
import {
  diagnoseTechSpecSegmentRealProductLoss,
  splitStrictTechTextByLogicalPathSegments
} from "@/lib/ai/extract-goods-from-tech-spec";
import { buildGoodsCorpusClassification, extractPriorityLayersForGoodsTech } from "@/lib/ai/masked-corpus-sources";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const T32 = path.resolve(__dirname, "../../../samples/regression-goods/Тенд32");

async function main() {
  const files = await loadTenderDocumentsFromDir(T32);
  const routing = buildGoodsSourceRoutingReport(files);
  const minimized = buildMinimizedTenderTextForAi(files, { routingReport: routing });
  const masked = maskPiiForAi(minimized.fullRawCorpusForMasking);
  const slice = extractPriorityLayersForGoodsTech(masked);
  const c = buildGoodsCorpusClassification(slice.corpusForGoodsTechExtraction);
  const segs = splitStrictTechTextByLogicalPathSegments(c.strictTechText);
  const seg = segs.reduce((a, s) => (s.lines.length > a.lines.length ? s : a), segs[0]!);

  const d = diagnoseTechSpecSegmentRealProductLoss(seg.lines, seg.logicalPath);

  console.log("=== segment ===");
  console.log("logicalPath:", d.logicalPath.slice(0, 120));
  console.log("segmentLineCount:", d.segmentLineCount);
  console.log("allowGenericNumbered:", d.allowGenericNumbered, "verticalBareTable:", d.verticalBareTable);
  console.log("blockCount:", d.blockCount, "startCount:", d.startCount, "normalParsedOkCount:", d.normalParsedOkCount);
  console.log("usePositionBlockBackbone:", d.usePositionBlockBackbone, "backboneRowsParsedOkCount:", d.backboneRowsParsedOkCount);
  console.log("realProductLineHitsTotal (candidate lines):", d.realProductLineHitsTotal);
  console.log("startIndicesHead (first 24):", d.startIndicesHead.slice(0, 24).join(", "));

  console.log("\n=== hits (line → block → parse) [first", d.hits.length, "of total] ===");
  for (const h of d.hits) {
    console.log(
      `\nline ${h.lineIndex} | block ${h.blockIndex} start@${h.blockStartLineIndex} lines=${h.blockLineCount} parseOk=${h.parseOk}`
    );
    console.log("  line:", JSON.stringify(h.linePreview));
    console.log("  blockHead:", JSON.stringify(h.blockHeadPreview));
    if (!h.parseOk) console.log("  parseRejectionSample:", h.parseRejectionSample.join(" | "));
    else {
      console.log("  parsed pid:", JSON.stringify(h.parsedPositionId), "name:", JSON.stringify(h.parsedNamePreview));
      console.log(
        "  chars:",
        h.parsedCharacteristicsCount,
        "survivesVerticalDedupe:",
        h.survivesVerticalBareDedupe,
        "wouldSkipSeen:",
        h.wouldSkipInExtractSeenDedupe
      );
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
