/**
 * Одноразовая диагностика zero-goods по папкам regression (read-only).
 * Запуск: cd apps/web && node ../ai-gateway/node_modules/tsx/dist/cli.mjs scripts/diag-zero-goods-regression.ts
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import {
  dedupeTechSpecBundleCrossSource,
  enhanceTechSpecBundleWithNoticeRows
} from "@/lib/ai/deterministic-goods-merge";
import { extractGoodsFromNoticePriceTable } from "@/lib/ai/extract-goods-notice-table";
import { extractGoodsFromTechSpec, shouldUseTechSpecBackbone } from "@/lib/ai/extract-goods-from-tech-spec";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";
import { buildRoutedFullRawCorpus } from "@/lib/ai/tender-corpus-routing";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import { reconcileGoodsItemsWithDocumentSources } from "@/lib/ai/match-goods-across-sources";
import { sanitizeTenderAiParseResult } from "@/lib/ai/sanitize-tender-analysis-fields";
import { extractFromBuffer, getExtractionConfigFromEnv } from "../../../packages/extraction/src/index.ts";
import type { TenderAiParseResult } from "@tendery/contracts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "../../..");
const REGRESSION = path.join(REPO, "samples/regression-goods");

const TENDERS = ["Тенд1", "Тенд10", "Тенд11", "Тенд12", "Тенд13", "Тенд14", "Тенд16"] as const;

/** Признаки товарной/табличной спецификации в тексте (грубая эвристика для диагноза). */
function goodsLikeSignals(text: string) {
  const t = (text ?? "").replace(/\s+/g, " ");
  return {
    ktru: /\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{5}/.test(t),
    okpd: /\d{2}\.\d{2}\.\d{2}\.\d{2}/.test(t),
    specWord: /спецификац|ведомост|номенклатур|позици\w*\s+п\/п|п\.?\s*п\.?\s*\d/i.test(t),
    qtyCol: /(?:кол-?во|количеств|ед\.?\s*изм|шт\.?|штук)/i.test(t),
    nmck: /НМЦК|начальн\w+\s+максимальн|максимальн\w+\s+цен/i.test(t),
    services: /оказан\w+\s+услуг|перечень\s+услуг|состав\s+услуг|этап\w*\s+работ/i.test(t),
    lot: /лот\s*№|регистрационн\w+\s+номер|ИКЗ/i.test(t)
  };
}

async function loadFiles(dir: string) {
  const names = await readdir(dir);
  const paths: string[] = [];
  for (const n of names) {
    if (n.startsWith(".")) continue;
    const p = path.join(dir, n);
    if ((await stat(p)).isFile()) paths.push(p);
  }
  paths.sort();
  const config = getExtractionConfigFromEnv();
  const rows: { originalName: string; extractedText: string; extractOk: boolean }[] = [];
  for (const p of paths) {
    const buf = await readFile(p);
    const base = path.basename(p);
    const r = await extractFromBuffer({ buffer: buf, filename: base, mime: "", config });
    const ok = r.kind === "ok";
    rows.push({
      originalName: base,
      extractedText: ok ? r.text : `[extract:${r.kind}]`,
      extractOk: ok
    });
  }
  return rows;
}

function stageZero(
  parts: {
    anyExtractFail: boolean;
    totalSourceChars: number;
    routedPrimaryChars: number;
    techParseItems: number;
    bundleAfterDedupe: number;
    afterSanitize: number;
    afterReconcile: number;
  }
): "A" | "B" | "C" | "D" | "?" {
  if (parts.anyExtractFail && parts.totalSourceChars < 200) return "A";
  if (parts.totalSourceChars < 80) return "B";
  if (parts.techParseItems === 0 && parts.bundleAfterDedupe === 0) return "C";
  if (parts.afterSanitize > 0 || parts.bundleAfterDedupe > 0) {
    if (parts.afterReconcile === 0) return "D";
  }
  if (parts.techParseItems > 0 && parts.afterReconcile === 0) return "D";
  return "?";
}

