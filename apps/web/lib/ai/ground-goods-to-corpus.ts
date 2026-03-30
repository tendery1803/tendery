/**
 * Срезает из товаров и характеристик упоминания брендов, которых нет в маскированном корпусе.
 * По умолчанию ВЫКЛЮЧЕНО: минимизированный текст часто не содержит тех же латинских маркеров, что ТЗ,
 * из‑за чего вырезались Canon/HP и обнулялись характеристики. Включение: TENDER_AI_GROUND_GOODS_BRANDS=1.
 */

import type { TenderAiCharacteristicRow, TenderAiGoodItem } from "@tendery/contracts";

function normalizeCorpusForMatch(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ");
}

/** Латиница: бренды и частые «якоря» модельных рядов. */
const BRAND_OR_VENDOR_TOKENS = [
  "samsung",
  "самсунг",
  "canon",
  "кэнон",
  "hp",
  "hewlett",
  "kyocera",
  "brother",
  "xerox",
  "ricoh",
  "epson",
  "lexmark",
  "oki",
  "sharp",
  "konica",
  "minolta",
  "panasonic",
  "dell",
  "toshiba",
  "fujifilm",
  "utax",
  "develop",
  "triumph",
  "adler",
  "pantum",
  "zte",
  "huawei"
];

function corpusContainsToken(corpusNorm: string, token: string): boolean {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (token.length <= 4) {
    return new RegExp(`\\b${esc}\\b`, "i").test(corpusNorm);
  }
  return corpusNorm.includes(token);
}

/**
 * Убирает токены брендов, которых нет в корпусе (целиком слово, регистронезависимо).
 */
export function stripAbsentBrandMentions(text: string, corpusNorm: string): string {
  if (!text?.trim()) return text;
  let out = text;
  for (const b of BRAND_OR_VENDOR_TOKENS) {
    if (corpusContainsToken(corpusNorm, b)) continue;
    const reWord = new RegExp(`\\b${b}\\b`, "gi");
    if (!reWord.test(out)) continue;
    out = out.replace(reWord, " ").replace(/\s{2,}/g, " ").trim();
  }
  out = out
    .replace(/\s*[—–-]\s*[—–-]+/g, " — ")
    .replace(/^\s*[—–:,;]\s*/g, "")
    .replace(/\s*[—–]\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return out;
}

function cleanCharacteristics(
  rows: TenderAiCharacteristicRow[] | undefined,
  corpusNorm: string
): TenderAiCharacteristicRow[] {
  const raw = rows ?? [];
  const out: TenderAiCharacteristicRow[] = [];
  for (const ch of raw) {
    const name = stripAbsentBrandMentions(ch.name ?? "", corpusNorm).trim() || (ch.name ?? "").trim();
    const value = stripAbsentBrandMentions(ch.value ?? "", corpusNorm).trim();
    if (!value && (ch.value ?? "").trim()) continue;
    if (!name && !value) continue;
    out.push({ ...ch, name: name || ch.name, value });
  }
  return out;
}

export function groundGoodsItemsToMaskedCorpus(
  items: TenderAiGoodItem[],
  maskedCorpus: string
): TenderAiGoodItem[] {
  const c = (maskedCorpus ?? "").trim();
  if (!c || items.length === 0) return items;
  const corpusNorm = normalizeCorpusForMatch(c);
  return items.map((g) => {
    const prevName = (g.name ?? "").trim();
    let name = stripAbsentBrandMentions(prevName, corpusNorm).trim();
    if (name.length < 4) name = prevName;
    return {
      ...g,
      name: name,
      characteristics: cleanCharacteristics(g.characteristics, corpusNorm)
    };
  });
}
