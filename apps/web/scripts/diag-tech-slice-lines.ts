import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import { buildGoodsCorpusClassification, extractPriorityLayersForGoodsTech } from "@/lib/ai/masked-corpus-sources";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";
import { loadTenderDocumentsFromDir } from "@/lib/ai/goods-regression-batch";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const id = process.argv[2] ?? "Тенд14";
  const a = parseInt(process.argv[3] ?? "120", 10);
  const b = parseInt(process.argv[4] ?? "200", 10);
  const files = await loadTenderDocumentsFromDir(
    path.resolve(__dirname, `../../../samples/regression-goods/${id}`)
  );
  const routing = buildGoodsSourceRoutingReport(files);
  const masked = maskPiiForAi(
    buildMinimizedTenderTextForAi(files, { routingReport: routing }).fullRawCorpusForMasking
  );
  const tech = buildGoodsCorpusClassification(extractPriorityLayersForGoodsTech(masked).corpusForGoodsTechExtraction)
    .strictTechText;
  const lines = tech.split("\n");
  for (let i = a; i < Math.min(b, lines.length); i++) {
    console.log(String(i).padStart(5), "|", lines[i]);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