async function main() {
  const out: unknown[] = [];
  for (const name of TENDERS) {
    const dir = path.join(REGRESSION, name);
    const fileInputs = await loadFiles(dir);
    const anyExtractFail = fileInputs.some((f) => !f.extractOk);
    const routing = buildGoodsSourceRoutingReport(fileInputs);
    const routed = buildRoutedFullRawCorpus(fileInputs, routing);
    const minimized = buildMinimizedTenderTextForAi(fileInputs, { routingReport: routing });
    const masked = maskPiiForAi(minimized.fullRawCorpusForMasking);
    const noticeRows = extractGoodsFromNoticePriceTable(masked);
    const bundle0 = extractGoodsFromTechSpec(masked);
    const bundle1 = enhanceTechSpecBundleWithNoticeRows(bundle0, noticeRows);
    const bundle2 = dedupeTechSpecBundleCrossSource(bundle1);
    const emptyParse: TenderAiParseResult = {
      fields: [],
      summary: "",
      procurementKind: "goods",
      procurementMethod: "",
      goodsItems: [],
      servicesOfferings: []
    };
    const stabilized = shouldUseTechSpecBackbone(bundle2);
    const afterSan = sanitizeTenderAiParseResult(emptyParse, {
      maskedTenderCorpus: masked,
      goodsTechSpecDeterministicStabilize: stabilized
    });
    const rec = reconcileGoodsItemsWithDocumentSources(
      afterSan.goodsItems,
      masked,
      bundle2 ?? undefined
    );
    const rawJoined = fileInputs.map((f) => f.extractedText).join("\n");
    const signalsRaw = goodsLikeSignals(rawJoined);
    const signalsMasked = goodsLikeSignals(masked);
    const tier = routed.diagnostics.routedCharsByTier;
    const st = stageZero({
      anyExtractFail,
      totalSourceChars: minimized.stats.sourceChars,
      routedPrimaryChars: tier.primary,
      techParseItems: bundle0.items.length,
      bundleAfterDedupe: bundle2.items.length,
      afterSanitize: afterSan.goodsItems.length,
      afterReconcile: rec.items.length
    });
    out.push({
      tender: name,
      files: fileInputs.map((f) => ({
        name: f.originalName,
        chars: f.extractedText.length,
        extractOk: f.extractOk
      })),
      routingSummary: {
        byPriority: routing.byPriority,
        primaryPaths: routing.primaryGoodsSourcePaths.slice(0, 12),
        preferredCount: routing.preferredGoodsSourcePaths.length,
        diagnostics: routing.diagnostics
      },
      routedTiersChars: tier,
      pathsInCorpus: {
        primary: routed.diagnostics.pathsPrimary,
        preferred: routed.diagnostics.pathsPreferred.slice(0, 8),
        fallback: routed.diagnostics.pathsFallback.slice(0, 8)
      },
      corpus: {
        sourceChars: minimized.stats.sourceChars,
        maskedChars: masked.length,
        minimizerOutChars: minimized.stats.outChars,
        fragments: minimized.stats.fragments,
        fallbackTruncated: routed.diagnostics.fallbackTruncated
      },
      goodsSignalsInRawConcat: signalsRaw,
      goodsSignalsInMaskedCorpus: signalsMasked,
      pipelineCounts: {
        extractGoodsFromTechSpec_items: bundle0.items.length,
        noticeDetRows: noticeRows.length,
        bundleAfterEnhanceAndDedupe: bundle2.items.length,
        sanitizeOutGoods: afterSan.goodsItems.length,
        reconcileOutGoods: rec.items.length,
        techBackbone: stabilized,
        reconcileRejectedSample: rec.goodsSourceSummary.rejectedFromTechSpecReasons.slice(0, 4)
      },
      stageWhereZero: st,
      likelyNonGoodsDocs: signalsRaw.services && !signalsRaw.ktru && bundle0.items.length === 0
    });
  }
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
