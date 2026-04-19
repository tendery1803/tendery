/**
 * Офлайн batch: корпус из файлов → тот же пост-модельный путь goods, что в `tender-ai-analyze`
 * (sanitize → reconcile с notice/TZ bundle → опциональный final model dedupe), без вызова AI и без БД.
 */
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TenderAiGoodItem, TenderAiParseResult } from "@tendery/contracts";
import { collapseSameCodePfAnchoredOrphanTailGoodsItemsAfterAnnotate } from "@/lib/ai/collapse-same-code-orphan-tail-goods-items";
import {
  annotateGoodsItemsWithPositionIdStatus,
  type GoodsPositionIdStatusCounts
} from "@/lib/ai/goods-position-id-status";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import {
  dedupeTechSpecBundleCrossSource,
  enhanceTechSpecBundleWithNoticeRows
} from "@/lib/ai/deterministic-goods-merge";
import { enrichSoleUnusedExternal20PidWhenSingleEmptyCartridgeRow } from "@/lib/ai/cartridge-registry-order-restore";
import { collapseConsecutiveDuplicateGoodsModelKtruTwinsAfterReconcile } from "@/lib/ai/collapse-consecutive-duplicate-goods-model-ktru-twin";
import {
  extractGoodsFromTechSpec,
  shouldUseTechSpecBackbone,
  type ExtractGoodsFromTechSpecResult
} from "@/lib/ai/extract-goods-from-tech-spec";
import { buildNoticeDeterministicRowsForGoodsMerge } from "@/lib/ai/extract-goods-notice-table";
import {
  normalizeFinalGoodsItemsByModelDedupe,
  shouldApplyFinalCartridgeTzPfArchetypeLayer
} from "@/lib/ai/goods-items-final-model-dedupe";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";
import { ensureGoodsItemsNonEmptyAfterPipeline } from "@/lib/ai/stabilize-goods-items";
import { extractMainAnalyzeModelOutputSegment } from "@/lib/ai/goods-pipeline-diagnostics";
import {
  collectGoodsRegressionProblemPositions,
  computeGoodsRegressionQualityMetrics,
  type GoodsRegressionProblemPosition,
  type GoodsRegressionQualityMetrics
} from "@/lib/ai/goods-regression-metrics";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import { reconcileGoodsItemsWithDocumentSources } from "@/lib/ai/match-goods-across-sources";
import { finalizeGoodsItemsFromModelOutput, parseTenderAiResult } from "@/lib/ai/parse-model-json";
import { sanitizeTenderAiParseResult } from "@/lib/ai/sanitize-tender-analysis-fields";
import type { GoodsCardinalityAgainstDocsResult } from "@/lib/ai/verify-goods-cardinality-against-tender-docs";
import { verifyGoodsCardinalityAgainstTenderDocs } from "@/lib/ai/verify-goods-cardinality-against-tender-docs";
import { extractFromBuffer, getExtractionConfigFromEnv } from "../../../../packages/extraction/src/index.ts";

const RAW_OUTPUT_NAMES = ["raw_output.txt", "raw_output.json", "model_raw_output.txt"] as const;

function isRegressionMetaFile(basename: string): boolean {
  const lower = basename.toLowerCase();
  if (lower === ".gitkeep" || lower === ".ds_store") return true;
  return RAW_OUTPUT_NAMES.includes(lower as (typeof RAW_OUTPUT_NAMES)[number]);
}

export async function listRegressionTenderDirs(regressionRoot: string): Promise<string[]> {
  const names = await readdir(regressionRoot);
  const out: string[] = [];
  for (const n of names) {
    if (n.startsWith(".")) continue;
    const p = path.join(regressionRoot, n);
    if ((await stat(p)).isDirectory()) out.push(p);
  }
  return out.sort((a, b) => path.basename(a).localeCompare(path.basename(b), "ru"));
}

