/**
 * Диагностика strict-tech и lineStartsPosition для папок regression (временно).
 * cd apps/web && node ../ai-gateway/node_modules/tsx/dist/cli.mjs scripts/diag-tech-parse-two.ts Тенд11
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import { buildGoodsCorpusClassification, extractPriorityLayersForGoodsTech } from "@/lib/ai/masked-corpus-sources";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";
import { extractGoodsFromTechSpec } from "@/lib/ai/extract-goods-from-tech-spec";
import { loadTenderDocumentsFromDir } from "@/lib/ai/goods-regression-batch";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../../samples/regression-goods");

async function main() {
  const id = process.argv[2] ?? "Тенд11";
  const files = await loadTenderDocumentsFromDir(path.join(ROOT, id));
  const routing = buildGoodsSourceRoutingReport(files);
  const minimized = buildMinimizedTenderTextForAi(files, { routingReport: routing });
  const masked = maskPiiForAi(minimized.fullRawCorpusForMasking);
  const slice = extractPriorityLayersForGoodsTech(masked);
  const classification = buildGoodsCorpusClassification(slice.corpusForGoodsTechExtraction);
  const tech = classification.strictTechText;
  const lines = tech.split("\n");
  const looseNumbered = lines.filter((l) => /^\s*\d{1,4}\s+\S/.test(l.trim()) && !/^\s*\d{1,4}\s*[.)]\s+/.test(l.trim()));
  const strictNumbered = lines.filter((l) => /^\s*\d{1,4}\s*[.)]\s+\S/.test(l.trim()));
  const res = extractGoodsFromTechSpec(masked);
  const ktruLines = lines
    .map((l, i) => ({ i, l: l.trim() }))
    .filter((x) => /\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{5}/.test(x.l));
  const okpdOnly = lines
    .map((l, i) => ({ i, l: l.trim() }))
    .filter((x) => /^\d{2}\.\d{2}\.\d{2}\.\d{2,3}(?:\.\d{3})?$/.test(x.l));
  const digitSpaceName = lines
    .map((l) => l.trim())
    .filter((l) => /^\d{1,4}\s+(?![.)])(?=\S)/.test(l) && /(?:КТРУ|ОКПД|наименован|товар|шт|ед\.?\s*изм)/i.test(l));
  console.log(
    JSON.stringify(
      {
        tender: id,
        priorityPaths: slice.logicalPathsInPriority,
        strictTechChars: tech.length,
        looseNumberedSample: looseNumbered.slice(0, 8).map((l) => l.trim().slice(0, 120)),
        strictNumberedSample: strictNumbered.slice(0, 8).map((l) => l.trim().slice(0, 120)),
        looseCount: looseNumbered.length,
        strictCount: strictNumbered.length,
        ktruLineCount: ktruLines.length,
        ktruLineSamples: ktruLines.slice(0, 10).map((x) => `${x.i}:${x.l.slice(0, 130)}`),
        okpdOnlyLineCount: okpdOnly.length,
        okpdOnlySamples: okpdOnly.slice(0, 12).map((x) => `${x.i}:${x.l}`),
        digitSpaceNameSamples: digitSpaceName.slice(0, 8).map((l) => l.slice(0, 130)),
        items: res.items.length,
        diagnosticsTail: res.diagnostics.slice(-8),
        rejectionTail: res.parseAudit.rejectionReasons.slice(0, 25),
        strictHead: tech.slice(0, 2500)
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
