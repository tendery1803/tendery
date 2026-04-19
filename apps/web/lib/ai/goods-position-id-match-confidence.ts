/**
 * Уровень уверенности для реестрового `positionId` на позиции goods.
 * `matched_by_order` выставляется только в `applyIndexAlignedNoticePositionIdFallback` (deterministic-goods-merge).
 */
import type { PositionIdMatchConfidence, TenderAiGoodItem } from "@tendery/contracts";
import { isRegistryStylePositionId } from "@/lib/ai/registry-position-ids";
import { normGoodsPositionId } from "@/lib/ai/goods-position-id-status";

export function positionIdMatchConfidenceForTechRowReconcile(params: {
  finalPositionId: string;
  tz: TenderAiGoodItem;
  tzPid: string;
}): PositionIdMatchConfidence {
  const fn = normGoodsPositionId(params.finalPositionId);
  if (!fn || !isRegistryStylePositionId(fn)) return "not_found";

  const tzPidNorm = params.tzPid.replace(/\s/g, "").trim();
  const tzNorm = normGoodsPositionId(params.tz.positionId ?? "");
  if (isRegistryStylePositionId(tzPidNorm) && fn === tzNorm) {
    return params.tz.positionIdMatchConfidence === "matched_by_order" ? "matched_by_order" : "matched_exact";
  }
  return "matched_exact";
}

/** Lenient merge: реестровый id только из доверенного корпуса (notice/AI/registry scan), не индексный fallback ТЗ. */
export function positionIdMatchConfidenceForMergeFallbackLenient(positionIdOut: string): PositionIdMatchConfidence {
  const fn = normGoodsPositionId(positionIdOut);
  if (!fn || !isRegistryStylePositionId(fn)) return "not_found";
  return "matched_exact";
}
