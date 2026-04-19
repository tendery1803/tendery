/**
 * Read-only снимок этапов пайплайна goodsItems/characteristics по данным БД
 * (без повторного вызова AI и без изменения merge/sanitize).
 */
import { createHash } from "node:crypto";
import type { TenderAiGoodItem, TenderAiParseResult } from "@tendery/contracts";
import { TenderAnalysisStructuredBlockSchema } from "@tendery/contracts";
import {
  buildMinimizedTenderTextForAi,
  type MinimizerRoutingStats
} from "@/lib/ai/build-minimized-tender-text-for-ai";
import { buildGoodsSpecificationChunksWithMeta } from "@/lib/ai/goods-spec-chunks";
import {
  buildGoodsSourceRoutingReport,
  type GoodsSourceRoutingReport
} from "@/lib/ai/goods-source-routing";
import {
  dedupeTechSpecBundleCrossSource,
  stripGlueOnlyRegistryPositionIdsFromTechSpecBundle
} from "@/lib/ai/deterministic-goods-merge";
import { extractGoodsFromTechSpec, type GoodsTechSpecParseAudit } from "@/lib/ai/extract-goods-from-tech-spec";
import {
  formatGoodItemQuantityForDisplay,
  goodItemHasNumericQuantityData,
  parseQuantityValueLoose
} from "@/lib/ai/goods-quantity-display";
import {
  normalizeGoodsMatchingKey,
  reconcileGoodsItemsWithDocumentSources
} from "@/lib/ai/match-goods-across-sources";
import { finalizeGoodsItemsFromModelOutput, parseTenderAiResult } from "@/lib/ai/parse-model-json";
import { computeStructuredGoodsDiagnostics } from "@/lib/checklist/build-tender-checklist";
import { prisma } from "@/lib/db";

function sha256Short(s: string, maxLen = 12): string {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, maxLen);
}

/** Первый ответ модели до доп. проходов goods_chunk / supplement (как в rawOutput до склейки). */
export function extractMainAnalyzeModelOutputSegment(rawOutput: string): string {
  const idx = rawOutput.indexOf("\n\n--- goods_");
  return idx >= 0 ? rawOutput.slice(0, idx) : rawOutput;
}

function metricsFromParse(
  label: string,
  parsed: ReturnType<typeof parseTenderAiResult>
): {
  label: string;
  ok: boolean;
  error?: string;
  goodsCount: number;
  charRowsTotal: number;
  positions: Array<{
    positionId: string;
    name: string;
    quantity: string;
    characteristicsCount: number;
  }>;
} {
  if (!parsed.ok) {
    return {
      label,
      ok: false,
      error: parsed.error,
      goodsCount: 0,
      charRowsTotal: 0,
      positions: []
    };
  }
  const data = parsed.data as TenderAiParseResult;
  const goods = data.goodsItems ?? [];
  const charRowsTotal = goods.reduce((acc, g) => acc + g.characteristics.length, 0);
  return {
    label,
    ok: true,
    goodsCount: goods.length,
    charRowsTotal,
    positions: goods.map((g) => ({
      positionId: g.positionId,
      name: g.name,
      quantity: g.quantity,
      quantityValue: g.quantityValue ?? null,
      quantityUnit: (g.quantityUnit || "").trim(),
      quantitySource: g.quantitySource ?? "unknown",
      characteristicsCount: g.characteristics.length
    }))
  };
}

type AuditCoverageSlice = {
  mainAnalyzeGoodsCount: number | null;
  finalGoodsCount: number | null;
  supplementTriggered: boolean | null;
  pipelineTrace: Array<{
    stage: string;
    extractedGoodsCount: number;
    cumulativeGoodsCountAfterStep: number;
  }>;
} | null;

