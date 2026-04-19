import { TenderAnalysisStructuredBlockSchema } from "@tendery/contracts";
import { prisma } from "@/lib/db";
import { normGoodsPositionId } from "@/lib/ai/goods-position-id-status";

function canonicalCandidateFromList(candidates: string[], chosen: string): string | null {
  const nChosen = normGoodsPositionId(chosen);
  if (!nChosen) return null;
  for (const c of candidates) {
    if (c === chosen) return c;
    if (normGoodsPositionId(c) === nChosen) return c;
  }
  return null;
}

export type ConfirmGoodsPositionIdErrorCode =
  | "not_found"
  | "no_analysis"
  | "bad_index"
  | "not_ambiguous"
  | "invalid_choice"
  | "duplicate_pid"
  | "invalid_body";

/**
 * Ручное подтверждение реестрового positionId для ambiguous-позиции в последнем done-анализе.
 */
export async function confirmGoodsPositionIdForTender(params: {
  companyId: string;
  tenderId: string;
  goodsItemIndex: number;
  positionId: string;
}): Promise<
  | { ok: true }
  | { ok: false; code: ConfirmGoodsPositionIdErrorCode; message: string; httpStatus: number }
> {
  const { companyId, tenderId, goodsItemIndex, positionId } = params;

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
      code: "no_analysis",
      message: "Структурированный блок анализа повреждён",
      httpStatus: 409
    };
  }

  const block = parsed.data;
  const goods = block.goodsItems ?? [];
  if (
    !Number.isInteger(goodsItemIndex) ||
    goodsItemIndex < 0 ||
    goodsItemIndex >= goods.length
  ) {
    return { ok: false, code: "bad_index", message: "Некорректный индекс позиции", httpStatus: 400 };
  }

  const item = goods[goodsItemIndex]!;
  if (item.positionIdStatus !== "ambiguous") {
    return {
      ok: false,
      code: "not_ambiguous",
      message: "Позиция не в статусе ambiguous",
      httpStatus: 400
    };
  }

  const cands = item.positionIdCandidates ?? [];
  const canonical = canonicalCandidateFromList(cands, positionId);
  if (!canonical) {
    return {
      ok: false,
      code: "invalid_choice",
      message: "Выбранный идентификатор не из списка кандидатов",
      httpStatus: 400
    };
  }

  const chosenNorm = normGoodsPositionId(canonical);
  for (let i = 0; i < goods.length; i++) {
    if (i === goodsItemIndex) continue;
    const otherPid = normGoodsPositionId(goods[i]!.positionId ?? "");
    if (otherPid && otherPid === chosenNorm) {
      return {
        ok: false,
        code: "duplicate_pid",
        message:
          "Этот реестровый номер уже назначен другой позиции в разборе. Выберите другой вариант из списка.",
        httpStatus: 409
      };
    }
  }

  const { positionIdCandidates: _drop, positionIdAutoAssigned: _auto, ...itemBase } = item;
  const nextItem = {
    ...itemBase,
    positionId: canonical,
    positionIdStatus: "resolved_manual" as const,
    positionIdUserConfirmed: true as const
  };

  const nextGoods = [...goods];
  nextGoods[goodsItemIndex] = nextItem;

  await prisma.tenderAnalysis.update({
    where: { id: analysis.id },
    data: {
      structuredBlock: {
        ...block,
        goodsItems: nextGoods
      }
    }
  });

  return { ok: true };
}