async function tryReadOptionalRawOutput(tenderDir: string): Promise<{ fileName: string; text: string } | null> {
  for (const name of RAW_OUTPUT_NAMES) {
    const p = path.join(tenderDir, name);
    try {
      const st = await stat(p);
      if (st.isFile()) {
        const text = await readFile(p, "utf8");
        return { fileName: name, text };
      }
    } catch {
      /* missing */
    }
  }
  return null;
}

export type TenderFileInput = { originalName: string; extractedText: string };

export async function loadTenderDocumentsFromDir(tenderDir: string): Promise<TenderFileInput[]> {
  const entries = await readdir(tenderDir);
  const paths: string[] = [];
  for (const n of entries) {
    if (isRegressionMetaFile(n)) continue;
    const p = path.join(tenderDir, n);
    if ((await stat(p)).isFile()) paths.push(p);
  }
  paths.sort((a, b) => path.basename(a).localeCompare(path.basename(b), "ru"));
  const config = getExtractionConfigFromEnv();
  const fileInputs: TenderFileInput[] = [];
  for (const p of paths) {
    const buf = await readFile(p);
    const base = path.basename(p);
    const r = await extractFromBuffer({ buffer: buf, filename: base, mime: "", config });
    fileInputs.push({
      originalName: base,
      extractedText: r.kind === "ok" ? r.text : `[extract:${r.kind}]`
    });
  }
  return fileInputs;
}

export type GoodsRegressionPipelineResult = {
  goodsItems: TenderAiGoodItem[];
  maskedCorpusChars: number;
  modelGoodsCount: number;
  modelParseOk: boolean | null;
  modelParseError: string | null;
  techBundleItemCount: number;
  finalDedupeApplied: boolean;
  positionIdStatusCounts: GoodsPositionIdStatusCounts | null;
  /** Самопроверка кардинальности по документам тендера (без изменения позиций). */
  goodsCardinalityCheck: GoodsCardinalityAgainstDocsResult;
  /** Диагностики детерминированного бандла ТЗ (для debug-UI). */
  techSpecBundleDiagnostics: string[];
};

/**
 * Повторяет цепочку из `tender-ai-analyze` для goods после ответа модели (без chunk-merge / completeness AI).
 */
