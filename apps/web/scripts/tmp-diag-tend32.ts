/**
 * Diagnostic script for Тенд32 - traces why only 29/74 items are extracted
 */
import { loadTenderDocumentsFromDir } from "@/lib/ai/goods-regression-batch";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import { buildGoodsCorpusClassification } from "@/lib/ai/masked-corpus-sources";
import {
  splitStrictTechTextByLogicalPathSegments,
  extractGoodsFromTechSpec
} from "@/lib/ai/extract-goods-from-tech-spec";
import { runGoodsDocumentFirstPipelineFromInputs } from "@/lib/ai/goods-regression-batch";

const DIR = "/home/shylugan/tendery/samples/regression-goods/Тенд32";

(async () => {
  const files = await loadTenderDocumentsFromDir(DIR);
  const routing = buildGoodsSourceRoutingReport(files);
  const min = buildMinimizedTenderTextForAi(files, { routingReport: routing });
  const corpus = maskPiiForAi(min.fullRawCorpusForMasking);
  const cls = buildGoodsCorpusClassification(corpus);
  const segs = splitStrictTechTextByLogicalPathSegments(cls.strictTechText);
  const seg = segs.find((s) => s.logicalPath.includes("Описание"));
  const lines = seg?.lines ?? [];

  // Find 'количеств' / 'кол-во'
  console.log("=== Search for 'количеств' ===");
  for (let i = 0; i < lines.length; i++) {
    if (/(?:количеств|кол-?\s*во)/i.test(lines[i]!.trim())) {
      console.log("  line", i, JSON.stringify(lines[i]?.slice(0, 80)));
      if (i === 0 || i === lines.findIndex((l, idx) => /(?:количеств|кол-?\s*во)/i.test(l.trim()) && idx > 0))
        break;
    }
  }

  // Check indexFirstVerticalSpecDataRowAfterGhostOrdinalRun behavior
  // by manually tracing
  const kolIdx = lines.findIndex((l) => /^(?:количеств|кол-?\s*во)\b/i.test(l.trim()));
  console.log("\n=== 'количеств' first index:", kolIdx, "===");
  if (kolIdx >= 0) {
    console.log("  context:");
    for (let j = Math.max(0, kolIdx - 2); j < Math.min(lines.length, kolIdx + 15); j++) {
      if (lines[j]?.trim()) console.log("  ", j, JSON.stringify(lines[j]?.slice(0, 80)));
    }
  }

  // Check if item 30 bare ordinal would pass
  console.log("\n=== Check item 30 area ===");
  for (let i = 410; i < 430; i++) {
    console.log(i, JSON.stringify(lines[i]?.slice(0, 80)));
  }

  // TechSpec extraction result
  const ts = extractGoodsFromTechSpec(corpus);
  console.log("\n=== TechSpec items:", ts?.items.length, "===");
  (ts?.items ?? []).forEach((x, i) =>
    console.log(i + 1, x.positionId, x.name?.slice(0, 70), "qty:", x.quantity)
  );

  // Final pipeline
  const pipe = runGoodsDocumentFirstPipelineFromInputs(files, null);
  console.log("\n=== Final pipeline:", pipe.goodsItems.length, "===");
  pipe.goodsItems.forEach((x, i) =>
    console.log(i + 1, x.positionId, x.name?.slice(0, 70), "qty:", x.quantity)
  );
})();
