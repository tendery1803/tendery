/**
 * One-off: print masked line ranges for тендэксперемент 2 (tech names vs PF ids).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import { dedupeTechSpecBundleCrossSource } from "@/lib/ai/deterministic-goods-merge";
import { extractGoodsFromTechSpec } from "@/lib/ai/extract-goods-from-tech-spec";
import { REGISTRY_POSITION_ID_CAPTURE_RE, isRegistryStylePositionId } from "@/lib/ai/registry-position-ids";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";
import { loadTenderDocumentsFromDir } from "@/lib/ai/goods-regression-batch";
import { reconcileGoodsItemsWithDocumentSources } from "@/lib/ai/match-goods-across-sources";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const dir = path.resolve(__dirname, "../../../samples/regression-goods/тендэксперемент 2");
  const files = await loadTenderDocumentsFromDir(dir);
  const routing = buildGoodsSourceRoutingReport(files);
  const minimized = buildMinimizedTenderTextForAi(files, { routingReport: routing });
  const masked = maskPiiForAi(minimized.fullRawCorpusForMasking);
  const lines = masked.split("\n");
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/tn-?3480|brother.*tn|mfc-l5750/i.test(lines[i] ?? "")) hits.push(i);
  }
  console.log("lines with brother/tn3480:", hits.slice(0, 20));

  const bh: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/\bbrother\b/i.test(lines[i] ?? "")) bh.push(i);
  }
  console.log("all brother lines:", bh);

  const tn: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/\btn\b/i.test(lines[i] ?? "")) tn.push(i);
  }
  console.log("lines with TN substring:", tn);

  const c067: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/067h/i.test(lines[i] ?? "")) c067.push(i);
  }
  console.log("lines with 067H:", c067);

  const c067pf: number[] = [];
  for (let i = 900; i < lines.length; i++) {
    if (/067h/i.test(lines[i] ?? "")) c067pf.push(i);
  }
  console.log("067H lines with i>=900:", c067pf);

  for (let i = 0; i < lines.length; i++) {
    if (/mf657/i.test(lines[i] ?? "")) console.log("mf657 line", i, (lines[i] ?? "").slice(0, 100));
  }

  const r20: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = (lines[i] ?? "").trim();
    if (/^20\d{6,10}$/.test(t)) r20.push(i);
  }
  console.log("standalone 20* id lines:", r20);

  const roth: number[] = [];
  for (let i = 900; i < lines.length; i++) {
    if (/rother|3480|tn\s*3/i.test(lines[i] ?? "")) roth.push(i);
  }
  console.log("PF>=900 rother|3480|tn 3:", roth);

  for (const needle of ["3480", "5750", "mfc", "purp", "пурп", "жёлт", "желт", "голуб"]) {
    const hits: number[] = [];
    for (let i = 900; i < lines.length; i++) {
      if (lines[i]!.toLowerCase().includes(needle)) hits.push(i);
    }
    console.log("PF>=900", needle, hits.slice(0, 15));
  }
  {
    const hits: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (/5750|l5750|mfc-l/i.test(lines[i] ?? "")) hits.push(i);
    }
    console.log("FULL mfc/5750 lines:", hits);
  }

  for (const needle of ["пурпур", "жёлты", "mag"]) {
    const hits: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.toLowerCase().includes(needle)) hits.push(i);
    }
    console.log("FULL", needle, hits);
  }

  {
    const regRe = new RegExp(REGISTRY_POSITION_ID_CAPTURE_RE.source, `${REGISTRY_POSITION_ID_CAPTURE_RE.flags}g`);
    const chunk = lines.slice(930, 1100).join("\n");
    const found = [...chunk.matchAll(regRe)].map((m) => m[1]!).filter(isRegistryStylePositionId);
    console.log("registry ids in lines 930-1100 (order):", [...new Set(found)].join(", "));
  }

  const probe = "01383000001260001704";
  const li = lines.findIndex((l) => l.includes(probe));
  console.log("\nfirst line with", probe, "idx=", li);
  if (li >= 0) {
    for (let j = li; j < Math.min(lines.length, li + 55); j++) {
      const t = (lines[j] ?? "").trim();
      if (t) console.log(j, t.slice(0, 120));
    }
  }

  const ranges: [number, number][] = [
    [155, 230],
    [850, 1012],
    [980, 1060],
    [1080, 1180],
    [1180, 1280],
    [1390, 1520]
  ];
  for (const [a, b] of ranges) {
    console.log(`\n--- lines ${a}..${b}`);
    for (let i = a; i <= b && i < lines.length; i++) {
      const t = (lines[i] ?? "").trim();
      if (t) console.log(i, t.slice(0, 130));
    }
  }

  function expWin(pid: string, tail: number): string {
    const i = lines.findIndex((ln) => ln.includes(pid));
    if (i < 0) return "";
    return lines
      .slice(Math.max(0, i - 4), Math.min(lines.length, i + tail))
      .join(" ")
      .replace(/\s+/g, " ");
  }
  for (const pid of ["208665246", "208665247", "208665248", "208665249"]) {
    const raw = expWin(pid, 70);
    const w = raw.toLowerCase().replace(/\s+/g, "");
    console.log(
      "\nEXP",
      pid,
      "cf259?",
      w.includes("cf259"),
      "ce278?",
      w.includes("ce278"),
      "067hc?",
      /067h\s*c/i.test(expWin(pid, 70)),
      "067hm?",
      /067h\s*m/i.test(expWin(pid, 70)),
      "kyocera?",
      w.includes("kyocera")
    );
  }
  console.log("\n120-line tail: 067hm in any 20-block?");
  for (const pid of ["208665246", "208665247", "208665248"]) {
    const raw = expWin(pid, 120);
    console.log(pid, "067hm?", /067h\s*m/i.test(raw), "067hy?", /067h\s*y/i.test(raw));
  }

  {
    const regRe = new RegExp(REGISTRY_POSITION_ID_CAPTURE_RE.source, `${REGISTRY_POSITION_ID_CAPTURE_RE.flags}g`);
    const all = [...masked.matchAll(regRe)].map((m) => m[1]!).filter(isRegistryStylePositionId);
    const uniq = [...new Set(all)];
    function expWin2(pid: string, tail: number): string {
      const i = lines.findIndex((ln) => ln.includes(pid));
      if (i < 0) return "";
      return lines
        .slice(Math.max(0, i - 4), Math.min(lines.length, i + tail))
        .join("\n");
    }
    const hits: string[] = [];
    for (const pid of uniq) {
      if (!/^01/.test(pid)) continue;
      const w = expWin2(pid, 100);
      if (/067h\s*m/i.test(w)) hits.push(pid);
    }
    console.log("01* pids whose expanded window has 067H M:", hits);
  }

  const bundle = dedupeTechSpecBundleCrossSource(extractGoodsFromTechSpec(masked)!)!;
  console.log("\n--- tech bundle names (deduped)", bundle.items.length);
  for (const g of bundle.items) {
    console.log(JSON.stringify({ tzPid: (g.positionId ?? "").trim(), name: (g.name ?? "").slice(0, 70) }));
  }
  const rec = reconcileGoodsItemsWithDocumentSources([], masked, bundle);
  console.log("\n--- reconcile positionIds (tech-first, ai empty)");
  for (const g of rec.items) {
    console.log(JSON.stringify({ pid: (g.positionId ?? "").trim(), name: (g.name ?? "").slice(0, 60) }));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