export function runGoodsDocumentFirstPipelineFromInputs(
  fileInputs: TenderFileInput[],
  rawOutputText: string | null
): GoodsRegressionPipelineResult {
  const routing = buildGoodsSourceRoutingReport(fileInputs);
  const minimized = buildMinimizedTenderTextForAi(fileInputs, { routingReport: routing });
  const maskedFullCorpusForDelivery = maskPiiForAi(minimized.fullRawCorpusForMasking);

  const noticeDeterministicRows = buildNoticeDeterministicRowsForGoodsMerge(maskedFullCorpusForDelivery);
  let techSpecGoodsBundle: ExtractGoodsFromTechSpecResult | null = extractGoodsFromTechSpec(
    maskedFullCorpusForDelivery
  );
  techSpecGoodsBundle = enhanceTechSpecBundleWithNoticeRows(techSpecGoodsBundle, noticeDeterministicRows);
  techSpecGoodsBundle = dedupeTechSpecBundleCrossSource(techSpecGoodsBundle);

  const goodsTechSpecDeterministicStabilize =
    techSpecGoodsBundle != null && shouldUseTechSpecBackbone(techSpecGoodsBundle);

  let modelGoods: TenderAiGoodItem[] = [];
  let modelParseOk: boolean | null = null;
  let modelParseError: string | null = null;
  if (rawOutputText != null && rawOutputText.trim().length > 0) {
    const main = extractMainAnalyzeModelOutputSegment(rawOutputText);
    const parsed = parseTenderAiResult(main);
    if (parsed.ok) {
      modelParseOk = true;
      modelGoods = finalizeGoodsItemsFromModelOutput(parsed.data.goodsItems);
    } else {
      modelParseOk = false;
      modelParseError = parsed.error;
    }
  }

  const mergedAi: TenderAiParseResult = {
    fields: [],
    summary: "",
    procurementKind: "goods",
    procurementMethod: "",
    goodsItems: modelGoods,
    servicesOfferings: []
  };

  let data = sanitizeTenderAiParseResult(mergedAi, {
    maskedTenderCorpus: maskedFullCorpusForDelivery,
    goodsTechSpecDeterministicStabilize
  });

  const rec = reconcileGoodsItemsWithDocumentSources(
    data.goodsItems,
    maskedFullCorpusForDelivery,
    techSpecGoodsBundle ?? undefined
  );
  data = { ...data, goodsItems: rec.items };
  if (data.goodsItems.length && maskedFullCorpusForDelivery.trim()) {
    const sole = enrichSoleUnusedExternal20PidWhenSingleEmptyCartridgeRow(
      data.goodsItems,
      maskedFullCorpusForDelivery
    );
    if (sole.enriched > 0) {
      data = { ...data, goodsItems: sole.items };
    }
  }
  if (data.goodsItems.length > 1) {
    const tw = collapseConsecutiveDuplicateGoodsModelKtruTwinsAfterReconcile(data.goodsItems);
    if (tw.length !== data.goodsItems.length) {
      data = { ...data, goodsItems: tw };
    }
  }
  if (data.goodsItems.length === 0 && maskedFullCorpusForDelivery.trim().length > 0) {
    data = {
      ...data,
      goodsItems: ensureGoodsItemsNonEmptyAfterPipeline(techSpecGoodsBundle, maskedFullCorpusForDelivery)
    };
  }

  let finalDedupeApplied = false;
  if (
    data.goodsItems.length > 1 &&
    shouldApplyFinalCartridgeTzPfArchetypeLayer(data.goodsItems, techSpecGoodsBundle?.diagnostics)
  ) {
    const fr = normalizeFinalGoodsItemsByModelDedupe(data.goodsItems);
    if (fr.items.length !== data.goodsItems.length) {
      data = { ...data, goodsItems: fr.items };
      finalDedupeApplied = true;
    }
  }

  let positionIdStatusCounts: GoodsPositionIdStatusCounts | null = null;
  if (data.goodsItems.length > 0) {
    let ann = annotateGoodsItemsWithPositionIdStatus(maskedFullCorpusForDelivery, data.goodsItems);
    const collapsed = collapseSameCodePfAnchoredOrphanTailGoodsItemsAfterAnnotate(ann.items);
    ann = annotateGoodsItemsWithPositionIdStatus(maskedFullCorpusForDelivery, collapsed);
    data = { ...data, goodsItems: ann.items };
    positionIdStatusCounts = ann.counts;
  }

  const goodsCardinalityCheck = verifyGoodsCardinalityAgainstTenderDocs({
    fileInputs,
    routingReport: routing,
    goodsItems: data.goodsItems,
    techSpecParsedRowCount: techSpecGoodsBundle?.items.length ?? null
  });

  return {
    goodsItems: data.goodsItems,
    maskedCorpusChars: maskedFullCorpusForDelivery.length,
    modelGoodsCount: modelGoods.length,
    modelParseOk,
    modelParseError,
    techBundleItemCount: techSpecGoodsBundle?.items.length ?? 0,
    finalDedupeApplied,
    positionIdStatusCounts,
    goodsCardinalityCheck,
    techSpecBundleDiagnostics: [...(techSpecGoodsBundle?.diagnostics ?? [])]
  };
}

export type GoodsRegressionTenderReport = {
  tenderId: string;
  tenderDir: string;
  inputFiles: string[];
  rawOutputUsed: string | null;
  modelParseOk: boolean | null;
  modelParseError: string | null;
  maskedCorpusChars: number;
  techBundleItemCount: number;
  finalDedupeApplied: boolean;
  /** Строка `goods_cardinality_check …` для логов / JSON отчёта. */
  goodsCardinalityCheckDiagnostic: string;
  metrics: GoodsRegressionQualityMetrics;
  problemPositions: GoodsRegressionProblemPosition[];
};

