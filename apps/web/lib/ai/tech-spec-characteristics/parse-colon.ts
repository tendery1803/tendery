import type { TenderAiCharacteristicRow } from "@tendery/contracts";
import { CHARACTERISTIC_NAME_SIGNATORY_LINE_RE, PROC_CHAR_JUNK } from "./constants";

/**
 * Вертикальная спецификация (docx/pdf): после наименования графа «назначение:» и т.п. иногда
 * склеивается без пробела или с одним пробелом с хвостом наименования — одна строка превращается
 * в псевдо-имя «…назначение». Разрываем только перед известными **нижним регистром** заголовками граф.
 */
/** Склейка без пробела: «…ПНДобъём» — lookbehind только кириллица, чтобы не резать латинские аббревиатуры. */
const GLUED_GRAPH_HEAD_NO_SPACE = new RegExp(
  String.raw`(?<=[а-яё])(?=(назначение|свойства|состав|объем|объём|комплектац(?:ия|ии)|фасовк[а-яё]*|упаковк[а-яё]*|количество\s+в\s+упаковк[а-яё]*|срок\s+годност[а-яё]*|условия\s+хранен[а-яё]*|комплектация\s*/\s*фасовк[а-яё]*)\s*:)`,
  "giu"
);
/**
 * Склейка «…мусора назначение:» (пробел). Объём/объем с пробелом не режем — часто «… удара. Объем:» в одной фразе.
 */
const GLUED_GRAPH_HEAD_WITH_SPACE = new RegExp(
  String.raw`(?<=[а-яё])\s+(?=(назначение|свойства|состав|комплектац(?:ия|ии)|фасовк[а-яё]*|упаковк[а-яё]*|количество\s+в\s+упаковк[а-яё]*|срок\s+годност[а-яё]*|условия\s+хранен[а-яё]*|комплектация\s*/\s*фасовк[а-яё]*)\s*:)`,
  "giu"
);

/** «…черный. Упаковка:» / «…разрывам. Объём:» в одной строке; точка перед цифрой версии («2. Объём») не трогаем. */
const AFTER_DOT_PACK_OR_VOLUME = /\.(?=\s*(?:объ[её]м|упаковк[а-яё]*)\s*:)/giu;

/** «…веществ. Свойства:» / «…время.Состав:» — типичная печатная склейка вертикальной спеки ЕИС. */
const AFTER_DOT_SECTION_LABEL = /\.(?=\s*(?:свойства|состав)\s*:)/giu;

/** «…эффектомСостав:» без пробела после точки — тот же класс склейки. */
const BEFORE_SECTION_LABEL_COLON = /(?<=[а-яёa-z0-9%)])(?=(?:состав|свойства)\s*:)/giu;

/** Хвост без «:» перед первой графой — вероятное описание, не дубли короткого наименования. */
export const VERTICAL_SPEC_ORPHAN_DESC_MIN_CHARS = 48;

export function splitVerticalSpecGluedGraphLines(line: string): string[] {
  let t = line.replace(/\s+/g, " ").trim();
  if (!t) return [];
  t = t.replace(GLUED_GRAPH_HEAD_NO_SPACE, "\n").replace(GLUED_GRAPH_HEAD_WITH_SPACE, "\n");
  t = t.replace(AFTER_DOT_SECTION_LABEL, ".\n");
  t = t.replace(BEFORE_SECTION_LABEL_COLON, "\n");
  t = t.replace(AFTER_DOT_PACK_OR_VOLUME, ".\n");
  return t.split("\n").map((s) => s.trim()).filter(Boolean);
}

export function canonicalCharacteristicName(name: string): string {
  const n = name.replace(/\s+/g, " ").trim();
  const low = n.toLowerCase();
  if (/^цвет\s+красител/i.test(low)) return "Цвет красителя";
  if (/^цвет\b/i.test(low)) return "Цвет красителя";
  if (/^модел/i.test(low)) return "Модель";
  if (/област(ь)?\s*применен/i.test(low)) return "Область применения";
  if (/чип|наличие\s*чип/i.test(low)) return "Наличие чипа";
  return n;
}

/**
 * В конец значения «Описание товара» иногда склеивается юридический абзац из хвоста документа (тендэксперемент 2).
 * Отрезаем только после длинного технического префикса, чтобы не трогать короткие ячейки.
 */
