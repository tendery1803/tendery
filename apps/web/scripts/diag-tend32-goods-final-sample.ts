/**
 * Диагностика Тенд32: финальные goodsItems пайплайна + qty attach из extractGoodsFromTechSpec.
 *
 * cd apps/web && node ../ai-gateway/node_modules/tsx/dist/cli.mjs scripts/diag-tend32-goods-final-sample.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import { extractGoodsFromTechSpec } from "@/lib/ai/extract-goods-from-tech-spec";
import { loadTenderDocumentsFromDir, runGoodsDocumentFirstPipelineFromInputs } from "@/lib/ai/goods-regression-batch";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import type { TenderAiGoodItem } from "@tendery/contracts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const T32 = path.resolve(__dirname, "../../../samples/regression-goods/Тенд32");

const BARE_3_2 = "bare_digit_then_position_start_below_block_peek_3_2";

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

  const pipe = runGoodsDocumentFirstPipelineFromInputs(files, null);
  const final = pipe.goodsItems;

  const bundle = extractGoodsFromTechSpec(masked);
  const attachByKey = new Map<string, string>();
  const attachList = bundle.techSpecQuantityAttachSources ?? [];
  for (let i = 0; i < bundle.items.length; i++) {
    attachByKey.set(normKey(bundle.items[i]!), attachList[i] ?? "unknown");
  }

  const qtyAttachForFinal = final.map((g) => attachByKey.get(normKey(g)) ?? "(no_tech_extract_match)");

  console.log("=== Тенд32: финальные goodsItems (пайплайн), первые 30 ===\n");
  for (let i = 0; i < Math.min(30, final.length); i++) {
    const g = final[i]!;
    const qa = qtyAttachForFinal[i]!;
    console.log(
      [
        `#${i}`,
        `pid=${JSON.stringify((g.positionId ?? "").trim())}`,
        `name=${JSON.stringify((g.name ?? "").slice(0, 88))}`,
        `qty=${JSON.stringify((g.quantity ?? "").trim())}`,
        `qtyUnit=${JSON.stringify((g.quantityUnit ?? "").trim())}`,
        `qtySource=${JSON.stringify((g as { quantitySource?: string }).quantitySource ?? "")}`,
        `sourceHint=${JSON.stringify((g.sourceHint ?? "").replace(/\s+/g, " ").trim().slice(0, 100))}`,
        `techQtyAttach=${JSON.stringify(qa)}`,
        `chars=${(g.characteristics ?? []).length}`
      ].join("\n  ")
    );
    console.log("");
  }

  const idxBare = final
    .map((g, i) => (qtyAttachForFinal[i] === BARE_3_2 ? i : -1))
    .filter((i) => i >= 0);
  const idxEmptyPid = final.map((g, i) => (!(g.positionId ?? "").trim() ? i : -1)).filter((i) => i >= 0);
  const idxEmptyChars = final.map((g, i) => ((g.characteristics ?? []).length === 0 ? i : -1)).filter((i) => i >= 0);

  const preview = (indices: number[]) =>
    indices
      .slice(0, 25)
      .map((i) => `#${i} ${(final[i]!.name ?? "").slice(0, 72)} | qty=${(final[i]!.quantity ?? "").trim()} | attach=${qtyAttachForFinal[i]}`)
      .join("\n");

  console.log("=== Индексы: bare_digit …_3_2 (tech attach) ===");
  console.log(`count=${idxBare.length}`);
  if (idxBare.length) console.log(preview(idxBare));
  console.log("\n=== Индексы: empty_position_id (нет pid) ===");
  console.log(`count=${idxEmptyPid.length}`);
  if (idxEmptyPid.length) console.log(preview(idxEmptyPid));
  console.log("\n=== Индексы: empty_characteristics ===");
  console.log(`count=${idxEmptyChars.length}`);
  if (idxEmptyChars.length) console.log(preview(idxEmptyChars));

  const bareAndEmptyPid = idxBare.filter((i) => idxEmptyPid.includes(i));
  const bareAndEmptyChars = idxBare.filter((i) => idxEmptyChars.includes(i));
  console.log("\n=== Пересечение bare_3_2 ∩ empty pid ===", bareAndEmptyPid.length, bareAndEmptyPid.slice(0, 15).join(", "));
  console.log("=== Пересечение bare_3_2 ∩ empty chars ===", bareAndEmptyChars.length, bareAndEmptyChars.slice(0, 15).join(", "));

  const unmatched = qtyAttachForFinal.filter((x) => x === "(no_tech_extract_match)").length;
  console.log("\n=== Сводка ===");
  console.log("finalCount", final.length, "techBundleCount", bundle.items.length, "unmatchedAttach", unmatched);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
