/**
 * Единое форматирование количества для UI и диагностики (без серверных зависимостей).
 */

export type GoodQuantityDisplayInput = {
  quantity?: string;
  unit?: string;
  quantityValue?: number | null;
  quantityUnit?: string;
  quantitySource?: string;
};

export function parseQuantityValueLoose(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 999_999) return v;
  if (typeof v === "string") {
    const t = v.trim().replace(/\s/g, "").replace(",", ".");
    if (!t) return null;
    const n = parseFloat(t);
    if (Number.isFinite(n) && n >= 0 && n <= 999_999) return n;
  }
  return null;
}

/** Есть ли в данных числовое количество (для трассировки потерь). */
export function goodItemHasNumericQuantityData(g: GoodQuantityDisplayInput | undefined): boolean {
  if (!g) return false;
  if (parseQuantityValueLoose(g.quantityValue) != null) return true;
  return /\d/.test((g.quantity ?? "").trim());
}

/**
 * Подпись для блока «Количество»: число + ед.; число без ед.; строка quantity с цифрой;
 * при пустом числе, но известной единице — «— · ед.» (строка не скрывается целиком).
 */
export function formatGoodItemQuantityForDisplay(g: GoodQuantityDisplayInput): string | null {
  const v = parseQuantityValueLoose(g.quantityValue);
  const qu = (g.quantityUnit || "").trim();
  if (v != null) {
    const vs = Number.isInteger(v) ? String(Math.trunc(v)) : String(v);
    return qu ? `${vs} ${qu}` : vs;
  }
  const qs = (g.quantity ?? "").trim();
  if (qs) {
    if (/\d/.test(qs)) {
      const u = (g.unit || "").trim();
      if (
        u &&
        !qs.toLowerCase().includes(u.toLowerCase().slice(0, Math.min(4, u.length)))
      ) {
        return `${qs} ${u}`.trim();
      }
      return qs;
    }
    return qs;
  }
  const uComb = qu || (g.unit || "").trim();
  if (uComb) {
    return `— ${uComb}`;
  }
  return null;
}

export function shouldShowGoodsQuantityRow(g: GoodQuantityDisplayInput): boolean {
  return formatGoodItemQuantityForDisplay(g) != null;
}
