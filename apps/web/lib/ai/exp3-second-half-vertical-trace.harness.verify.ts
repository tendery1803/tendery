/**
 * Трасса A–G для эксп.3 (тендэксперемент 3), позиции 19 и 28–35.
 * pnpm -C apps/web exec node ../ai-gateway/node_modules/tsx/dist/cli.mjs lib/ai/exp3-second-half-vertical-trace.harness.verify.ts
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";
import {
  diagnoseVerticalBareDocumentDescriptionLinePick,
  extractGoodsFromTechSpec,
  listDeterministicTechSpecBlocksForHarness,
  mergeContinuationLinesForCharacteristics
} from "@/lib/ai/extract-goods-from-tech-spec";
import {
  verticalSpecBareOrdinalTitleRawLines,
  verticalSpecBareOrdinalShortTitleFromBlock
} from "@/lib/ai/tech-spec-vertical-goods-layout";
import { extractFromBuffer, getExtractionConfigFromEnv } from "../../../../packages/extraction/src/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "../../../../");
const EXP3 = path.join(REPO, "samples/tenders-batch/Тендеры/тендэксперемент 3");

const TRACE_ORD = ["19", "28", "29", "30", "31", "32", "33", "34", "35"];

async function corpus(): Promise<string> {
  const { readdir, stat } = await import("node:fs/promises");
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
  return maskPiiForAi(minimized.fullRawCorpusForMasking);
}

function parserBlockForOrdinal(
  blocks: Array<{ logicalPath: string; block: string[] }>,
  ord: string
): string[] | null {
  const hit = blocks.find((b) => (b.block[0] ?? "").trim() === ord);
  return hit ? hit.block : null;
}

function tailBleed(prevBlock: string[] | null, block: string[], nextBlock: string[] | null): string {
  const bits: string[] = [];
  if (prevBlock && prevBlock.length) {
    const last = [...prevBlock].reverse().find((l) => l.trim())?.trim() ?? "";
    const first = block.find((l) => l.trim())?.trim() ?? "";
    if (last.length > 20 && first.length > 20) {
      const a = last.slice(-Math.min(80, last.length)).toLowerCase();
      const b = first.slice(0, Math.min(120, first.length)).toLowerCase();
      if (/[а-яё]\s*[.,]\s*[а-яё]/u.test(`${last.slice(-40)} ${first.slice(0, 60)}`))
        bits.push("possible_prev_sentence_spill_into_first_line");
    }
  }
  if (nextBlock && nextBlock.length > 1) {
    const last = [...block].reverse().find((l) => l.trim())?.trim() ?? "";
    const n0 = (nextBlock[0] ?? "").trim();
    if (last.length > 200 && !/^\d{1,3}$/.test(n0)) bits.push("last_line_of_block_very_long_before_next_ord");
  }
  return bits.join("; ") || "none_flagged";
}

function bestHumanDocLine(preMerged: string[], productName: string): string | null {
  const pn = productName.replace(/\s+/g, " ").trim();
  const pLow = pn.toLowerCase();
  const pref = pLow.slice(0, Math.min(22, pLow.length));
  let best: string | null = null;
  let bestLen = 0;
  for (const ln of preMerged) {
    const L = ln.replace(/\s+/g, " ").trim();
    if (L.length < 28 || L.length > 2000) continue;
    if (/^[А-ЯЁA-Z][^:]{0,100}:\s*\S/.test(L)) continue;
    const ll = L.toLowerCase();
    if (pref.length >= 6 && ll.startsWith(pref) && L.length > bestLen) {
      best = L;
      bestLen = L.length;
    }
  }
  return best;
}

async function main() {
  const masked = await corpus();
  const parserBlocks = listDeterministicTechSpecBlocksForHarness(masked);
  const bundle = extractGoodsFromTechSpec(masked);
  const spec = bundle.items.filter((i) => (i.sourceHint ?? "").toLowerCase().includes("спецификац"));
  const ids = new Set(spec.map((i) => (i.positionId ?? "").trim()));
  console.log(
    JSON.stringify({
      techSpecExtractedCount: bundle.techSpecExtractedCount,
      specRows: spec.length,
      uniquePositionIds: ids.size,
      count35: spec.filter((i) => /^\d{1,3}$/.test((i.positionId ?? "").trim())).length
    })
  );

  for (const ord of TRACE_ORD) {
    const prev = parserBlockForOrdinal(parserBlocks, String(Number(ord) - 1));
    const block = parserBlockForOrdinal(parserBlocks, ord);
    const next = parserBlockForOrdinal(parserBlocks, String(Number(ord) + 1));
    const item = spec.find((i) => i.positionId === ord);
    console.log("\n" + "=".repeat(76) + `\n POS ${ord} ` + "=".repeat(76));
    console.log("G) tail bleed heuristic:", tailBleed(prev, block ?? [], next));
    if (!block) {
      console.log("MISSING block");
      continue;
    }
    console.log("\nA) raw block lines (trim end, cap 22):");
    block.slice(0, 22).forEach((l, i) => console.log(`  ${i}:`, JSON.stringify(l.trimEnd().slice(0, 200))));

    const titleRaw = verticalSpecBareOrdinalTitleRawLines(block);
    console.log("\nB) title raw lines:");
    titleRaw.forEach((l, i) => console.log(`  ${i}:`, JSON.stringify(l.slice(0, 220))));

    const spl = verticalSpecBareOrdinalShortTitleFromBlock(block);
    const bodyTail = block.slice(1);
    const preMerged = mergeContinuationLinesForCharacteristics(bodyTail);
    console.log("\nC) body lines after mergeContinuation (cap 16):");
    preMerged.slice(0, 16).forEach((l, i) => console.log(`  ${i}:`, JSON.stringify(l.slice(0, 220))));

    const name = (item?.name ?? spl.shortTitle).replace(/\s+/g, " ").trim();
    const docPick = diagnoseVerticalBareDocumentDescriptionLinePick(preMerged, name, {});
    const docPickHeal = diagnoseVerticalBareDocumentDescriptionLinePick(preMerged, name, {
      allowTitleLineAsDescription: true,
      avoidPackagingPhrases: false
    });
    const want = bestHumanDocLine(preMerged, name);

    console.log("\nD) parsed fields (name + chars):");
    console.log("  name:", JSON.stringify((item?.name ?? "").slice(0, 220)));
    const desc = item?.characteristics?.find((c) => /^описание\s+товара$/i.test((c.name ?? "").trim()));
    console.log(
      "  описание:",
      JSON.stringify((desc?.value ?? "").slice(0, 280)),
      "len=",
      (desc?.value ?? "").length
    );
    (item?.characteristics ?? []).forEach((c) => {
      if (/^описание\s+товара$/i.test((c.name ?? "").trim())) return;
      console.log(`  - ${c.name}:`, JSON.stringify((c.value ?? "").slice(0, 140)));
    });

    console.log("\nE) description doc-first pick (diagnose):", JSON.stringify(docPick.best?.slice(0, 260)));
    console.log("   scored candidates (top 6 by score):");
    const ranked = docPick.lines
      .filter((x) => x.outcome === "scored" || x.outcome === "picked")
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 6);
    ranked.forEach((r) =>
      console.log(
        "   ",
        r.score,
        r.tier,
        r.outcome,
        JSON.stringify(r.normalized.slice(0, 140))
      )
    );
    console.log(
      "\nF) heuristic 'should start with name prefix' longest line:",
      JSON.stringify(want?.slice(0, 260))
    );
    console.log("   (allowTitleLineAsDescription pick):", JSON.stringify(docPickHeal.best?.slice(0, 200)));

    console.log("\nSkip summary (first 10 tail_fragment / no_name_anchor):");
    docPick.lines
      .filter((x) => x.skip === "tail_fragment" || x.skip === "no_name_anchor")
      .slice(0, 10)
      .forEach((x) => console.log("  ", x.skip, JSON.stringify(x.normalized.slice(0, 100))));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
