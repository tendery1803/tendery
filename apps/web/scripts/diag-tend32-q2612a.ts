import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import { buildNoticeDeterministicRowsForGoodsMerge } from "@/lib/ai/extract-goods-notice-table";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";
import { loadTenderDocumentsFromDir } from "@/lib/ai/goods-regression-batch";
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
  const needle = "q2612a";
  const hits = rows.filter((r) => (r.name ?? "").replace(/\s/g, "").toLowerCase().includes(needle));
  console.log("notice rows with Q2612A in name:", hits.length);
  for (const r of hits) {
    console.log(normGoodsPositionId(r.positionId ?? ""), (r.name ?? "").slice(0, 100));
  }
  for (const nd of ["101R00582", "108R01470"]) {
    const h = rows.filter((r) => (r.name ?? "").toLowerCase().includes(nd.toLowerCase()));
    console.log("\n", nd, "in name:", h.length);
    for (const r of h.slice(0, 6)) {
      console.log(normGoodsPositionId(r.positionId ?? ""), (r.name ?? "").slice(0, 100));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
