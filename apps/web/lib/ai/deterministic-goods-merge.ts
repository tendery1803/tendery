/**
 * Слияние детерминированных строк ТЗ и печатной формы: цены/п/п из извещения, характеристики из ТЗ по порядку.
 */

import type { TenderAiGoodItem } from "@tendery/contracts";
import type { ExtractGoodsFromTechSpecResult } from "@/lib/ai/extract-goods-from-tech-spec";

function positionSortKey(g: TenderAiGoodItem): number {
  const p = (g.positionId ?? "").trim();
  if (/^\d{1,4}$/.test(p)) {
    const n = parseInt(p, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function allShortPositionIds(items: TenderAiGoodItem[]): boolean {
  return (
    items.length > 0 &&
    items.every((g) => /^\d{1,4}$/.test((g.positionId ?? "").trim()))
  );
}

/**
 * Сшиваем по индексу порядка строк в документе. Сортировка п/п — только если в обоих списках
 * короткие номера; длинные реестровые id не гоняем через parseInt (иначе порядок ломается).
 */
export function mergeTechAndNoticeDeterministicRows(
  techItems: TenderAiGoodItem[],
  noticeItems: TenderAiGoodItem[]
): TenderAiGoodItem[] {
  if (noticeItems.length === 0) return techItems;
  const sortBoth = allShortPositionIds(techItems) && allShortPositionIds(noticeItems);
  const ti = sortBoth
    ? [...techItems].sort((a, b) => positionSortKey(a) - positionSortKey(b))
    : [...techItems];
  const ni = sortBoth
    ? [...noticeItems].sort((a, b) => positionSortKey(a) - positionSortKey(b))
    : [...noticeItems];

  if (noticeItems.length >= 2 && noticeItems.length >= techItems.length) {
    const out: TenderAiGoodItem[] = [];
    for (let i = 0; i < ni.length; i++) {
      const n = ni[i]!;
      const t = ti[i];
      const tName = (t?.name ?? "").trim();
      const nName = (n.name ?? "").trim();
      out.push({
        ...n,
        name: tName.length > nName.length ? t!.name : n.name,
        characteristics:
          t?.characteristics && t.characteristics.length > 0 ? t.characteristics : n.characteristics ?? [],
        codes: n.codes || t?.codes || "",
        quantity: n.quantity || t?.quantity || "",
        unit: n.unit || t?.unit || "шт",
        unitPrice: n.unitPrice || t?.unitPrice || "",
        lineTotal: n.lineTotal || t?.lineTotal || "",
        positionId: n.positionId || t?.positionId || "",
        sourceHint: [t?.sourceHint, n.sourceHint].filter(Boolean).join("; ") || "merged_deterministic"
      });
    }
    return out;
  }

  if (techItems.length > noticeItems.length) return techItems;
  return noticeItems;
}

function goodsPriceScore(xs: TenderAiGoodItem[]): number {
  return xs.reduce(
    (acc, g) =>
      acc + ((g.lineTotal ?? "").trim() ? 2 : 0) + ((g.unitPrice ?? "").trim() ? 1 : 0),
    0
  );
}

export function enhanceTechSpecBundleWithNoticeRows(
  base: ExtractGoodsFromTechSpecResult | null,
  noticeItems: TenderAiGoodItem[]
): ExtractGoodsFromTechSpecResult | null {
  if (noticeItems.length < 2) return base;
  if (!base) {
    return {
      items: noticeItems,
      techBlockText: "",
      techSpecExtractedCount: noticeItems.length,
      diagnostics: [`notice_only_deterministic_rows=${noticeItems.length}`],
      parseAudit: {
        techSpecTableDetected: true,
        techSpecClusterCount: noticeItems.length,
        techSpecExtractedCount: noticeItems.length,
        techSpecRowsParsed: noticeItems.map((g) => g.name.slice(0, 80)),
        techSpecRowsRejected: [],
        rejectionReasons: [],
        finalRetainedFromTechSpecCount: noticeItems.length
      },
      strictTechCorpusChars: 0
    };
  }

  const merged = mergeTechAndNoticeDeterministicRows(base.items, noticeItems);
  const useMerged =
    merged.length > base.items.length ||
    (merged.length === base.items.length && goodsPriceScore(merged) > goodsPriceScore(base.items));

  if (!useMerged) return base;

  return {
    ...base,
    items: merged,
    techSpecExtractedCount: merged.length,
    diagnostics: [
      ...base.diagnostics,
      `notice_det=${noticeItems.length},merged_deterministic=${merged.length}`
    ],
    parseAudit: {
      ...base.parseAudit,
      techSpecExtractedCount: merged.length,
      finalRetainedFromTechSpecCount: merged.length
    }
  };
}
