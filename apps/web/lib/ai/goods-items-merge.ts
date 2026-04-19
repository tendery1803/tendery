import type { GoodsQuantitySource, TenderAiGoodItem } from "@tendery/contracts";
import { formatQuantityValueForStorage } from "@/lib/ai/extract-goods-from-tech-spec";

function normKeyPart(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function extractStructuralCodeToken(codesRaw: string): string {
  const t = (codesRaw ?? "").replace(/\s+/g, " ");
  const ktru = t.match(/\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{5}/);
  if (ktru) return ktru[0]!.toLowerCase();
  const okpd = t.match(/\b\d{2}\.\d{2}\.\d{2}\.\d{2,3}(?:\.\d{3})?\b/);
  if (okpd) return okpd[0]!.toLowerCase();
  return "";
}

/**
 * Ключ мержа: не сливаем разные позиции только из‑за похожего названия.
 * Приоритет — номер позиции; иначе код КТРУ/ОКПД + количество + ед.изм. + усечённое имя; иначе составной отпечаток строки.
 */
export function goodsItemMergeKey(g: TenderAiGoodItem): string {
  const codeTok = extractStructuralCodeToken(g.codes ?? "");
  const name = normKeyPart(g.name ?? "").slice(0, 120);
  const q = normKeyPart(g.quantity ?? "");
  const u = normKeyPart(g.unit ?? "");
  const pidRaw = normKeyPart(g.positionId ?? "")
    .replace(/^№\s*/i, "")
    .replace(/\.$/, "");
  if (
    pidRaw &&
    pidRaw !== "—" &&
    pidRaw !== "-" &&
    /^[\d\.]+$/.test(pidRaw) &&
    pidRaw.length <= 14
  ) {
    /** Короткие позиционные номера (1,2,3...) часто переиспользуются между файлами/таблицами. */
    if (pidRaw.length <= 4) {
      if (codeTok) return `p:${pidRaw}|c:${codeTok}|q:${q}|u:${u}`;
      return `p:${pidRaw}|n:${name.slice(0, 72)}|q:${q}|u:${u}`;
    }
    return `p:${pidRaw}`;
  }
  const up = normKeyPart(g.unitPrice ?? "").slice(0, 36);
  const lt = normKeyPart(g.lineTotal ?? "").slice(0, 36);
  const regFromText =
    (pidRaw.match(/^20\d{7,11}$/) ? pidRaw : "") ||
    `${g.name ?? ""} ${g.codes ?? ""}`.match(/\b(20\d{7,11})\b/)?.[1] ||
    "";
  if (codeTok) {
    const regSeg = regFromText ? `|r:${regFromText}` : "";
    return `c:${codeTok}${regSeg}|q:${q}|u:${u}|n:${name.slice(0, 72)}`;
  }
  return `n:${name}|q:${q}|u:${u}|up:${up}|lt:${lt}`;
}

function preferLongerText(a: string, b: string): string {
  const x = a.trim();
  const y = b.trim();
  if (y.length > x.length) return y;
  return x;
}

function parseGoodsQuantityNumber(s: string): number | null {
  const t = s.trim().replace(/\s/g, "").replace(",", ".");
  if (!t) return null;
  const n = parseFloat(t);
  return Number.isFinite(n) && n >= 0 && n <= 999_999 ? n : null;
}

function plausibleLineItemQty(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= 10_000;
}

function looksLikeMoneyColumnInteger(n: number): boolean {
  return Number.isInteger(n) && n >= 100;
}

/** Не даём чанку/второму проходу перетирать количество ценой (255) и наоборот. */
function preferMergeQuantity(base: string, incoming: string): string {
  const b = base.trim();
  const i = incoming.trim();
  if (!i) return b;
  if (!b) return i;
  const nb = parseGoodsQuantityNumber(b);
  const ni = parseGoodsQuantityNumber(i);
  if (nb != null && ni != null) {
    const ib = Number.isInteger(nb);
    const ii = Number.isInteger(ni);
    if (ib && !ii) return b;
    if (!ib && ii) return i;
    if (ib && ii && nb !== ni) {
      if (looksLikeMoneyColumnInteger(nb) && plausibleLineItemQty(ni)) return i;
      if (looksLikeMoneyColumnInteger(ni) && plausibleLineItemQty(nb)) return b;
      if (nb > ni && nb >= ni * 2 && ni >= 1) return i;
      if (ni > nb && ni >= nb * 2 && nb >= 1) return b;
      return b;
    }
    if (nb === ni) return b;
  }
  return b;
}

function quantityStringLooksUnitOnly(s: string): boolean {
  const t = s.trim();
  if (!t || /\d/.test(t)) return false;
  return /^(?:шт\.?|штук(?:и|а|ой)?|ед\.?\s*изм\.?|комплект(?:а|ов)?|компл\.?|упак(?:овк\w*)?)$/i.test(
    t
  );
}

function isChipRelatedCharKey(normName: string): boolean {
  return /чип|наличие\s*чип/.test(normName);
}

function preferChipCharacteristicValue(a: string, b: string): string {
  const xa = a.trim();
  const xb = b.trim();
  const boiler = (s: string) =>
    /указано\s+в\s+описании|см\.?\s*описание|по\s+описанию/i.test(s);
  const yn = (s: string) => /^(да|нет)\s*$/i.test(s);
  if (yn(xa) && (boiler(xb) || xb.length > xa.length + 8)) return xa;
  if (yn(xb) && (boiler(xa) || xa.length > xb.length + 8)) return xb;
  return preferLongerText(xa, xb);
}

function normalizeCharNameForMerge(name: string): string {
  let t = name.trim();
  t = t.replace(/\bчипада\b/gi, "чипа");
  t = t.replace(/\bналичие\s+чипада\b/gi, "наличие чипа");
  return t;
}

function mergeCharacteristics(
  a: TenderAiGoodItem["characteristics"],
  b: TenderAiGoodItem["characteristics"]
): TenderAiGoodItem["characteristics"] {
  const map = new Map<string, { name: string; value: string; sourceHint: string }>();
  const add = (rows: typeof a) => {
    for (const row of rows) {
      const nk = normKeyPart(normalizeCharNameForMerge(row.name ?? ""));
      if (!nk) continue;
      const prev = map.get(nk);
      const val = (row.value ?? "").trim();
      const name =
        normalizeCharNameForMerge(row.name ?? "").trim() || prev?.name || normalizeCharNameForMerge(row.name ?? "");
      const sh = (row.sourceHint ?? "").trim();
      if (!prev) {
        map.set(nk, { name, value: val, sourceHint: sh });
        continue;
      }
      const mergedVal = isChipRelatedCharKey(nk)
        ? preferChipCharacteristicValue(prev.value, val)
        : preferLongerText(prev.value, val);
      const mergedSh = preferLongerText(prev.sourceHint, sh);
      map.set(nk, { name: preferLongerText(prev.name, name), value: mergedVal, sourceHint: mergedSh });
    }
  };
  add(a);
  add(b);
  return Array.from(map.values()).map((r) => ({
    name: r.name,
    value: r.value,
    sourceHint: r.sourceHint
  }));
}

function mergeOneItem(
  base: TenderAiGoodItem,
  incoming: TenderAiGoodItem,
  options?: { preservePrimaryCoreFields?: boolean }
): TenderAiGoodItem {
  const preservePrimaryCoreFields = options?.preservePrimaryCoreFields === true;
  const bq = base.quantity ?? "";
  const iq = incoming.quantity ?? "";
  const baseTech = base.quantitySource === "tech_spec" && base.quantityValue != null;
  const incTech = incoming.quantitySource === "tech_spec" && incoming.quantityValue != null;

  let qMerged: string;
  let quantityValueOut: number | undefined;
  let quantityUnitOut: string;
  let quantitySourceOut: GoodsQuantitySource;

  if (baseTech && incTech) {
    qMerged = bq.trim() || formatQuantityValueForStorage(base.quantityValue!);
    quantityValueOut = base.quantityValue ?? undefined;
    quantityUnitOut = ((base.quantityUnit || "").trim() || (base.unit || "").trim()).trim();
    quantitySourceOut = "tech_spec";
  } else if (baseTech) {
    qMerged = bq.trim() || formatQuantityValueForStorage(base.quantityValue!);
    quantityValueOut = base.quantityValue ?? undefined;
    quantityUnitOut = ((base.quantityUnit || "").trim() || (base.unit || "").trim()).trim();
    quantitySourceOut = "tech_spec";
  } else if (incTech) {
    qMerged = iq.trim() || formatQuantityValueForStorage(incoming.quantityValue!);
    quantityValueOut = incoming.quantityValue ?? undefined;
    quantityUnitOut = ((incoming.quantityUnit || "").trim() || (incoming.unit || "").trim()).trim();
    quantitySourceOut = "tech_spec";
  } else {
    if (bq.trim() && /\d/.test(bq) && quantityStringLooksUnitOnly(iq)) {
      qMerged = bq;
    } else {
      qMerged =
        preservePrimaryCoreFields && bq.trim() ? bq : preferMergeQuantity(bq, iq);
    }
    quantityValueOut =
      base.quantityValue != null
        ? base.quantityValue
        : incoming.quantityValue != null
          ? incoming.quantityValue
          : undefined;
    quantityUnitOut = ((base.quantityUnit || "").trim() || (incoming.quantityUnit || "").trim()).trim();
    const bs = (base.quantitySource ?? "unknown") as GoodsQuantitySource;
    const ins = (incoming.quantitySource ?? "unknown") as GoodsQuantitySource;
    quantitySourceOut = bs !== "unknown" ? bs : ins !== "unknown" ? ins : "unknown";
  }

  const unitOut = (() => {
    if (baseTech && incTech) {
      const u = ((base.quantityUnit || "").trim() || (base.unit || "").trim()).trim();
      return u || preferLongerText(base.unit ?? "", incoming.unit ?? "");
    }
    if (baseTech) {
      const u = ((base.quantityUnit || "").trim() || (base.unit || "").trim()).trim();
      return u || preferLongerText(base.unit ?? "", incoming.unit ?? "");
    }
    if (incTech) {
      const u = ((incoming.quantityUnit || "").trim() || (incoming.unit || "").trim()).trim();
      return u || preferLongerText(base.unit ?? "", incoming.unit ?? "");
    }
    return preferLongerText(base.unit ?? "", incoming.unit ?? "");
  })();

  return {
    name:
      preservePrimaryCoreFields && (base.name ?? "").trim()
        ? base.name
        : preferLongerText(base.name ?? "", incoming.name ?? ""),
    positionId:
      preservePrimaryCoreFields && (base.positionId ?? "").trim()
        ? base.positionId
        : preferLongerText(base.positionId ?? "", incoming.positionId ?? ""),
    codes: preferLongerText(base.codes ?? "", incoming.codes ?? ""),
    unit: unitOut,
    quantity: qMerged,
    unitPrice: preferLongerText(base.unitPrice ?? "", incoming.unitPrice ?? ""),
    lineTotal: preferLongerText(base.lineTotal ?? "", incoming.lineTotal ?? ""),
    sourceHint: preferLongerText(base.sourceHint ?? "", incoming.sourceHint ?? ""),
    characteristics: mergeCharacteristics(base.characteristics ?? [], incoming.characteristics ?? []),
    quantityUnit: quantityUnitOut,
    quantitySource: quantitySourceOut,
    ...(quantityValueOut != null ? { quantityValue: quantityValueOut } : {})
  };
}

const MAX_MERGE_OPS_IN_DIAGNOSTICS = 96;

export type GoodsMergeOperationRecord = {
  mergeKey: string;
  outcome: "merged_into_existing";
  existingPositionId: string;
  incomingPositionId: string;
};

export type GoodsMergeDiagnostics = {
  /** Разные positionId попали под один merge-key (подозрительное схлопывание). */
  mergeKeyCollisionWarnings: string[];
  /** Схлопывание по одному ключу (дедуп вторичного списка в существующую строку). */
  mergeOperations: GoodsMergeOperationRecord[];
};

/**
 * Объединяет два списка позиций (основной проход + доп. проход / перекрывающиеся чанки):
 * дедуп по positionId / кодам / названию; характеристики — по имени, value берём более длинный.
 */
export function mergeGoodsItemsListsWithDiagnostics(
  primary: TenderAiGoodItem[],
  secondary: TenderAiGoodItem[],
  options?: { preservePrimaryCoreFields?: boolean }
): { merged: TenderAiGoodItem[]; diagnostics: GoodsMergeDiagnostics } {
  const mergeKeyCollisionWarnings: string[] = [];
  const mergeOperations: GoodsMergeOperationRecord[] = [];
  const order: string[] = [];
  const byKey = new Map<string, TenderAiGoodItem>();

  const push = (g: TenderAiGoodItem) => {
    const k = goodsItemMergeKey(g);
    const ex = byKey.get(k);
    if (!ex) {
      byKey.set(k, {
        ...g,
        characteristics: [...(g.characteristics ?? [])]
      });
      order.push(k);
      return;
    }
    const pa = normKeyPart(ex.positionId ?? "").replace(/^№\s*/i, "");
    const pb = normKeyPart(g.positionId ?? "").replace(/^№\s*/i, "");
    if (pa && pb && pa !== "—" && pb !== "—" && pa !== pb) {
      mergeKeyCollisionWarnings.push(
        `merge_key=${k}: positionId "${ex.positionId}" vs "${g.positionId}"`
      );
    }
    if (mergeOperations.length < MAX_MERGE_OPS_IN_DIAGNOSTICS) {
      mergeOperations.push({
        mergeKey: k,
        outcome: "merged_into_existing",
        existingPositionId: ex.positionId ?? "",
        incomingPositionId: g.positionId ?? ""
      });
    }
    byKey.set(k, mergeOneItem(ex, g, options));
  };

  for (const g of primary) push(g);
  for (const g of secondary) push(g);

  return {
    merged: order.map((k) => byKey.get(k)!),
    diagnostics: { mergeKeyCollisionWarnings, mergeOperations }
  };
}

export function mergeGoodsItemsLists(primary: TenderAiGoodItem[], secondary: TenderAiGoodItem[]): TenderAiGoodItem[] {
  return mergeGoodsItemsListsWithDiagnostics(primary, secondary).merged;
}

function extractDeclaredPositionCount(corpus: string): number | null {
  const c = corpus.replace(/\s+/g, " ");
  const patterns: RegExp[] = [
    /(?:спецификаци|перечен)[^.\d]{0,80}?(\d{1,4})\s*(?:позици|наименован)/i,
    /(\d{1,4})\s*(?:позици|строк)[^.\d]{0,50}(?:специфик|таблиц|перечн)/i,
    /в\s+количестве\s+(\d{1,4})\s*позиц/i,
    /всего\s+(\d{1,4})\s*(?:позици|наименован)/i,
    /(\d{1,4})\s*позици[ийя]\s+(?:в\s+)?(?:специфик|таблиц)/i
  ];
  let best: number | null = null;
  for (const re of patterns) {
    const m = c.match(re);
    if (!m?.[1]) continue;
    const v = parseInt(m[1], 10);
    if (!Number.isFinite(v) || v < 2 || v > 5000) continue;
    best = best == null ? v : Math.max(best, v);
  }
  return best;
}

/** Строки вида «1. Наименование» / «12) Товар» — нижняя оценка числа строк спецификации. */
export function countLikelySpecTableRows(corpus: string): number {
  let n = 0;
  for (const line of corpus.split(/\n/)) {
    if (/^\s*\d{1,4}\s*[\.\)]\s+\S/.test(line)) n++;
  }
  return n;
}

function looksLikeTruncatedGoodsTail(goods: TenderAiGoodItem[]): boolean {
  const last = goods[goods.length - 1];
  if (!last) return false;
  const blob = [last.name, ...last.characteristics.map((x) => x.value)].join(" ");
  return (
    /(?:\.\.\.|…|не\s+полностью|продолжени\s+специфик|значение\s+указано\s+в\s+описани|указано\s+в\s+описании\s+объект)/i.test(
      blob
    ) && blob.length < 500
  );
}

/**
 * Нужен ли второй проход извлечения товаров (тот же tender_analyze, мержим только goodsItems).
 */
export function shouldSupplementGoodsItems(
  corpus: string,
  goods: TenderAiGoodItem[],
  procurementKind: string
): boolean {
  if (procurementKind !== "goods" && procurementKind !== "mixed") return false;
  const n = goods.length;
  const declared = extractDeclaredPositionCount(corpus);
  if (declared != null && declared > n) return true;

  const rows = countLikelySpecTableRows(corpus);
  if (n <= 5 && rows >= 12) return true;
  if (rows >= n + 6 && n > 0) return true;

  if (n > 0 && looksLikeTruncatedGoodsTail(goods)) return true;

  return false;
}
