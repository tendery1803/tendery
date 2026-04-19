import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";
import {
  extractGoodsFromTechSpec,
  splitStrictTechTextByLogicalPathSegments
} from "@/lib/ai/extract-goods-from-tech-spec";
import {
  extractPositionBlocksFromTechSpec,
  LINE_CARTRIDGE_MODEL_EQUIV_ANCHOR
} from "@/lib/ai/tech-spec-characteristics";
import { loadTenderDocumentsFromDir } from "@/lib/ai/goods-regression-batch";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import { buildGoodsCorpusClassification, extractPriorityLayersForGoodsTech } from "@/lib/ai/masked-corpus-sources";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../../samples/regression-goods");

async function main() {
  const id = "тендэксперемент 2";
  const files = await loadTenderDocumentsFromDir(path.join(ROOT, id));
  const routing = buildGoodsSourceRoutingReport(files);
  const minimized = buildMinimizedTenderTextForAi(files, { routingReport: routing });
  const masked = maskPiiForAi(minimized.fullRawCorpusForMasking);
  const bundle = extractGoodsFromTechSpec(masked);
  console.log("bundle items", bundle.items.length);
  for (let i = 0; i < Math.min(3, bundle.items.length); i++) {
    const g = bundle.items[i]!;
    console.log(i, "pid=", JSON.stringify(g.positionId), "name", (g.name ?? "").slice(0, 60));
  }
  const slice = extractPriorityLayersForGoodsTech(masked);
  const tech = buildGoodsCorpusClassification(slice.corpusForGoodsTechExtraction).strictTechText;
  const segs = splitStrictTechTextByLogicalPathSegments(tech);
  for (const s of segs) {
    if (!s.lines.length) continue;
    const pbs = extractPositionBlocksFromTechSpec(s.lines);
    console.log("seg", s.logicalPath.slice(0, 50), "pbs", pbs.length);
    for (let j = 0; j < Math.min(5, pbs.length); j++) {
      const pb = pbs[j]!;
      const bl = [pb.headerLine, ...pb.lines];
      console.log("  pb", j, "pidField=", JSON.stringify(pb.pid), "hdr=", pb.headerLine.trim().slice(0, 70), "bodyLines", pb.lines.length);
      const re = /\b(20\d{7,11})\b/;
      let found = 0;
      for (let k = 0; k < bl.length; k++) {
        const m = re.exec(bl[k] ?? "");
        if (m) {
          console.log("    line", k, "MATCH", m[1], (bl[k] ?? "").trim().slice(0, 120));
          found++;
          if (found >= 3) break;
        }
      }
      if (!found && LINE_CARTRIDGE_MODEL_EQUIV_ANCHOR.test(pb.headerLine.trim())) {
        console.log("    body sample", pb.lines.slice(0, 14).map((l, i) => `${i}:${l.trim().slice(0, 100)}`).join(" | "));
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
