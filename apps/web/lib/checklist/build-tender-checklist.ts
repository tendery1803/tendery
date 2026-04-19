import { TenderAnalysisStructuredBlockSchema } from "@tendery/contracts";
import { prisma } from "@/lib/db";

type CompanyDocType =
  | "charter"
  | "extract_egrul"
  | "company_card"
  | "power_of_attorney"
  | "license"
  | "certificate"
  | "other";

const DOC_ROWS: Array<{ itemKey: string; title: string; docType: CompanyDocType }> = [
  { itemKey: "doc_charter", title: "Устав компании", docType: "charter" },
  { itemKey: "doc_egrul", title: "Выписка ЕГРЮЛ/ЕГРИП", docType: "extract_egrul" },
  { itemKey: "doc_company_card", title: "Карточка предприятия", docType: "company_card" },
  { itemKey: "doc_poa", title: "Доверенность", docType: "power_of_attorney" },
  { itemKey: "doc_license", title: "Лицензия (при необходимости)", docType: "license" }
];

type ChecklistRow = {
  tenderId: string;
  itemKey: string;
  title: string;
  required: boolean;
  status: string;
  note: string | null;
};

function buildAiChecklistRows(
  tenderId: string,
  analysis: {
    structuredBlock: unknown;
    fields: Array<{ confidence: number }>;
  } | null
): ChecklistRow[] {
  const rows: ChecklistRow[] = [];

  if (!analysis) {
    rows.push({
      tenderId,
      itemKey: "ai_analysis_done",
      title: "AI: выполнен разбор закупки",
      required: false,
      status: "missing",
      note: "Нет завершённого разбора — запустите AI-разбор"
    });
    return rows;
  }

  const lowConf = analysis.fields.some((f) => f.confidence < 0.45);
  rows.push({
    tenderId,
    itemKey: "ai_fields_confidence",
    title: "AI: уверенность по полям верхнего блока",
    required: false,
    status: lowConf ? "review" : "ok",
    note: lowConf
      ? "Есть поля с низкой уверенностью — проверьте вручную"
      : "Критичных провалов уверенности нет"
  });

  const blockParsed = TenderAnalysisStructuredBlockSchema.safeParse(analysis.structuredBlock);
  if (!blockParsed.success) {
    rows.push({
      tenderId,
      itemKey: "ai_goods_services_block",
      title: "AI: товары, характеристики и услуги",
      required: false,
      status: "missing",
      note: "Структурированный блок отсутствует или в старом формате"
    });
    return rows;
  }

  const { procurementKind, goodsItems, servicesOfferings, goodsCompleteness } = blockParsed.data;
  const nGoods = goodsItems.length;
  const nServices = servicesOfferings.length;
  const charRowsTotal = goodsItems.reduce((acc, g) => acc + g.characteristics.length, 0);
  const goodsWithChars = goodsItems.filter((g) => g.characteristics.length > 0).length;

  const isGoodsLike =
    procurementKind === "goods" || procurementKind === "mixed" || nGoods > 0;
  const isServicesLike =
    procurementKind === "services" || procurementKind === "mixed" || nServices > 0;

  if (isGoodsLike) {
    const gc = goodsCompleteness;
    let completenessNote =
      gc?.checklistNote?.trim() ||
      (nGoods > 0 ? `Позиций: ${nGoods}` : "Позиции не выделены");
    if (gc && gc.extractedCount !== nGoods && /\(извлечено\s+\d+/.test(completenessNote)) {
      completenessNote = completenessNote.replace(
        /\(извлечено\s+\d+\s*\)/,
        `(извлечено ${nGoods})`
      );
    }
    let goodsPositionsStatus: string;
    if (nGoods === 0) {
      goodsPositionsStatus = "missing";
    } else if (!gc) {
      goodsPositionsStatus = "ok";
    } else if (gc.completenessStatus === "complete") {
      goodsPositionsStatus = "ok";
    } else if (gc.completenessStatus === "partial") {
      goodsPositionsStatus = "review";
    } else {
      goodsPositionsStatus = "review";
    }
    rows.push({
      tenderId,
      itemKey: "ai_goods_positions",
      title: "AI: товарные позиции и полнота спецификации",
      required: false,
      status: goodsPositionsStatus,
      note: completenessNote
    });
    rows.push({
      tenderId,
      itemKey: "ai_goods_characteristics",
      title: "AI: характеристики товаров",
      required: false,
      status: charRowsTotal > 0 ? "ok" : "missing",
      note:
        charRowsTotal > 0
          ? `Строк характеристик: ${charRowsTotal}`
          : "Характеристики не извлечены"
    });
    if (nGoods > 1) {
      const allHaveChars = goodsWithChars === nGoods;
      rows.push({
        tenderId,
        itemKey: "ai_chars_per_position",
        title: "AI: характеристики по каждой позиции",
        required: false,
        status: allHaveChars ? "ok" : "review",
        note: allHaveChars
          ? "По каждой позиции есть хотя бы одна характеристика"
          : "Есть позиции без характеристик — проверьте привязку в документах"
      });
    }
  }

  if (isServicesLike) {
    rows.push({
      tenderId,
      itemKey: "ai_services_list",
      title: "AI: перечень услуг / работ",
      required: false,
      status: nServices > 0 ? "ok" : "missing",
      note: nServices > 0 ? `Блоков: ${nServices}` : "Перечень не выделен"
    });
    const detailScore = servicesOfferings.filter(
      (s) =>
        s.volumeOrScope.trim().length > 0 ||
        s.deadlinesOrStages.trim().length > 0 ||
        s.resultRequirements.trim().length > 0
    ).length;
    rows.push({
      tenderId,
      itemKey: "ai_services_scope",
      title: "AI: объём, этапы и результат услуг",
      required: false,
      status: nServices === 0 ? "missing" : detailScore > 0 ? "ok" : "review",
      note:
        nServices === 0
          ? "—"
          : detailScore > 0
            ? "Заполнены объём/сроки/результат по части услуг"
            : "Мало деталей по объёму и результату — проверьте ТЗ"
    });
  }

  rows.push({
    tenderId,
    itemKey: "ai_manual_review_hint",
    title: "AI: условия, требующие ручной проверки",
    required: false,
    status: lowConf || (nGoods > 1 && goodsWithChars < nGoods) ? "review" : "ok",
    note:
      lowConf || (nGoods > 1 && goodsWithChars < nGoods)
        ? "Сверьте спорные требования с исходными файлами"
        : "Явных флагов неоднозначности нет"
  });

  return rows;
}

/** Сводка по товарам/характеристикам из сохранённого structuredBlock (для диагностики и регрессий). */
export function computeStructuredGoodsDiagnostics(structuredBlock: unknown): {
  schemaOk: boolean;
  procurementKind?: string;
  nGoods: number;
  nServices: number;
  charRowsTotal: number;
  goodsWithChars: number;
  positions: Array<{
    positionId: string;
    name: string;
    quantity: string;
    quantityValue: number | null;
    quantityUnit: string;
    quantitySource: string;
    characteristicsCount: number;
  }>;
} {
  const blockParsed = TenderAnalysisStructuredBlockSchema.safeParse(structuredBlock);
  if (!blockParsed.success) {
    return {
      schemaOk: false,
      nGoods: 0,
      nServices: 0,
      charRowsTotal: 0,
      goodsWithChars: 0,
      positions: []
    };
  }
  const { procurementKind, goodsItems, servicesOfferings } = blockParsed.data;
  const charRowsTotal = goodsItems.reduce((acc, g) => acc + g.characteristics.length, 0);
  const goodsWithChars = goodsItems.filter((g) => g.characteristics.length > 0).length;
  return {
    schemaOk: true,
    procurementKind,
    nGoods: goodsItems.length,
    nServices: servicesOfferings.length,
    charRowsTotal,
    goodsWithChars,
    positions: goodsItems.map((g) => ({
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

export async function rebuildChecklistForTender(tenderId: string, companyId: string) {
  const docs = await prisma.companyDocument.findMany({
    where: { companyId, status: "active" },
    select: { type: true }
  });
  const have = new Set(docs.map((d) => d.type));

  const docItems: ChecklistRow[] = DOC_ROWS.map((row) => {
    const ok = have.has(row.docType);
    return {
      tenderId,
      itemKey: row.itemKey,
      title: row.title,
      required: true,
      status: ok ? "ok" : "missing",
      note: ok ? null : "Нет активного документа этого типа"
    };
  });

  const latestAnalysis = await prisma.tenderAnalysis.findFirst({
    where: { tenderId, status: "done" },
    orderBy: { createdAt: "desc" },
    select: { structuredBlock: true, fields: { select: { confidence: true } } }
  });

  const aiItems = buildAiChecklistRows(tenderId, latestAnalysis);

  await prisma.$transaction(async (tx) => {
    await tx.tenderChecklistItem.deleteMany({ where: { tenderId } });
    const merged = [...docItems, ...aiItems];
    if (merged.length) {
      await tx.tenderChecklistItem.createMany({ data: merged });
    }
  });

  return prisma.tenderChecklistItem.findMany({
    where: { tenderId },
    orderBy: { itemKey: "asc" }
  });
}
