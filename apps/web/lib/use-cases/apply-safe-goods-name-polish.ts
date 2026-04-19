import { TenderAnalysisStructuredBlockSchema } from "@tendery/contracts";
import { polishGoodsDisplayName } from "@/lib/ai/polish-goods-display-name";
import { collectGoodsRegressionProblemsByItemIndex } from "@/lib/ai/goods-regression-metrics";
import { prisma } from "@/lib/db";

const POLISH_SIGNALS = new Set([
  "long_title",
  "tail_fragment_description",
  "service_tail",
  "temperature_garble"
]);

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export type ApplySafeGoodsNamePolishErrorCode =
  | "not_found"
  | "no_analysis"
  | "invalid_block"
  | "nothing_to_apply";

/**
 * Обновляет только `name` у позиций с известными сигналами и нетривиальным polishGoodsDisplayName.
 * Длина массива goodsItems и остальные поля позиций не меняются.
 */
export async function applySafeGoodsNamePolishForTender(params: {
  companyId: string;
  tenderId: string;
}): Promise<
  | { ok: true; updatedIndices: number[] }
  | {
      ok: false;
      code: ApplySafeGoodsNamePolishErrorCode;
      message: string;
      httpStatus: number;
    }
> {
  const { companyId, tenderId } = params;

  const tender = await prisma.tender.findFirst({
    where: { id: tenderId, companyId },
    select: { id: true }
  });
  if (!tender) {
    return { ok: false, code: "not_found", message: "Тендер не найден", httpStatus: 404 };
  }

  const analysis = await prisma.tenderAnalysis.findFirst({
    where: { tenderId, status: "done" },
    orderBy: { createdAt: "desc" }
  });
  if (!analysis) {
    return { ok: false, code: "no_analysis", message: "Нет завершённого разбора", httpStatus: 409 };
  }

  const parsed = TenderAnalysisStructuredBlockSchema.safeParse(analysis.structuredBlock ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      code: "invalid_block",
      message: "Структурированный блок анализа повреждён",
      httpStatus: 409
    };
  }

  const block = parsed.data;
  const goods = block.goodsItems ?? [];
  if (goods.length === 0) {
    return {
      ok: false,
      code: "nothing_to_apply",
      message: "Нет позиций для обработки",
      httpStatus: 400
    };
  }

  const byIdx = collectGoodsRegressionProblemsByItemIndex(goods);
  const updatedIndices: number[] = [];
  const nextGoods = goods.map((item, index) => {
    const problems = byIdx.get(index);
    if (!problems?.length) return item;
    const hasPolishSignal = problems.some((t) => POLISH_SIGNALS.has(t));
    if (!hasPolishSignal) return item;
    const current = (item.name ?? "").trim();
    const polished = polishGoodsDisplayName(item.name).trim();
    if (!polished || norm(polished) === norm(current)) return item;
    updatedIndices.push(index);
    return { ...item, name: polished };
  });

  if (updatedIndices.length === 0) {
    return {
      ok: false,
      code: "nothing_to_apply",
      message: "Нет позиций, где безопасная очистка меняет название",
      httpStatus: 400
    };
  }

  await prisma.tenderAnalysis.update({
    where: { id: analysis.id },
    data: {
      structuredBlock: {
        ...block,
        goodsItems: nextGoods
      }
    }
  });

  return { ok: true, updatedIndices };
}