export async function runGoodsRegressionForTenderDir(tenderDir: string): Promise<GoodsRegressionTenderReport> {
  const tenderId = path.basename(tenderDir);
  const fileInputs = await loadTenderDocumentsFromDir(tenderDir);
  const raw = await tryReadOptionalRawOutput(tenderDir);
  const pipe = runGoodsDocumentFirstPipelineFromInputs(fileInputs, raw?.text ?? null);
  const metrics = computeGoodsRegressionQualityMetrics(pipe.goodsItems);
  const problemPositions = collectGoodsRegressionProblemPositions(pipe.goodsItems);
  if (pipe.goodsCardinalityCheck.ok === false && pipe.goodsCardinalityCheck.referenceCount != null) {
    problemPositions.unshift({
      positionId: "(cardinality)",
      problemType: "cardinality_vs_docs",
      titlePreview: pipe.goodsCardinalityCheck.diagnostic.slice(0, 160),
      descriptionPreview: `ref=${pipe.goodsCardinalityCheck.referenceCount} source=${pipe.goodsCardinalityCheck.referenceSource} method=${pipe.goodsCardinalityCheck.method}`
    });
  }
  return {
    tenderId,
    tenderDir,
    inputFiles: fileInputs.map((f) => f.originalName),
    rawOutputUsed: raw?.fileName ?? null,
    modelParseOk: pipe.modelParseOk,
    modelParseError: pipe.modelParseError,
    maskedCorpusChars: pipe.maskedCorpusChars,
    techBundleItemCount: pipe.techBundleItemCount,
    finalDedupeApplied: pipe.finalDedupeApplied,
    goodsCardinalityCheckDiagnostic: pipe.goodsCardinalityCheck.diagnostic,
    metrics,
    problemPositions
  };
}

export type GoodsRegressionBatchReport = {
  generatedAt: string;
  regressionRoot: string;
  tenderCount: number;
  tenders: GoodsRegressionTenderReport[];
};

export async function runGoodsRegressionBatch(regressionRoot: string): Promise<GoodsRegressionBatchReport> {
  const dirs = await listRegressionTenderDirs(regressionRoot);
  const tenders: GoodsRegressionTenderReport[] = [];
  for (const d of dirs) {
    tenders.push(await runGoodsRegressionForTenderDir(d));
  }
  return {
    generatedAt: new Date().toISOString(),
    regressionRoot,
    tenderCount: tenders.length,
    tenders
  };
}

export async function writeGoodsRegressionReportJson(report: GoodsRegressionBatchReport, outPath: string) {
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

export function formatGoodsRegressionConsoleTable(rows: GoodsRegressionTenderReport[]): string {
  const headers = [
    "tender",
    "files",
    "goods",
    "uniqPid",
    "dupPid",
    "emptyCh",
    "longTitle",
    "desc=pack",
    "longDesc",
    "svcTail",
    "tempGarble",
    "tailFrag",
    "problems"
  ];
  const lines = [headers.join("\t")];
  for (const r of rows) {
    const m = r.metrics;
    lines.push(
      [
        r.tenderId.slice(0, 28),
        String(r.inputFiles.length),
        String(m.goodsCount),
        String(m.uniquePositionIdCount),
        String(m.duplicatePositionIds),
        String(m.emptyCharacteristicsCount),
        String(m.longTitleCount),
        String(m.descriptionEqualsPackagingCount),
        String(m.longDescriptionCount),
        String(m.serviceTailCount),
        String(m.temperatureGarbleCount),
        String(m.tailFragmentDescriptionCount),
        String(r.problemPositions.length)
      ].join("\t")
    );
  }
  return lines.join("\n");
}
