/**
 * Трассировка body → поля для эксп.3 (временный скрипт).
 * pnpm -C apps/web exec node ../ai-gateway/node_modules/tsx/dist/cli.mjs lib/ai/tmp-trace-exp3-body-fields.ts
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";
import {
  mergeContinuationLinesForCharacteristics,
  parseRelaxedColonAndTabCharacteristicLines
} from "@/lib/ai/extract-goods-from-tech-spec";
import { extractGoodsFromTechSpec } from "@/lib/ai/extract-goods-from-tech-spec";
import { parseCharacteristicsForPositionBody } from "@/lib/ai/tech-spec-characteristics";
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

function main() {
  return corpus().then((masked) => {
    const lines = masked.split("\n");
    const bundle = extractGoodsFromTechSpec(masked);
    const spec = bundle.items.filter((i) => (i.sourceHint ?? "").toLowerCase().includes("спецификац"));
    const want = ["18", "19", "28", "30", "35", "10", "25", "33"];
    for (const ord of want) {
      const block = blockForOrd(lines, ord);
      const item = spec.find((i) => i.positionId === ord);
      console.log("\n==========", ord, "==========");
      if (!block) {
        console.log("no block");
        continue;
      }
      const body = block.slice(1);
      console.log("--- raw body (first 25 non-empty) ---");
      let n = 0;
      for (const ln of body) {
        const t = ln.trimEnd();
        if (!t.trim()) continue;
        console.log(n, JSON.stringify(t.slice(0, 200)));
        if (++n >= 25) break;
      }
      const pre = mergeContinuationLinesForCharacteristics(body);
      console.log("--- preMerged (first 12) ---");
      pre.slice(0, 12).forEach((l, i) => console.log(i, JSON.stringify(l.slice(0, 220))));
      const det = parseCharacteristicsForPositionBody(pre);
      const rel = parseRelaxedColonAndTabCharacteristicLines(pre);
      console.log(
        "--- fromDetect ---",
        det.rows.map((r) => `${r.name}=${(r.value ?? "").slice(0, 100)}`)
      );
      console.log(
        "--- relaxed ---",
        rel.map((r) => `${r.name}=${(r.value ?? "").slice(0, 120)}`)
      );
      console.log(
        "--- bundle item chars ---",
        item?.characteristics?.map((c) => `${c.name}: ${(c.value ?? "").slice(0, 140)}`)
      );
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
