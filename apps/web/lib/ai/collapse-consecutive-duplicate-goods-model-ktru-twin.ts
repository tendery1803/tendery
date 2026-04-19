/**
 * Узкое схлопывание подряд идущих «близнецов» после reconcile:
 * один и тот же сильный модельный якорь + общая четырёхгрупповая база КТРУ в поле codes
 * (типично: дубль строки ТЗ с полным КТРУ в name и соседняя строка ПФ с тем же артикулом).
 * Не трогает registry_scan, glue, collapse после annotate.
 */
import type { TenderAiGoodItem } from "@tendery/contracts";
import {
  noticeCodesFieldsShareKtruSegment,
  noticeCodesShareKtruFourGroupPrefix
} from "@/lib/ai/extract-goods-notice-table";
import { computeGoodsItemModelDedupeKey } from "@/lib/ai/goods-items-final-model-dedupe";
import { normalizeGoodsMatchingKey } from "@/lib/ai/match-goods-across-sources";

function techTwinQualityScore(g: TenderAiGoodItem): number {
  let s = 0;
  s += (g.characteristics?.length ?? 0) * 14;
  const qv = g.quantityValue;
  if (qv != null && Number.isFinite(qv)) s += 28;
  else if ((g.quantity ?? "").trim().length > 0) s += 20;
  const pid = (g.positionId ?? "").replace(/\s/g, "").trim();
  if (/^2[01]\d{7,11}$/.test(pid)) s += 36;
  else if (/^01\d{14,22}$/.test(pid)) s += 22;
  else if (/^\d{1,4}$/.test(pid)) s += 6;
  else if (pid.length > 0) s += 4;
  const codes = (g.codes ?? "").replace(/\s/g, "");
  if (codes.includes(";") && codes.length > 18) s += 18;
  else if (codes.length >= 12) s += 12;
  const name = (g.name ?? "").trim();
  s += Math.min(name.length, 220) * 0.14;
  if (g.quantitySource === "tech_spec") s += 8;
  if ((g.unitPrice ?? "").trim() || (g.lineTotal ?? "").trim()) s += 4;
  return s;
}

/** Нормализованное начало наименования без хвостов КТРУ в тексте (дубль ТЗ+ПФ при расхождении поля codes). */
function normalizedNameStemForModelTwin(name: string): string {
  let s = normalizeGoodsMatchingKey(name ?? "");
  s = s.replace(/\b\d{2}\.\d{2}\.\d{2}\.\d{3}(?:-\d{2,5})?\b/gi, " ");
  return s.replace(/\s+/g, " ").trim();
}

function pickRicherTwinRow(a: TenderAiGoodItem, b: TenderAiGoodItem): TenderAiGoodItem {
  const sa = techTwinQualityScore(a);
  const sb = techTwinQualityScore(b);
  if (sa !== sb) return sa > sb ? a : b;
  const pa = (a.positionId ?? "").replace(/\s/g, "");
  const pb = (b.positionId ?? "").replace(/\s/g, "");
  if (/^2[01]\d{7,11}$/.test(pa) && !/^2[01]\d{7,11}$/.test(pb)) return a;
  if (/^2[01]\d{7,11}$/.test(pb) && !/^2[01]\d{7,11}$/.test(pa)) return b;
  const la = (a.name ?? "").length;
  const lb = (b.name ?? "").length;
  if (la !== lb) return la > lb ? a : b;
  return a;
}

export function collapseConsecutiveDuplicateGoodsModelKtruTwinsAfterReconcile(
  items: TenderAiGoodItem[]
): TenderAiGoodItem[] {
  if (items.length < 2) return items;
  const out: TenderAiGoodItem[] = [];
  let collapsed = 0;
  for (let i = 0; i < items.length; i++) {
    const g = items[i]!;
    const nxt = items[i + 1];
    if (nxt) {
      const k1 = computeGoodsItemModelDedupeKey(g);
      const k2 = computeGoodsItemModelDedupeKey(nxt);
      const stemA = normalizedNameStemForModelTwin(g.name ?? "");
      const stemB = normalizedNameStemForModelTwin(nxt.name ?? "");
      const nameStemTwin =
        stemA.length >= 18 && stemB.length >= 18 && stemA === stemB;
      const codesTwin =
        noticeCodesShareKtruFourGroupPrefix(g.codes ?? "", nxt.codes ?? "") ||
        noticeCodesFieldsShareKtruSegment(g.codes ?? "", nxt.codes ?? "");
      if (k1 && k2 && k1 === k2 && k1.length >= 5 && (codesTwin || nameStemTwin)) {
        out.push(pickRicherTwinRow(g, nxt));
        collapsed++;
        i++;
        continue;
      }
    }
    out.push(g);
  }
  return collapsed > 0 ? out : items;
}
