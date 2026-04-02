import type { TenderAiGoodItem, TenderAiParseResult } from "@tendery/contracts";
import { groundGoodsItemsToMaskedCorpus } from "@/lib/ai/ground-goods-to-corpus";
import { stabilizeGoodsItems } from "@/lib/ai/stabilize-goods-items";

function shouldGroundGoodsBrandsToCorpus(): boolean {
  return process.env.TENDER_AI_GROUND_GOODS_BRANDS === "1";
}
import { refineDeliveryTermAfterSanitize } from "@/lib/ai/delivery-term-post-parse";
import {
  enhanceDeliveryPlaceFromModelAndCorpus,
  finalizeDeliveryPlaceOutput
} from "@/lib/ai/delivery-place-from-corpus";

const DATES_FALLBACK =
  "В документе не найдены однозначные даты; требуется проверка вручную.";

/** Маркеры maskPiiForAi v2 и устаревшие нижний регистр. */
const TYPED_MASK_TOKEN = /\[(?:EMAIL|PHONE|INN|KPP|OGRN|BIK|BANK_ACC|BANK_REF|ID_DOC|PERSON)_\d+\]/gi;
const LEGACY_BRACKET_MASK = /\[(?:phone|email|inn|kpp|address|id_doc|ogrn|bank_account|bank_ref)\]/gi;

function hasBracketPlaceholder(s: string): boolean {
  TYPED_MASK_TOKEN.lastIndex = 0;
  LEGACY_BRACKET_MASK.lastIndex = 0;
  return TYPED_MASK_TOKEN.test(s) || LEGACY_BRACKET_MASK.test(s);
}

/** Только эти маркеры / шаблоны — считаем невалидным содержимым для перечисленных полей. */
const STANDALONE_INVALID = [
  /^\s*\[(?:EMAIL|PHONE|INN|KPP|OGRN|BIK|BANK_ACC|BANK_REF|ID_DOC|PERSON)_\d+\]\s*$/i,
  /^\s*\[phone\]\s*$/i,
  /^\s*\[email\]\s*$/i,
  /^\s*\[inn\]\s*$/i,
  /^\s*\[kpp\]\s*$/i,
  /^\s*\[address\]\s*$/i,
  /^№?\s*0{3,}\s*$/i,
  /^0+$/,
  /^00:00$/,
  /^_+\s*\.\s*_+\s*\.\s*_+$/,
  /^_*\.{2,}_*\.{2,}_*$/
];

const GENERIC_NON_VALUE = new RegExp(
  [
    "^\\s*устанавливается\\s+в\\s+договоре\\s*$",
    "^\\s*указывается\\s+в\\s+договоре\\s*$",
    "^\\s*согласно\\s+заявке\\s*$",
    "^\\s*определяется\\s+заявкой\\s*$",
    "^\\s*будет\\s+указано\\s+в\\s+договоре\\s*$",
    "^\\s*указано\\s+в\\s+договоре\\s*$",
    "^\\s*указано\\s+в\\s+договоре\\s+и\\s+заявках\\s*$"
  ].join("|"),
  "i"
);

const SANITIZE_KEYS = new Set([
  "tender_no",
  "nmck",
  "dates_stages",
  "delivery_term",
  "delivery_place"
]);

function isStandaloneInvalid(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  for (const re of STANDALONE_INVALID) {
    if (re.test(t)) return true;
  }
  if (GENERIC_NON_VALUE.test(t)) return true;
  return false;
}

