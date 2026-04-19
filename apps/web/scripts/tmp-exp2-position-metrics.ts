import path from "node:path";
import { fileURLToPath } from "node:url";
import { computeGoodsRegressionQualityMetrics } from "@/lib/ai/goods-regression-metrics";
import { loadTenderDocumentsFromDir, runGoodsDocumentFirstPipelineFromInputs } from "@/lib/ai/goods-regression-batch";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../../samples/regression-goods");

async function m(id: string, printPids: boolean) {
  const files = await loadTenderDocumentsFromDir(path.join(ROOT, id));
  const pipe = runGoodsDocumentFirstPipelineFromInputs(files, null);
  const met = computeGoodsRegressionQualityMetrics(pipe.goodsItems);
  console.log(
    id,
    "goods",
    met.goodsCount,
    "uniquePid",
    met.uniquePositionIdCount,
    "dupPid",
    met.duplicatePositionIds
  );
  if (printPids) console.log("  pids", pipe.goodsItems.map((g) => (g.positionId ?? "").trim()).join(", "));
}

async function main() {
  await m("тендэксперемент 2", true);
  await m("тендэксперемент 3", false);
  await m("Тенд3", false);
  await m("Тенд11", false);
  await m("Тенд14", false);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
