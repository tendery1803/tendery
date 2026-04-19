import type { TenderAiGoodItem } from "@tendery/contracts";
import { isRegistryStylePositionId } from "@/lib/ai/registry-position-ids";

function normGoodsCodesDedupKey(codes: string): string {
  return (codes ?? "").replace(/\s/g, "").toLowerCase().trim();
}

/** Только одиночный сегмент codes без «;» — не трогаем multi-segment и glue-кейсы (Тенд8). */
function looksLikeSingleSegmentKtruOrOkpdKey(k: string): boolean {
  if (!k || k.includes(";")) return false;
  return /^\d{2}\.\d{2}\.\d{2}\.\d{2,3}(?:-\d{3,5})?$/i.test(k);
}

function hasNonEmptyPid(g: TenderAiGoodItem): boolean {
  return !!(g.positionId ?? "").replace(/\s/g, "").trim();
}

/**
 * Ровно одна «якорная» строка с внутренним id ПФ (210…/211…) и уверенным сопоставлением.
 */
function isPfAnchoredResolvedRow(g: TenderAiGoodItem): boolean {
  const pid = (g.positionId ?? "").replace(/\s/g, "").trim();
  if (!pid || !isRegistryStylePositionId(pid)) return false;
  if (!/^2[01]\d{7,11}$/.test(pid)) return false;
  if (g.positionIdStatus !== "resolved") return false;
  const c = g.positionIdMatchConfidence;
  return c === "matched_exact" || c === "matched_by_order";
}

/**
 * Хвостовая строка: пустой pid после annotate, ambiguous/missing и not_found — нет самостоятельного notice identity.
 */
function isSameCodeOrphanTailRow(g: TenderAiGoodItem): boolean {
  if (hasNonEmptyPid(g)) return false;
  const st = g.positionIdStatus;
  if (st !== "ambiguous" && st !== "missing") return false;
  return g.positionIdMatchConfidence === "not_found";
}

function qtyNorm(q: string): string {
  return (q ?? "").replace(/\s/g, "").replace(",", ".").trim().toLowerCase();
}

/**
 * После `annotateGoodsItemsWithPositionIdStatus`: убрать узкий класс «лишних» строк ТЗ с тем же codes,
 * что и одна устойчивая PF-строка, но без pid (not_found) — типично варианты цвета/фасовки одной позиции ПФ.
 *
 * Не трогает registry_scan / notice-layer. Не использует имена товаров и id тендера.
 */
export function collapseSameCodePfAnchoredOrphanTailGoodsItemsAfterAnnotate(
  items: TenderAiGoodItem[]
): TenderAiGoodItem[] {
  if (items.length < 2) return items;

  const n = items.length;
  const toRemove = new Set<number>();

  for (let i = 0; i < n; i++) {
    const k = normGoodsCodesDedupKey(items[i]!.codes ?? "");
    if (!k || !looksLikeSingleSegmentKtruOrOkpdKey(k)) continue;

    const groupIdx: number[] = [];
    for (let j = 0; j < n; j++) {
      if (normGoodsCodesDedupKey(items[j]!.codes ?? "") === k) groupIdx.push(j);
    }
    if (groupIdx.length < 2 || groupIdx.length > 12) continue;

    const anchoredIdx = groupIdx.filter((idx) => isPfAnchoredResolvedRow(items[idx]!));
    if (anchoredIdx.length === 0) continue;

    for (const idx of groupIdx) {
      const row = items[idx]!;
      if (!isSameCodeOrphanTailRow(row)) continue;

      const oq = qtyNorm(row.quantity ?? "");
      if (!oq) {
        /** Без количества — только если в группе ровно одна PF-якорная строка (узкий случай). */
        if (anchoredIdx.length !== 1) continue;
        toRemove.add(idx);
        continue;
      }

      const matchAnchors = anchoredIdx.filter(
        (ai) => qtyNorm(items[ai]!.quantity ?? "") === oq
      );
      /** Несколько позиций ПФ с одним KTRU (Тенд25): хвост сопоставляем по совпадению qty с ровно одной якорной строкой. */
      if (matchAnchors.length !== 1) continue;
      toRemove.add(idx);
    }
  }

  if (toRemove.size === 0) return items;
  return items.filter((_, idx) => !toRemove.has(idx));
}
