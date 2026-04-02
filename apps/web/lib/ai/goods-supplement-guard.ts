import type { TenderAiGoodItem } from "@tendery/contracts";
import { normalizeGoodsPositionIdForMatch } from "@/lib/ai/goods-expected-items";

export type ApplyTrustedSupplementGuardsArgs = {
  incoming: TenderAiGoodItem[];
  currentCount: number;
  trustedExpectedGoodsCount: number | null;
  trustedExpectedPositionIds: string[];
};

export function applyTrustedSupplementGuards(
  args: ApplyTrustedSupplementGuardsArgs
): TenderAiGoodItem[] {
  let out = [...args.incoming];

  if (args.trustedExpectedPositionIds.length > 0) {
    const trustedSet = new Set(
      args.trustedExpectedPositionIds
        .map((x) => normalizeGoodsPositionIdForMatch(x))
        .filter(Boolean)
    );
    out = out.filter((g) => {
      const pid = normalizeGoodsPositionIdForMatch(g.positionId ?? "");
      return pid ? trustedSet.has(pid) : false;
    });
  }

  if (args.trustedExpectedGoodsCount != null) {
    const room = Math.max(0, args.trustedExpectedGoodsCount - args.currentCount);
    if (room === 0) return [];
    if (out.length > room) out = out.slice(0, room);
  }

  return out;
}