function sliceGoodsCoverageAudit(meta: unknown): AuditCoverageSlice {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  const g = m.goodsCoverageAudit;
  if (!g || typeof g !== "object") return null;
  const gc = g as Record<string, unknown>;
  const traceRaw = gc.pipelineTrace;
  const pipelineTrace = Array.isArray(traceRaw)
    ? traceRaw
        .filter((x) => x && typeof x === "object")
        .map((x) => {
          const t = x as Record<string, unknown>;
          return {
            stage: String(t.stage ?? ""),
            extractedGoodsCount: Number(t.extractedGoodsCount ?? 0),
            cumulativeGoodsCountAfterStep: Number(t.cumulativeGoodsCountAfterStep ?? 0)
          };
        })
    : [];
  return {
    mainAnalyzeGoodsCount:
      gc.mainAnalyzeGoodsCount != null ? Number(gc.mainAnalyzeGoodsCount) : null,
    finalGoodsCount: gc.finalGoodsCount != null ? Number(gc.finalGoodsCount) : null,
    supplementTriggered:
      gc.supplementTriggered != null ? Boolean(gc.supplementTriggered) : null,
    pipelineTrace
  };
}

function sliceGoodsTechSpecParseAudit(meta: unknown): GoodsTechSpecParseAudit | null {
  if (!meta || typeof meta !== "object") return null;
  const a = (meta as Record<string, unknown>).goodsTechSpecParseAudit;
  if (!a || typeof a !== "object") return null;
  return a as GoodsTechSpecParseAudit;
}

/** Какой корпус ушёл в основной промпт vs goods (после `corpusSplit` в analyze). */
export type AnalyzeCorpusSplitFromAudit = {
  mainAiPromptUses: string;
  goodsPipelineUses: string;
  maskedDeterministicExtractorsUse: string;
  topFieldsOutChars: number;
  goodsPipelineOutChars: number;
  /** Основной промпт: wide + routed в одном запросе (если есть в audit). */
  mainPromptDualSection: boolean | null;
  mainPromptCombinedMinimizedChars: number | null;
};

function sliceAnalyzeCorpusSplitFromAudit(meta: unknown): AnalyzeCorpusSplitFromAudit | null {
  if (!meta || typeof meta !== "object") return null;
  const minimization = (meta as Record<string, unknown>).minimization;
  if (!minimization || typeof minimization !== "object") return null;
  const m = minimization as Record<string, unknown>;
  const split = m.corpusSplit;
  if (!split || typeof split !== "object") return null;
  const s = split as Record<string, unknown>;
  const top = m.topFieldsMinimizer;
  const goods = m.goodsPipelineMinimizer;
  const topO = top && typeof top === "object" ? (top as Record<string, unknown>).outChars : null;
  const goodsO = goods && typeof goods === "object" ? (goods as Record<string, unknown>).outChars : null;
  const map = m.mainAnalyzePrompt;
  let dual: boolean | null = null;
  let combined: number | null = null;
  if (map && typeof map === "object") {
    const mp = map as Record<string, unknown>;
    if (typeof mp.dualSection === "boolean") dual = mp.dualSection;
    const cc = mp.combinedMinimizedChars;
    if (typeof cc === "number") combined = cc;
    else if (cc != null && Number.isFinite(Number(cc))) combined = Number(cc);
  }
  return {
    mainAiPromptUses: String(s.mainAiPromptUses ?? ""),
    goodsPipelineUses: String(s.goodsPipelineUses ?? ""),
    maskedDeterministicExtractorsUse: String(s.maskedDeterministicExtractorsUse ?? ""),
    topFieldsOutChars: typeof topO === "number" ? topO : Number(topO ?? 0),
    goodsPipelineOutChars: typeof goodsO === "number" ? goodsO : Number(goodsO ?? 0),
    mainPromptDualSection: dual,
    mainPromptCombinedMinimizedChars: combined
  };
}

