/**
 * Тенд32: только диагностика — harness-блоки vs финальные items (без правок логики).
 *
 * cd apps/web && node ../ai-gateway/node_modules/tsx/dist/cli.mjs scripts/diag-tend32-blocks-vs-items.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import { loadTenderDocumentsFromDir, runGoodsDocumentFirstPipelineFromInputs } from "@/lib/ai/goods-regression-batch";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";
import { extractGoodsFromTechSpec, listDeterministicTechSpecBlocksForHarness } from "@/lib/ai/extract-goods-from-tech-spec";
import type { TenderAiGoodItem } from "@tendery/contracts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const T32 = path.resolve(__dirname, "../../../samples/regression-goods/Тенд32");

function firstNonEmptyLine(block: string[]): string {
  for (const ln of block) {
    const t = (ln ?? "").trim();
    if (t) return t.slice(0, 120);
  }
  return "(all empty)";
}

function normKey(g: TenderAiGoodItem): string {
  const nk = (g.name ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .slice(0, 96)
    .trim();
  return `${nk}|${(g.quantity ?? "").trim()}|${(g.codes ?? "").trim()}`;
}

async function main() {
  const files = await loadTenderDocumentsFromDir(T32);
  const routing = buildGoodsSourceRoutingReport(files);
  const minimized = buildMinimizedTenderTextForAi(files, { routingReport: routing });
  const masked = maskPiiForAi(minimized.fullRawCorpusForMasking);

  const harnessBlocks = listDeterministicTechSpecBlocksForHarness(masked);
  const bundle = extractGoodsFromTechSpec(masked);
  const pipe = runGoodsDocumentFirstPipelineFromInputs(files, null);
  const finalItems = pipe.goodsItems;
  const attachList = bundle.techSpecQuantityAttachSources ?? [];

  console.log("=== listDeterministicTechSpecBlocksForHarness: первые 20 блоков ===\n");
  for (let i = 0; i < Math.min(20, harnessBlocks.length); i++) {
    const { block } = harnessBlocks[i]!;
    const len = block.length;
    const first = firstNonEmptyLine(block);
    console.log(`#${i}\tlen=${len}\tfirstNonEmpty=${JSON.stringify(first)}`);
  }

  console.log("\n=== Финальные goodsItems (пайплайн): index, name, positionId, codes, techSpecQtyAttach[i] ===\n");
  const attachByKey = new Map<string, string>();
  for (let i = 0; i < bundle.items.length; i++) {
    attachByKey.set(normKey(bundle.items[i]!), attachList[i] ?? "(missing)");
  }
  for (let i = 0; i < finalItems.length; i++) {
    const g = finalItems[i]!;
    const qa = attachByKey.get(normKey(g)) ?? "(no_extract_match)";
    console.log(
      [
        `#${i}`,
        `name=${JSON.stringify((g.name ?? "").slice(0, 72))}`,
        `pid=${JSON.stringify((g.positionId ?? "").trim())}`,
        `codes=${JSON.stringify((g.codes ?? "").trim())}`,
        `techSpecQtyAttach=${JSON.stringify(qa)}`
      ].join("\t")
    );
  }

  console.log("\n=== Сводка ===");
  console.log("harnessBlocksTotal", harnessBlocks.length);
  console.log("extractItems", bundle.items.length, "attachLen", attachList.length);
  console.log("finalItems", finalItems.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