/** Маркеры маршрутизации корпуса не должны попадать в значение графы (слияние relaxed + merge). */
export function stripCorpusRoutingMarkerFromTechSpecValue(value: string): string {
  const t = value.replace(/\s+/g, " ").trim();
  const idx = t.search(/###\s*слой\s*:/i);
  if (idx < 0) return t;
  return t.slice(0, idx).trim().replace(/[;,\s]+$/u, "");
}

export function truncateAppendedLegalBoilerplateFromDescriptionValue(name: string, value: string): string {
  const nm = name.replace(/\s+/g, " ").trim();
  if (!/^описание\s+товара$/iu.test(nm)) return value;
  const v = value.replace(/\s+/g, " ").trim();
  if (v.length < 720) return value;
  let cut = v.length;
  const consider = (re: RegExp) => {
    const m = v.search(re);
    if (m >= 320 && m < cut) cut = m;
  };
  consider(/\bв\s+связи\s+с\s+тем\b/i);
  // без `\b` у кириллицы: в JS `\b` не работает как «граница слова» для не-ASCII букв.
  consider(/,\s*указаны\s+дополнительные\s+показатели\s+характеристик/i);
  consider(/товаров\s*,\s*работ\s*,\s*услуг/i);
  consider(/для\s+обеспечения\s+государственных/i);
  consider(/\bутвержд[а-яё]{4,22}\b[\s\S]{10,400}?Постановлени[емя]\s+Правительств/i);
  if (cut < v.length) return v.slice(0, cut).trim().replace(/[,:;\s]+$/u, "");
  return value;
}

function parseCharacteristicLine(line: string): TenderAiCharacteristicRow | null {
  const t = line.trim();
  if (t.length < 5 || t.length > 12_000) return null;
  const m = t.match(/^([А-Яа-яЁёA-Za-z0-9][^:]{1,120}?)\s*:\s*(.+)$/);
  if (!m) return null;
  const name = m[1]!.trim();
  if (name.length < 2 || CHARACTERISTIC_NAME_SIGNATORY_LINE_RE.test(name)) return null;
  let value = m[2]!.trim();
  if (value.length < 1) return null;
  if (PROC_CHAR_JUNK.test(name)) return null;
  const cn = canonicalCharacteristicName(name);
  value = stripCorpusRoutingMarkerFromTechSpecValue(
    truncateAppendedLegalBoilerplateFromDescriptionValue(cn, value)
  );
  if (!/^описание\s+товара$/iu.test(cn) && PROC_CHAR_JUNK.test(value)) return null;
  if (
    !/^описание\s+товара$/iu.test(cn) &&
    value.length > 400 &&
    /федеральн|постановлен|ст\.\s*\d/i.test(value)
  ) {
    return null;
  }
  return { name: cn, value, sourceHint: "tech_spec" };
}

/** Хвост следующей позиции, склеенный в PDF в строку «Объём: …» без перевода строки. */
export function trimVolumeLiterValueBleedIntoNextGoodsClause(value: string): string {
  const t = value.replace(/\s+/g, " ").trim();
  const m = t.match(
    /^(.{1,420}?\d+(?:[.,]\d+)?\s*(?:л|л\.|мл)\.?)\s+(?=[А-ЯЁ][а-яё]{3,44}\s+для\s+[а-яё])/u
  );
  return (m?.[1] ?? t).trim();
}

function pieceIsSignatoryColonLine(piece: string): boolean {
  const tp = piece.replace(/\s+/g, " ").trim();
  const sm = tp.match(/^([^:]+):\s*.+$/);
  if (!sm) return false;
  return CHARACTERISTIC_NAME_SIGNATORY_LINE_RE.test(sm[1]!.trim());
}

function parseColonPiecesToRows(pieces: string[]): TenderAiCharacteristicRow[] {
  const out: TenderAiCharacteristicRow[] = [];
  let pending = "";
  const flushPending = () => {
    const p = pending.replace(/\s+/g, " ").trim();
    pending = "";
    if (p.length >= VERTICAL_SPEC_ORPHAN_DESC_MIN_CHARS) {
      const value = stripCorpusRoutingMarkerFromTechSpecValue(
        truncateAppendedLegalBoilerplateFromDescriptionValue("Описание товара", p)
      );
      out.push({ name: "Описание товара", value, sourceHint: "tech_spec" });
    }
  };
  for (const piece of pieces) {
    const tp = piece.replace(/\s+/g, " ").trim();
    if (/^\d{1,6}(?:[.,]\d{1,2})?$/.test(tp) || /^(?:шт\.?|штук[а-яё]*|рул\.?|упак\.?|ед\.?\s*изм\.?)$/i.test(tp)) {
      flushPending();
      continue;
    }
    const ch = parseCharacteristicLine(piece);
    if (ch) {
      flushPending();
      if (/^объ[её]м$/iu.test(ch.name)) {
        out.push({ ...ch, value: trimVolumeLiterValueBleedIntoNextGoodsClause(ch.value) });
      } else {
        out.push(ch);
      }
    } else if (pieceIsSignatoryColonLine(piece)) {
      flushPending();
    } else {
      pending = pending ? `${pending} ${piece}`.trim() : piece;
    }
  }
  flushPending();
  return out;
}

/**
 * Type A — baseline: одна строка = одна пара «имя: значение».
 */
export function parseColonCharacteristics(bodyLines: string[]): TenderAiCharacteristicRow[] {
  const out: TenderAiCharacteristicRow[] = [];
  for (const ln of bodyLines) {
    out.push(...parseColonPiecesToRows(splitVerticalSpecGluedGraphLines(ln)));
  }
  return out;
}