/** Где пропали строки характеристик относительно детерминированного ТЗ (если аудит есть). */
export function inferCharacteristicsLossRelativeToTechSpecParse(report: GoodsPipelineReport): {
  techSpecCharRows: number | null;
  modelMainCharRows: number;
  savedCharRows: number;
  lostAfterTechSpecParse: number | null;
  lostAfterModelMainParse: number | null;
  note: string;
} {
  const tech =
    report.stages.goodsTechSpecParseAudit?.prioritySliceDiagnostics?.charRowsAtTechSpecParse ?? null;
  const modelMain = report.stages.parseModelJsonMain.charRowsTotal;
  const saved = report.stages.savedStructuredBlock.charRowsTotal;
  const lostAfterTech =
    tech != null ? Math.max(0, tech - saved) : null;
  const lostAfterModel = Math.max(0, modelMain - saved);
  let note =
    tech == null
      ? "В meta последнего audit нет goodsTechSpecParseAudit.prioritySliceDiagnostics (старый разбор или без reconcile)."
      : `После детерминированного ТЗ: ${tech} строк; в основном сегменте модели: ${modelMain}; в сохранённом блоке: ${saved}.`;
  if (tech != null && tech > modelMain) {
    note += " Часть характеристик из ТЗ могла не попасть в JSON модели.";
  }
  if (modelMain > saved) {
    note += " Расхождение модель→сохранение: merge/sanitize/reconcile.";
  }
  return {
    techSpecCharRows: tech,
    modelMainCharRows: modelMain,
    savedCharRows: saved,
    lostAfterTechSpecParse: lostAfterTech,
    lostAfterModelMainParse: lostAfterModel,
    note
  };
}

/** Сопоставление quantity из снимка ТЗ-парсера (до 8 строк) с сохранённым structuredBlock. */
export function inferQuantityLossRelativeToTechSpecParse(report: GoodsPipelineReport): {
  samples: Array<{
    logicalPath: string;
    namePreview: string;
    quantityValueAtTechParse: number | null;
    quantityUnitAtTechParse: string;
    quantityAttachedAtRow: number | null;
    quantityAttachSource: string;
    quantityLostLater: boolean;
  }>;
  note: string;
} {
  const samples =
    report.stages.goodsTechSpecParseAudit?.prioritySliceDiagnostics?.positionSamples ?? [];
  const saved = report.stages.savedStructuredBlock.positions;
  const rows = samples.map((s) => {
    const pref = s.namePreview.slice(0, Math.min(32, s.namePreview.length));
    const savedMatch = saved.find(
      (p) =>
        (s.positionId && (p.positionId || "").trim() === s.positionId.trim()) ||
        (pref.length > 0 && (p.name || "").trim().startsWith(pref))
    );
    const hadTechQty = s.quantityValue != null;
    const savedHasNumeric = Boolean(
      savedMatch &&
        ((savedMatch.quantityValue != null && savedMatch.quantityValue > 0) ||
          /\d/.test(savedMatch.quantity ?? ""))
    );
    const quantityLostLater = Boolean(hadTechQty && savedMatch && !savedHasNumeric);
    return {
      logicalPath: s.logicalPath,
      namePreview: s.namePreview,
      quantityValueAtTechParse: s.quantityValue,
      quantityUnitAtTechParse: s.quantityUnit,
      quantityAttachedAtRow: s.quantityAttachedAtRow ?? null,
      quantityAttachSource: s.quantityAttachSource ?? "",
      quantityLostLater
    };
  });
  const lostN = rows.filter((r) => r.quantityLostLater).length;
  const note =
    samples.length === 0
      ? "Нет positionSamples в goodsTechSpecParseAudit (старый audit или без ТЗ-каркаса)."
      : `Потеря quantity после ТЗ: ${lostN} из ${rows.length} (выборка positionSamples).`;
  return { samples: rows, note };
}

export type GoodsPipelineReport = {
  tenderId: string;
  analysisId: string | null;
  analysisCreatedAt: string | null;
  analysisHasRawOutput: boolean;
  rawOutputTotalChars: number;
  stages: {
    rawFiles: {
      fileCount: number;
      totalExtractedChars: number;
      minimizedChars: number;
      goodsSpecChunksCount: number;
      files: Array<{
        originalName: string;
        extractedChars: number;
        sha256: string;
      }>;
      chunkSummaries: Array<{
        chunkIndex1: number;
        textLength: number;
        startLine: number;
        endLine: number;
        previewHead: string;
        previewTail: string;
      }>;
      minimizerRouting: MinimizerRoutingStats;
    };
    parseModelJsonMain: ReturnType<typeof metricsFromParse>;
    parseModelJsonFullRaw: ReturnType<typeof metricsFromParse>;
    auditCoverage: AuditCoverageSlice;
    savedStructuredBlock: ReturnType<typeof computeStructuredGoodsDiagnostics> & {
      checklistCharRowsNote: string;
    };
    /** Маршрутизация источников goods по logical path из extraction diagnostics. */
    sourceRouting: GoodsSourceRoutingReport;
    /** Снимок из audit meta последнего analyze (детерминированное ТЗ + priority slice). */
    goodsTechSpecParseAudit: GoodsTechSpecParseAudit | null;
    /** Из audit.meta.minimization после развязки корпусов (null для старых разборов). */
    analyzeCorpusSplitFromAudit: AnalyzeCorpusSplitFromAudit | null;
  };
};

