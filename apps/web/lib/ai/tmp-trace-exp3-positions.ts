/**
 * Трасса A–D для позиций эксп.3. Запуск:
 * pnpm -C apps/web exec node ../ai-gateway/node_modules/tsx/dist/cli.mjs lib/ai/tmp-trace-exp3-positions.ts
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";
import { extractGoodsFromTechSpec } from "@/lib/ai/extract-goods-from-tech-spec";
import {
  verticalSpecBareOrdinalTitleRawLines,
  verticalSpecBareOrdinalShortTitleFromBlock
} from "@/lib/ai/tech-spec-vertical-goods-layout";
import { extractFromBuffer, getExtractionConfigFromEnv } from "../../../../packages/extraction/src/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "../../../../");
const EXP3 = path.join(REPO, "samples/tenders-batch/Тендеры/тендэксперемент 3");

async function corpus() {
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

function blockForOrd(lines: string[], ord: string): string[] | null {
  const reH = new RegExp(`^${ord}$`);
  const reN = new RegExp(`^${Number(ord) + 1}$`);
  let s = -1;
  for (let i = 0; i < lines.length; i++) {
    if (reH.test(lines[i]!.trim())) {
      s = i;
      break;
    }
  }
  if (s < 0) return null;
  let e = lines.length;
  for (let j = s + 1; j < lines.length; j++) {
    if (reN.test(lines[j]!.trim())) {
      e = j;
      break;
    }
  }
  return lines.slice(s, e);
}

const WANT = ["6", "12", "13", "17", "20", "21", "27", "31", "32", "33", "35"];

async function main() {
  const masked = await corpus();
  const lines = masked.split("\n");
  const bundle = extractGoodsFromTechSpec(masked);
  const spec = bundle.items.filter((i) => (i.sourceHint ?? "").toLowerCase().includes("спецификац"));
  for (const ord of WANT) {
    const block = blockForOrd(lines, ord);
    const item = spec.find((i) => i.positionId === ord);
    console.log("\n" + "=".repeat(70) + "\nPOS", ord, "\n" + "=".repeat(70));
    if (!block) {
      console.log("NO BLOCK");
      continue;
    }
    console.log("\nA) raw block lines (trimmed, cap 18):");
    block.slice(0, 18).forEach((l, i) => console.log(`  ${i}:`, JSON.stringify(l.trimEnd().slice(0, 180))));
    const titleRaw = verticalSpecBareOrdinalTitleRawLines(block);
    const spl = verticalSpecBareOrdinalShortTitleFromBlock(block);
    console.log("\nB) title raw lines:");
    titleRaw.forEach((l, i) => console.log(`  ${i}:`, JSON.stringify(l.slice(0, 200))));
    console.log("\nC) shortTitle / layoutExtra count:", JSON.stringify(spl.shortTitle.slice(0, 200)), "/", spl.extraCharacteristicRows.length);
    const body = block.slice(1);
    console.log("\nD) body lines (first 14 non-empty):");
    let n = 0;
    for (const ln of body) {
      const t = ln.trim();
      if (!t) continue;
      console.log(`  ${n}:`, JSON.stringify(t.slice(0, 200)));
      if (++n >= 14) break;
    }
    console.log("\nE) parsed card:");
    console.log("  name:", JSON.stringify((item?.name ?? "").slice(0, 220)));
    console.log("  chars:", item?.characteristics?.length ?? 0);
    (item?.characteristics ?? []).forEach((c) =>
      console.log(`    - ${c.name}:`, JSON.stringify((c.value ?? "").slice(0, 160)))
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
