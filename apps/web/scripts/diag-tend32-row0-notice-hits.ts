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
  const noticeRows = buildNoticeDeterministicRowsForGoodsMerge(corpus);
  const pipe = runGoodsDocumentFirstPipelineFromInputs(f, null);
  const g0 = pipe.goodsItems[0]!;
  const pids = ["01722000047260000693", "017220000472600006941", "210211527"];
  for (const pid of pids) {
    const rows = noticeRows.filter((r) => normGoodsPositionId(r.positionId ?? "") === pid);
    console.log("\npid", pid, "hits", rows.length);
    for (const r of rows) {
      console.log("  name:", (r.name ?? "").slice(0, 120));
      console.log("  codes:", (r.codes ?? "").slice(0, 120));
    }
  }
  console.log("\nTZ row0 codes", g0.codes, "name", g0.name?.slice(0, 100));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