export function inferGoodsPipelineDivergence(report: GoodsPipelineReport): string {
  const { rawFiles, parseModelJsonMain, savedStructuredBlock } = report.stages;
  if (rawFiles.fileCount === 0) return "no_extracted_files";
  if (!report.analysisHasRawOutput) return "no_raw_output_in_analysis";
  if (!parseModelJsonMain.ok) return "parse_main_failed";
  if (
    parseModelJsonMain.goodsCount > 0 &&
    savedStructuredBlock.schemaOk &&
    savedStructuredBlock.nGoods === 0
  ) {
    return "main_parse_ok_saved_empty";
  }
  if (parseModelJsonMain.goodsCount > savedStructuredBlock.nGoods) {
    return "loss_goods_after_main_parse_merge_sanitize_or_reconcile";
  }
  if (
    parseModelJsonMain.goodsCount === savedStructuredBlock.nGoods &&
    parseModelJsonMain.charRowsTotal > savedStructuredBlock.charRowsTotal
  ) {
    return "loss_characteristics_same_goods_count";
  }
  if (parseModelJsonMain.goodsCount < savedStructuredBlock.nGoods) {
    return "saved_more_goods_than_main_parse_segment";
  }
  return "no_obvious_divergence";
}

/** Сводные метрики для baseline JSON (без тяжёлых вложенных массивов). */
export function compactMetricsForBaseline(report: GoodsPipelineReport) {
  return {
    tenderId: report.tenderId,
    analysisId: report.analysisId,
    analysisHasRawOutput: report.analysisHasRawOutput,
    /** Без rawOutput сравнение parse-model-json с сохранённым блоком невозможно; см. AI_STORE_RAW_OUTPUT=true при разборе. */
    parseMainComparable: report.analysisHasRawOutput,
    rawFiles: {
      fileCount: report.stages.rawFiles.fileCount,
      minimizedChars: report.stages.rawFiles.minimizedChars,
      goodsSpecChunksCount: report.stages.rawFiles.goodsSpecChunksCount
    },
    parseMain: {
      ok: report.stages.parseModelJsonMain.ok,
      error: report.stages.parseModelJsonMain.error,
      goodsCount: report.stages.parseModelJsonMain.goodsCount,
      charRowsTotal: report.stages.parseModelJsonMain.charRowsTotal
    },
    parseFull: {
      ok: report.stages.parseModelJsonFullRaw.ok,
      error: report.stages.parseModelJsonFullRaw.error,
      goodsCount: report.stages.parseModelJsonFullRaw.goodsCount,
      charRowsTotal: report.stages.parseModelJsonFullRaw.charRowsTotal
    },
    audit: report.stages.auditCoverage
      ? {
          mainAnalyzeGoodsCount: report.stages.auditCoverage.mainAnalyzeGoodsCount,
          finalGoodsCount: report.stages.auditCoverage.finalGoodsCount,
          supplementTriggered: report.stages.auditCoverage.supplementTriggered,
          lastPipelineCumulative:
            report.stages.auditCoverage.pipelineTrace.at(-1)?.cumulativeGoodsCountAfterStep ?? null
        }
      : null,
    saved: {
      schemaOk: report.stages.savedStructuredBlock.schemaOk,
      nGoods: report.stages.savedStructuredBlock.nGoods,
      charRowsTotal: report.stages.savedStructuredBlock.charRowsTotal
    },
    divergence: inferGoodsPipelineDivergence(report),
    techSpecPriority:
      report.stages.goodsTechSpecParseAudit?.prioritySliceDiagnostics ?? null,
    characteristicsLossHint: inferCharacteristicsLossRelativeToTechSpecParse(report),
    quantityLossHint: inferQuantityLossRelativeToTechSpecParse(report),
    analyzeCorpusSplit: report.stages.analyzeCorpusSplitFromAudit
  };
}

