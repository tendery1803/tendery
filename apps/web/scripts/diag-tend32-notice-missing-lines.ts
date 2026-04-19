/**
 * Тенд32: строки с 26.20 + qty/цена, не попавшие в extractGoodsFromNoticePriceTable.
 * Запуск: cd apps/web && node ../ai-gateway/node_modules/tsx/dist/cli.mjs scripts/diag-tend32-notice-missing-lines.ts
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import {
  extractGoodsFromNoticePriceTable,
  extractMoneyStringsForGoodsRow,
  isNoticeGoodsTableRowCandidate
} from "@/lib/ai/extract-goods-notice-table";
import { extractKtruOrOkpd, extractQuantityFromTabularGoodsLine } from "@/lib/ai/extract-goods-from-tech-spec";
import { loadTenderDocumentsFromDir } from "@/lib/ai/goods-regression-batch";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";
import { REGISTRY_POSITION_ID_CAPTURE_RE, REGISTRY_POSITION_ID_INLINE_RE } from "@/lib/ai/registry-position-ids";

const KTRU_26 = /\b26\.20\.\d{2}\.\d{3}(?:-\d{3,5})?(?!\d)/;
const GLUED = /ТоварШтука(\d{1,6})(?=[.,]\d)/i;

function stripLikeNotice(line: string): string {
  return line
    .replace(REGISTRY_POSITION_ID_INLINE_RE, " ")
    .replace(/\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{3,5}(?!\d)/g, " ")
    .replace(/\d{2}\.\d{2}\.\d{2}\.\d{2,3}(?:\.\d{3})?/g, " ")
    .replace(/\b\d{1,2}[./]\d{1,2}[./]\d{4}\b/g, " ");
}

function countPriceToks(line: string): number {
  let rest = stripLikeNotice(line);
  rest = rest.replace(/\d+(?:[.,]\d+)?\s*(?:шт|ед\.?\s*изм|упак|компл|комплект)\b/gi, " ");
  const withKop = [...rest.matchAll(/\b\d{1,3}(?:\s\d{3})+(?:[.,]\d{2})\b|\b\d{1,6}[.,]\d{2}\b/g)];
  if (withKop.length >= 2) return withKop.length;
  const ints = [...rest.matchAll(/\b\d{3,7}\b/g)]
    .map((m) => parseInt(m[0]!, 10))
    .filter((n) => Number.isFinite(n) && n >= 100 && n < 50_000_000);
  return ints.length;
}

function gluedQty(line: string): string | undefined {
  const m = line.replace(/\u00A0/g, " ").match(GLUED);
  if (!m?.[1]) return undefined;
  const n = parseInt(m[1]!, 10);
  if (!Number.isFinite(n) || n < 1) return undefined;
  return String(n);
}

function noticeQty(line: string): string | undefined {
  return extractQuantityFromTabularGoodsLine(line) ?? gluedQty(line);
}

function probeLine(line: string): boolean {
  const t = line.trim();
  if (!KTRU_26.test(t)) return false;
  const hasRub = /(?:руб|₽)/i.test(t);
  const q = noticeQty(t);
  const moneyish = /\d{3,6}[.,]\d{2}\b|\b\d{1,3}(?:\s\d{3})+[.,]\d{2}\b/.test(t);
  return !!(q || hasRub || moneyish);
}

function candidateFailReason(line: string): string {
  const t = line.trim();
  if (t.length < 28) return `len=${t.length}<28`;
  if (!extractKtruOrOkpd(t)) return "no_ktru_okpd";
  if (!noticeQty(t)) return "no_qty_neither_tabular_nor_glued";
  if (/(?:руб|₽)/i.test(t)) return "would_pass_rub";
  const compact = t.replace(/\s/g, "");
  const hasReg = REGISTRY_POSITION_ID_CAPTURE_RE.test(compact);
  const pt = countPriceToks(t);
  const g = GLUED.test(t);
  if (hasReg && pt >= 2) return "would_pass_registry";
  if (g && pt >= 1) return "would_pass_glued";
  return `no_rub_path_fail hasReg=${hasReg} priceToks=${pt} glued=${g}`;
}

async function main() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const tenderDir = path.resolve(__dirname, "../../../samples/regression-goods/Тенд32");
  const inputs = await loadTenderDocumentsFromDir(tenderDir);
  const routing = buildGoodsSourceRoutingReport(inputs);
  const minimized = buildMinimizedTenderTextForAi(inputs, { routingReport: routing });
  const masked = maskPiiForAi(minimized.fullRawCorpusForMasking);
  const lines = masked.split("\n");

  const tableOut = extractGoodsFromNoticePriceTable(masked);
  const emittedKeys = new Set(
    tableOut.map((g) => `${(g.positionId ?? "").trim()}|${(g.codes ?? "").replace(/\s/g, "")}|${g.quantity}|${(g.lineTotal ?? "").trim()}`)
  );

  const interesting: Array<{ line: string; reason: string }> = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!probeLine(line)) continue;
    if (isNoticeGoodsTableRowCandidate(line)) {
      const money = extractMoneyStringsForGoodsRow(line);
      if (money.length === 0) interesting.push({ line: line.slice(0, 220), reason: "candidate_ok_but_money_empty" });
      continue;
    }
    interesting.push({ line: line.slice(0, 220), reason: candidateFailReason(line) });
  }

  console.log("extractGoodsFromNoticePriceTable count", tableOut.length);
  console.log("probe_lines_not_candidate_or_money_empty", interesting.length);
  console.log("\n--- first 12 ---\n");
  for (const x of interesting.slice(0, 12)) {
    console.log(x.reason);
    console.log(x.line);
    console.log("hasТоварШтука", /ТоварШтука/i.test(x.line), "hasШтука", /штук/i.test(x.line), "hasТовар", /товар/i.test(x.line));
    console.log("---");
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
