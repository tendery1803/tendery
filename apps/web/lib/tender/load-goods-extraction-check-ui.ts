/**
 * Данные для пользовательского блока «Проверка извлечения товаров» (без изменения пайплайна извлечения).
 */
import type { TenderAiGoodItem } from "@tendery/contracts";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import { dedupeTechSpecBundleCrossSource, enhanceTechSpecBundleWithNoticeRows } from "@/lib/ai/deterministic-goods-merge";
import { extractGoodsFromTechSpec } from "@/lib/ai/extract-goods-from-tech-spec";
import { buildNoticeDeterministicRowsForGoodsMerge } from "@/lib/ai/extract-goods-notice-table";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import { buildGoodsSourceRoutingReport } from "@/lib/ai/goods-source-routing";
import {
  computeGoodsRegressionQualityMetrics,
  type GoodsRegressionQualityMetrics
} from "@/lib/ai/goods-regression-metrics";
import { verifyGoodsCardinalityAgainstTenderDocs } from "@/lib/ai/verify-goods-cardinality-against-tender-docs";
import { prisma } from "@/lib/db";

export type GoodsExtractionCheckUi = {
  extractedCount: number;
  referenceCount: number | null;
  sourceLabel: string;
  methodDetailLabel: string;
  ok: boolean | null;
  /** Одна строка для блока «Подробнее» (без bundle-диагностик). */
  goodsCardinalityLine: string | null;
};

export type GoodsExtractionQualityRow = GoodsExtractionCheckUi & {
  metrics: GoodsRegressionQualityMetrics;
};

type StructuredGoodLike = {
  name?: string;
  positionId?: string;
  codes?: string;
  unit?: string;
  quantity?: string;
  unitPrice?: string;
  lineTotal?: string;
  sourceHint?: string;
  characteristics?: { name?: string; value?: string; sourceHint?: string }[];
};

type StructuredBlockLike = {
  procurementKind?: string;
  goodsItems?: StructuredGoodLike[];
};

function toTenderAiGoods(rows: StructuredGoodLike[]): TenderAiGoodItem[] {
  return rows.map((g) => ({
    name: (g.name ?? "").trim(),
    positionId: (g.positionId ?? "").trim(),
    codes: (g.codes ?? "").trim(),
    unit: (g.unit ?? "").trim(),
    quantity: (g.quantity ?? "").trim(),
    unitPrice: (g.unitPrice ?? "").trim(),
    lineTotal: (g.lineTotal ?? "").trim(),
    sourceHint: (g.sourceHint ?? "").trim(),
    characteristics: (g.characteristics ?? []).map((c) => ({
      name: (c.name ?? "").trim(),
      value: (c.value ?? "").trim(),
      sourceHint: (c.sourceHint ?? "").trim()
    })),
    quantityUnit: (g as { quantityUnit?: string }).quantityUnit ?? "",
    quantitySource: (g as { quantitySource?: string }).quantitySource ?? "unknown"
  }));
}

function sourceLabelRu(source: string | null | undefined): string {
  switch (source) {
    case "spec":
      return "спецификация";
    case "print_form":
      return "печатная форма";
    case "tech_spec":
      return "техническое задание";
    case "none":
    default:
      return "нет данных";
  }
}

function methodDetailLabelRu(method: string): string {
  switch (method) {
    case "numbered_lines":
      return "сверка по нумерации строк в документе";
    case "deterministic_parse_rows":
      return "сверка по разбору технического задания";
    case "sku_model_tail_guard":
      return "контроль по числу модельных якорей в ТЗ/спецификации";
    case "na":
    default:
      return "нет данных";
  }
}

type GoodsExtractionCheckBundle = {
  ui: GoodsExtractionCheckUi;
  goodsItems: TenderAiGoodItem[];
};

/**
 * Общая загрузка для UI-блока и внутренних экранов качества (метрики по тем же goodsItems, что и сверка).
 */
async function loadGoodsExtractionCheckBundle(tenderId: string): Promise<GoodsExtractionCheckBundle | null> {
  const analysis = await prisma.tenderAnalysis.findFirst({
    where: { tenderId, status: "done" },
    orderBy: { createdAt: "desc" },
    select: { structuredBlock: true }
  });
  if (!analysis?.structuredBlock || typeof analysis.structuredBlock !== "object") return null;

  const block = analysis.structuredBlock as StructuredBlockLike;
  const kind = (block.procurementKind ?? "unknown").trim();
  const goods = Array.isArray(block.goodsItems) ? block.goodsItems : [];
  if (kind === "services" && goods.length === 0) return null;

  const goodsItems = toTenderAiGoods(goods);

  const files = await prisma.tenderFile.findMany({
    where: { tenderId, extractionStatus: "done", extractedText: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { originalName: true, extractedText: true }
  });
  const fileInputs = files.map((f) => ({
    originalName: f.originalName,
    extractedText: f.extractedText ?? ""
  }));
  if (fileInputs.length === 0) {
    const checkEmpty = verifyGoodsCardinalityAgainstTenderDocs({
      fileInputs: [],
      routingReport: buildGoodsSourceRoutingReport([]),
      goodsItems,
      techSpecParsedRowCount: null
    });
    return {
      goodsItems,
      ui: {
        extractedCount: checkEmpty.extractedCount,
        referenceCount: checkEmpty.referenceCount,
        sourceLabel: sourceLabelRu(checkEmpty.referenceSource),
        methodDetailLabel: methodDetailLabelRu(checkEmpty.method),
        ok: checkEmpty.ok,
        goodsCardinalityLine: checkEmpty.diagnostic
      }
    };
  }

  const routing = buildGoodsSourceRoutingReport(fileInputs);
  const minimized = buildMinimizedTenderTextForAi(fileInputs, { routingReport: routing });
  const corpus = maskPiiForAi(minimized.fullRawCorpusForMasking);
  let techBundle = extractGoodsFromTechSpec(corpus);
  techBundle = enhanceTechSpecBundleWithNoticeRows(techBundle, buildNoticeDeterministicRowsForGoodsMerge(corpus));
  techBundle = dedupeTechSpecBundleCrossSource(techBundle);

  const check = verifyGoodsCardinalityAgainstTenderDocs({
    fileInputs,
    routingReport: routing,
    goodsItems,
    techSpecParsedRowCount: techBundle?.items.length ?? null
  });

  return {
    goodsItems,
    ui: {
      extractedCount: check.extractedCount,
      referenceCount: check.referenceCount,
      sourceLabel: sourceLabelRu(check.referenceSource),
      methodDetailLabel: methodDetailLabelRu(check.method),
      ok: check.ok,
      goodsCardinalityLine: check.diagnostic
    }
  };
}

/**
 * Возвращает null, если блок проверки для пользователя не показываем (нет разбора / не товары).
 */
export async function loadGoodsExtractionCheckForTender(tenderId: string): Promise<GoodsExtractionCheckUi | null> {
  const bundle = await loadGoodsExtractionCheckBundle(tenderId);
  return bundle?.ui ?? null;
}

/** Строка для внутреннего экрана качества: сверка + метрики регрессии по тем же позициям. */
export async function loadGoodsExtractionQualityRowForTender(
  tenderId: string
): Promise<GoodsExtractionQualityRow | null> {
  const bundle = await loadGoodsExtractionCheckBundle(tenderId);
  if (!bundle) return null;
  return {
    ...bundle.ui,
    metrics: computeGoodsRegressionQualityMetrics(bundle.goodsItems)
  };
}