export async function loadGoodsPipelineReportForTender(tenderId: string): Promise<GoodsPipelineReport> {
  const tender = await prisma.tender.findUnique({
    where: { id: tenderId },
    select: { id: true }
  });
  if (!tender) {
    throw new Error(`tender not found: ${tenderId}`);
  }

  const files = await prisma.tenderFile.findMany({
    where: { tenderId, extractionStatus: "done", extractedText: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { originalName: true, extractedText: true }
  });

  const fileRows = files.map((f) => ({
    originalName: f.originalName,
    extractedText: f.extractedText ?? ""
  }));
  const sourceRouting = buildGoodsSourceRoutingReport(fileRows);
  const { text: minimized, stats: minimizerStats } = buildMinimizedTenderTextForAi(fileRows, {
    routingReport: sourceRouting
  });
  const chunkMetas = buildGoodsSpecificationChunksWithMeta(minimized);

  const totalExtractedChars = fileRows.reduce((acc, t) => acc + t.extractedText.length, 0);

  const analysis = await prisma.tenderAnalysis.findFirst({
    where: { tenderId, status: "done" },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      rawOutput: true,
      structuredBlock: true,
      createdAt: true
    }
  });

  const audit = await prisma.auditLog.findFirst({
    where: {
      targetType: "Tender",
      targetId: tenderId,
      action: { in: ["tender.ai_analyze", "tender.parse"] }
    },
    orderBy: { createdAt: "desc" },
    select: { meta: true }
  });

  const raw = analysis?.rawOutput ?? "";
  const hasRaw = raw.trim().length > 0;
  const mainSeg = extractMainAnalyzeModelOutputSegment(raw);
  const parsedMain = parseTenderAiResult(mainSeg);
  const parsedFull = parseTenderAiResult(raw);

  const savedDiag = computeStructuredGoodsDiagnostics(analysis?.structuredBlock ?? null);
  const checklistCharRowsNote =
    savedDiag.charRowsTotal > 0
      ? `Строк характеристик: ${savedDiag.charRowsTotal}`
      : "Характеристики не извлечены";

  const goodsTechSpecParseAudit = sliceGoodsTechSpecParseAudit(audit?.meta);
  const analyzeCorpusSplitFromAudit = sliceAnalyzeCorpusSplitFromAudit(audit?.meta);

  return {
    tenderId,
    analysisId: analysis?.id ?? null,
    analysisCreatedAt: analysis?.createdAt?.toISOString() ?? null,
    analysisHasRawOutput: hasRaw,
    rawOutputTotalChars: raw.length,
    stages: {
      rawFiles: {
        fileCount: files.length,
        totalExtractedChars,
        minimizedChars: minimized.length,
        goodsSpecChunksCount: chunkMetas.length,
        files: files.map((f) => {
          const t = f.extractedText ?? "";
          return {
            originalName: f.originalName,
            extractedChars: t.length,
            sha256: sha256Short(t)
          };
        }),
        chunkSummaries: chunkMetas.map((ch, i) => ({
          chunkIndex1: i + 1,
          textLength: ch.textLength,
          startLine: ch.startLine,
          endLine: ch.endLine,
          previewHead: ch.previewHead,
          previewTail: ch.previewTail
        })),
        minimizerRouting: minimizerStats.routing
      },
      parseModelJsonMain: metricsFromParse("parse_model_json_main_segment", parsedMain),
      parseModelJsonFullRaw: metricsFromParse("parse_model_json_full_raw_output", parsedFull),
      auditCoverage: sliceGoodsCoverageAudit(audit?.meta),
      savedStructuredBlock: {
        ...savedDiag,
        checklistCharRowsNote
      },
      sourceRouting,
      goodsTechSpecParseAudit,
      analyzeCorpusSplitFromAudit
    }
  };
}

function traceKeyForGoodsQuantityStage(g: TenderAiGoodItem): string {
  const pid = (g.positionId || "").replace(/^№\s*/i, "").trim().replace(/\s/g, "");
  const nm = normalizeGoodsMatchingKey(`${g.name} ${g.codes}`).slice(0, 96);
  return pid ? `pid:${pid}|${nm}` : `nm:${nm}`;
}

