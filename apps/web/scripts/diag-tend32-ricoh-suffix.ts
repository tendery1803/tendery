import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import { buildNoticeDeterministicRowsForGoodsMerge } from "@/lib/ai/extract-goods-notice-table";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";
import { loadTenderDocumentsFromDir, runGoodsDocumentFirstPipelineFromInputs } from "@/lib/ai/goods-regression-batch";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import { normGoodsPositionId } from "@/lib/ai/goods-position-id-status";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

async function main() {
  const dir = path.join(repoRoot, "samples", "regression-goods", "Тенд32");
  const f = await loadTenderDocumentsFromDir(dir);
  const routing = buildGoodsSourceRoutingReport(f);
  const min = buildMinimizedTenderTextForAi(f, { routingReport: routing });
  const corpus = maskPiiForAi(min.fullRawCorpusForMasking);
  const rows = buildNoticeDeterministicRowsForGoodsMerge(corpus);
  const suf = "26.20.40.120-1029";
  const withSuf = rows.filter((r) => (r.codes ?? "").replace(/\s/g, "").toLowerCase().includes(suf));
  console.log("notice rows with suffix", suf, ":", withSuf.length);
  for (const r of withSuf.slice(0, 15)) {
    console.log(normGoodsPositionId(r.positionId ?? ""), (r.name ?? "").slice(0, 70), "|", (r.codes ?? "").slice(0, 80));
  }
  const with842 = rows.filter((r) => (r.name ?? "").includes("842452") || (r.codes ?? "").includes("842452"));
  console.log("\nrows with 842452:", with842.length);
  for (const r of with842.slice(0, 8)) {
    console.log(normGoodsPositionId(r.positionId ?? ""), (r.name ?? "").slice(0, 90));
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
