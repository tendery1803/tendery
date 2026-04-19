/**
 * Список weak_header по сегменту спецификации тендэксперемент 3.
 *   cd apps/web && node ../ai-gateway/node_modules/tsx/dist/cli.mjs tmp-print-exp3-weak-blocks.ts
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import {
  diagnoseVerticalSpecPositionBlockFailures,
  diagnoseWeakHeaderVerticalSpecBlocks,
  extractGoodsFromTechSpec,
  getTechSpecSegmentPositionStats,
  splitStrictTechTextByLogicalPathSegments
} from "@/lib/ai/extract-goods-from-tech-spec";
import { buildGoodsCorpusClassification, extractPriorityLayersForGoodsTech } from "@/lib/ai/masked-corpus-sources";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";
import { extractFromBuffer, getExtractionConfigFromEnv } from "../../packages/extraction/src/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "../..");
const EXP3 = path.join(REPO, "samples/tenders-batch/Тендеры/тендэксперемент 3");

async function main() {
  const paths: string[] = [];
  for (const n of await readdir(EXP3)) {
    const p = path.join(EXP3, n);
    if ((await stat(p)).isFile()) paths.push(p);
  }
  paths.sort();
  const config = getExtractionConfigFromEnv();
  const fileInputs: { originalName: string; extractedText: string }[] = [];
  for (const p of paths) {
    const buf = await readFile(p);
    const r = await extractFromBuffer({ buffer: buf, filename: path.basename(p), mime: "", config });
    fileInputs.push({ originalName: path.basename(p), extractedText: r.kind === "ok" ? r.text : "" });
  }
  const routing = buildGoodsSourceRoutingReport(fileInputs);
  const minimized = buildMinimizedTenderTextForAi(fileInputs, { routingReport: routing });
  const masked = maskPiiForAi(minimized.fullRawCorpusForMasking);
  const slice = extractPriorityLayersForGoodsTech(masked);
  const { strictTechText } = buildGoodsCorpusClassification(slice.corpusForGoodsTechExtraction);
  const segments = splitStrictTechTextByLogicalPathSegments(strictTechText);
  const spec = segments.find((s) => /спецификац/i.test(s.logicalPath));
  if (!spec) {
    console.log("no spec segment");
    return;
  }
  const st = getTechSpecSegmentPositionStats(spec.lines, spec.logicalPath);
  console.log("segment stats:", st);
  const bundle = extractGoodsFromTechSpec(masked);
  console.log("extract items total:", bundle.items.length);
  const rows = diagnoseWeakHeaderVerticalSpecBlocks(spec.lines, spec.logicalPath);
  console.log("weak_header blocks:", rows.length);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    console.log("\n--- block", i + 1, "head=", JSON.stringify(r.head), "---");
    console.log("detail:", r.detail);
    console.log("--- raw ---\n" + r.blockRaw + "\n--- end raw ---");
  }
  const fails = diagnoseVerticalSpecPositionBlockFailures(spec.lines, spec.logicalPath);
  console.log("\n=== any parse failure (vertical spec) ===", fails.length);
  for (let i = 0; i < fails.length; i++) {
    const f = fails[i]!;
    console.log("\n--- fail", i + 1, "head=", JSON.stringify(f.head), "---");
    console.log("reasons:", f.reasons.join(" | "));
    console.log("--- raw ---\n" + f.blockRaw + "\n--- end raw ---");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