function findCorrespondingGoodItem(
  items: TenderAiGoodItem[],
  target: TenderAiGoodItem
): TenderAiGoodItem | undefined {
  const k = traceKeyForGoodsQuantityStage(target);
  const direct = items.find((x) => traceKeyForGoodsQuantityStage(x) === k);
  if (direct) return direct;
  const nt = normalizeGoodsMatchingKey(target.name ?? "").slice(0, 48);
  return items.find((x) => normalizeGoodsMatchingKey(x.name ?? "").slice(0, 48) === nt);
}

/** Снимок полей quantity на одном этапе (для отладки цепочки). */
export type GoodsQuantityStageSnapshot = {
  stage: string;
  namePreview: string;
  quantity: string;
  quantityValue: number | null;
  quantityUnit: string;
  quantitySource: string;
  unit: string;
  hasNumericQuantity: boolean;
  displayLabel: string | null;
  /** Есть ли числовое quantity на следующем этапе (null для последнего). */
  hasNumericOnNextStage: boolean | null;
};

export type GoodsQuantityStageTracePosition = {
  traceKey: string;
  stages: GoodsQuantityStageSnapshot[];
  /** Где впервые пропало числовое quantity относительно предыдущего этапа. */
  firstNumericLossAfterStage: string | null;
};

export type GoodsQuantityStageTraceResult = {
  ok: boolean;
  parseError?: string;
  positions: GoodsQuantityStageTracePosition[];
  /**
   * Офлайн по БД воспроизводим main-сегмент rawOutput → finalize; merge чанков / mergeGoodsItemsLists
   * к сохранённому mergedAi не сводим (нужен полный повтор analyze).
   */
  traceScopeNote: string;
};

/**
 * Восстанавливает цепочку quantity без вызова AI: tech parse → finalize(main segment) → reconcile → saved block.
 * Сопоставление позиций — по positionId+name+codes и резервно по префиксу имени.
 */
export function buildGoodsQuantityStageTrace(params: {
  maskedCorpusMinimized: string;
  rawOutput: string;
  structuredBlock: unknown;
}): GoodsQuantityStageTraceResult {
  const savedParsed = TenderAnalysisStructuredBlockSchema.safeParse(params.structuredBlock);
  const savedGoods = savedParsed.success ? savedParsed.data.goodsItems : [];

  const main = extractMainAnalyzeModelOutputSegment(params.rawOutput);
  const parsed = parseTenderAiResult(main);
  const scopeNote =
    "Этапы: tech_spec_parse → model_after_finalize (только первый сегмент rawOutput) → reconcile_match_goods → saved_structured_block. Промежуточные merge чанков не воспроизводятся.";

  if (!parsed.ok) {
    return { ok: false, parseError: parsed.error, positions: [], traceScopeNote: scopeNote };
  }

  const techBundleRaw = extractGoodsFromTechSpec(params.maskedCorpusMinimized);
  const techBundleDeduped = dedupeTechSpecBundleCrossSource(techBundleRaw) ?? techBundleRaw;
  const techBundle =
    stripGlueOnlyRegistryPositionIdsFromTechSpecBundle(techBundleDeduped, params.maskedCorpusMinimized) ??
    techBundleDeduped;
  const techItems = techBundle.items;
  const afterFinalize = finalizeGoodsItemsFromModelOutput(parsed.data.goodsItems);
  const reconciled = reconcileGoodsItemsWithDocumentSources(
    afterFinalize,
    params.maskedCorpusMinimized,
    techBundle
  ).items;

  const driver = savedGoods.length > 0 ? savedGoods : reconciled;
  const positions: GoodsQuantityStageTracePosition[] = [];

  for (const anchor of driver.slice(0, 16)) {
    const traceKey = traceKeyForGoodsQuantityStage(anchor);
    const tItem = findCorrespondingGoodItem(techItems, anchor);
    const fItem = findCorrespondingGoodItem(afterFinalize, anchor);
    const rItem = findCorrespondingGoodItem(reconciled, anchor);
    const sItem = findCorrespondingGoodItem(savedGoods, anchor) ?? anchor;

    const stagesOrdered: Array<{ id: string; item?: TenderAiGoodItem }> = [
      { id: "tech_spec_parse", item: tItem },
      { id: "model_after_finalize", item: fItem },
      { id: "reconcile_match_goods", item: rItem },
      { id: "saved_structured_block", item: sItem }
    ];

    const snaps: GoodsQuantityStageSnapshot[] = stagesOrdered.map((row, i) => {
      const g = row.item;
      const nextG = stagesOrdered[i + 1]?.item;
      if (!g) {
        return {
          stage: row.id,
          namePreview: "",
          quantity: "",
          quantityValue: null,
          quantityUnit: "",
          quantitySource: "missing",
          unit: "",
          hasNumericQuantity: false,
          displayLabel: null,
          hasNumericOnNextStage:
            i + 1 < stagesOrdered.length ? goodItemHasNumericQuantityData(nextG) : null
        };
      }
      const qv = parseQuantityValueLoose(g.quantityValue);
      return {
        stage: row.id,
        namePreview: (g.name ?? "").slice(0, 72),
        quantity: (g.quantity ?? "").trim(),
        quantityValue: qv,
        quantityUnit: (g.quantityUnit ?? "").trim(),
        quantitySource: g.quantitySource ?? "unknown",
        unit: (g.unit ?? "").trim(),
        hasNumericQuantity: goodItemHasNumericQuantityData(g),
        displayLabel: formatGoodItemQuantityForDisplay(g),
        hasNumericOnNextStage:
          i + 1 < stagesOrdered.length ? goodItemHasNumericQuantityData(nextG) : null
      };
    });

    let firstNumericLossAfterStage: string | null = null;
    for (let i = 0; i < snaps.length - 1; i++) {
      if (snaps[i]!.hasNumericQuantity && !snaps[i + 1]!.hasNumericQuantity) {
        firstNumericLossAfterStage = snaps[i]!.stage;
        break;
      }
    }

    positions.push({ traceKey, stages: snaps, firstNumericLossAfterStage });
  }

  return { ok: true, positions, traceScopeNote: scopeNote };
}

