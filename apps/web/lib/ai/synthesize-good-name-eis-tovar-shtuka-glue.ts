import type { TenderAiCharacteristicRow } from "@tendery/contracts";

/**
 * Печатная форма ЕИС в PDF: колонки склеиваются в `ТоварШтука…` без пробела (см. extract-goods-from-tech-spec).
 * Если название — только такая склейка, собираем короткое имя из строк «Материал*» и аббревиатуры цвета
 * («Цв», «Цвет»), не меняя массив characteristics.
 *
 * Узкий хвост «Цвет» + «ет…»: значение могло потерять префикс при склейке с «ет» слова «цвет».
 */
export function synthesizeGoodNameFromCharacteristicsWhenEisTovarShtukaGlued(
  rawName: string,
  characteristics: TenderAiCharacteristicRow[] | undefined
): string | null {
  const name = (rawName ?? "").replace(/\s+/g, " ").trim();
  if (!/^ТоварШтука/i.test(name)) return null;

  const rows = (characteristics ?? []).filter((c) => (c.name ?? "").trim() && (c.value ?? "").trim());
  if (rows.length === 0) return null;

  const materialRows = rows.filter((c) => /материал/i.test((c.name ?? "").trim()));
  const colorRow = rows.find((c) => {
    const nm = (c.name ?? "").replace(/\s+/g, " ").trim();
    return /^(цв\.?|цвет)$/i.test(nm);
  });

  const fixEtColorPrefix = (value: string): string => {
    const v = value.replace(/\s+/g, " ").trim();
    if (!v) return "";
    if (/^ет(?=[а-яё])/i.test(v)) return v.replace(/^ет/i, "").trim();
    return v;
  };

  const parts: string[] = [];
  for (const m of materialRows) {
    const v = (m.value ?? "").replace(/\s+/g, " ").trim();
    if (v) parts.push(v);
  }
  if (colorRow) {
    const cv = fixEtColorPrefix(colorRow.value ?? "");
    if (cv) parts.push(cv);
  }

  const joined = parts.join(" ").replace(/\s+/g, " ").trim();
  if (joined.length < 4) return null;
  if (joined.length > 240) return `${joined.slice(0, 237)}…`;
  return joined;
}
