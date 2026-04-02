/**
 * Самопроверка guard-ограничений для supplement:
 *   pnpm -C apps/ai-gateway exec tsx --tsconfig ../web/tsconfig.json ../web/lib/ai/goods-supplement-guard.verify.ts
 */
import assert from "node:assert/strict";
import type { TenderAiGoodItem } from "@tendery/contracts";
import { applyTrustedSupplementGuards } from "./goods-supplement-guard";

function makeIncoming(idx: number): TenderAiGoodItem {
  return {
    name: `Товар ${idx}`,
    positionId: String(idx),
    codes: `26.20.40.120-00000${idx.toString().padStart(3, "0")}`,
    unit: "шт",
    quantity: "1",
    unitPrice: "",
    lineTotal: "",
    sourceHint: "",
    characteristics: []
  };
}

/** Реально доверенно 8 позиций, supplement пытается дать 24 — лишнее режем. */
const inflated = Array.from({ length: 24 }, (_, i) => makeIncoming(i + 1));
const filtered = applyTrustedSupplementGuards({
  incoming: inflated,
  currentCount: 8,
  trustedExpectedGoodsCount: 8,
  trustedExpectedPositionIds: Array.from({ length: 8 }, (_, i) => String(i + 1))
});
assert.equal(filtered.length, 0);

/** Если trusted ordinals неизвестны, не фильтруем «по пропущенным id». */
const noTrustedOrdinals = applyTrustedSupplementGuards({
  incoming: inflated.slice(0, 3),
  currentCount: 2,
  trustedExpectedGoodsCount: null,
  trustedExpectedPositionIds: []
});
assert.equal(noTrustedOrdinals.length, 3);

console.log("goods-supplement-guard.verify: OK");