/**
 * Загрузка из БД и построение трассировки quantity (для CLI/отладки).
 * Лог при `TENDER_AI_GOODS_QUANTITY_TRACE=1`: краткая сводка в stdout.
 */
export async function loadGoodsQuantityStageTraceForTender(
  tenderId: string
): Promise<GoodsQuantityStageTraceResult & { tenderId: string; analysisId: string | null }> {
  const files = await prisma.tenderFile.findMany({
    where: { tenderId, extractionStatus: "done", extractedText: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { originalName: true, extractedText: true }
  });
  const fileRows = files.map((f) => ({
    originalName: f.originalName,
    extractedText: f.extractedText ?? ""
  }));
  const sourceRouting = buildGoodsSourceRoutingReport(fileRows);
  const { text: minimized } = buildMinimizedTenderTextForAi(fileRows, {
    routingReport: sourceRouting
  });

  const analysis = await prisma.tenderAnalysis.findFirst({
    where: { tenderId, status: "done" },
    orderBy: { createdAt: "desc" },
    select: { id: true, rawOutput: true, structuredBlock: true }
  });

  const trace = buildGoodsQuantityStageTrace({
    maskedCorpusMinimized: minimized,
    rawOutput: analysis?.rawOutput ?? "",
    structuredBlock: analysis?.structuredBlock ?? null
  });

  if (process.env.TENDER_AI_GOODS_QUANTITY_TRACE === "1" && trace.positions.length > 0) {
    const lines: string[] = ["[goods_quantity_stage_trace]", `tenderId=${tenderId}`];
    for (const p of trace.positions.slice(0, 6)) {
      lines.push(`  key=${p.traceKey.slice(0, 60)} lossAfter=${p.firstNumericLossAfterStage ?? "—"}`);
      for (const s of p.stages) {
        lines.push(
          `    ${s.stage}: num=${s.hasNumericQuantity} q="${s.quantity}" qv=${s.quantityValue ?? "null"} qu="${s.quantityUnit}" src=${s.quantitySource} label="${s.displayLabel ?? ""}"`
        );
      }
    }
    console.info(lines.join("\n"));
  }

  return { tenderId, analysisId: analysis?.id ?? null, ...trace };
}