function stripBracketPlaceholders(s: string): string {
  return s
    .replace(TYPED_MASK_TOKEN, "")
    .replace(LEGACY_BRACKET_MASK, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function stripPlaceholderDates(s: string): string {
  return s
    .replace(/\d{2}:\d{2}(?=\s|$|[^\d])/g, (m) => (m === "00:00" ? "" : m))
    .replace(/_+\s*\.\s*_+\s*\.\s*_+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Текст явно содержит шаблонные даты / маски. */
function hasDatePlaceholderNoise(s: string): boolean {
  return /_+\s*\.\s*_+\s*\.\s*_+/.test(s) || /\b00:00\b/.test(s) || hasBracketPlaceholder(s);
}

function isLikelyNmckNonAmount(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  if (GENERIC_NON_VALUE.test(t)) return true;
  if (!/\d/.test(t)) return true;
  return false;
}

function sanitizeTenderNo(value: string): string {
  let v = stripBracketPlaceholders(value);
  v = v.replace(/\s+/g, " ").trim();
  if (isStandaloneInvalid(v)) return "";
  if (/^№?\s*0+\s*$/i.test(v)) return "";
  return v;
}

function sanitizeNmck(value: string): string {
  let v = stripBracketPlaceholders(value);
  v = v.replace(/\s+/g, " ").trim();
  if (isStandaloneInvalid(v)) return "";
  if (GENERIC_NON_VALUE.test(v)) return "";
  if (isLikelyNmckNonAmount(v)) return "";
  return v;
}

function sanitizeDatesStages(value: string): string {
  const raw = value;
  let v = stripBracketPlaceholders(raw);
  v = stripPlaceholderDates(v);
  if (isStandaloneInvalid(v)) v = "";
  if (hasDatePlaceholderNoise(raw) && v.length < 8) return DATES_FALLBACK;
  if (!v && (hasDatePlaceholderNoise(raw) || hasBracketPlaceholder(raw))) {
    return DATES_FALLBACK;
  }
  return v;
}

function sanitizeDeliveryTerm(value: string): string {
  let v = stripBracketPlaceholders(value);
  v = stripPlaceholderDates(v);
  if (isStandaloneInvalid(v)) return "";
  if (GENERIC_NON_VALUE.test(v.trim())) return "";
  const base = v.trim();
  return refineDeliveryTermAfterSanitize(base);
}

function sanitizeDeliveryPlace(value: string): string {
  let v = stripBracketPlaceholders(value);
  v = v.replace(/\s+/g, " ").trim();
  if (isStandaloneInvalid(v)) return "";
  if (GENERIC_NON_VALUE.test(v)) return "";
  return v;
}

function sanitizeOneField(
  key: string,
  value: string,
  options?: SanitizeTenderAiParseOptions
): string {
  switch (key) {
    case "tender_no":
      return sanitizeTenderNo(value);
    case "nmck":
      return sanitizeNmck(value);
    case "dates_stages":
      return sanitizeDatesStages(value);
    case "delivery_term":
      return sanitizeDeliveryTerm(value);
    case "delivery_place": {
      let v = sanitizeDeliveryPlace(value);
      const c = options?.maskedTenderCorpus?.trim();
      if (c) v = enhanceDeliveryPlaceFromModelAndCorpus(v, c);
      return finalizeDeliveryPlaceOutput(v);
    }
    default:
      return value;
  }
}

export type SanitizeTenderAiParseOptions = {
  /** Полный обезличенный корпус файлов тендера — пост-подбор delivery_place из текста. */
  maskedTenderCorpus?: string;
  /** Не урезать goodsItems по региону/НМЦК до reconcile с ТЗ-first списком. */
  goodsTechSpecDeterministicStabilize?: boolean;
};

/** Короткие мета-заглушки вместо реального текста из документа — убираем (лучше пусто, чем ложная полнота). */
const META_PLACEHOLDER_CHAR_VALUE =
  /^\s*\(?\s*(?:значение\s+указано\s+в\s+описании|продолжение\s+спецификации|не\s+полностью\s+приведено|значение\s+не\s+полностью)/i;

/** Служебные инструкции 44-ФЗ / положения о заполнении — не характеристика товара. */
const PROC_META_CHAR =
  /значени[ея]\s+характеристик[аи]?\s+не\s+может\s+изменя|не\s+может\s+изменяться\s+участник|участник(?:ом)?\s+закупк|участник\s+закупки\s+указывает|участник\s+указывает\s+конкретн|значени[ея]\s+не\s+может\s+изменя|типов[аое]\s+решени|формулировк[аи]\s+характеристик|заполнени[ея]\s+заявк|дополнительн(?:ая|ой|ую|ые)\s+информаци/i;

/** Фрагменты value — не свойство товара (мусор из изложения закупки). */
const JUNK_CHAR_VALUE_SNIPPETS = [
  "участник закупки указывает",
  "значение характеристики не может изменяться",
  "обоснование включения",
  "дополнительной информации",
  "инструкция по заполнению",
  "в соответствии со ст.",
  "постановлением правительства"
] as const;

/** Имя строки характеристики — заголовок/инструкция, не свойство. */
const JUNK_CHAR_NAME_SNIPPETS = [
  "инструкция по заполнению",
  "обоснование включения",
  "характеристики товара"
] as const;

function valueContainsJunkSnippet(value: string): boolean {
  const t = value.toLowerCase();
  for (const s of JUNK_CHAR_VALUE_SNIPPETS) {
    if (t.includes(s)) return true;
  }
  return false;
}

/** Длинный юридический «простыни» в value — убрать. */
function isLegalBoilerplateCharacteristicValue(value: string): boolean {
  if (value.length <= 200) return false;
  return (
    /в\s+соответствии\s+со\s+ст[\.\d]/i.test(value) ||
    /постановлени[емя]\s+правительства/i.test(value) ||
    /федеральн[ыйого]\s+закон/i.test(value)
  );
}

function normChKey(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

function preferLongerStr(a: string, b: string): string {
  const x = a.trim();
  const y = b.trim();
  return y.length > x.length ? y : x;
}

/** «Да»/«Нет» из ТЗ не заменять длинной заглушкой «указано в описании…». */
function preferChipCharacteristicMergeValue(a: string, b: string): string {
  const xa = a.trim();
  const xb = b.trim();
  const boiler = (s: string) =>
    /указано\s+в\s+описании|см\.?\s*описание|по\s+описанию/i.test(s);
  const yn = (s: string) => /^(да|нет)\s*$/i.test(s);
  if (yn(xa) && (boiler(xb) || xb.length > xa.length + 8)) return xa;
  if (yn(xb) && (boiler(xa) || xa.length > xb.length + 8)) return xb;
  return preferLongerStr(xa, xb);
}

function normalizeCharacteristicNameOcr(name: string): string {
  let t = name.trim();
  t = t.replace(/\bчипада\b/gi, "чипа");
  t = t.replace(/\bналичие\s+чипада\b/gi, "наличие чипа");
  return t;
}

/** Объединение синонимов в один ключ Map (например длинное «цвет …» → цвет). */
function canonicalCharacteristicGroupKey(name: string): string {
  const k = normChKey(normalizeCharacteristicNameOcr(name));
  if (!k) return k;
  if (
    /^(?:цвет|цвет\s+(красителя|картриджа|тонера|чернил))$/.test(k) ||
    /\bцвет\s+(красителя|картриджа|тонера|чернил)\b/.test(k)
  ) {
    return "цвет_товара";
  }
  if (/^модел/.test(k)) return "модель";
  if (/област(ь)?\s*применен/.test(k)) return "область применения";
  return k;
}

function preferShorterStr(a: string, b: string): string {
  const x = a.trim();
  const y = b.trim();
  if (!x) return b;
  if (!y) return a;
  return x.length <= y.length ? a : b;
}

function nameContainsJunkSnippet(name: string): boolean {
  const t = normChKey(name);
  for (const s of JUNK_CHAR_NAME_SNIPPETS) {
    if (t.includes(s)) return true;
  }
  return false;
}

/** Оставить при перегрузе списка: модель, область применения, цвет, чип. */
function isPreferredRetailCharacteristicName(name: string): boolean {
  const t = normChKey(normalizeCharacteristicNameOcr(name));
  if (!t) return false;
  if (/\bмодел/.test(t)) return true;
  if (/област(ь)?\s*применен/.test(t)) return true;
  if (/\bцвет\b/.test(t)) return true;
  if (/чип|наличие\s*чип/.test(t)) return true;
  return false;
}

function stripTrailingProcFromValue(v: string): string {
  return v
    .replace(/\s*[.;]\s*значени[ея]\s+характеристик[аи]?.{0,220}?$/i, "")
    .replace(/\s*[.;]\s*не\s+может\s+изменяться\s+участник.{0,120}?$/i, "")
    .trim();
}

function isProceduralCharacteristicRow(name: string, value: string): boolean {
  const n = name.trim();
  const v = value.trim();
  if (PROC_META_CHAR.test(n)) return true;
  if (v && PROC_META_CHAR.test(v) && v.length < 260) return true;
  if (nameContainsJunkSnippet(n)) return true;
  if (v && valueContainsJunkSnippet(v)) return true;
  if (v && isLegalBoilerplateCharacteristicValue(v)) return true;
  return false;
}

/** Много длинных повторяющихся строк — оставить ключевые для карточки товара. */
function squeezeHeavyCharacteristicList<T extends { name: string; value: string }>(rows: T[]): T[] {
  if (rows.length <= 8) return rows;
  const longCount = rows.filter((c) => (c.value ?? "").trim().length > 80).length;
  if (longCount < 3) return rows;
  const preferred = rows.filter((c) => isPreferredRetailCharacteristicName(c.name));
  if (preferred.length > 0) {
    const preferredSet = new Set(preferred);
    const tail = rows.filter((c) => !preferredSet.has(c)).slice(0, 6);
    return [...preferred, ...tail];
  }
  return rows.slice(0, 12);
}

function cleanGoodsItemsCharacteristics(items: TenderAiGoodItem[]): TenderAiGoodItem[] {
  return items.map((g) => {
    const raw = (g.characteristics ?? []).map((ch) => {
      const name = normalizeCharacteristicNameOcr(ch.name ?? "");
      let value = stripTrailingProcFromValue((ch.value ?? "").trim());
      if (META_PLACEHOLDER_CHAR_VALUE.test(value) && value.length < 200) value = "";
      return {
        ...ch,
        name,
        value,
        sourceHint: (ch.sourceHint ?? "").trim()
      };
    });
    const filtered = raw.filter((ch) => !isProceduralCharacteristicRow(ch.name, ch.value));
    const kept = filtered.filter((ch) => ch.name.trim() || ch.value.trim());
    const byName = new Map<string, (typeof kept)[number]>();
    for (const ch of kept) {
      const k = canonicalCharacteristicGroupKey(ch.name);
      if (!k) continue;
      const prev = byName.get(k);
      if (!prev) {
        byName.set(k, ch);
        continue;
      }
      const shortCanon = k === "цвет_товара" || k === "модель" || k === "область применения";
      const chipKey = /чип|наличие\s*чип/.test(k);
      byName.set(k, {
        ...prev,
        name: shortCanon ? preferShorterStr(prev.name, ch.name) : preferLongerStr(prev.name, ch.name),
        value: chipKey
          ? preferChipCharacteristicMergeValue(prev.value, ch.value)
          : preferLongerStr(prev.value, ch.value),
        sourceHint: preferLongerStr(prev.sourceHint ?? "", ch.sourceHint ?? "")
      });
    }
    const merged = squeezeHeavyCharacteristicList(Array.from(byName.values()));
    return { ...g, characteristics: merged };
  });
}

/**
 * Убирает placeholder’ы и шаблонные «не-значения» из верхних полей после ответа модели.
 * Контракт JSON и порядок ключей не меняются.
 */
export function sanitizeTenderAiParseResult(
  data: TenderAiParseResult,
  options?: SanitizeTenderAiParseOptions
): TenderAiParseResult {
  const fields = data.fields.map((f) => {
    if (!SANITIZE_KEYS.has(f.key)) return f;
    const next = sanitizeOneField(f.key, f.value, options);
    if (next === f.value) return f;
    return { ...f, value: next };
  });
  const nmckText = fields.find((f) => f.key === "nmck")?.value ?? "";
  // Стабилизация не требует цену в строке; сверка цен с печатной формой — в reconcile (tender-ai-analyze).
  const goodsStabilized = stabilizeGoodsItems(data.goodsItems ?? [], {
    corpus: options?.maskedTenderCorpus ?? "",
    nmckText,
    techSpecDeterministicMode: options?.goodsTechSpecDeterministicStabilize === true
  });
  const cleaned = cleanGoodsItemsCharacteristics(goodsStabilized);
  const mc = options?.maskedTenderCorpus?.trim();
  const goodsItems =
    mc && shouldGroundGoodsBrandsToCorpus()
      ? groundGoodsItemsToMaskedCorpus(cleaned, mc)
      : cleaned;

  return {
    ...data,
    fields,
    procurementMethod: (data.procurementMethod ?? "").trim(),
    goodsItems
  };
}
