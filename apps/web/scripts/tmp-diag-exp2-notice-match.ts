/**
 * Диагностика: тендэксперемент 2 — notice anchors vs 4 позиции с пустым positionId.
 * node ../ai-gateway/node_modules/tsx/dist/cli.mjs scripts/tmp-diag-exp2-notice-match.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildGoodsCorpusClassification } from "@/lib/ai/masked-corpus-sources";
import { loadTenderDocumentsFromDir, runGoodsDocumentFirstPipelineFromInputs } from "@/lib/ai/goods-regression-batch";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";
import { extractGoodsFromTechSpec } from "@/lib/ai/extract-goods-from-tech-spec";
import { dedupeTechSpecBundleCrossSource } from "@/lib/ai/deterministic-goods-merge";
import {
  extractModelTokens,
  normalizeGoodsMatchingKey
} from "@/lib/ai/match-goods-across-sources";
import { isRegistryStylePositionId } from "@/lib/ai/registry-position-ids";
import { REGISTRY_POSITION_ID_CAPTURE_RE } from "@/lib/ai/registry-position-ids";
import { isNoticeGoodsTableRowCandidate } from "@/lib/ai/extract-goods-notice-table";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function lineHasRub(line: string): boolean {
  return /\d[\d]*(?:[.,]\d{1,2})?\s*(?:руб|₽)/i.test(line);
}

function lineLooksLikeNoticePriceRow(line: string): boolean {
  const t = line.trim();
  if (t.length < 14) return false;
  if (lineHasRub(t)) return true;
  return isNoticeGoodsTableRowCandidate(t);
}

type CorpusAnchor = {
  key: string;
  tokens: string[];
  positionId?: string;
  rawLine: string;
};

function buildAnchorsFromText(text: string): CorpusAnchor[] {
  const out: CorpusAnchor[] = [];
  for (const line of text.split("\n")) {
    if (!lineLooksLikeNoticePriceRow(line)) continue;
    const nk = normalizeGoodsMatchingKey(line);
    const tokens = extractModelTokens(nk);
    if (tokens.length === 0 && !/\d{2}\.\d{2}\.\d{2}/.test(line)) continue;
    const regPos = line.match(REGISTRY_POSITION_ID_CAPTURE_RE)?.[1];
    const key = tokens[0] ?? nk.slice(0, 32).replace(/\s+/g, "_");
    if (key.length < 3) continue;
    out.push({
      key,
      tokens: tokens.length ? tokens : [key],
      positionId: regPos,
      rawLine: line.trim()
    });
  }
  return out;
}

async function main() {
  const dir = path.resolve(__dirname, "../../../samples/regression-goods/тендэксперемент 2");
  const files = await loadTenderDocumentsFromDir(dir);
  const routing = buildGoodsSourceRoutingReport(files);
  const minimized = buildMinimizedTenderTextForAi(files, { routingReport: routing });
  const masked = maskPiiForAi(minimized.fullRawCorpusForMasking);
  console.log("masked chars", masked.length, "lines", masked.split("\n").length);
  const pidLines = masked.split("\n").filter((l) => /208665248/.test(l));
  const pidLong = pidLines.sort((a, b) => b.length - a.length)[0];
  if (pidLong) {
    console.log(
      "208665248 lines",
      pidLines.length,
      "longest len",
      pidLong.length,
      "cand?",
      isNoticeGoodsTableRowCandidate(pidLong),
      "rub?",
      lineHasRub(pidLong.trim())
    );
    console.log(pidLong.slice(0, 400));
  }
  const cls = buildGoodsCorpusClassification(masked);
  const noticeBlob = [cls.strictNoticeText || "", masked].filter(Boolean).join("\n");
  const noticeLines = noticeBlob.split("\n").filter((l) => l.trim().length > 14);
  const rubLines = noticeLines.filter((l) => lineHasRub(l) || /^\d{2}\.\d{2}\.\d{2}/.test(l));
  const bundle = dedupeTechSpecBundleCrossSource(extractGoodsFromTechSpec(masked)!)!;
  const targets = ["Brother", "067H C", "067H M", "067H Y"];
  const items = bundle.items.filter((g) => targets.some((t) => (g.name ?? "").includes(t)));

  let cand = 0;
  let passTok = 0;
  for (const line of masked.split("\n")) {
    if (!lineLooksLikeNoticePriceRow(line)) continue;
    cand++;
    const nk = normalizeGoodsMatchingKey(line);
    const tokens = extractModelTokens(nk);
    if (tokens.length === 0 && !/\d{2}\.\d{2}\.\d{2}/.test(line)) continue;
    passTok++;
  }
  console.log("lines noticePriceRow ok:", cand, "pass token/ktru filter:", passTok);

  const regRe = new RegExp(REGISTRY_POSITION_ID_CAPTURE_RE.source, `${REGISTRY_POSITION_ID_CAPTURE_RE.flags}g`);
  const registryHits = [...masked.matchAll(regRe)].map((m) => m[1]!).filter(isRegistryStylePositionId);
  const uniq = [...new Set(registryHits)];
  console.log("registry ids in corpus:", uniq.length, uniq.slice(0, 12).join(", "));
  for (const bid of ["208665246", "208665247", "208665248"]) {
    const lines = masked.split("\n");
    const i = lines.findIndex((ln) => ln.includes(bid));
    const win =
      i < 0 ? "" : lines.slice(Math.max(0, i - 4), Math.min(lines.length, i + 18)).join(" ").replace(/\s+/g, " ");
    const wn = normalizeGoodsMatchingKey(win);
    console.log("\nFULL window norm", bid, "len=", wn.length);
    console.log(wn);
  }

  {
    const lines = masked.split("\n");
    const needles = ["tn-3480", "tn3480", "brother", "mfc-l5750", "067h", "067 h"];
    for (const needle of needles) {
      const j = lines.findIndex((ln) => ln.toLowerCase().includes(needle));
      console.log("first line idx for", JSON.stringify(needle), j);
      if (j >= 0) console.log(" ", (lines[j] ?? "").slice(0, 160));
    }
    const pid = "208665246";
    const i = lines.findIndex((ln) => ln.includes(pid));
    const from = Math.max(0, i - 80);
    const to = Math.min(lines.length, i + 80);
    const chunk = lines.slice(from, to).join("\n");
    console.log("\nwide chunk around", pid, "i=", i, "lines", to - from);
    for (const needle of ["067", "canon", "mf657", "tn3480", "brother", "5750"]) {
      console.log(" contains", needle, "?", chunk.toLowerCase().includes(needle));
    }
    console.log("sample lines with models near pid:");
    for (let j = Math.max(0, i - 25); j < Math.min(lines.length, i + 25); j++) {
      if (/067|canon|tn-?\s*34|brother|mf657|mfc-l5750/i.test(lines[j]!))
        console.log(j, (lines[j] ?? "").slice(0, 140));
    }
  }

  {
    const lines = masked.split("\n");
    const regRe = new RegExp(REGISTRY_POSITION_ID_CAPTURE_RE.source, `${REGISTRY_POSITION_ID_CAPTURE_RE.flags}g`);
    const hits: { pid: string; line: number }[] = [];
    for (let li = 0; li < lines.length; li++) {
      const ln = lines[li] ?? "";
      let m: RegExpExecArray | null;
      const r = new RegExp(regRe.source, regRe.flags);
      while ((m = r.exec(ln))) {
        const pid = m[1]!;
        if (isRegistryStylePositionId(pid)) hits.push({ pid, line: li });
      }
    }
    console.log("\nregistry id line positions (208665* and 01383* first 24):");
    for (const h of hits.filter((x) => /^208665|^0138300000126000170/.test(x.pid)).slice(0, 24)) {
      console.log(h.line, h.pid, (lines[h.line] ?? "").slice(0, 90));
    }
  }

  const anchors = buildAnchorsFromText(masked);
  console.log("anchors from masked corpus:", anchors.length);
  for (const a of anchors.filter((x) => /20866524|tn|067|brother|canon/i.test(x.rawLine)).slice(0, 12)) {
    console.log(" A pid=", a.positionId, "tok=", JSON.stringify(a.tokens), a.rawLine.slice(0, 140));
  }
  for (const g of items) {
    const tzNorm = normalizeGoodsMatchingKey(`${g.name} ${g.codes}`);
    const tzTokens = extractModelTokens(tzNorm);
    const ch = (g.characteristics ?? [])
      .map((c) => `${(c.name ?? "").trim()}: ${(c.value ?? "").trim()}`)
      .join(" | ");
    console.log("\n===", g.name, "===");
    console.log("tzNorm:", tzNorm);
    console.log("tzTokens:", JSON.stringify(tzTokens));
    console.log("chars:", ch.slice(0, 220));
    let best = 0;
    let bestRaw = "";
    for (const a of anchors) {
      let sc = 0;
      const an = normalizeGoodsMatchingKey(a.rawLine);
      const A = new Set(a.tokens.map((x) => x.toLowerCase()));
      const tokenHit = tzTokens.some((t) => A.has(t.toLowerCase()));
      if (tokenHit) sc += 5;
      const prefixHit = tzNorm.length >= 12 && an.includes(tzNorm.slice(0, 28));
      if (prefixHit) sc += 3;
      if (tzTokens.some((t) => t.length >= 5 && an.includes(t))) sc += 2;
      if (sc > best) {
        best = sc;
        bestRaw = a.rawLine;
      }
    }
    console.log("bestScore (min 3):", best);
    console.log("bestAnchor raw:", bestRaw.slice(0, 180));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
