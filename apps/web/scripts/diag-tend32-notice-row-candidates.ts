/**
 * Строки с КТРУ/ценой/кол-вом, не проходящие isNoticeGoodsTableRowCandidate (Тенд32).
 * Запуск: cd apps/web && node ../ai-gateway/node_modules/tsx/dist/cli.mjs scripts/diag-tend32-notice-row-candidates.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import {
  extractQuantityFromTabularGoodsLine,
  extractKtruOrOkpd
} from "@/lib/ai/extract-goods-from-tech-spec";
import { isNoticeGoodsTableRowCandidate } from "@/lib/ai/extract-goods-notice-table";
import { loadTenderDocumentsFromDir } from "@/lib/ai/goods-regression-batch";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";
import { REGISTRY_POSITION_ID_CAPTURE_RE, REGISTRY_POSITION_ID_INLINE_RE } from "@/lib/ai/registry-position-ids";

const KTRU_26 = /\b26\.20\.\d{2}\.\d{3}(?:-\d{3,5})?(?!\d)/;
const HAS_RUB = /(?:руб|₽)/i;

function stripRegistryAndCodesForMoneyScan(line: string): string {
  return line
    .replace(REGISTRY_POSITION_ID_INLINE_RE, " ")
    .replace(/\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{3,5}(?!\d)/g, " ")
    .replace(/\d{2}\.\d{2}\.\d{2}\.\d{2,3}(?:\.\d{3})?/g, " ")
    .replace(/\b\d{1,2}[./]\d{1,2}[./]\d{4}\b/g, " ");
}

function countEisPriceLikeTokensAfterStrip(line: string): number {
  let rest = stripRegistryAndCodesForMoneyScan(line);
  rest = rest.replace(/\d+(?:[.,]\d+)?\s*(?:шт|ед\.?\s*изм|упак|компл|комплект)\b/gi, " ");
  const withKop = [...rest.matchAll(/\b\d{1,3}(?:\s\d{3})+(?:[.,]\d{2})\b|\b\d{1,6}[.,]\d{2}\b/g)];
  if (withKop.length >= 2) return withKop.length;
  const ints = [...rest.matchAll(/\b\d{3,7}\b/g)]
    .map((m) => parseInt(m[0]!, 10))
    .filter((n) => Number.isFinite(n) && n >= 100 && n < 50_000_000);
  return ints.length;
}

function explainReject(t: string): string[] {
  const reasons: string[] = [];
  if (t.length < 28) reasons.push(`len=${t.length}<28`);
  if (!extractKtruOrOkpd(t)) reasons.push("no_ktru_okpd");
  if (!extractQuantityFromTabularGoodsLine(t)) reasons.push("no_tabular_qty");
  if (/(?:руб|₽)/i.test(t)) {
    if (reasons.length) return reasons;
    return ["would_pass_rub??"];
  }
  const compact = t.replace(/\s/g, "");
  if (!REGISTRY_POSITION_ID_CAPTURE_RE.test(compact)) reasons.push("no_registry_id_on_line");
  const cnt = countEisPriceLikeTokensAfterStrip(t);
  if (cnt < 2) reasons.push(`price_like_tokens_after_strip=${cnt}<2`);
  return reasons;
}

async function main() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const tenderDir = path.resolve(__dirname, "../../../samples/regression-goods/Тенд32");

  {
    const inputs = await loadTenderDocumentsFromDir(tenderDir);
    const routing = buildGoodsSourceRoutingReport(inputs);
    const minimized = buildMinimizedTenderTextForAi(inputs, { routingReport: routing });
    const masked = maskPiiForAi(minimized.fullRawCorpusForMasking);
    const lines = masked.split("\n");

    const hits: Array<{ line: string; reasons: string[] }> = [];
    const stats: Record<string, number> = {};
    let totalRejected = 0;

    for (const raw of lines) {
      const line = raw.trim();
      if (!KTRU_26.test(line)) continue;
      const hasQty = !!extractQuantityFromTabularGoodsLine(line);
      const hasRub = HAS_RUB.test(line);
      const hasMoneyLike = /\d{3,6}[.,]\d{2}\b|\b\d{1,3}(?:\s\d{3})+[.,]\d{2}\b/.test(line);
      if (!hasQty && !hasRub && !hasMoneyLike) continue;
      if (isNoticeGoodsTableRowCandidate(line)) continue;

      totalRejected++;
      const reasons = explainReject(line);
      for (const r of reasons) stats[r] = (stats[r] ?? 0) + 1;
      if (hits.length < 45) hits.push({ line: line.slice(0, 200), reasons });
    }

    console.log("rejected_lines_matching_probe", totalRejected, "of", lines.length, "lines");
    console.log("stats", JSON.stringify(stats, null, 2));
    console.log("\n--- samples ---\n");
    for (const h of hits.slice(0, 25)) {
      console.log(h.reasons.join("; "));
      console.log(h.line);
      console.log("---");
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
