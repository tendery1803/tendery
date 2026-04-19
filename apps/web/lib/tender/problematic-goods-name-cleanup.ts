/**
 * Превью и безопасное применение полировки name для позиций с известными сигналами качества.
 * Не меняет число позиций и прочие поля.
 */
import type { GoodsRegressionProblemType } from "@/lib/ai/goods-regression-metrics";
import { collectGoodsRegressionProblemsByItemIndex } from "@/lib/ai/goods-regression-metrics";
import { polishGoodsDisplayName } from "@/lib/ai/polish-goods-display-name";
import type { TenderAiGoodItem } from "@tendery/contracts";

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
  quantityUnit?: string;
  quantitySource?: string;
};

/** Тот же маппинг, что в load-goods-extraction-check-ui (для согласованных сигналов регрессии). */
export function structuredGoodsLikeToTenderAiGoods(rows: StructuredGoodLike[] | null | undefined): TenderAiGoodItem[] {
  if (!Array.isArray(rows)) return [];
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
    quantityUnit: g.quantityUnit ?? "",
    quantitySource: g.quantitySource ?? "unknown"
  }));
}

/** Проблемы, при которых имеет смысл пробовать polishGoodsDisplayName по полю name. */
const PROBLEM_TYPES_THAT_NAME_POLISH_MAY_ADDRESS: ReadonlySet<GoodsRegressionProblemType> = new Set([
  "long_title",
  "tail_fragment_description",
  "service_tail",
  "temperature_garble"
]);

function humanReasonForProblemType(t: GoodsRegressionProblemType): string {
  switch (t) {
    case "long_title":
      return "слишком длинное название";
    case "tail_fragment_description":
      return "возможный хвост описания";
    case "duplicate_position_id":
      return "похоже на дубль";
    case "service_tail":
      return "хвост про услуги или работы";
    case "temperature_garble":
      return "подозрительный формат температуры";
    case "long_description":
      return "очень длинное описание";
    case "description_equals_packaging":
      return "описание совпадает с упаковкой";
    case "empty_characteristics":
      return "нет характеристик";
    case "empty_position_id":
      return "нет реестрового номера";
    case "cardinality_vs_docs":
      return "число позиций не сходится с оценкой по документам";
    default:
      return "замечание по качеству";
  }
}

export type ProblematicGoodsNameRow = {
  index: number;
  currentName: string;
  reasons: string[];
  problemTypes: GoodsRegressionProblemType[];
  /** Результат polishGoodsDisplayName; null если совпадает с текущим или пусто. */
  suggestedName: string | null;
  /** Можно применить кнопкой: есть сигнал для имени и предложение отличается от текущего. */
  canApplyPolish: boolean;
};

function normalizeNameCompare(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function buildProblematicGoodsNameRows(items: TenderAiGoodItem[]): ProblematicGoodsNameRow[] {
  const byIdx = collectGoodsRegressionProblemsByItemIndex(items);
  const rows: ProblematicGoodsNameRow[] = [];
  for (const [index, problemTypes] of [...byIdx.entries()].sort((a, b) => a[0] - b[0])) {
    const g = items[index]!;
    const currentName = (g.name ?? "").trim();
    const reasons = problemTypes.map(humanReasonForProblemType);
    const polished = polishGoodsDisplayName(g.name);
    const suggested =
      normalizeNameCompare(polished) !== normalizeNameCompare(currentName) && normalizeNameCompare(polished)
        ? polished.trim()
        : null;
    const hasPolishSignal = problemTypes.some((t) => PROBLEM_TYPES_THAT_NAME_POLISH_MAY_ADDRESS.has(t));
    const canApplyPolish = Boolean(suggested && hasPolishSignal);
    rows.push({
      index,
      currentName: g.name ?? "",
      reasons,
      problemTypes,
      suggestedName: suggested,
      canApplyPolish
    });
  }
  return rows;
}

export function countPolishableProblematicRows(rows: ProblematicGoodsNameRow[]): number {
  return rows.filter((r) => r.canApplyPolish).length;
}
