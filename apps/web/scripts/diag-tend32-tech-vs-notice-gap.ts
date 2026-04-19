/**
 * Тенд32: какие tech-позиции не покрыты notice-слоем (по codes+qty).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import { extractGoodsFromTechSpec } from "@/lib/ai/extract-goods-from-tech-spec";
import { buildNoticeDeterministicRowsForGoodsMerge } from "@/lib/ai/extract-goods-notice-table";
import { loadTenderDocumentsFromDir } from "@/lib/ai/goods-regression-batch";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";

function normCodes(c: string): string {
  return (c ?? "").replace(/\s/g, "").toLowerCase();
}
function normQty(q: string): string {
  return (q ?? "").replace(/\s/g, "").replace(",", ".").trim();
}

function noticeMatchesTech(n: { codes?: string; quantity?: string }, t: { codes?: string; quantity?: string }): boolean {
  const nc = normCodes(n.codes ?? "");
  const tc = normCodes(t.codes ?? "");
  if (!nc || !tc) return false;
  if (nc === tc) return normQty(n.quantity ?? "") === normQty(t.quantity ?? "");
  return (nc.includes(tc) || tc.includes(nc)) && normQty(n.quantity ?? "") === normQty(t.quantity ?? "");
}

async function main() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const tenderDir = path.resolve(__dirname, "../../../samples/regression-goods/Тенд32");
  const inputs = await loadTenderDocumentsFromDir(tenderDir);
  const routing = buildGoodsSourceRoutingReport(inputs);
  const minimized = buildMinimizedTenderTextForAi(inputs, { routingReport: routing });
  const masked = maskPiiForAi(minimized.fullRawCorpusForMasking);
  const tech = extractGoodsFromTechSpec(masked).items;
  const notice = buildNoticeDeterministicRowsForGoodsMerge(masked);

  const misses: typeof tech = [];
  for (const t of tech) {
    if (notice.some((n) => noticeMatchesTech(n, t))) continue;
    misses.push(t);
  }

  console.log(JSON.stringify({ tech: tech.length, notice: notice.length, misses: misses.length }, null, 2));
  for (const m of misses) {
    console.log("\n--- miss ---");
    console.log("name", (m.name ?? "").slice(0, 80));
    console.log("codes", m.codes);
    console.log("qty", m.quantity);
    console.log("pid", m.positionId);
  }

  const lines = masked.split("\n");
  for (const m of misses) {
    const q = normQty(m.quantity ?? "");
    const cfrag = (m.codes ?? "").split(";")[0]?.trim().slice(0, 20) ?? "";
    const hits = lines
      .map((ln, i) => ({ i, ln: ln.trim() }))
      .filter(({ ln }) => ln.includes("26.20") && (cfrag.length < 8 || ln.replace(/\s/g, "").includes(cfrag.replace(/\s/g, ""))) && (q.length === 0 || ln.includes(q)));
    console.log("\n corpus lines mentioning code fragment + qty (max 5):", cfrag, q);
    for (const h of hits.slice(0, 5)) {
      console.log("L", h.i, h.ln.slice(0, 200));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
