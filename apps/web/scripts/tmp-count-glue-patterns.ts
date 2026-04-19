import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import { extractGoodsPositionsFromRegistryIds } from "@/lib/ai/extract-goods-notice-table";
import { loadTenderDocumentsFromDir } from "@/lib/ai/goods-regression-batch";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";

const PII_PH = /ТоварШтука(\d{1,6})\.\[[^\]]+\]\.(\d{2})\b/gi;
const NORMAL = /ТоварШтука(\d{1,6})(?=[.,]\d)/gi;

async function main() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const tenderDir = path.resolve(__dirname, "../../../samples/regression-goods/Тенд32");
  const inputs = await loadTenderDocumentsFromDir(tenderDir);
  const routing = buildGoodsSourceRoutingReport(inputs);
  const minimized = buildMinimizedTenderTextForAi(inputs, { routingReport: routing });
  const masked = maskPiiForAi(minimized.fullRawCorpusForMasking);
  let pii = 0;
  let norm = 0;
  for (const ln of masked.split("\n")) {
    PII_PH.lastIndex = 0;
    NORMAL.lastIndex = 0;
    while (PII_PH.exec(ln)) pii++;
    while (NORMAL.exec(ln)) norm++;
  }
  const reg = extractGoodsPositionsFromRegistryIds(masked).length;
  console.log({ linesWithPiiPlaceholderGlue: pii, linesWithNormalGlue: norm, registryScanItems: reg });
}

main().catch(console.error);
