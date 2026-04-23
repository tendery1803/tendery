/**
 * Детерминированное извлечение позиций из ТЗ (блоки «наименование → КТРУ → количество → характеристики»).
 * Не использует AI.
 */

import type { TenderAiCharacteristicRow, TenderAiGoodItem } from "@tendery/contracts";
import { classifyDocumentByLogicalPath } from "@/lib/ai/goods-source-routing";
import {
  buildGoodsCorpusClassification,
  extractPriorityLayersForGoodsTech
} from "@/lib/ai/masked-corpus-sources";
import {
  CHARACTERISTIC_NAME_SIGNATORY_LINE_RE,
  PROC_CHAR_JUNK
} from "@/lib/ai/tech-spec-characteristics/constants";
import {
  extractPositionBlocksFromTechSpec,
  explainPositionBlockBackboneForSegment,
  LINE_CARTRIDGE_MODEL_EQUIV_ANCHOR,
  LINE_KTRU_COLON_ANCHOR,
  parseCharacteristicsForPositionBody,
  positionBlockHeaderIsKnownAnchor,
  shouldUsePositionBlockBackboneForSegment,
  type PositionBlock,
  type PositionBlockBackboneSegmentExplain
} from "@/lib/ai/tech-spec-characteristics";
import {
  canonicalCharacteristicName,
  splitVerticalSpecGluedGraphLines,
  stripCorpusRoutingMarkerFromTechSpecValue,
  trimVolumeLiterValueBleedIntoNextGoodsClause,
  truncateAppendedLegalBoilerplateFromDescriptionValue,
  VERTICAL_SPEC_ORPHAN_DESC_MIN_CHARS
} from "@/lib/ai/tech-spec-characteristics/parse-colon";
import {
  extractPackagingNoteFromLine,
  healVerticalBareGluedСоставCharacteristicName,
  lineLooksLikePackOnlyQtyInProse,
  normalizeCelsiusRangeGarbles,
  stripVerticalSpecTitleEchoFromCharacteristics,
  verticalSpecBareOrdinalShortTitleFromBlock,
  verticalSpecBareOrdinalTitleRawLines
} from "@/lib/ai/tech-spec-vertical-goods-layout";
import {
  isRegistryStylePositionId,
  REGISTRY_POSITION_ID_CAPTURE_RE,
  REGISTRY_POSITION_ID_INLINE_RE
} from "@/lib/ai/registry-position-ids";
import { stripDuplicateRegistryPidFromConsecutiveCanon067hColorVariantRows } from "@/lib/ai/strip-duplicate-registry-pid-canon067h-variant-run";
import {
  enrichCartridgeRegistryPositionIdsStrictSameLineTechCorpus,
  restoreCanon067hConsecutiveVariantPidsFromTechCorpus
} from "@/lib/ai/cartridge-registry-order-restore";

function lineHasRub(line: string): boolean {
  return /\d[\d\s]*(?:[.,]\d{1,2})?\s*(?:руб|₽)/i.test(line);
}

/** Замена \b: в JS граница слова не работает для кириллицы. */
const NOT_WORD_CONTINUATION = /(?![а-яёА-ЯЁa-zA-Z0-9_])/;

/** Старт новой позиции: картридж / тонер / барабан и т.п. (с опциональным п/п). */
const POSITION_START_RE = new RegExp(
  `^(?:\\d{1,4}\\s*[.)]\\s*)?(Картридж|Тонер-туба|Тонер|Фотобарабан|СНПЧ|Барабан|Расходный\\s+материал|Набор\\s+(?:картридж|тонер)|Модуль|Чип\\s+для)${NOT_WORD_CONTINUATION.source}`,
  "i"
);

/** Строка начинается с бренда/модельного ряда (ТЗ без слова «Картридж» в первой колонке). */
const MODEL_FIRST_LINE_RE = new RegExp(
  `^(?:\\d{1,4}\\s*[.)]\\s*)?(?:(?:Картридж|Тонер|Краска)\\s+)?(?:HP|Hewlett|Canon|Brother|Kyocera|Lexmark|Samsung|OKI|Xerox|Ricoh|Sharp|Konica|Epson)${NOT_WORD_CONTINUATION.source}`,
  "i"
);

/** Заголовки таблицы / раздела ТЗ. */
const TABLE_HEADER_RE =
  /^(Наименование\s+товара|КТРУ|ОКПД|Характеристик\w*\s+товара|Единица\s+измерения|Количеств\w*|№\s*п\/п|п\/п)\s*[:\s|]/i;

const SECTION_MARK_RE =
  /техническ(?:ое|их)\s+задан|описан(?:ие|ия)\s+объект[а]?\s+закупк|требовани[яе]\s+к\s+характеристик/i;

export function extractKtruOrOkpd(s: string): string {
  /** КТРУ: после дефиса часто 5 цифр, но в корпусе встречается и 3 (напр. …120-957) — иначе срез совпадает с ОКПД и collect дедупит вторую строку. */
  const k = s.match(/\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{3,5}(?!\d)/);
  if (k) return k[0]!;
  const o = s.match(/\d{2}\.\d{2}\.\d{2}\.\d{2,3}(?:\.\d{3})?/);
  return o?.[0] ?? "";
}

/** Все ОКПД2/КТРУ из строк блока по порядку (уникальные). Раньше брался только первый match + break — терялась вторая кодовая строка (Тенд32). */
function collectKtruOkpdCodesFromBlockLines(blockLines: string[]): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const ln of blockLines) {
    const k = extractKtruOrOkpd(ln).trim();
    if (!k) continue;
    const key = k.replace(/\s/g, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(k);
  }
  return parts.join("; ");
}

/**
 * Количество в строке печатной формы / извещения: не первое «число + шт» (часто цепляет реестр 208665xxx
 * или колонку цены), а после КТРУ/ОКПД или реестрового id; иначе — последнее «N шт» до первой суммы в рублях.
 */
export function extractQuantityFromTabularGoodsLine(line: string): string | undefined {
  const t = line.trim();
  if (!t) return undefined;
  /** Суффикс КТРУ в ПФ часто >5 цифр (…120-00000002); иначе «хвост» цепляет qty (R2 registry selftest). */
  const ktru = t.match(/\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{3,12}(?!\d)/);
  const okpd = t.match(/\d{2}\.\d{2}\.\d{2}\.\d{2,3}(?:\.\d{3})?/);
  const reg = t.match(REGISTRY_POSITION_ID_CAPTURE_RE);
  let anchor = 0;
  if (ktru) anchor = Math.max(anchor, t.indexOf(ktru[0]) + ktru[0].length);
  if (okpd) anchor = Math.max(anchor, t.indexOf(okpd[0]) + okpd[0].length);
  if (reg) anchor = Math.max(anchor, t.indexOf(reg[1]) + reg[1].length);

  const rubIdx = t.search(/\d[\d\s]*(?:[.,]\d{1,2})?\s*(?:руб|₽)/i);
  const endBeforeMoney = rubIdx >= 0 ? rubIdx : t.length;
  /** Нельзя склеивать «до руб» с куском после якоря КТРУ: хвост «…-00000002 Штука» давал ложный qty=000002 (R2). */
  const segments =
    anchor > 0
      ? [t.slice(anchor, endBeforeMoney), t.slice(0, anchor)].filter((s) => s.trim().length > 0)
      : [t.slice(0, endBeforeMoney)];

  const trySegment = (seg: string): string | undefined => {
    const matches = [
      ...seg.matchAll(
        /(\d{1,6}(?:[.,]\d{1,2})?)\s*(?:шт\.?|штук[а-яё]*|ед\.?\s*изм|упак|компл|комплект)(?=[\s\t|,.;)]|$)/gi
      )
    ];
    if (!matches.length) return undefined;
    const m = matches[matches.length - 1]!;
    const q = m[1]!.replace(/\s/g, "").replace(",", ".");
    const n = parseFloat(q);
    if (!Number.isFinite(n) || n < 0 || n > 999_999) return undefined;
    if (!Number.isInteger(n) && n > 500) return undefined;
    return q;
  };

  for (const seg of segments) {
    const q = trySegment(seg);
    if (q) return q;
  }
  return undefined;
}

function lineLooksLikeCharacteristicRow(line: string): boolean {
  const t = line.trim();
  if (t.length < 6) return false;
  return /^[А-Яа-яЁёA-Za-z0-9][^:]{1,220}?\s*:\s*\S/.test(t);
}

/** Строка вида «Количество: …» — тоже «имя: значение», но её нельзя отбрасывать до разбора колонки количества. */
function lineLooksLikeQtyLabelRow(t: string): boolean {
  return /^(?:количеств|кол-?\s*во|объ[её]м|quantity)\b/i.test(t.trim());
}

/** «Количество в упаковке: …» — фасовка, не закупка по позиции. */
function lineLooksLikeQuantityLabelButMeansPackageFilling(line: string): boolean {
  const t = line.replace(/\s+/g, " ").trim();
  if (/количеств\w*\s+в\s+(?:упаковк|наборе|пачк|фасовк|полиэтиленов)/i.test(t)) return true;
  if (/кол-?\s*во\w*\s+в\s+(?:упаковк|наборе|пачк)/i.test(t)) return true;
  return false;
}

/**
 * Строка с «N л/мл» как объём/номинал товара (мешки 120 л и т.п.), не как количество закупки в этой строке.
 */
function lineLooksLikeProductVolumeLiterQtyInProse(line: string): boolean {
  const t = line.replace(/\s+/g, " ").trim();
  if (!/\d{1,4}\s*(?:л|л\.|мл)\b/i.test(t)) return false;
  if (/^(?:количеств|кол-?\s*во|quantity|ед\.?\s*изм)\b/i.test(t)) return false;
  if (/\d{1,4}\s*(?:л|л\.|мл)\s*$/i.test(t)) return true;
  return /\b(?:объ[еёe]м|ёмкост|емкост|вместимост|литров|мешк|флакон|тары?|канист)\w*/i.test(t);
}

function isLiterCapacityUnitStr(unitStr: string): boolean {
  const x = unitStr.trim().toLowerCase().replace(/\s+/g, "");
  return /^(л|л\.|мл)$/.test(x);
}

/** То же число + л/мл уже есть в шапке блока как номинал (наименование / объём товара). */
function blockHeadTextSuggestsNominalLiterVolume(blockLines: string[], quantity: number): boolean {
  if (!Number.isFinite(quantity) || quantity <= 0) return false;
  const head = blockLines.slice(0, 60).join("\n");
  const re = new RegExp(`\\b${quantity}\\s*(?:л|л\\.|мл)\\b`, "i");
  return re.test(head);
}

/**
 * Печатная форма ЕИС: колонки PDF часто склеивает в «ТоварШтука4000.00» без пробела между ед. изм. и числом.
 */
function tryExtractGluedRussianUnitQuantity(line: string): { quantityValue: number; unitStr: string } | null {
  const t = line.replace(/\u00A0/g, " ").trim();
  if (t.length < 8 || lineLooksLikePackOnlyQtyInProse(t)) return null;
  const m = t.match(/^(?:Товар)?(шт\.?|штук[а-яё]{0,4})(\d{1,6}(?:[.,]\d{1,2})?)\s*$/i);
  if (!m?.[2]) return null;
  const n = parseDeterministicQuantityNumberFragment(m[2]!);
  if (n == null || n <= 0) return null;
  return { quantityValue: n, unitStr: m[1]!.replace(/\s+/g, " ").trim().slice(0, 40) };
}

/**
 * Склейка многострочных значений и continuation-строк (xlsx/docx) перед разбором характеристик.
 * Строки с TAB не объединяем — отдаём simple-table парсеру как есть.
 */
export function mergeContinuationLinesForCharacteristics(bodyLines: string[]): string[] {
  const result: string[] = [];
  let current = "";
  const flush = () => {
    const t = current.trimEnd();
    if (t) result.push(t);
    current = "";
  };
  for (const raw of bodyLines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      flush();
      continue;
    }
    if (trimmed.includes("\t")) {
      flush();
      result.push(line);
      continue;
    }
    const looksNewPair =
      /^[А-Яа-яЁёA-Za-z0-9][^:]{0,400}:\s*\S/.test(trimmed) ||
      /^[А-Яа-яЁёA-Za-z0-9][^:]{0,400}:\s*$/.test(trimmed);
    if (looksNewPair) {
      flush();
      current = trimmed;
      continue;
    }
    if (current) current = `${current} ${trimmed}`;
    else result.push(trimmed);
  }
  flush();
  return result;
}

/**
 * Дополнительный разбор «имя: значение» и tab-строк с длинными значениями (вне ограничений parse-colon.ts).
 */
export function parseRelaxedColonAndTabCharacteristicLines(
  mergedLines: string[]
): TenderAiCharacteristicRow[] {
  const out: TenderAiCharacteristicRow[] = [];
  let relaxedOrphan = "";
  const flushRelaxedOrphan = () => {
    const p = relaxedOrphan.replace(/\s+/g, " ").trim();
    relaxedOrphan = "";
    if (p.length >= VERTICAL_SPEC_ORPHAN_DESC_MIN_CHARS) {
      const val = stripCorpusRoutingMarkerFromTechSpecValue(
        truncateAppendedLegalBoilerplateFromDescriptionValue("Описание товара", p)
      );
      out.push({ name: "Описание товара", value: val, sourceHint: "tech_spec" });
    }
  };
  for (const raw of mergedLines) {
    const t = raw.trim();
    if (!t) continue;
    if (t.includes("\t")) {
      flushRelaxedOrphan();
      const tabIdx = t.indexOf("\t");
      const name = t.slice(0, tabIdx).trim();
      let value = t.slice(tabIdx + 1).trim().replace(/\t/g, " ");
      if (name.length < 2 || value.length < 1) continue;
      if (CHARACTERISTIC_NAME_SIGNATORY_LINE_RE.test(name)) continue;
      if (PROC_CHAR_JUNK.test(name)) continue;
      const cn = canonicalCharacteristicName(name);
      value = stripCorpusRoutingMarkerFromTechSpecValue(
        truncateAppendedLegalBoilerplateFromDescriptionValue(cn, value)
      );
      if (!/^описание\s+товара$/iu.test(cn) && PROC_CHAR_JUNK.test(value)) continue;
      if (
        !/^описание\s+товара$/iu.test(cn) &&
        value.length > 400 &&
        /федеральн|постановлен|ст\.\s*\d/i.test(value)
      ) {
        continue;
      }
      out.push({ name: cn, value, sourceHint: "tech_spec" });
      continue;
    }
    for (const piece of splitVerticalSpecGluedGraphLines(t)) {
      const tp = piece.replace(/\s+/g, " ").trim();
      if (/^\d{1,6}(?:[.,]\d{1,2})?$/.test(tp) || /^(?:шт\.?|штук[а-яё]*|рул\.?|упак\.?|ед\.?\s*изм\.?)$/i.test(tp)) {
        flushRelaxedOrphan();
        continue;
      }
      const m = piece.match(/^([А-Яа-яЁёA-Za-z0-9][^:]{0,400}?)\s*:\s*([\s\S]+)$/);
      if (!m) {
        relaxedOrphan = relaxedOrphan ? `${relaxedOrphan} ${piece}`.trim() : piece;
        continue;
      }
      flushRelaxedOrphan();
      const name = m[1]!.trim();
      let value = m[2]!.trim();
      if (value.length > 12_000) value = `${value.slice(0, 12_000)}…`;
      if (name.length < 2 || value.length < 1) continue;
      if (CHARACTERISTIC_NAME_SIGNATORY_LINE_RE.test(name)) continue;
      if (PROC_CHAR_JUNK.test(name)) continue;
      const cn = canonicalCharacteristicName(name);
      value = stripCorpusRoutingMarkerFromTechSpecValue(
        truncateAppendedLegalBoilerplateFromDescriptionValue(cn, value)
      );
      if (!/^описание\s+товара$/iu.test(cn) && PROC_CHAR_JUNK.test(value)) continue;
      if (
        !/^описание\s+товара$/iu.test(cn) &&
        value.length > 400 &&
        /федеральн|постановлен|ст\.\s*\d/i.test(value)
      ) {
        continue;
      }
      const v =
        /^объ[её]м$/iu.test(cn) ? trimVolumeLiterValueBleedIntoNextGoodsClause(value) : value;
      out.push({ name: cn, value: v, sourceHint: "tech_spec" });
    }
  }
  flushRelaxedOrphan();
  return out;
}

function segmentAllowsGenericNumberedPositions(logicalPath: string): boolean {
  if (!logicalPath.trim()) return false;
  const cat = classifyDocumentByLogicalPath(logicalPath);
  return (
    cat === "description_of_object" ||
    cat === "technical_spec" ||
    cat === "technical_part" ||
    cat === "appendix_to_spec"
  );
}

/** Делит strictTech-текст на части по маркерам `--- path ---` из extraction. */
export function splitStrictTechTextByLogicalPathSegments(
  strictTechText: string
): Array<{ logicalPath: string; lines: string[] }> {
  const lines = strictTechText.split("\n");
  const segments: Array<{ logicalPath: string; lines: string[] }> = [];
  let currentPath = "";
  let buf: string[] = [];
  const flush = () => {
    if (buf.length) segments.push({ logicalPath: currentPath, lines: [...buf] });
    buf = [];
  };
  for (const line of lines) {
    const hm = line.match(/^---\s+(.+?)\s+---\s*$/);
    if (hm) {
      flush();
      currentPath = hm[1]!.replace(/\s*\((nested\s+(?:zip|rar|7z))\)\s*$/i, "").trim();
      continue;
    }
    buf.push(line);
  }
  flush();
  if (segments.length === 0) return [{ logicalPath: "", lines }];
  return segments;
}

function logicalPathFromSourceHint(hint: string): string {
  const m = hint.match(/\|lp:([^|]+)$/);
  return m ? m[1]!.trim() : "";
}

/** Число + ед. изм. в одной ячейке; «Штука» целиком (не только «шт» + \\b). */
const QTY_UNIT_RE =
  /(\d+(?:[.,]\d+)?)\s*(шт\.?|штук[а-яё]*|ед\.?\s*изм\.?|упак|компл|комплект|м²|м2|кг|л)(?=[\s\t|,.;)]|$)/gi;

/**
 * Выбор количества из фрагмента позиции: не «последнее N шт в блоке» (часто цепляет хвост
 * характеристик / ОКПД / мусор), а строка с явным «Количество», затем скоринг по строкам шапки.
 */
export function pickSpecificationQuantityFromLines(
  lines: string[],
  options?: { skipCharacteristicLines?: boolean; maxHeadLines?: number }
): { quantity: string; unit: string } | null {
  const skipChar = options?.skipCharacteristicLines !== false;
  const cap = Math.min(lines.length, Math.max(1, options?.maxHeadLines ?? 28));
  const head = lines.slice(0, cap);

  /** Явная строка закупки с ед. изм. в той же строке (без «л» как объём тары — см. QTY_UNIT ниже). */
  const LABELED_PURCHASE_QTY_UNIT_RE =
    /(?:количеств[а-яёА-ЯЁ]*(?:\s+в\s+единиц[а-яёА-ЯЁ]*(?:\s+измерен[а-яёА-ЯЁ]*)?)?|кол-?\s*во|quantity)\s*[:\s\t|]+\s*(\d+(?:[.,]\d+)?)\s*(шт\.?|штук[а-яё]*|ед\.?\s*изм\.?|упак|компл|комплект|м²|м2|кг)(?=[\s\t|,.;)]|$)/i;
  for (let i = 0; i < head.length; i++) {
    const line = head[i]!;
    if (lineLooksLikePackOnlyQtyInProse(line)) continue;
    const t = line.trim();
    if (lineLooksLikeQuantityLabelButMeansPackageFilling(t)) continue;
    const m = t.match(LABELED_PURCHASE_QTY_UNIT_RE);
    if (m?.[1] && m[2]) {
      return {
        quantity: m[1]!.replace(",", "."),
        unit: m[2]!.replace(/\s+/g, " ").trim()
      };
    }
  }

  /** «Количество» / «Кол-во» в одной ячейке/строке без «шт» рядом; «Ед. изм.» — в соседней строке/колонке. */
  for (let i = 0; i < head.length; i++) {
    const line = head[i]!;
    if (lineLooksLikeQuantityLabelButMeansPackageFilling(line.trim())) continue;
    const mq = line.match(
      /(?:^|[\t|]\s*)(?:количеств[а-яёА-ЯЁ]*(?:\s+в\s+единиц[а-яёА-ЯЁ]*(?:\s+измерен[а-яёА-ЯЁ]*)?)?|кол-?\s*во)\s*[,\s]*(?:штук[а-яёА-ЯЁ]*|шт\.?)?\s*[:\s\t|]+\s*(\d+(?:[.,]\d+)?)\b/i
    );
    if (!mq?.[1]) continue;
    const q = mq[1]!.replace(",", ".");
    const n = parseFloat(q);
    if (!Number.isFinite(n) || n <= 0 || n >= 1_000_000) continue;
    /** «Количество: 14000.00» — формат цены, не закупка в шт (R3 selftest). */
    if (/[.,]\d{2}$/.test(q.trim()) && n >= 50) continue;
    let unit = "";
    const tail = line.slice((mq.index ?? 0) + mq[0]!.length).trim();
    const tailUnit = tail.match(
      /^[:\t|\s,]+([А-Яа-яЁёA-Za-z][А-Яа-яЁёA-Za-z\s.]{1,30})$/i
    );
    if (tailUnit?.[1] && !/^\d/.test(tailUnit[1]!.trim()) && tailUnit[1]!.length <= 34) {
      unit = tailUnit[1]!.replace(/\s+/g, " ").trim().slice(0, 32);
    }
    if (!unit) {
      for (let j = i; j <= Math.min(head.length - 1, i + 4); j++) {
        const um = head[j]!.match(
          /(?:ед(?:иниц[а-яёА-ЯЁ]*)?\s+измерен[а-яёА-ЯЁ]*|ед\.\s*изм\.?)\s*[:\s\t|]+\s*([^\t\n|]{2,40})/i
        );
        if (um?.[1]) {
          unit = um[1]!.replace(/\s+/g, " ").trim().slice(0, 32);
          break;
        }
      }
    }
    if (!unit) unit = "шт";
    return { quantity: q, unit };
  }

  type Cand = { q: string; u: string; score: number; lineIdx: number };
  const candidates: Cand[] = [];
  for (let i = 0; i < head.length; i++) {
    const line = head[i]!;
    if (lineLooksLikePackOnlyQtyInProse(line)) continue;
    const glued = tryExtractGluedRussianUnitQuantity(line.trim());
    if (glued) {
      candidates.push({
        q: formatQuantityValueForStorage(glued.quantityValue),
        u: glued.unitStr,
        score: 18,
        lineIdx: i
      });
    }
    if (skipChar && lineLooksLikeCharacteristicRow(line)) continue;
    QTY_UNIT_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = QTY_UNIT_RE.exec(line)) !== null) {
      const q = m[1]!.replace(",", ".");
      const u = m[2]!.replace(/\s+/g, " ").trim();
      const n = parseFloat(q);
      let score = 0;
      const uLow = u.toLowerCase();
      if (uLow.startsWith("шт")) {
        score += 12;
        if (Number.isFinite(n) && Number.isInteger(n) && n >= 1 && n <= 500) score += 8;
        if (Number.isFinite(n) && (!Number.isInteger(n) || n > 200)) score -= 10;
      } else {
        score += 4;
      }
      if (/\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{5}/.test(line) || /\d{2}\.\d{2}\.\d{2}\.\d{2}/.test(line)) {
        score += 5;
      }
      if (/картридж|тонер|мфу|лазер|принтер|hp\b|canon|kyocera|brother|lexmark|ricoh|xerox/i.test(line)) {
        score += 4;
      }
      if (/^[\d\s.,;:|-]{0,6}$/.test(line.trim())) score -= 6;
      if (line.length > 220) score -= 4;
      if (lineHasRub(line)) score -= 15;
      const uLowCand = u.toLowerCase();
      if (
        (uLowCand === "л" || uLowCand === "л." || uLowCand.startsWith("мл")) &&
        lineLooksLikeProductVolumeLiterQtyInProse(line)
      ) {
        continue;
      }
      candidates.push({ q, u, score, lineIdx: i });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score || a.lineIdx - b.lineIdx);
  let best = candidates[0]!;
  let quantity = best.q;
  const unitLow = best.u.toLowerCase();
  if (unitLow.startsWith("шт") && quantity.includes(".")) {
    const intPrefer = candidates.find(
      (c) =>
        c.u.toLowerCase().startsWith("шт") &&
        !c.q.includes(".") &&
        parseFloat(c.q) >= 1 &&
        parseFloat(c.q) <= 200
    );
    if (intPrefer) {
      quantity = intPrefer.q;
      best = intPrefer;
    }
  }
  if (unitLow.startsWith("шт")) {
    const n = parseFloat(quantity);
    if (Number.isFinite(n) && n > 500) {
      const sane = candidates.find(
        (c) =>
          c.u.toLowerCase().startsWith("шт") &&
          parseFloat(c.q) >= 1 &&
          parseFloat(c.q) <= 200 &&
          !c.q.includes(".")
      );
      if (sane) {
        quantity = sane.q;
        best = sane;
      }
    }
  }

  const corpusForModel = head.join("\n");
  const looksLikeCartridgeModel =
    /(?:^|\s)(?:CF|CE|TK|TN|CRG|W2|067)\s*[-]?\s*[A-Z0-9]+/i.test(corpusForModel) ||
    /\b(?:Canon|HP|Kyocera|Brother|Xerox)\s+/i.test(corpusForModel);
  if (looksLikeCartridgeModel && best.u.toLowerCase().startsWith("шт")) {
    const n = parseFloat(quantity);
    if (Number.isFinite(n) && n > 50 && !quantity.includes(".")) {
      const alt = candidates.find(
        (c) =>
          c.u.toLowerCase().startsWith("шт") &&
          parseFloat(c.q) >= 1 &&
          parseFloat(c.q) <= 50 &&
          !c.q.includes(".") &&
          best.score - c.score <= 6
      );
      if (alt) {
        quantity = alt.q;
        best = alt;
      }
    }
  }

  return { quantity, unit: best.u };
}

function extractQuantityFromBlock(block: string): { quantity: string; unit: string } | null {
  return pickSpecificationQuantityFromLines(block.split("\n"), { skipCharacteristicLines: true });
}

function extractUnitFromBlock(block: string): string {
  const u = block.match(/единиц\w+\s+измерен\w*\s*[:\s|]+([^\n|]{1,24})/i);
  if (u) return u[1]!.replace(/\s+/g, " ").trim().slice(0, 32);
  const u2 = block.match(/ед\.\s*изм\.?\s*[:\s\t|]+([^\n|]{1,32})/i);
  if (u2) return u2[1]!.replace(/\s+/g, " ").trim().slice(0, 32);
  return "";
}

/** Число из ячейки: 1,00 / 10.0 / «≥ 5» — базовое значение для quantityValue. */
export function parseDeterministicQuantityNumberFragment(raw: string): number | null {
  if (!raw?.trim()) return null;
  const cleaned = raw
    .replace(/\u00A0/g, " ")
    .replace(/^[≥≤>]+?\s*/i, "")
    .trim();
  const compact = cleaned.replace(/\s/g, "").replace(",", ".");
  const m = compact.match(/^(\d{1,6}(?:\.\d{1,4})?)/);
  if (!m) return null;
  const n = parseFloat(m[1]!);
  if (!Number.isFinite(n) || n < 0 || n > 999_999) return null;
  return n;
}

export function formatQuantityValueForStorage(n: number): string {
  if (!Number.isFinite(n)) return "";
  if (Math.abs(n - Math.round(n)) < 1e-9) return String(Math.round(n));
  const s = n.toFixed(4).replace(/\.?0+$/, "");
  return s;
}

const REGISTRY_POS_ID_RE = REGISTRY_POSITION_ID_INLINE_RE;

function splitTableLikeCells(line: string): string[] {
  const t = line.trimEnd();
  if (t.includes("\t")) return t.split("\t").map((c) => c.trim());
  if (/\|/.test(t) && t.split("|").length >= 3) return t.split("|").map((c) => c.trim());
  const parts = t.split(/\s{3,}/).map((c) => c.trim()).filter(Boolean);
  if (parts.length >= 3) return parts;
  return [t.trim()];
}

function cellLooksLikeKtruOkpdOrRegistry(s: string): boolean {
  const x = s.replace(/\s/g, "");
  return (
    /\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{5}/.test(s) ||
    /\d{2}\.\d{2}\.\d{2}\.\d{2}/.test(s) ||
    REGISTRY_POS_ID_RE.test(x)
  );
}

function isNumericQuantityCell(s: string): boolean {
  const compact = s.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d{1,6}(\.\d{1,4})?$/.test(compact)) return false;
  if (REGISTRY_POS_ID_RE.test(compact)) return false;
  const n = parseFloat(compact);
  return Number.isFinite(n) && n > 0 && n <= 999_999;
}

function isUnitTableCell(s: string): boolean {
  const low = s.trim().toLowerCase().replace(/\s+/g, " ");
  if (low.length < 2 || low.length > 40 || /^\d/.test(low)) return false;
  if (/^(шт\.?|штук[а-яё]{0,3})$/i.test(low)) return true;
  if (/^ед\.?\s*изм\.?$/i.test(low)) return true;
  if (/^(упак\.?|упаковк\w*|комплект\w*|компл\.?|пачк\w*|пач\.?|рул\.?|рулон\w*)$/i.test(low)) return true;
  if (/^(м²|м2|кг|г|л|м|м3)$/i.test(low)) return true;
  return false;
}

/**
 * Количество и ед. изм. из первых строк блока позиции (табличная строка позиции),
 * до разбора характеристик — чтобы не терять правые колонки «Штука / 7».
 */
function extractQuantityFromPositionRowFirst(
  blockLines: string[],
  maxLines = 6
): {
  quantityStr: string;
  unitStr: string;
  quantityValue: number | null;
  attachedAtRow: number;
  attachSource: string;
} | null {
  const n = Math.min(blockLines.length, maxLines);
  for (let row = 0; row < n; row++) {
    const raw = blockLines[row] ?? "";
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (lineLooksLikePackOnlyQtyInProse(trimmed)) continue;
    /**
     * Вертикальная вёрстка ЕИС в docx (архив «тендэксперемент 2»): «Штука», затем (через пустые строки) «5».
     */
    if (isUnitTableCell(trimmed)) {
      for (let j = row + 1; j < Math.min(row + 6, n); j++) {
        const next = (blockLines[j] ?? "").trim();
        if (!next) continue;
        if (isNumericQuantityCell(next) && !cellLooksLikeKtruOkpdOrRegistry(next)) {
          const q = parseDeterministicQuantityNumberFragment(next);
          const uStr = trimmed.replace(/\s+/g, " ").trim().slice(0, 40);
          if (q != null && q > 0) {
            if (isLiterCapacityUnitStr(uStr) && blockHeadTextSuggestsNominalLiterVolume(blockLines, q)) continue;
            return {
              quantityStr: formatQuantityValueForStorage(q),
              unitStr: uStr,
              quantityValue: q,
              attachedAtRow: j,
              attachSource: "position_row_unit_line_then_qty_line"
            };
          }
        }
      }
    }
    if (isNumericQuantityCell(trimmed) && !cellLooksLikeKtruOkpdOrRegistry(trimmed)) {
      for (let j = row - 1; j >= Math.max(0, row - 8); j--) {
        const prev = (blockLines[j] ?? "").trim();
        if (!prev) continue;
        if (isUnitTableCell(prev)) {
          const q = parseDeterministicQuantityNumberFragment(trimmed);
          const uStr = prev.replace(/\s+/g, " ").trim().slice(0, 40);
          if (q != null && q > 0) {
            if (isLiterCapacityUnitStr(uStr) && blockHeadTextSuggestsNominalLiterVolume(blockLines, q)) continue;
            return {
              quantityStr: formatQuantityValueForStorage(q),
              unitStr: uStr,
              quantityValue: q,
              attachedAtRow: row,
              attachSource: "position_row_qty_line_after_unit_line"
            };
          }
        }
      }
    }
    const glued = tryExtractGluedRussianUnitQuantity(trimmed);
    if (glued) {
      return {
        quantityStr: formatQuantityValueForStorage(glued.quantityValue),
        unitStr: glued.unitStr,
        quantityValue: glued.quantityValue,
        attachedAtRow: row,
        attachSource: "position_row_glued_unit_qty"
      };
    }
    if (lineLooksLikeCharacteristicRow(trimmed) && !trimmed.includes("\t") && !lineLooksLikeQtyLabelRow(trimmed)) {
      continue;
    }

    const inlineTab = trimmed.match(
      /(\d{1,6}(?:[.,]\d{1,4})?)\s*[\t|\u00A0]+\s*(шт\.?|штук[а-яё]*|ед\.?\s*изм\.?|упак\w*|комплект\w*|компл\.?|м²|м2|кг|л)(?=\s|$|[\t|;,])/i
    );
    if (inlineTab) {
      const q = parseDeterministicQuantityNumberFragment(inlineTab[1]!);
      const uStr = inlineTab[2]!.replace(/\s+/g, " ").trim().slice(0, 40);
      if (q != null && q > 0) {
        if (!(isLiterCapacityUnitStr(uStr) && blockHeadTextSuggestsNominalLiterVolume(blockLines, q))) {
          return {
            quantityStr: formatQuantityValueForStorage(q),
            unitStr: uStr,
            quantityValue: q,
            attachedAtRow: row,
            attachSource: "position_row_inline_tab"
          };
        }
      }
    }

    const tailWord = trimmed.match(
      /(\d{1,6}(?:[.,]\d{1,4})?)\s+(шт\.?|штук[а-яё]*|ед\.?\s*изм\.?)\s*$/i
    );
    if (tailWord && !cellLooksLikeKtruOkpdOrRegistry(trimmed)) {
      const q = parseDeterministicQuantityNumberFragment(tailWord[1]!);
      if (q != null && q > 0) {
        return {
          quantityStr: formatQuantityValueForStorage(q),
          unitStr: tailWord[2]!.replace(/\s+/g, " ").trim().slice(0, 40),
          quantityValue: q,
          attachedAtRow: row,
          attachSource: "position_row_tail_cell"
        };
      }
    }

    const cells = splitTableLikeCells(raw);
    if (cells.length >= 2) {
      for (let ci = cells.length - 1; ci >= 1; ci--) {
        const right = cells[ci]!;
        const left = cells[ci - 1]!;
        if (isUnitTableCell(right) && isNumericQuantityCell(left)) {
          const q = parseDeterministicQuantityNumberFragment(left);
          const uStr = right.replace(/\s+/g, " ").trim().slice(0, 40);
          if (q != null && q > 0) {
            if (isLiterCapacityUnitStr(uStr) && blockHeadTextSuggestsNominalLiterVolume(blockLines, q)) continue;
            return {
              quantityStr: formatQuantityValueForStorage(q),
              unitStr: uStr,
              quantityValue: q,
              attachedAtRow: row,
              attachSource: "position_row_adjacent_cells"
            };
          }
        }
      }
      const last = cells[cells.length - 1]!;
      const prev = cells[cells.length - 2]!;
      if (isNumericQuantityCell(last) && isUnitTableCell(prev)) {
        const q = parseDeterministicQuantityNumberFragment(last);
        const uStr = prev.replace(/\s+/g, " ").trim().slice(0, 40);
        if (
          q != null &&
          q > 0 &&
          !(isLiterCapacityUnitStr(uStr) && blockHeadTextSuggestsNominalLiterVolume(blockLines, q))
        ) {
          return {
            quantityStr: formatQuantityValueForStorage(q),
            unitStr: uStr,
            quantityValue: q,
            attachedAtRow: row,
            attachSource: "position_row_unit_then_qty"
          };
        }
      }
    }
  }
  return null;
}

/**
 * Подпись колонки закупки (без «Объём»): в вертикальных ТЗ «Объём» почти всегда объём тары/товара,
 * а не количество закупки — иначе «120 л» в наименовании сливается с полем.
 */
const QTY_COLUMN_LABEL_RE =
  /(?:количеств[а-яёА-ЯЁ]*(?:\s+в\s+единиц[а-яёА-ЯЁ]*(?:\s+измерен[а-яёА-ЯЁ]*)?)?|кол-?\s*во|quantity)\s*(?:,\s*штук\w*|,\s*шт\.?)?\s*[:\s\t|]+\s*(?:≥|<=|>=|≤|>)?\s*(\d{1,6}(?:[.,]\d{1,4})?)/gi;

/** Только закупка: не «Объём: 100 шт в упаковке» как quantity позиции. */
const QTY_PURCHASE_COLUMN_LABEL_RE =
  /(?:количеств[а-яёА-ЯЁ]*(?:\s+в\s+единиц[а-яёА-ЯЁ]*(?:\s+измерен[а-яёА-ЯЁ]*)?)?|кол-?\s*во|quantity)\s*(?:,\s*штук\w*|,\s*шт\.?)?\s*[:\s\t|]+\s*(?:≥|<=|>=|≤|>)?\s*(\d{1,6}(?:[.,]\d{1,4})?)/gi;

const UNIT_COLUMN_LABEL_RE =
  /(?:ед(?:иниц[а-яёА-ЯЁ]*)?\s+измерен[а-яёА-ЯЁ]*|ед\.\s*изм\.?|ед\.\s*измерен\w*)\s*[:\s\t|]+\s*([^\t\n|]{2,48})/i;

/**
 * Колонки «Количество» / «Объём» / Quantity и «Ед. изм.» в первых строках блока позиции.
 * Строки «имя: значение» характеристик не используются для числа quantity (ложные совпадения).
 */
function extractLabeledQuantityAndUnitFromBlockLines(
  lines: string[],
  maxLines = 40,
  qtyRe: RegExp = QTY_PURCHASE_COLUMN_LABEL_RE
): {
  quantityValue: number | null;
  quantityUnit: string;
  fromLabeledQty: boolean;
  quantityLabeledAtLine: number | null;
} {
  const head = lines.slice(0, Math.min(lines.length, maxLines));
  let quantityValue: number | null = null;
  let quantityLabeledAtLine: number | null = null;
  for (let i = 0; i < head.length; i++) {
    const line = head[i]!;
    const t = line.trim();
    if (lineLooksLikeQuantityLabelButMeansPackageFilling(t)) continue;
    if (lineLooksLikeCharacteristicRow(t) && !t.includes("\t") && !lineLooksLikeQtyLabelRow(t)) continue;
    const re = new RegExp(qtyRe.source, qtyRe.flags);
    const m = re.exec(line);
    if (!m?.[1]) continue;
    const n = parseDeterministicQuantityNumberFragment(m[1]!);
    if (n != null && n > 0) {
      quantityValue = n;
      quantityLabeledAtLine = i;
      break;
    }
  }
  let quantityUnit = "";
  for (const line of head) {
    const t = line.trim();
    if (lineLooksLikeCharacteristicRow(t) && !t.includes("\t") && !lineLooksLikeQtyLabelRow(t)) continue;
    const um = line.match(UNIT_COLUMN_LABEL_RE);
    if (um?.[1]) {
      const u = um[1]!.replace(/\s+/g, " ").trim();
      if (u.length >= 2 && u.length <= 48 && !/^\d+[.,]?\d*$/.test(u)) {
        quantityUnit = u.slice(0, 40);
        break;
      }
    }
  }
  return {
    quantityValue,
    quantityUnit,
    fromLabeledQty: quantityValue != null,
    quantityLabeledAtLine
  };
}

function resolveDeterministicGoodsQuantity(
  blockLines: string[],
  blockText: string,
  relaxWeakHeader: boolean,
  numberedHead: boolean,
  /** Вертикальная спецификация: явная строка «Количество:» важнее раннего «N шт» из описания/фасовки. */
  verticalBarePreferLabeledQty = false
): {
  quantityValue: number | null;
  quantityUnit: string;
  quantityStr: string;
  unitStr: string;
  quantityAttachedAtRow: number | null;
  quantityAttachSource: string;
} | null {
  if (verticalBarePreferLabeledQty) {
    const labeledFirst = extractLabeledQuantityAndUnitFromBlockLines(blockLines, 40, QTY_PURCHASE_COLUMN_LABEL_RE);
    if (labeledFirst.fromLabeledQty && labeledFirst.quantityValue != null && labeledFirst.quantityValue > 0) {
      const n = labeledFirst.quantityValue;
      const u =
        (labeledFirst.quantityUnit || "").trim() ||
        extractUnitFromBlock(blockText) ||
        "шт";
      return {
        quantityValue: n,
        quantityUnit: u,
        quantityStr: formatQuantityValueForStorage(n),
        unitStr: u,
        quantityAttachedAtRow: labeledFirst.quantityLabeledAtLine,
        quantityAttachSource: "labeled_column"
      };
    }
  }

  const posScan =
    verticalBarePreferLabeledQty ? Math.min(blockLines.length, 160) : Math.min(blockLines.length, 28);
  const posFirst = extractQuantityFromPositionRowFirst(blockLines, posScan);
  if (posFirst) {
    return {
      quantityValue: posFirst.quantityValue,
      quantityUnit: posFirst.unitStr,
      quantityStr: posFirst.quantityStr,
      unitStr: posFirst.unitStr,
      quantityAttachedAtRow: posFirst.attachedAtRow,
      quantityAttachSource: posFirst.attachSource
    };
  }

  const labeled = extractLabeledQuantityAndUnitFromBlockLines(blockLines, 40, QTY_PURCHASE_COLUMN_LABEL_RE);
  let qu = extractQuantityFromBlock(blockText);
  if (!qu && relaxWeakHeader && numberedHead) {
    const q2 = pickSpecificationQuantityFromLines(blockLines, {
      skipCharacteristicLines: false,
      maxHeadLines: 40
    });
    if (q2) qu = q2;
  }

  let quantityValue = labeled.quantityValue;
  let quantityAttachedAtRow: number | null = labeled.quantityLabeledAtLine;
  let quantityAttachSource = labeled.fromLabeledQty ? "labeled_column" : "";

  const unitStr =
    (labeled.quantityUnit || "").trim() ||
    (qu?.unit ?? "").trim() ||
    extractUnitFromBlock(blockText) ||
    "шт";

  if (quantityValue == null && qu) {
    const qn = parseDeterministicQuantityNumberFragment(qu.quantity);
    if (qn != null) {
      quantityValue = qn;
      if (!quantityAttachSource) quantityAttachSource = "block_head_pick";
    }
  }

  if (quantityValue == null && !qu) return null;

  const quantityStr =
    quantityValue != null
      ? formatQuantityValueForStorage(quantityValue)
      : (qu?.quantity ?? "").trim();

  if (!quantityStr) return null;

  if (!quantityAttachSource) quantityAttachSource = "block_head_pick";

  return {
    quantityValue,
    quantityUnit: unitStr,
    quantityStr,
    unitStr,
    quantityAttachedAtRow,
    quantityAttachSource
  };
}

/** Узкий peek ниже границы блока (ШАГ 3.1): мало строк, только надёжные qty-пути. */
const VERTICAL_BARE_PEEK_QTY_MAX_SCAN_LINES = 8;
/** Блоки длиннее — количество должно находиться обычным resolve внутри блока. */
const VERTICAL_BARE_PEEK_QTY_MAX_BLOCK_LINES = 16;

type VerticalBareQtyBelowBlockCtx = {
  segmentLines: string[];
  /** Индекс первой строки сегмента после текущего блока (как у `starts[bi + 1]`). */
  blockEndExclusive: number;
  allowGenericNumbered: boolean;
  verticalBareTable: boolean;
  /** Тело текущего блока (как в split); только гейт ШАГ 3.2, границы split не меняются. */
  blockLinesForBareDigitGate?: string[];
};

function verticalBareQtyBelowBlockCtxForSplitBlock(
  segmentLines: string[],
  starts: number[],
  blockIndex: number,
  allowGenericNumbered: boolean,
  verticalBareTable: boolean,
  blockLines?: string[]
): VerticalBareQtyBelowBlockCtx | undefined {
  if (!verticalBareTable || starts.length === 0 || blockIndex < 0 || blockIndex >= starts.length) return undefined;
  const blockEndExclusive = blockIndex + 1 < starts.length ? starts[blockIndex + 1]! : segmentLines.length;
  return {
    segmentLines,
    blockEndExclusive,
    allowGenericNumbered,
    verticalBareTable,
    blockLinesForBareDigitGate: blockLines
  };
}

function collectSegmentLinesForBelowBlockQtyPeek(ctx: VerticalBareQtyBelowBlockCtx): string[] {
  const { segmentLines, blockEndExclusive, allowGenericNumbered } = ctx;
  if (blockEndExclusive < 0 || blockEndExclusive >= segmentLines.length) return [];
  const out: string[] = [];
  let taken = 0;
  for (
    let i = blockEndExclusive;
    i < segmentLines.length && taken < VERTICAL_BARE_PEEK_QTY_MAX_SCAN_LINES;
    i++
  ) {
    const raw = segmentLines[i] ?? "";
    const L = raw.trim();
    if (L && lineStartsPosition(L, { allowGenericNumbered })) break;
    out.push(raw.trimEnd());
    taken++;
  }
  return out;
}

function segmentNextNonEmptyLineFrom(segmentLines: string[], fromInclusive: number, maxAhead: number): string | null {
  const cap = Math.min(segmentLines.length, fromInclusive + Math.max(1, maxAhead));
  for (let j = fromInclusive; j < cap; j++) {
    const t = (segmentLines[j] ?? "").trim();
    if (t) return t;
  }
  return null;
}

/** Между шапкой и голой цифрой qty в peek: нет типичных «имя: значение» / маркеров матрицы «Тип»/«х». */
function verticalBareBlockBodyAllowsBareDigitQtyBetweenHeadAndPeek(blockLines: string[] | undefined): boolean {
  if (!blockLines || blockLines.length <= 1) return true;
  for (const raw of blockLines.slice(1)) {
    const t = raw.trim();
    if (!t) continue;
    if (lineLooksLikeCharacteristicRow(t) && !lineLooksLikeQtyLabelRow(t)) return false;
    if (/^тип$/i.test(t)) return false;
    if (/^[xх]{1,4}$/i.test(t)) return false;
  }
  return true;
}

type ResolvedDeterministicGoodsQuantity = NonNullable<ReturnType<typeof resolveDeterministicGoodsQuantity>>;

/**
 * ШАГ 3.1 + 3.2: posFirst, labeled (узко), затем один сверхузкий bare digit при POSITION_START на следующей строке.
 */
function tryVerticalBareDeterministicQtyBelowPositionBlock(
  ctx: VerticalBareQtyBelowBlockCtx
): ResolvedDeterministicGoodsQuantity | null {
  const peek = collectSegmentLinesForBelowBlockQtyPeek(ctx);
  if (peek.length === 0) return null;

  const peekQtyWindow = peek.slice(0, Math.min(peek.length, VERTICAL_BARE_PEEK_QTY_MAX_SCAN_LINES));
  const posFirst = extractQuantityFromPositionRowFirst(
    peekQtyWindow,
    Math.min(peekQtyWindow.length, VERTICAL_BARE_PEEK_QTY_MAX_SCAN_LINES)
  );
  if (posFirst) {
    return {
      quantityValue: posFirst.quantityValue,
      quantityUnit: posFirst.unitStr,
      quantityStr: posFirst.quantityStr,
      unitStr: posFirst.unitStr,
      quantityAttachedAtRow: null,
      quantityAttachSource: `${posFirst.attachSource}_below_block_peek`
    };
  }

  const labeled = extractLabeledQuantityAndUnitFromBlockLines(
    peekQtyWindow,
    Math.min(peekQtyWindow.length, 8),
    QTY_PURCHASE_COLUMN_LABEL_RE
  );
  const uLabeled = (labeled.quantityUnit || "").trim();
  if (labeled.fromLabeledQty && labeled.quantityValue != null && labeled.quantityValue > 0 && uLabeled.length >= 2) {
    const n = labeled.quantityValue;
    return {
      quantityValue: n,
      quantityUnit: uLabeled,
      quantityStr: formatQuantityValueForStorage(n),
      unitStr: uLabeled,
      quantityAttachedAtRow: null,
      quantityAttachSource: "labeled_column_below_block_peek"
    };
  }

  /**
   * ШАГ 3.2: одна голая цифра закупки сразу под блоком, далее — явная следующая позиция по POSITION_START_RE;
   * тело блока без «характеристик»/матрицы; unit только «шт». Без MODEL, без glued/whole-line.
   */
  if (
    ctx.blockLinesForBareDigitGate &&
    ctx.blockLinesForBareDigitGate.length <= 10 &&
    verticalBareBlockBodyAllowsBareDigitQtyBetweenHeadAndPeek(ctx.blockLinesForBareDigitGate)
  ) {
    let firstSegIdx = -1;
    let firstLine = "";
    for (let i = 0; i < peekQtyWindow.length; i++) {
      const t = (peekQtyWindow[i] ?? "").trim();
      if (!t) continue;
      firstSegIdx = ctx.blockEndExclusive + i;
      firstLine = t;
      break;
    }
    if (
      firstSegIdx >= 0 &&
      firstSegIdx - ctx.blockEndExclusive <= 2 &&
      /^\d{1,4}$/.test(firstLine) &&
      isNumericQuantityCell(firstLine) &&
      !cellLooksLikeKtruOkpdOrRegistry(firstLine)
    ) {
      const n = parseDeterministicQuantityNumberFragment(firstLine);
      if (n != null && n >= 1 && n <= 500) {
        const next = segmentNextNonEmptyLineFrom(ctx.segmentLines, firstSegIdx + 1, 10);
        if (next && POSITION_START_RE.test(next)) {
          return {
            quantityValue: n,
            quantityUnit: "шт",
            quantityStr: formatQuantityValueForStorage(n),
            unitStr: "шт",
            quantityAttachedAtRow: null,
            quantityAttachSource: "bare_digit_then_position_start_below_block_peek_3_2"
          };
        }
      }
    }
  }

  return null;
}

export type GoodsTechSpecParseAudit = {
  techSpecTableDetected: boolean;
  techSpecClusterCount: number;
  techSpecExtractedCount: number;
  techSpecRowsParsed: string[];
  techSpecRowsRejected: string[];
  rejectionReasons: string[];
  finalRetainedFromTechSpecCount: number;
  /** Диагностика извлечения из primary/preferred слоя маршрутизированного корпуса. */
  prioritySliceDiagnostics?: {
    usedRoutedPrioritySlice: boolean;
    logicalPathsInPriorityCorpus: string[];
    logicalPathsWithExtractedItems: string[];
    goodsExtractedCount: number;
    charRowsAtTechSpecParse: number;
    notePostParse: string;
    positionSamples: Array<{
      positionId: string;
      namePreview: string;
      characteristicsCount: number;
      logicalPath: string;
      quantityValue: number | null;
      quantityUnit: string;
      /** Индекс строки внутри блока позиции, где сработало извлечение quantity (0 = первая строка). */
      quantityAttachedAtRow: number | null;
      quantityAttachSource: string;
    }>;
  };
};

export type ExtractGoodsFromTechSpecResult = {
  items: TenderAiGoodItem[];
  techBlockText: string;
  techSpecExtractedCount: number;
  diagnostics: string[];
  parseAudit: GoodsTechSpecParseAudit;
  /** Текст только из файлов, классифицированных как ТЗ (для аудита). */
  strictTechCorpusChars: number;
  /**
   * По индексу с `items`: `quantityAttachSource` после parse (до reconcile).
   * Длина совпадает с `items` после matrix post-filter; для диагностики/регресса.
   */
  techSpecQuantityAttachSources?: string[];
};

/** Строка похожа на однострочную табличную запись ТЗ (для stabilize / регион). */
export function lineLooksLikeTechSpecGoodsRow(line: string): boolean {
  const t = line.trim();
  if (t.length < 12) return false;
  if (lineHasRub(t)) return false;
  if (POSITION_START_RE.test(t) || MODEL_FIRST_LINE_RE.test(t)) return true;
  if (/(?:\d+(?:[.,]\d+)?\s*(?:шт|ед\.?\s*изм|упак|компл|комплект))/i.test(t)) return true;
  /** Вертикальный OOZ: классификационный код часто на отдельной строке (название/qty/unit вокруг). */
  if (/^\s*\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{3,12}(?!\d)\s*$/i.test(t)) return true;
  if (/^\s*\d{2}\.\d{2}\.\d{2}\.\d{2,3}(?:\.\d{3})?(?!\d)\s*$/i.test(t)) return true;
  if (
    /\d{2}\.\d{2}\.\d{2}/.test(t) &&
    /\d+(?:[.,]\d+)?/.test(t) &&
    /(?:наименован|модел|картридж|тонер|состав|характеристик|объект|кол-?\s*во|ед\.?\s*изм)/i.test(t)
  ) {
    return true;
  }
  return false;
}

/** Кластеризация индексов строк таблицы: соседние строки с разрывом не больше gap. */
function clusterLineIndices(indices: number[], gap = 18): number[][] {
  if (indices.length === 0) return [];
  const sorted = [...indices].sort((a, b) => a - b);
  const groups: number[][] = [];
  let cur = [sorted[0]!];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const x = sorted[i]!;
    if (x - prev <= gap) cur.push(x);
    else {
      groups.push(cur);
      cur = [x];
    }
  }
  groups.push(cur);
  return groups;
}

function lineStartsPosition(L: string, opts?: { allowGenericNumbered?: boolean }): boolean {
  if (POSITION_START_RE.test(L)) return true;
  if (MODEL_FIRST_LINE_RE.test(L)) return true;
  if (opts?.allowGenericNumbered) {
    const t = L.trim();
    if (!t || TABLE_HEADER_RE.test(t)) return false;
    /** После «1.» / «2)» нужен пробел, иначе строки вида «20.41.32.119» ошибочно считаются п/п. */
    if (!/^(?:\d{1,4}\s*[.)]\s+)\S/.test(t)) return false;
    return /(?:картридж|тонер|КТРУ|ОКПД|наименован|модел|издели|товар|устройств|оборудов|материал|средств|ламп|батар|кабел|детал|комплект|позици)/i.test(
      t
    );
  }
  return false;
}

type TechPositionSplitOpts = {
  allowGenericNumbered?: boolean;
  /** Маркер сегмента `--- path ---` для узких эвристик (вертикальная спецификация ЕИС). */
  logicalPath?: string;
};

/**
 * Экспорт docx «СПЕЦИФИКАЦИЯ»: колонки идут столбиком (№ п/п, строка «1», ниже наименование, «Шт.», число).
 * Такие позиции не имеют «1. » в одной строке и часто без КТРУ/ОКПД в тексте.
 */
function segmentLooksLikeVerticalEisSpecification(logicalPath: string, lines: string[]): boolean {
  if (/спецификац/i.test(logicalPath)) return true;
  /** Таблица часто после десятков страниц вводного текста; «Кол-во» не содержит подстроки «количеств». */
  const joined = lines.join("\n");
  const probe = joined.slice(0, Math.min(joined.length, 120_000));
  if (!/наименование\s+товара/im.test(probe)) return false;
  if (!/(?:количеств|кол-?\s*во)/im.test(probe)) return false;
  return /^\s*№\s*п\s*[\\/]?\s*п\s*$/im.test(probe);
}

/**
 * Имя файла может быть «документация»/прочее, но тело — вертикальная спецификация ЕИС;
 * тогда включаем allowGenericNumbered + verticalBare, иначе bare-«1»/«2» не станут стартами позиций.
 */
function splitOptsForTechSpecSegment(
  logicalPath: string,
  segLines: string[]
): { allowGenericNumbered: boolean; verticalBareTable: boolean } {
  const pathAllows = segmentAllowsGenericNumberedPositions(logicalPath);
  const verticalShape = segmentLooksLikeVerticalEisSpecification(logicalPath, segLines);
  const allowGenericNumbered = pathAllows || verticalShape;
  return {
    allowGenericNumbered,
    verticalBareTable: allowGenericNumbered && verticalShape
  };
}

/** Скоринг строки распарсенной позиции: при дублях bare «N» оставляем строку с кодом и полным наименованием. */
function verticalBareOrdinalRowQualityScore(it: TenderAiGoodItem): number {
  let s = 0;
  const codes = (it.codes ?? "").trim();
  if (codes) s += 10_000;
  if (extractKtruOrOkpd(it.name ?? "")) s += 2000;
  s += Math.min(4000, (it.name ?? "").length);
  s += (it.characteristics?.length ?? 0) * 4;
  return s;
}

/** Контекст узкого post-pass КТРУ-суффикса: только строки блока + до 2 строк ниже в том же tech-сегменте. */
type TechSpecKtruAdjacentSegmentCtx = {
  blockLines: string[];
  segLines: string[];
  /** -1 если начало блока в сегменте не найдено — смотрим только blockLines. */
  blockStartInSegment: number;
};

type VerticalBareDedupeRow = {
  item: TenderAiGoodItem;
  quantityDiag: { attachedAtRow: number | null; attachSource: string };
  head: string;
  ktruAdjacentSegmentCtx?: TechSpecKtruAdjacentSegmentCtx;
};

/**
 * Два parsed-row с одним bare № п/п — дубль шума (краткий блок + полный), а не две разные позиции с ошибочным номером.
 */
function verticalBareSamePidLooksLikeDuplicateNoise(a: TenderAiGoodItem, b: TenderAiGoodItem): boolean {
  const na = normalizeNameKey(a.name);
  const nb = normalizeNameKey(b.name);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const minL = Math.min(na.length, nb.length);
  if (minL < 10) return false;
  const prefixLen = Math.min(28, minL);
  const pa = na.slice(0, prefixLen);
  const pb = nb.slice(0, prefixLen);
  if (na.includes(pb) || nb.includes(pa)) return true;
  const ca = (a.codes ?? "").trim();
  const cb = (b.codes ?? "").trim();
  if (ca && !cb && nb.includes(pa)) return true;
  if (cb && !ca && na.includes(pb)) return true;
  return false;
}

/** Один номер п/п — несколько подблоков только с «шумовым» дублированием (Тенд11); разные наименования не схлопываем. */
function dedupeVerticalBareOrdinalParsedRows(rows: VerticalBareDedupeRow[]): VerticalBareDedupeRow[] {
  if (rows.length <= 1) return rows;
  type G = { rows: VerticalBareDedupeRow[]; minI: number };
  const groups = new Map<string, G>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const pid = (r.item.positionId ?? "").trim();
    const key = /^\d{1,3}$/.test(pid) ? `ord:${pid}` : `row:${i}`;
    const cur = groups.get(key);
    if (!cur) groups.set(key, { rows: [r], minI: i });
    else {
      cur.rows.push(r);
      cur.minI = Math.min(cur.minI, i);
    }
  }
  const picks: Array<{ minI: number; row: VerticalBareDedupeRow }> = [];
  for (const { rows: g, minI } of groups.values()) {
    if (g.length === 1) {
      picks.push({ minI, row: g[0]! });
      continue;
    }
    const sorted = [...g].sort(
      (a, b) => verticalBareOrdinalRowQualityScore(b.item) - verticalBareOrdinalRowQualityScore(a.item)
    );
    const kept: VerticalBareDedupeRow[] = [];
    for (const cand of sorted) {
      if (kept.some((k) => verticalBareSamePidLooksLikeDuplicateNoise(k.item, cand.item))) continue;
      kept.push(cand);
    }
    for (const row of kept) {
      const origI = rows.indexOf(row);
      picks.push({ minI: origI >= 0 ? origI : minI, row });
    }
  }
  picks.sort((a, b) => a.minI - b.minI);
  return picks.map((p) => p.row);
}

/**
 * После заголовка «Количество» в вертикальной спецификации часто идёт мусорная колонка 1,2,3,4,5;
 * первая реальная строка позиции — следующий «1». Ищем её индекс (без привязки к конкретной пятёрке).
 */
function indexFirstVerticalSpecDataRowAfterGhostOrdinalRun(lines: string[]): number {
  const kolIdx = lines.findIndex((l) => /^(?:количеств|кол-?\s*во)\b/i.test(l.trim()));
  if (kolIdx < 0) return -1;
  let j = kolIdx + 1;
  while (j < lines.length && !lines[j]!.trim()) j++;
  let expected = 1;
  while (j < lines.length) {
    const t = lines[j]!.trim();
    if (!t) {
      j++;
      continue;
    }
    const m = t.match(/^(\d{1,3})$/);
    if (!m) return j;
    const n = parseInt(m[1]!, 10);
    if (n === expected) {
      expected++;
      j++;
      continue;
    }
    return j;
  }
  return lines.length;
}

/** Строка только «Шт.» / «Упак.» / «ед. изм.» — колонка единицы; следующая «15» — количество, не новый № п/п. */
function verticalSpecUnitOnlyQuantityColumnLine(t: string): boolean {
  const s = t.trim();
  return /^(?:штука|штуки?|шт\.?|единица(?:\s+измерен)?|ед\.?\s*изм\.?|упак(?:овк\w*)?\.?|пач(?:к\w*)?\.?)$/i.test(
    s
  );
}

/** Строка «1» / «12» — начало строки спецификации, если сразу ниже идёт текст наименования, а не следующий номер. */
function verticalSpecBareOrdinalStartsPosition(lines: string[], idx: number): boolean {
  const L = (lines[idx] ?? "").trim();
  if (!L || lineHasRub(L) || TABLE_HEADER_RE.test(L)) return false;
  if (!/^\d{1,3}$/.test(L)) return false;
  const n = parseInt(L, 10);
  if (n < 1 || n > 999) return false;
  const dataStart = indexFirstVerticalSpecDataRowAfterGhostOrdinalRun(lines);
  if (dataStart >= 0 && idx < dataStart) return false;
  /** Количество под «Шт.»/«Упак.»; не путать с голым номером позиции. */
  for (let k = idx - 1; k >= Math.max(0, idx - 12); k--) {
    const p = (lines[k] ?? "").trim();
    if (!p) continue;
    if (verticalSpecUnitOnlyQuantityColumnLine(p)) return false;
    break;
  }
  for (let j = idx + 1; j < Math.min(idx + 14, lines.length); j++) {
    const t = (lines[j] ?? "").trim();
    if (!t) continue;
    /** Маркеры склейки корпуса / markdown — не наименование позиции. */
    if (/^#{1,6}\s+/.test(t) || /^---\s/.test(t)) continue;
    if (/^\d{1,3}$/.test(t)) return false;
    if (/^(?:назначение|состав|объем|объём|срок|условия|способ|меры|требован)\s*:/i.test(t)) continue;
    /** Пункты договора/документации («2. Обязательные…», «2.1. Прием…») — не позиция спецификации. */
    if (/^\d{1,3}\.(?:\d{1,3}\.)?\s*[А-ЯЁа-яё]/.test(t)) return false;
    /** Анкета участника / реквизиты — часто те же bare-ординалы 1…15, что и в таблице позиций. */
    if (
      /участник\w*\s+закупки|наименование\s+участника|фирменное\s+наименование|место\s+нахождения|идентификационный\s+номер|номер\s+контактного\s+телефона|электронн\w*\s+адрес|паспортные\s+данные/i.test(
        t
      )
    )
      continue;
    if (/^(?:ОГРН|ОКПО|ОКОПФ|ОКТМО|КПП|БИК)\b/i.test(t)) continue;
    if (t.length >= 4 && /[А-Яа-яЁё]{2,}/.test(t)) return true;
  }
  return false;
}

function verticalSpecBareOrdinalBlockTitle(blockLines: string[]): string {
  return verticalSpecBareOrdinalTitleRawLines(blockLines)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 520);
}

function lineLooksLikeNumberedTzCandidateHead(line: string): boolean {
  const t = line.trim();
  if (!t || TABLE_HEADER_RE.test(t) || lineHasRub(t)) return false;
  if (!/^(?:\d{1,4}\s*[.)]\s+)\S/.test(t)) return false;
  const namePart = t.replace(/^\d{1,4}\s*[.)]\s+/, "").trim();
  return namePart.length >= 8;
}

function findNextTzPositionBoundaryLineIndex(
  lines: string[],
  from: number,
  splitOpts: TechPositionSplitOpts & { verticalBareTable?: boolean }
): number {
  for (let j = from; j < lines.length; j++) {
    const L = lines[j]!.trim();
    if (!L || lineHasRub(L)) continue;
    if (lineStartsPosition(L, splitOpts)) return j;
    if (splitOpts.verticalBareTable && verticalSpecBareOrdinalStartsPosition(lines, j)) return j;
    if (TABLE_HEADER_RE.test(L)) continue;
    if (lineLooksLikeNumberedTzCandidateHead(L)) return j;
  }
  return lines.length;
}

const NUMBERED_HEAD_KTRU_OKPD_MAX_SCAN_LINES = 60;

/**
 * Нумерованная строка «N. …» без ключевых слов в заголовке, но с КТРУ/ОКПД до следующей шапки позиции
 * (или в пределах лимита строк).
 */
function numberedListLineStartsPositionViaNearbyKtruOkpd(
  lines: string[],
  idx: number,
  splitOpts?: TechPositionSplitOpts & { verticalBareTable?: boolean }
): boolean {
  const L = lines[idx]!.trim();
  if (!L || TABLE_HEADER_RE.test(L) || lineHasRub(L)) return false;
  if (!/^(?:\d{1,4}\s*[.)]\s+)\S/.test(L)) return false;
  const namePart = L.replace(/^\d{1,4}\s*[.)]\s+/, "").trim();
  if (namePart.length < 10) return false;
  const nextBoundary = findNextTzPositionBoundaryLineIndex(lines, idx + 1, splitOpts ?? {});
  const endExclusive = Math.min(nextBoundary, idx + 1 + NUMBERED_HEAD_KTRU_OKPD_MAX_SCAN_LINES);
  let window = "";
  for (let j = idx; j < endExclusive; j++) window += `${lines[j] ?? ""}\n`;
  return !!extractKtruOrOkpd(window);
}

/**
 * Старт блока позиции для «прозаических» ТЗ (топливо и т.п.) без POSITION_START и без «N.» в начале строки.
 * Не трогает POSITION_START_RE; срабатывает только при allowGenericNumbered.
 */
function proseTechGoodsLineStartsPosition(line: string, logicalPath: string): boolean {
  const L = line.trim();
  if (!L || lineHasRub(L) || TABLE_HEADER_RE.test(L)) return false;
  if (POSITION_START_RE.test(L) || MODEL_FIRST_LINE_RE.test(L)) return false;
  if (/^(?:\d{1,4}\s*[.)]\s+)\S/.test(L)) return false;
  if (L.length < 18 || L.length > 560) return false;
  if (/^Подраздел\s+\d/i.test(L)) return false;
  if (/^Маркировка\b/i.test(L)) return false;
  if (/\[Код\s+позиции\s+КТРУ/i.test(L)) return !!extractKtruOrOkpd(L);
  const pathOrLine = `${logicalPath}\n${L}`;
  if (
    /(?:топлив|бензин|дизель|певек)/i.test(pathOrLine) &&
    /(?:ГОСТ|СТО\s*\d|или\s+аналог)/i.test(L) &&
    /(?:АИ-\d|ДТ-|дизельн|неэтилирован|Топливо\s+дизель|Бензин\s+)/i.test(L)
  ) {
    return true;
  }
  return false;
}

/**
 * Дополнительный старт блока в tech-сегменте: повторяющиеся «карточки» кода позиции (КТРУ/ОКПД),
 * в т.ч. когда номер КТРУ перенесён на следующую строку после «[Код позиции КТРУ …».
 * Не расширяет POSITION_START_RE; опирается на extractKtruOrOkpd.
 */
function techSegmentKtruOkpdPositionCodeLineStartsSplit(
  lines: string[],
  idx: number,
  logicalPath: string
): boolean {
  const lp = (logicalPath ?? "").replace(/\s+/g, " ").trim();
  if (!lp) return false;
  const cat = classifyDocumentByLogicalPath(lp);
  if (cat !== "technical_spec" && cat !== "technical_part") return false;

  const L = lines[idx]!.trim();
  if (!L || lineHasRub(L) || TABLE_HEADER_RE.test(L)) return false;
  if (POSITION_START_RE.test(L) || MODEL_FIRST_LINE_RE.test(L)) return false;
  if (/^Подраздел\s+\d/i.test(L)) return false;
  if (/^Маркировка\b/i.test(L)) return false;
  if (/^ОПИСАНИЕ\s+ОБЪЕКТА\s+ЗАКУПКИ/i.test(L)) return false;

  const openBracketKtru = /\[Код\s+позиции\s+КТРУ/i.test(L);
  const openParenKtru = /[(（]Код\s+позиции\s+КТРУ/i.test(L);
  const hasBracketKtru = openBracketKtru || openParenKtru;
  const openBracketOkpd = /\[Код\s+позиции\s+ОКПД/i.test(L) || /[(（]Код\s+позиции\s+ОКПД/i.test(L);
  const hasBracketOkpd = openBracketOkpd;
  const shortUnbracketedKtru =
    L.length <= 120 &&
    /^[\[\s(]*Код\s+позиции\s+КТРУ/i.test(L) &&
    !/\[Код\s+позиции\s+ОКПД/i.test(L) &&
    !/[(（]Код\s+позиции\s+ОКПД/i.test(L) &&
    !/ОКВЭД/i.test(L);

  if (!hasBracketKtru && !hasBracketOkpd && !shortUnbracketedKtru) return false;

  if (extractKtruOrOkpd(L)) {
    if (L.length > 180) return false;
    if (/ОКВЭД/i.test(L)) return false;
    return true;
  }

  if (!openBracketKtru && !openParenKtru && !openBracketOkpd) return false;
  for (let j = idx + 1; j < lines.length; j++) {
    const t = lines[j]!.trim();
    if (!t) continue;
    return !!extractKtruOrOkpd(`${L}\n${t}`);
  }
  return false;
}

/**
 * DOCX/EИС вертикальная вёрстка: «№ п/п» в отдельной ячейке, наименование — в следующей строке/блоке,
 * между ними только пустые строки. Тогда split даёт блок ["2",""], а карточка уходит в следующий chunk —
 * verticalSpecBareOrdinalTitleRawLines не видит заголовка → short_name / silent drop.
 * Склеиваем только «одна строка — bare ordinal» + следующий блок, если его первая непустая строка явно
 * начинает товарную карточку (те же якоря, что и parse strongHeader).
 */
function firstNonEmptyTrimmedLineInBlock(blockLines: string[]): string {
  for (const raw of blockLines) {
    const t = raw.trim();
    if (t) return t;
  }
  return "";
}

function isBareOrdinalOnlyVerticalBarePreludeBlock(blockLines: string[]): boolean {
  const nonempty = blockLines.map((l) => l.trim()).filter(Boolean);
  return nonempty.length === 1 && /^\d{1,3}$/.test(nonempty[0]!);
}

function verticalBareDetachedProductHeadLooksAnchored(head: string): boolean {
  const t = head.trim();
  if (t.length < 12) return false;
  if (POSITION_START_RE.test(t)) return true;
  /**
   * Короткие «HP CF257A» / «Canon …» без типа товара — часто вторая строка той же карточки (Тенд32);
   * склеивание с чужим п/п дало бы сшивку не того ordinal → обруб характеристик.
   * Длинная model-first строка — отдельная карточка (Тенд35: принтер целиком в строке).
   */
  if (MODEL_FIRST_LINE_RE.test(t) && t.length >= 22) return true;
  return false;
}

/**
 * Полная карточка «барабан + бренд» уже в первой строке; отдельная строка п/п только шум разметки (Тенд32).
 * «Тонер-картридж HP …» не трогаем — там склейка с п/п часто нужна для вертикальной таблицы.
 */
function verticalBareProductTitleLineAlreadySelfAnchored(nextHead: string): boolean {
  const t = nextHead.replace(/\s+/g, " ").trim();
  if (t.length < 14) return false;
  if (!/(?:барабан|фотобарабан)/i.test(t)) return false;
  return /\b(?:HP|Hewlett|Canon|Brother|Kyocera|Lexmark|Samsung|OKI|Xerox|Ricoh|Sharp|Konica|Epson)\b/i.test(t);
}

function mergeVerticalBareOrdinalPreludeBlocksWithFollowingCards(
  blocks: string[][],
  starts: number[]
): { blocks: string[][]; starts: number[] } {
  if (blocks.length !== starts.length || blocks.length < 2) return { blocks, starts };
  const outBlocks: string[][] = [];
  const outStarts: number[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const cur = blocks[i]!;
    const next = blocks[i + 1];
    const st = starts[i]!;
    const nextHead = next ? firstNonEmptyTrimmedLineInBlock(next) : "";
    if (
      next &&
      isBareOrdinalOnlyVerticalBarePreludeBlock(cur) &&
      verticalBareDetachedProductHeadLooksAnchored(nextHead) &&
      !verticalBareProductTitleLineAlreadySelfAnchored(nextHead)
    ) {
      const ord = firstNonEmptyTrimmedLineInBlock(cur);
      outBlocks.push([ord, ...next]);
      outStarts.push(st);
      i++;
      continue;
    }
    outBlocks.push(cur);
    outStarts.push(st);
  }
  return { blocks: outBlocks, starts: outStarts };
}

function splitTechTextIntoPositionBlocks(
  lines: string[],
  opts?: TechPositionSplitOpts
): { blocks: string[][]; starts: number[] } {
  const verticalBare =
    !!opts?.allowGenericNumbered &&
    !!opts.logicalPath &&
    segmentLooksLikeVerticalEisSpecification(opts.logicalPath, lines);
  const splitBase: TechPositionSplitOpts & { verticalBareTable?: boolean } = {
    ...opts,
    verticalBareTable: verticalBare
  };
  const blockStarts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i]!.trim();
    if (!L || lineHasRub(L)) continue;
    if (lineStartsPosition(L, opts)) {
      blockStarts.push(i);
      continue;
    }
    if (verticalBare && verticalSpecBareOrdinalStartsPosition(lines, i)) {
      blockStarts.push(i);
      continue;
    }
    if (
      opts?.allowGenericNumbered &&
      proseTechGoodsLineStartsPosition(L, opts.logicalPath ?? "")
    ) {
      blockStarts.push(i);
      continue;
    }
    if (techSegmentKtruOkpdPositionCodeLineStartsSplit(lines, i, opts?.logicalPath ?? "")) {
      blockStarts.push(i);
      continue;
    }
    if (opts?.allowGenericNumbered && numberedListLineStartsPositionViaNearbyKtruOkpd(lines, i, splitBase)) {
      blockStarts.push(i);
    }
  }
  if (blockStarts.length === 0) return { blocks: [], starts: [] };

  const blocks: string[][] = [];
  for (let b = 0; b < blockStarts.length; b++) {
    const from = blockStarts[b]!;
    const to = b + 1 < blockStarts.length ? blockStarts[b + 1]! - 1 : lines.length - 1;
    const chunk = lines.slice(from, to + 1).map((l) => l.trimEnd());
    blocks.push(chunk);
  }
  if (verticalBare) {
    return mergeVerticalBareOrdinalPreludeBlocksWithFollowingCards(blocks, blockStarts);
  }
  return { blocks, starts: blockStarts };
}

function mergeCharacteristics(rows: TenderAiCharacteristicRow[]): TenderAiCharacteristicRow[] {
  const m = new Map<string, TenderAiCharacteristicRow>();
  for (const r of rows) {
    const k = r.name.toLowerCase().replace(/\s+/g, " ");
    const prev = m.get(k);
    if (!prev || r.value.length > prev.value.length) m.set(k, r);
  }
  return Array.from(m.values()).map((r) => {
    const k = r.name.toLowerCase().replace(/\s+/g, " ").trim();
    if (k !== "описание товара") return r;
    return {
      ...r,
      value: stripCorpusRoutingMarkerFromTechSpecValue(
        truncateAppendedLegalBoilerplateFromDescriptionValue(r.name, r.value)
      )
    };
  });
}

function normCharacteristicMergeKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * В vertical bare ordinal одна и та же графа часто приходит и из строгого графа, и из relaxed;
 * mergeCharacteristics оставляет более длинное значение — у «Описание товара» это часто дубль
 * префикса наименования, у «Объём» — хвост абзаца на той же строке, у «Комплектация» — склейка
 * нескольких извлечённых фрагментов. Здесь выбираем значение по смыслу поля, без потери текста
 * в других графах.
 */
function mergeCharacteristicsVerticalBareOrdinal(
  rows: TenderAiCharacteristicRow[],
  cardName: string
): TenderAiCharacteristicRow[] {
  const groups = new Map<string, TenderAiCharacteristicRow[]>();
  for (const r of rows) {
    const k = normCharacteristicMergeKey(r.name);
    const g = groups.get(k) ?? [];
    g.push(r);
    groups.set(k, g);
  }
  return [...groups.entries()].map(([k, g]) => pickVerticalBareMergedCharacteristic(k, g, cardName));
}

function dedupePackagingExtracts(packs: string[]): string[] {
  const cleaned = [...new Set(packs.map((p) => p.replace(/\s+/g, " ").trim()))].filter(Boolean);
  cleaned.sort((a, b) => a.length - b.length);
  const out: string[] = [];
  for (const p of cleaned) {
    const pl = p.toLowerCase();
    if (out.some((x) => x.length > p.length + 20 && x.toLowerCase().includes(pl))) continue;
    for (let i = out.length - 1; i >= 0; i--) {
      const xl = out[i]!.toLowerCase();
      if (p.length > out[i]!.length + 20 && pl.includes(xl)) out.splice(i, 1);
    }
    out.push(p);
  }
  return out;
}

function verticalBareDescriptionNoiseScore(value: string, cardName: string): number {
  const v = value.replace(/\s+/g, " ").trim();
  if (!v) return 1e6;
  let score = 0;
  if (/###|---{3,}|\(?файл\s*\d/i.test(v)) score += 120;
  if (/федеральн\w*\s+закон|постановлени\w*\s+правительств/i.test(v)) score += 60;
  const cn = cardName.replace(/\s+/g, " ").trim().toLowerCase();
  const vl = v.toLowerCase();
  if (cn.length >= 10 && vl.startsWith(cn.slice(0, Math.min(48, cn.length)))) score += 45;
  const head = vl.slice(0, 24);
  if (head.length >= 14 && vl.split(head).length - 1 >= 2) score += 38;
  score += Math.min(v.length / 150, 38);
  return score;
}

/** «Название … Название …» и похожие повторы первых символов абзаца — не брать такое описание, если есть строка без повтора. */
function descriptionDuplicatePatternPenalty(value: string): number {
  const v = value.replace(/\s+/g, " ").trim().toLowerCase();
  if (v.length < 36) return 0;
  const head = v.slice(0, 26);
  if (head.length < 16) return 0;
  const parts = v.split(head);
  return parts.length >= 3 ? (parts.length - 1) * 40 : 0;
}

function refineVerticalBareVolumeValue(value: string): string {
  let t = trimVolumeLiterValueBleedIntoNextGoodsClause(value).replace(/\s+/g, " ").trim();
  const mНе = t.match(
    /^([\s\S]{0,400}?\d+(?:[.,]\d+)?\s*(?:литров?|л\.|мл|миллилитр\w*|кг|килограм\w*|г\.|шт\.?))\s*\.\s+Не\s/ui
  );
  if (mНе?.[1]) {
    const h = mНе[1].replace(/\s+/g, " ").trim();
    return h.endsWith(".") ? h : `${h}.`;
  }
  const m2 = t.match(
    /^(.{1,400}?\d+(?:[.,]\d+)?\s*(?:литров?|л\.?\b|мл))\s*\.\s+([А-ЯЁA-Z][а-яёa-z]{25,})/u
  );
  if (m2?.[1] && m2[2] && /[а-яё]{12,}/i.test(m2[2])) return `${m2[1].trim()}.`;
  return t;
}

function refineVerticalBarePackagingFieldValue(value: string): string {
  const t = value.replace(/\s+/g, " ").trim();
  const spill = t.search(/\.\s+(?:Не\s+[а-яё]{4,}|Состав\s*:|Средство\s+для\s+[а-яё]{4,})/i);
  if (spill >= 20 && spill < t.length - 12) return t.slice(0, spill + 1).trim();
  return t;
}

function refineVerticalBareКомплектацияValue(value: string): string {
  let t = value.replace(/\s+/g, " ").trim();
  const spill = t.search(/\.\s+(?:Не\s+[а-яё]{4,}|Средство\s+для\s+[а-яё]{4,})/i);
  if (spill >= 30 && spill < t.length - 20) t = t.slice(0, spill + 1).trim();
  const proseAfterPack = t.search(/\.\s+["«]/u);
  if (proseAfterPack >= 35 && proseAfterPack < t.length - 25) t = t.slice(0, proseAfterPack + 1).trim();
  if (t.length > 220) {
    const slice = t.slice(0, 210);
    const lastDot = slice.lastIndexOf(".");
    if (lastDot >= 50) t = t.slice(0, lastDot + 1).trim();
  }
  if (t.length > 280 && /\d+(?:[.,]\d+)?\s*(?:шт\.?|штук\w*)/i.test(t) && /[а-яё]{180,}/i.test(t)) {
    const m = t.match(/^(.{1,240}?\d+(?:[.,]\d+)?\s*(?:шт\.?|штук\w*)[^.]{0,120}\.)/iu);
    if (m?.[1]) return m[1].trim();
  }
  return t;
}

function postTrimVerticalBareMergedValue(keyNorm: string, value: string): string {
  if (keyNorm === "объем" || keyNorm === "объём") return refineVerticalBareVolumeValue(value);
  if (keyNorm === "упаковка") return refineVerticalBarePackagingFieldValue(value);
  if (keyNorm.includes("комплектация") && keyNorm.includes("фасовк"))
    return refineVerticalBareКомплектацияValue(value);
  return value;
}

function pickVerticalBareMergedCharacteristic(
  keyNorm: string,
  group: TenderAiCharacteristicRow[],
  cardName: string
): TenderAiCharacteristicRow {
  const nameOut = group[0]!.name;
  if (group.length === 1) {
    const r = group[0]!;
    return { ...r, name: nameOut, value: postTrimVerticalBareMergedValue(keyNorm, r.value) };
  }
  if (keyNorm === "описание товара") {
    const pref = cardName.replace(/\s+/g, " ").trim();
    const pref36 = pref.slice(0, Math.min(42, pref.length)).toLowerCase();
    const scored = [...group].map((r) => {
      const vl = r.value.replace(/\s+/g, " ").trim().toLowerCase();
      return {
        r,
        dup: descriptionDuplicatePatternPenalty(r.value),
        noise: verticalBareDescriptionNoiseScore(r.value, cardName),
        starts: pref36.length >= 6 && vl.startsWith(pref36),
        len: r.value.length
      };
    });
    scored.sort((a, b) => {
      /** Оба с префиксом наименования: длинная товарная проза важнее короткого echo и умеренного dup/noise (эксп.3 п.28). */
      if (a.starts && b.starts) {
        if (a.dup !== b.dup && Math.max(a.dup, b.dup) >= 120) return a.dup - b.dup;
        if (Math.abs(a.noise - b.noise) > 95) return a.noise - b.noise;
        return b.len - a.len;
      }
      if (a.dup !== b.dup) return a.dup - b.dup;
      if (a.starts !== b.starts) return a.starts ? -1 : 1;
      if (Math.abs(a.noise - b.noise) <= 55) return b.len - a.len;
      if (Math.abs(a.noise - b.noise) > 22) return a.noise - b.noise;
      const ia = group.indexOf(a.r);
      const ib = group.indexOf(b.r);
      if (ia !== ib) return ia - ib;
      return b.len - a.len;
    });
    const w = scored[0]!.r;
    return { ...w, name: nameOut, value: postTrimVerticalBareMergedValue(keyNorm, w.value) };
  }
  if (keyNorm === "объем" || keyNorm === "объём") {
    const refined = group.map((r) => ({ ...r, value: refineVerticalBareVolumeValue(r.value) }));
    const w = refined.reduce((a, b) => (a.value.length <= b.value.length ? a : b));
    return { ...w, name: nameOut, value: w.value };
  }
  if (keyNorm === "упаковка") {
    const w = group.reduce((a, b) => (a.value.length >= b.value.length ? a : b));
    return {
      ...w,
      name: nameOut,
      value: refineVerticalBarePackagingFieldValue(w.value)
    };
  }
  if (keyNorm.includes("комплектация") && keyNorm.includes("фасовк")) {
    const sorted = [...group].sort((a, b) => a.value.length - b.value.length);
    const minV = sorted[0]!.value;
    const maxV = sorted[sorted.length - 1]!.value;
    const wBase =
      maxV.length > minV.length * 2.5 && minV.length >= 10 ? sorted[0]! : sorted[sorted.length - 1]!;
    return { ...wBase, name: nameOut, value: refineVerticalBareКомплектацияValue(wBase.value) };
  }
  const w = group.reduce((a, b) => (a.value.length >= b.value.length ? a : b));
  return { ...w, name: nameOut, value: postTrimVerticalBareMergedValue(keyNorm, w.value) };
}

const VERTICAL_BARE_FINAL_DESC_MAX_CHARS = 248;
const VERTICAL_BARE_FINAL_DESC_MAX_SENTENCES = 2;
const VERTICAL_BARE_FIELD_DEDUPE_MIN = 0.85;

function verticalBareNormalizedForFieldDedupe(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[""«»„]/g, '"')
    .replace(/'/g, "'");
}

function verticalBareBigramCosineSimilarity(a: string, b: string): number {
  const x = verticalBareNormalizedForFieldDedupe(a).replace(/\s/g, "");
  const y = verticalBareNormalizedForFieldDedupe(b).replace(/\s/g, "");
  if (!x.length || !y.length) return 0;
  if (x === y) return 1;
  const bigrams = (s: string) => {
    const m = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const k = s.slice(i, i + 2);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const A = bigrams(x);
  const B = bigrams(y);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const v of A.values()) na += v * v;
  for (const v of B.values()) nb += v * v;
  for (const [k, va] of A) {
    const vb = B.get(k);
    if (vb) dot += va * vb;
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function verticalBareFieldsDuplicateEnough(a: string, b: string, minRatio: number): boolean {
  const x = verticalBareNormalizedForFieldDedupe(a);
  const y = verticalBareNormalizedForFieldDedupe(b);
  if (!x.length || !y.length) return false;
  if (x === y) return true;
  const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
  if (longer.includes(shorter) && shorter.length / longer.length >= minRatio) return true;
  return verticalBareBigramCosineSimilarity(a, b) >= minRatio;
}

function verticalBareValueLooksLikePackagingFocus(v: string): boolean {
  return /\d+(?:[.,]\d+)?\s*(?:шт\.?|штук\w*|пар\w*|упаковк\w*|рулон\w*|\bмл\b|мл\.|гр\.?|\bг\.?\b)/iu.test(v);
}

function verticalBareCanonInlineGraphLabel(raw: string): { norm: string; display: string } | null {
  const k = raw.replace(/\s+/g, " ").trim().toLowerCase();
  if (/^состав$/i.test(k)) return { norm: "состав", display: "Состав" };
  if (/^объ[её]м$/i.test(k)) return { norm: "объем", display: "Объем" };
  if (/^упаковка$/i.test(k)) return { norm: "упаковка", display: "Упаковка" };
  if (/^цвет$/i.test(k)) return { norm: "цвет", display: "Цвет" };
  if (/^материал$/i.test(k)) return { norm: "материал", display: "Материал" };
  if (/^плотность$/i.test(k)) return { norm: "плотность", display: "Плотность" };
  return null;
}

/** Первые 1–2 продуктовых предложения, обрезка по составу / повтору / длине. */
function verticalBareClampDescriptionProductLead(raw: string, maxChars: number, maxSentences: number): string {
  let t = raw.replace(/\s+/g, " ").trim();
  if (!t) return t;
  const spill =
    t.search(/\.\s*(?:Состав|состав)\s*:/iu) >= 12
      ? t.search(/\.\s*(?:Состав|состав)\s*:/iu)
      : t.search(/\.\s*(?:Объ[её]м|объ[её]м|Упаковка|упаковка|Цвет|цвет|Материал|материал|Плотность|плотность)\s*:/iu);
  if (spill >= 20 && spill < t.length - 10) t = t.slice(0, spill + 1).trim();
  const rep = t.search(/\.\s*(?=[А-ЯЁA-Z«„"\u00ab])/u);
  if (rep >= 30 && rep < t.length - 40) {
    const tail = t.slice(rep + 1).trim();
    const head = t.slice(0, rep + 1).trim();
    if (tail.length > 20 && head.length > 20 && verticalBareFieldsDuplicateEnough(head.slice(0, Math.min(48, head.length)), tail.slice(0, Math.min(48, tail.length)), 0.78))
      t = head;
  }
  const reSent = /\.(?:\s+)(?=[А-ЯЁA-Z«„"\u00ab])|\.(?=[А-ЯЁA-Z«„"\u00ab])/gu;
  const cuts: number[] = [];
  let m: RegExpExecArray | null;
  /** cuts[i] — конец (i+1)-го предложения; для 2 предложений нужны 2 точки-разделителя. */
  while ((m = reSent.exec(t)) !== null && cuts.length < maxSentences) {
    cuts.push(m.index + 1);
  }
  const endIdx =
    cuts.length >= maxSentences
      ? cuts[maxSentences - 1]!
      : cuts.length > 0
        ? cuts[cuts.length - 1]!
        : -1;
  let out = endIdx >= 0 ? t.slice(0, endIdx + 1).trim() : t;
  if (out.length > maxChars) {
    const slice = out.slice(0, maxChars);
    const lastDot = slice.lastIndexOf(".");
    out = (lastDot >= 35 ? slice.slice(0, lastDot + 1) : slice).trim();
  }
  if (out.length < 14 && t.length >= 14) out = t.slice(0, maxChars).trim();
  return out;
}

function verticalBareExtractLabeledGraphsFromDescription(
  desc: string,
  rows: TenderAiCharacteristicRow[]
): { head: string; injected: TenderAiCharacteristicRow[] } {
  const injected: TenderAiCharacteristicRow[] = [];
  let head = desc.replace(/\s+/g, " ").trim();
  if (head.length < 40) return { head, injected };
  let guard = 0;
  while (guard++ < 14) {
    const m = head.match(/(?:^|[.;!?]\s+)(состав|объ[её]м|упаковка|цвет|материал|плотность)\s*:\s*/iu);
    if (!m || m.index === undefined) break;
    const canon = verticalBareCanonInlineGraphLabel(m[1] ?? "");
    if (!canon) break;
    const start = m.index + m[0].length;
    const tail = head.slice(start);
    const nextIx = tail.search(/[.;!?]\s+(?:состав|объ[её]м|упаковка|цвет|материал|плотность)\s*:/iu);
    const rawVal = (nextIx < 0 ? tail : tail.slice(0, nextIx)).replace(/\s+/g, " ").trim();
    const prefix = head.slice(0, m.index).replace(/\s+/g, " ").trim();
    const suffix = nextIx < 0 ? "" : tail.slice(nextIx).replace(/\s+/g, " ").trim();
    head = [prefix, suffix].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
    if (rawVal.length > 6) {
      const prevIx = rows.findIndex((r) => normCharacteristicMergeKey(r.name) === canon.norm);
      const prev = prevIx >= 0 ? (rows[prevIx]!.value ?? "").replace(/\s+/g, " ").trim() : "";
      if (!prev || prev.length < 12 || !verticalBareFieldsDuplicateEnough(prev, rawVal, 0.82))
        injected.push({ name: canon.display, value: rawVal.slice(0, 12_000), sourceHint: "tech_spec" });
    }
  }
  return { head, injected };
}

/**
 * Финальный слой для vertical bare ordinal: дедуп описание↔фасовка, укорочение описания,
 * вынесение встроенных «Состав:/Объём:…» в графы (без дубля при уже заполненной графе).
 */
function finalizeVerticalBareOrdinalCharacteristicLayers(
  rows: TenderAiCharacteristicRow[],
  cardName: string
): TenderAiCharacteristicRow[] {
  let out = rows.map((r) => ({ ...r }));
  const ixDesc = out.findIndex((r) => /^описание\s+товара$/i.test((r.name ?? "").trim()));
  if (ixDesc >= 0) {
    const desc0 = (out[ixDesc]!.value ?? "").replace(/\s+/g, " ").trim();
    const { head, injected } = verticalBareExtractLabeledGraphsFromDescription(desc0, out);
    if (injected.length > 0) {
      out[ixDesc] = { ...out[ixDesc]!, value: head };
      out.push(...injected);
      out = mergeCharacteristicsVerticalBareOrdinal(out, cardName);
    }
    const ixPack = out.findIndex((r) => /комплектация\s*\/\s*фасовк/i.test((r.name ?? "").trim()));
    const ixUp = out.findIndex((r) => normCharacteristicMergeKey(r.name) === "упаковка");
    const dNow = (out.find((r) => /^описание\s+товара$/i.test((r.name ?? "").trim()))?.value ?? "")
      .replace(/\s+/g, " ")
      .trim();
    for (const ixComp of [ixPack, ixUp]) {
      if (ixDesc < 0 || ixComp < 0) continue;
      const compVal = (out[ixComp]!.value ?? "").replace(/\s+/g, " ").trim();
      if (!dNow || !compVal) continue;
      const dup =
        verticalBareFieldsDuplicateEnough(dNow, compVal, VERTICAL_BARE_FIELD_DEDUPE_MIN) ||
        (verticalBareValueLooksLikePackagingFocus(dNow) &&
          verticalBareFieldsDuplicateEnough(dNow, compVal, 0.78));
      if (dup) {
        const ixD = out.findIndex((r) => /^описание\s+товара$/i.test((r.name ?? "").trim()));
        if (ixD >= 0) out.splice(ixD, 1);
        break;
      }
    }
    const ixD2 = out.findIndex((r) => /^описание\s+товара$/i.test((r.name ?? "").trim()));
    if (ixD2 >= 0) {
      const v = (out[ixD2]!.value ?? "").replace(/\s+/g, " ").trim();
      const clipped = verticalBareClampDescriptionProductLead(
        v,
        VERTICAL_BARE_FINAL_DESC_MAX_CHARS,
        VERTICAL_BARE_FINAL_DESC_MAX_SENTENCES
      );
      if (clipped.length + 4 < v.length || v.length > VERTICAL_BARE_FINAL_DESC_MAX_CHARS)
        out[ixD2] = { ...out[ixD2]!, value: clipped };
    }
  }
  out = mergeCharacteristicsVerticalBareOrdinal(out, cardName);
  return out.filter((r) => (r.value ?? "").replace(/\s+/g, " ").trim().length > 0);
}

const VERTICAL_BARE_NAME_ENRICH_MAX = 220;

/** «Кусок, вес 90 гр.» / «Упаковано в …» — вынести в отдельные графы. */
function extractVerticalBareKusokWeightAndPackaging(line: string): TenderAiCharacteristicRow[] {
  const t = line.replace(/\s+/g, " ").trim();
  if (t.length < 8 || t.length > 420) return [];
  const out: TenderAiCharacteristicRow[] = [];
  const mK = t.match(/\bКусок\b[^.]{0,140}вес(?:ом)?\s+(\d+(?:[.,]\d+)?\s*(?:гр\.?|кг\.?|г\b))/iu);
  const mComma = !mK ? t.match(/,\s*вес\s+(\d+(?:[.,]\d+)?\s*(?:гр\.?|кг\.?|г\b))/iu) : null;
  const mW = !mK && !mComma ? t.match(/\bвес\s+(\d+(?:[.,]\d+)?\s*(?:гр\.?|кг\.?|г\b))/iu) : null;
  const wRaw = mK?.[1] ?? mComma?.[1] ?? mW?.[1];
  if (wRaw) {
    const norm = wRaw.replace(/\s+/g, "").replace(/гр\.?/gi, " г");
    out.push({ name: "Вес", value: norm, sourceHint: "tech_spec" });
  }
  if (/упаковано\s+в/i.test(t)) {
    out.push({ name: "Упаковка", value: t.slice(0, 480), sourceHint: "tech_spec" });
  }
  return out;
}

function collectVerticalBareDeterministicInjections(preMerged: string[]): TenderAiCharacteristicRow[] {
  const out: TenderAiCharacteristicRow[] = [];
  for (const ln of preMerged) {
    const t = ln.replace(/\s+/g, " ").trim();
    if (!t) continue;
    out.push(...extractVerticalBareKusokWeightAndPackaging(t));
  }
  return out;
}

function injectVerticalBareWeightFromCardNameIfMissing(
  name: string,
  rows: TenderAiCharacteristicRow[]
): TenderAiCharacteristicRow[] {
  if (rows.some((r) => normCharacteristicMergeKey(r.name) === "вес")) return rows;
  // Avoid leading `\b` before Cyrillic "вес/весом" — JS `\b` is ASCII-centric for some engines.
  const m = name
    .replace(/\s+/g, " ")
    .match(/(?:^|[\s,.;:])(?:весом|вес)\s+(\d+(?:[.,]\d+)?)\s*(гр\.?|кг\.?|г)(?=\s|\.|,|$)/iu);
  if (!m?.[1] || !m[2]) return rows;
  const num = m[1].replace(",", ".").trim();
  const u = m[2].toLowerCase();
  const v = u.startsWith("кг") ? `${num} кг` : `${num} г`;
  return [...rows, { name: "Вес", value: v, sourceHint: "tech_spec" }];
}

/** Значение «Материал» с «. Цвет:» / «… пар в упаковке» в одной строке — разнести. */
function detachEmbeddedColorAndPackFromMaterialRow(
  rows: TenderAiCharacteristicRow[],
  cardName: string
): TenderAiCharacteristicRow[] {
  const ix = rows.findIndex((r) => normCharacteristicMergeKey(r.name) === "материал");
  if (ix < 0) return rows;
  const t = rows[ix]!.value.replace(/\s+/g, " ").trim();
  if (!/\.\s*цвет\s*:/i.test(t)) return rows;
  const m = t.match(/^(.+?)\.\s*цвет\s*:\s*(.+?)(?=\.\s*\d+\s*пар|$)/iu);
  if (!m?.[1] || !m[2]) return rows;
  const matVal = m[1].replace(/^материал\s*:\s*/iu, "").trim();
  const colVal = m[2].replace(/\s+/g, " ").trim().replace(/\.\s*$/, "");
  const pk = t.match(/(\d+\s*пар\w*(?:\s+в\s+упаковк\w*)?)\s*\.?\s*$/iu);
  const next = rows.filter((_, i) => i !== ix);
  const pushIfAbsent = (r: TenderAiCharacteristicRow) => {
    const k = normCharacteristicMergeKey(r.name);
    if (!next.some((x) => normCharacteristicMergeKey(x.name) === k)) next.push(r);
  };
  pushIfAbsent({ name: "Материал", value: matVal, sourceHint: "tech_spec" });
  pushIfAbsent({ name: "Цвет", value: colVal, sourceHint: "tech_spec" });
  if (pk?.[1]) pushIfAbsent({ name: "Комплектация / фасовка", value: pk[1].trim(), sourceHint: "tech_spec" });
  return mergeCharacteristicsVerticalBareOrdinal(next, cardName);
}

/**
 * Строка начинается с короткой подписи графы «…: значение», а не с длинной товарной прозы с «Упаковка:» в середине.
 */
function verticalBareLineLooksLikeLeadingLabeledFieldRow(L: string): boolean {
  const t = L.replace(/\s+/g, " ").trim();
  const m = t.match(/^([А-ЯЁA-Za-zа-яё][^:\n]{0,100}?):\s*\S/u);
  if (!m?.[1]) return false;
  const head = m[1]!.replace(/\s+/g, " ").trim();
  if (head.length < 2 || head.length > 76) return false;
  if (/\.\s+[А-ЯЁA-Za-zа-яё«"„]/.test(head)) return false;
  return true;
}

function verticalBareDescriptionLooksLikeTailFragment(desc: string, productName: string): boolean {
  const d = desc.replace(/\s+/g, " ").trim();
  const p = productName.replace(/\s+/g, " ").trim();
  if (d.length < 12) return false;
  if (/^«[^»]{2,80}»\s+/u.test(d)) return true;
  if (/^["«„]/.test(d)) return true;
  const core = p.slice(0, Math.min(22, p.length)).toLowerCase();
  if (core.length >= 6 && !d.toLowerCase().startsWith(core) && /^[а-яё]/.test(d)) return true;
  /** Хвост предыдущей позиции: продолжение после «… упаковке.» / «… шт.» без начала текущего наименования. */
  if (
    core.length >= 6 &&
    /(?:упаковк\w*|шт\.?|штук\w*|пар\w*)\s*[.,]\s+[а-яё]/iu.test(d) &&
    !d.toLowerCase().startsWith(core)
  )
    return true;
  if (/^(?:не\s+менее|компонент|10-[йя]\s+класс|интенсивн\w+\s+формула|флакон\s+с\s+триггером)/iu.test(d))
    return true;
  if (/^\d+(?:[.,]\d+)?%/u.test(d)) return true;
  return false;
}

/** Сколько «значимых» токенов из начала наименования встречается в строке (вертикальная спека, поздние позиции). */
function verticalBareNameTokenHitsInLine(productName: string, lineLower: string): number {
  const pn = productName.replace(/\s+/g, " ").trim().toLowerCase();
  if (pn.length < 6) return 0;
  const words = pn
    .split(/\s+/)
    .map((w) => w.replace(/^[«""„(]+/u, "").replace(/[.,;:!?)»""']+$/u, ""))
    .filter((w) => w.length >= 4)
    .slice(0, 10);
  if (words.length === 0) return 0;
  let hits = 0;
  for (const w of words) {
    if (lineLower.includes(w)) hits++;
  }
  return hits;
}

/** Товарная строка вертикальной спеки без явного совпадения префикса (бумага, салфетки, полотенца …). */
const VERTICAL_BARE_DOC_DESC_PRODUCT_LEX_RE =
  /(?:перчатк|средств|мыло|крем|гель|освежител|антисептик|таблетк|бумаг|салфет|полотенц|туалетн|стеклоочист|ополаскивател|посудомоечн|серветк|пакет\w*|мешк\w*|рулон|нитрилов|латексн|влажн\w*\s+салфет)/i;

function scoreVerticalBareDocumentDescriptionLineCandidate(
  L: string,
  pn: string,
  pLow: string,
  prefShort: string,
  opts?: { allowTitleLineAsDescription?: boolean },
  lineIndex = 0
): { score: number; tier: string } | null {
  const ll = L.toLowerCase();
  if (!opts?.allowTitleLineAsDescription && (ll === pLow || L === pn)) return null;
  const ltr = L.trim();
  /** Не отбрасывать короткий документный префикс имени («Мыло … 72%.» при полном name с «Кусок…»). */
  const prefixEchoMin = Math.max(34, Math.floor(pn.length * 0.78));
  if (pn.length > ltr.length + 6 && pn.toLowerCase().startsWith(ll) && ltr.length >= prefixEchoMin) return null;
  let base = 0;
  let tier = "";
  if (prefShort.length >= 6 && ll.startsWith(prefShort)) {
    base = 400;
    tier = "prefix18";
  } else if (pLow.length >= 10 && ll.includes(pLow.slice(0, 12)) && L.length >= 22) {
    base = 220;
    tier = "substr12";
  } else if (
    VERTICAL_BARE_DOC_DESC_PRODUCT_LEX_RE.test(L) &&
    ll.includes(pLow.slice(0, Math.min(10, pLow.length))) &&
    L.length >= 32
  ) {
    base = 160;
    tier = "lexPlusSubstr10";
  } else {
    const hits = verticalBareNameTokenHitsInLine(pn, ll);
    /** Поздние блоки: короткое наименование + длинная товарная строка без общего 12-симв. подстринга (эксп.3, 28+). */
    if (pLow.length >= 8 && L.length >= 42 && hits >= 2) {
      /** Не брать «чужой» абзац из хвоста раздутого блока при совпадении 2–3 общих слов. */
      if (lineIndex > 6) return null;
      base = 118;
      tier = `tokenHits${hits}`;
    } else return null;
  }
  let score = base + Math.min(L.length, 720);
  if (/\.{3,}/.test(L)) score -= 40;
  return { score, tier };
}

export type VerticalBareDocDescriptionLineDiag = {
  raw: string;
  normalized: string;
  outcome: "picked" | "skipped" | "scored";
  score?: number;
  tier?: string;
  skip?: string;
};

/**
 * Диагностика выбора document-first строки описания (harness / трасса вертикальной спеки).
 */
export function diagnoseVerticalBareDocumentDescriptionLinePick(
  preMerged: string[],
  productName: string,
  opts?: { avoidPackagingPhrases?: boolean; allowTitleLineAsDescription?: boolean }
): { best: string | null; bestScore: number; lines: VerticalBareDocDescriptionLineDiag[] } {
  const pn = productName.replace(/\s+/g, " ").trim();
  const pLow = pn.toLowerCase();
  const prefShort = pLow.slice(0, Math.min(18, pLow.length));
  const lines: VerticalBareDocDescriptionLineDiag[] = [];
  let best: string | null = null;
  let bestScore = -1;
  for (let li = 0; li < preMerged.length; li++) {
    const ln = preMerged[li]!;
    const raw = ln;
    let L = ln.replace(/\s+/g, " ").trim();
    if (L.length < 14 || L.length > 1400) {
      lines.push({ raw, normalized: L, outcome: "skipped", skip: "len" });
      continue;
    }
    if (/^(?:штука|шт\.?|упак\.?|ед\.?\s*изм\.?)$/i.test(L)) {
      lines.push({ raw, normalized: L, outcome: "skipped", skip: "unit_word" });
      continue;
    }
    if (/^\d{1,6}$/.test(L)) {
      lines.push({ raw, normalized: L, outcome: "skipped", skip: "digits_only" });
      continue;
    }
    /** Только «графа: значение» в начале строки; не отсекать «…мыло. Упаковка: ПЭТ…» (эксп.3, поз. 28). */
    if (verticalBareLineLooksLikeLeadingLabeledFieldRow(L)) {
      lines.push({ raw, normalized: L, outcome: "skipped", skip: "labeled_field" });
      continue;
    }
    if (opts?.avoidPackagingPhrases && /упаковано\s+в/i.test(L)) {
      const head = L.split(/\s+упаковано\s+в/i)[0]?.replace(/\s+/g, " ").trim();
      if (head && head.length >= 14) L = head;
      else {
        lines.push({ raw, normalized: L, outcome: "skipped", skip: "pack_phrase" });
        continue;
      }
    }
    if (
      opts?.avoidPackagingPhrases &&
      /\bкусок\b/i.test(L) &&
      /^[а-яё«"„]/iu.test(L) &&
      /\.\s*кусок\b/i.test(L)
    ) {
      const beforeKusok = L.split(/\.\s*(?=кусок\b)/iu)[0]?.replace(/\s+/g, " ").trim();
      if (beforeKusok && beforeKusok.length >= 14) L = beforeKusok;
    }
    if (verticalBareDescriptionLooksLikeTailFragment(L, pn)) {
      lines.push({ raw, normalized: L, outcome: "skipped", skip: "tail_fragment" });
      continue;
    }
    const scored = scoreVerticalBareDocumentDescriptionLineCandidate(L, pn, pLow, prefShort, opts, li);
    if (!scored) {
      lines.push({ raw, normalized: L, outcome: "skipped", skip: "no_name_anchor" });
      continue;
    }
    lines.push({
      raw,
      normalized: L,
      outcome: "scored",
      score: scored.score,
      tier: scored.tier
    });
    if (scored.score > bestScore) {
      bestScore = scored.score;
      best = L;
    }
  }
  for (const row of lines) {
    if (row.outcome === "scored" && row.normalized === best) row.outcome = "picked";
  }
  return { best, bestScore, lines };
}

function pickVerticalBareDocumentDescriptionLine(
  preMerged: string[],
  productName: string,
  opts?: { avoidPackagingPhrases?: boolean; allowTitleLineAsDescription?: boolean }
): string | null {
  return diagnoseVerticalBareDocumentDescriptionLinePick(preMerged, productName, opts).best;
}

function tryEnrichVerticalBareNameWithQuotedBrand(name: string, preMerged: string[]): string {
  const nm = name.replace(/\s+/g, " ").trim();
  if (nm.length >= 88 || nm.length < 6) return name;
  if (/«[^»]{2,50}»/.test(nm)) return name;
  const low = nm.slice(0, Math.min(28, nm.length)).toLowerCase();
  for (const ln of preMerged) {
    const L = ln.replace(/\s+/g, " ").trim();
    if (L.length < 28 || L.length > 900) continue;
    const ll = L.toLowerCase();
    if (!ll.startsWith(low)) continue;
    const bq = L.match(/«([^»]{2,40})»/u);
    if (!bq?.[0] || nm.includes(bq[0])) continue;
    const enriched = `${nm} ${bq[0]}`.replace(/\s+/g, " ").trim().slice(0, VERTICAL_BARE_NAME_ENRICH_MAX);
    if (enriched.length > nm.length + 3) return enriched;
  }
  return name;
}

function injectVerticalBareBodyWhenMissing(
  rows: TenderAiCharacteristicRow[],
  preMerged: string[],
  productName: string
): TenderAiCharacteristicRow[] {
  if (rows.some((r) => /^описание\s+товара$/i.test((r.name ?? "").trim()))) return rows;
  const valRows = rows.filter((r) => (r.value ?? "").replace(/\s+/g, " ").trim().length > 2);
  const onlyPack =
    valRows.length > 0 &&
    valRows.every((r) => /^комплектация\s*\/\s*фасовк/i.test((r.name ?? "").trim()));
  if (valRows.length > 0 && !onlyPack) return rows;
  const pick = pickVerticalBareDocumentDescriptionLine(preMerged, productName, {});
  if (!pick) return rows;
  return [{ name: "Описание товара", value: pick.slice(0, 12_000), sourceHint: "tech_spec" }, ...rows];
}

/** Если выбрана строка = наименованию, но в блоке есть отдельная нарративная «хвостовая» строка — склеить (вертикальная спека, пр. 13). */
function augmentBareOrdinalDocPickIfTitleEchoOnly(
  pick: string,
  preMerged: string[],
  productName: string
): string {
  const pn = productName.replace(/\s+/g, " ").trim();
  const pl = pick.replace(/\s+/g, " ").trim();
  if (!pn || pl.toLowerCase() !== pn.toLowerCase()) return pick;
  for (const ln of preMerged) {
    const L = ln.replace(/\s+/g, " ").trim();
    if (L.length < pl.length + 16) continue;
    if (L.toLowerCase().startsWith(pl.toLowerCase())) continue;
    if (!verticalBareDescriptionLooksLikeTailFragment(L, productName)) continue;
    if (/^[А-ЯЁA-Z][^:]{0,100}:\s*\S/.test(L)) continue;
    return `${pl}. ${L}`.replace(/\s+/g, " ").trim().slice(0, 12_000);
  }
  return pick;
}

/**
 * Короткое «Описание» = только echo наименования, хотя в теле есть длинная товарная строка (эксп.3 п.28).
 * Подменяем document-first pick; встроенные «Упаковка:/Объём:» вырезаются, если графы уже есть в строках.
 */
function expandVerticalBareOrdinalDescriptionIfStunted(
  productName: string,
  rows: TenderAiCharacteristicRow[],
  preMerged: string[]
): TenderAiCharacteristicRow[] {
  const ix = rows.findIndex((r) => /^описание\s+товара$/i.test((r.name ?? "").trim()));
  if (ix < 0) return rows;
  const cur = (rows[ix]!.value ?? "").replace(/\s+/g, " ").trim();
  const pn = productName.replace(/\s+/g, " ").trim();
  const pLow = pn.toLowerCase();
  if (cur.length > 52 || pn.length < 8) return rows;
  const pref = pLow.slice(0, Math.min(12, pLow.length));
  if (pref.length < 6 || !cur.toLowerCase().startsWith(pref)) return rows;
  const pick = diagnoseVerticalBareDocumentDescriptionLinePick(preMerged, pn, {}).best;
  if (!pick || pick.length <= cur.length + 28) return rows;
  if (!pick.toLowerCase().startsWith(cur.toLowerCase()) && !pick.toLowerCase().startsWith(pref)) return rows;
  let nextVal = pick.replace(/\s+/g, " ").trim();
  const { head } = verticalBareExtractLabeledGraphsFromDescription(nextVal, rows);
  nextVal = head.length >= cur.length + 20 ? head : nextVal;
  const out = rows.map((r) => ({ ...r }));
  out[ix] = { ...out[ix]!, value: nextVal.slice(0, 12_000) };
  return out;
}

/**
 * В теле графы «Описание товара» иногда остаётся только общий префикс категории, тогда как
 * карточное наименование уже содержит модель/КТРУ/тип — без подтягивания хвоста сверка в UI пустая.
 * Поднимаем только суффикс после общего префикса (не копируем всё имя целиком — иначе echo-strip).
 */
function clipVerticalBareOrdinalDescriptionTailFromGluedNameNoise(tail: string): string {
  let t = tail.replace(/\s+/g, " ").trim();
  /** Не используем `\\b` перед кириллицой: в JS граница слова ASCII-центрична. */
  const cutAt = (s: string, re: RegExp): string => {
    const m = s.match(re);
    if (!m || m.index == null || m.index < 8) return s;
    return s.slice(0, m.index).trim();
  };
  t = cutAt(t, /\s+Значение\s+характеристики/i);
  t = cutAt(t, /\s+не\s+может\s+изменяться/i);
  t = cutAt(t, /\s+участником\s+закупки/i);
  t = cutAt(t, /\s+ТЕХНИЧЕСКОЕ\s+ЗАДАНИЕ/i);
  t = cutAt(t, /###\s*Файл/i);
  return t.replace(/[,;\s–-]+$/u, "").trim();
}

function expandVerticalBareOrdinalDescriptionFromCardNameTail(
  productName: string,
  rows: TenderAiCharacteristicRow[]
): TenderAiCharacteristicRow[] {
  const ix = rows.findIndex((r) => /^описание\s+товара$/i.test((r.name ?? "").trim()));
  if (ix < 0) return rows;
  const cur = (rows[ix]!.value ?? "").replace(/\s+/g, " ").trim();
  const pn = productName.replace(/\s+/g, " ").trim();
  if (!cur || !pn || pn.length < cur.length + 10) return rows;
  const cLow = cur.toLowerCase();
  const pLow = pn.toLowerCase();
  if (!pLow.startsWith(cLow)) return rows;
  if (cur.length > 58) return rows;
  let tail = pn.slice(cur.length).trim().replace(/^[,;.\s–-]+/, "");
  tail = clipVerticalBareOrdinalDescriptionTailFromGluedNameNoise(tail);
  if (tail.length < 10) return rows;
  /** Хвост должен нести сверочную конкретику: цифры (КТРУ/кол-во) или латинский артикул/модель. */
  if (!/\d/.test(tail) && !/[A-Za-z]{2,}\s*\d|[A-Za-z]{2,}\d{2,}|[A-Za-z]{2,}-/i.test(tail)) return rows;
  const out = rows.map((r) => ({ ...r }));
  out[ix] = { ...out[ix]!, value: tail.slice(0, 12_000) };
  return out;
}

function healVerticalBareOrdinalDescriptionAfterStrip(
  productName: string,
  rows: TenderAiCharacteristicRow[],
  preMerged: string[]
): TenderAiCharacteristicRow[] {
  const rowsOut = rows.map((r) => ({ ...r }));
  const ix = rowsOut.findIndex((r) => /^описание\s+товара$/i.test((r.name ?? "").trim()));
  if (ix < 0) return rowsOut;
  const cur = (rowsOut[ix]!.value ?? "").replace(/\s+/g, " ").trim();
  const forceDocPick =
    verticalBareDescriptionLooksLikeTailFragment(cur, productName) || /^интенсивн/i.test(cur.trim());
  if (!forceDocPick) return rowsOut;
  const pLow = productName.replace(/\s+/g, " ").trim().toLowerCase();
  const pickRaw = pickVerticalBareDocumentDescriptionLine(preMerged, productName, {
    avoidPackagingPhrases: /^\d+(?:[.,]\d+)?%/u.test(cur.trim()),
    allowTitleLineAsDescription: true
  });
  if (!pickRaw) return rowsOut;
  const pick = augmentBareOrdinalDocPickIfTitleEchoOnly(pickRaw, preMerged, productName);
  const takePick =
    pick.length >= Math.min(cur.length * 0.45, 38) ||
    (verticalBareDescriptionLooksLikeTailFragment(cur, productName) && pick.length >= 18) ||
    (pick.length > cur.length + 14 && pick.toLowerCase().startsWith(pLow.slice(0, Math.min(14, pLow.length)))) ||
    /^интенсивн/i.test(cur.trim());
  if (takePick) {
    rowsOut[ix] = { ...rowsOut[ix]!, value: pick.slice(0, 12_000) };
  }
  return rowsOut;
}

/** Почему не сработал allowLoose (только вертикальная спецификация / слабый заголовок). Для диагностики архивов. */
function explainVerticalSpecWeakHeaderGate(
  blockLines: string[],
  relaxWeakHeader: boolean,
  verticalBareOrdinalSpecSegment: boolean
): string {
  const blockText = blockLines.join("\n");
  const head = (blockLines[0] ?? "").trim();
  const bareOrdinalHead = verticalBareOrdinalSpecSegment && /^\d{1,3}$/.test(head.trim());
  let name = head.replace(/^\d{1,4}\s*[.)]\s+/, "").trim();
  if (bareOrdinalHead) name = verticalSpecBareOrdinalBlockTitle(blockLines);
  if (name.length < 6) return `short_name:nameLen=${name.length}`;
  const strongHeader =
    POSITION_START_RE.test(head) ||
    MODEL_FIRST_LINE_RE.test(head) ||
    /картридж|тонер|барабан|снпч|модуль|чип|canon|hp\b|brother|kyocera|lexmark|ricoh|xerox|sharp|oki\b|tk-|cf\d|ce\d|tn-/i.test(
      name
    );
  if (strongHeader) return "strong_header_true_should_not_weak_fail";
  const numberedHead = /^(?:\d{1,4}\s*[.)]\s+)/.test(head.trim()) || bareOrdinalHead;
  const verticalQtySignals =
    verticalBareOrdinalSpecSegment &&
    bareOrdinalHead &&
    verticalSpecBlockHasUnitOrQtySignals(blockText);
  const hasKtruHints =
    /(?:КТРУ|ОКПД|наименован|товар|модел|издели|характеристик)/i.test(blockText) || !!extractKtruOrOkpd(blockText);
  const allowLoose =
    relaxWeakHeader &&
    numberedHead &&
    name.length >= verticalSpecMinLooseNameLen(verticalBareOrdinalSpecSegment, bareOrdinalHead) &&
    (hasKtruHints || verticalQtySignals);
  if (allowLoose) return "allow_loose_true";
  const bits: string[] = [];
  if (!relaxWeakHeader) bits.push("relaxWeakHeader=false");
  if (!numberedHead) bits.push("numberedHead=false");
  const minLen = verticalSpecMinLooseNameLen(verticalBareOrdinalSpecSegment, bareOrdinalHead);
  if (name.length < minLen) bits.push(`nameLen=${name.length}<${minLen}`);
  if (!hasKtruHints && !verticalQtySignals) {
    bits.push("no_ktru_okpd_and_no_vertical_qty_unit");
    bits.push(`verticalBare=${verticalBareOrdinalSpecSegment},bareOrdinal=${bareOrdinalHead}`);
    bits.push(`namePreview=${JSON.stringify(name.slice(0, 120))}`);
  }
  return bits.join("; ");
}

/** В вертикальной спецификации ед. изм. не только «шт» (упак., усл. ед., кг, л …). */
function verticalSpecBlockHasUnitOrQtySignals(blockText: string): boolean {
  return /(?:шт\.?|штук|ед\.?\s*изм\.?|упак(?:овк\w*)?|пач(?:к\w*)?|компл(?:ект)?|кг|л|м[²2]|м3|усл\.?\s*ед)/i.test(
    blockText
  );
}

function verticalSpecMinLooseNameLen(verticalBareOrdinalSpecSegment: boolean, bareOrdinalHead: boolean): number {
  return verticalBareOrdinalSpecSegment && bareOrdinalHead ? 6 : 8;
}

/**
 * Блоки сегмента вертикальной спецификации, которые нарезались, но отсеялись по weak_header (отладка тендэксперемент 3).
 */
export function diagnoseWeakHeaderVerticalSpecBlocks(
  segLines: string[],
  logicalPath: string
): Array<{ head: string; detail: string; blockRaw: string }> {
  const { allowGenericNumbered: allowGen, verticalBareTable: verticalBare } = splitOptsForTechSpecSegment(
    logicalPath,
    segLines
  );
  if (!verticalBare) return [];
  const { blocks, starts } = splitTechTextIntoPositionBlocks(segLines, {
    allowGenericNumbered: allowGen,
    logicalPath
  });
  const out: Array<{ head: string; detail: string; blockRaw: string }> = [];
  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi]!;
    const rr: string[] = [];
    const tr: string[] = [];
    parsePositionBlock(
      block,
      rr,
      tr,
      logicalPath,
      allowGen,
      verticalBare,
      verticalBareQtyBelowBlockCtxForSplitBlock(segLines, starts, bi, allowGen, verticalBare, block)
    );
    if (!rr.some((r) => r.startsWith("weak_header:"))) continue;
    out.push({
      head: (block[0] ?? "").trim(),
      detail: explainVerticalSpecWeakHeaderGate(block, allowGen, verticalBare),
      blockRaw: block.join("\n")
    });
  }
  return out;
}

/** Все блоки вертикальной спецификации, которые нарезались, но не распарсились (weak_header, no_qty, short_name). */
export function diagnoseVerticalSpecPositionBlockFailures(
  segLines: string[],
  logicalPath: string
): Array<{ head: string; reasons: string[]; blockRaw: string }> {
  const { allowGenericNumbered: allowGen, verticalBareTable: verticalBare } = splitOptsForTechSpecSegment(
    logicalPath,
    segLines
  );
  if (!verticalBare) return [];
  const { blocks, starts } = splitTechTextIntoPositionBlocks(segLines, {
    allowGenericNumbered: allowGen,
    logicalPath
  });
  const out: Array<{ head: string; reasons: string[]; blockRaw: string }> = [];
  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi]!;
    const rr: string[] = [];
    const tr: string[] = [];
    const ok = parsePositionBlock(
      block,
      rr,
      tr,
      logicalPath,
      allowGen,
      verticalBare,
      verticalBareQtyBelowBlockCtxForSplitBlock(segLines, starts, bi, allowGen, verticalBare, block)
    );
    if (ok) continue;
    out.push({
      head: (block[0] ?? "").trim(),
      reasons: [...rr],
      blockRaw: block.join("\n")
    });
  }
  return out;
}

/**
 * В минимизированном корпусе после последней позиции вертикальной спеки часто идёт следующий файл (`### Файл`).
 * split оставляет один длинный «хвостовой» блок — здесь отрезаем только хвост для разбора, не меняя нарезку блоков.
 */
function truncateVerticalBareOrdinalBlockAtMinimizedCorpusBoundary(lines: string[]): string[] {
  if (lines.length <= 1) return lines;
  for (let i = 1; i < lines.length; i++) {
    const row = (lines[i] ?? "").trim();
    if (/^###\s*(?:Файл|Слой)\b/i.test(row)) return lines.slice(0, i);
    if (/^---\s+\S/.test(row)) return lines.slice(0, i);
  }
  return lines;
}

/**
 * Реестровый / внутренний id позиции в тексте: `20…` (классика) или длинный `01…` (ЕИС/OCR, см. registry-position-ids).
 * Без `\b`: в JS граница слова не ставится между кириллицей и цифрой, id часто примыкает к тексту.
 */
const REGISTRY_POSITION_ID_IN_BODY_RE = REGISTRY_POSITION_ID_CAPTURE_RE;

function extractRegistryPositionIdNearStartOfTechSpecBlock(blockLines: string[], maxScanLines: number): string {
  const end = Math.min(blockLines.length, Math.max(1, maxScanLines));
  for (let i = 0; i < end; i++) {
    const m = REGISTRY_POSITION_ID_IN_BODY_RE.exec(blockLines[i] ?? "");
    if (m?.[1]) return m[1]!;
  }
  return "";
}

/** Строки ТЗ «…или эквивалент» / model-first: в самом ТЗ часто нет реестрового id — он в печатной форме. */
function isCartridgeOrModelFirstRowForRegistryEnrich(name: string): boolean {
  const t = name.trim();
  if (!t) return false;
  if (/или\s+эквивалент|или\s+аналог/i.test(t)) return true;
  if (POSITION_START_RE.test(t)) return true;
  if (MODEL_FIRST_LINE_RE.test(t)) return true;
  return false;
}

function pickModelTokenForNoticeRegistryMatch(name: string): string | null {
  const norm = name.replace(/\s+/g, " ").replace(/[Хх]/g, "X");
  const cands: string[] = [];
  for (const re of [
    /\b(?:CF|CE|CB|CC)\d{2,}[A-Z0-9]*\b/gi,
    /\bTK-\d+\b/gi,
    /\bTK\d{2,}[A-Z0-9]*\b/gi,
    /\bTN-\d+[A-Z0-9]*\b/gi,
    /\bW\d{4}[A-Z0-9]*\b/gi,
    /** Xerox / OEM numeric+letter part numbers (Тенд32 и др.): 006R04368, 101R00582, 113R00780 */
    /\b(?:006|008|101|106|108|113)R\d{5,6}\b/gi,
    /** Ricoh / Katyusha-style 6-digit product codes */
    /\b842\d{3}\b/gi,
    /\b\d{3}H\b/gi
  ]) {
    let m: RegExpExecArray | null;
    const r = new RegExp(re.source, re.flags);
    while ((m = r.exec(norm)) !== null) cands.push(m[0]!);
  }
  if (cands.length === 0) return null;
  cands.sort((a, b) => b.length - a.length);
  const best = cands[0]!;
  return best.length >= 4 ? best : null;
}

/**
 * Подставляет реестровый positionId из корпуса извещения/ПФ, если в ТЗ-блоке id не извлечён (тендэксперемент 2).
 * Сначала строка с id и токеном вместе; иначе — id на одной строке, токен в окне ±4 строк (PDF/верстка ЕИС).
 */
function foldXForRegistryTokenMatch(s: string): string {
  return s.replace(/\s+/g, " ").replace(/[хХ]/g, "x").toLowerCase();
}

function enrichCartridgeRegistryPositionIdsFromNoticeCorpus(
  items: TenderAiGoodItem[],
  noticeText: string
): { items: TenderAiGoodItem[]; enriched: number } {
  if (!noticeText.trim() || items.length === 0) return { items, enriched: 0 };
  const lines = noticeText.split("\n");
  let enriched = 0;
  const out = items.map((g) => {
    const pid = (g.positionId ?? "").trim();
    if (pid && isRegistryStylePositionId(pid)) return g;
    if (pid) return g;
    const name = (g.name ?? "").trim();
    if (!name || !isCartridgeOrModelFirstRowForRegistryEnrich(name)) return g;
    const token = pickModelTokenForNoticeRegistryMatch(name);
    if (!token) return g;
    const tl = foldXForRegistryTokenMatch(token);
    for (const ln of lines) {
      const rid = REGISTRY_POSITION_ID_IN_BODY_RE.exec(ln)?.[1];
      if (!rid) continue;
      if (!foldXForRegistryTokenMatch(ln).includes(tl)) continue;
      enriched++;
      return { ...g, positionId: rid };
    }
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i] ?? "";
      const rid = REGISTRY_POSITION_ID_IN_BODY_RE.exec(ln)?.[1];
      if (!rid) continue;
      let win = "";
      for (let j = Math.max(0, i - 8); j < Math.min(lines.length, i + 9); j++) {
        win += `${lines[j] ?? ""}\n`;
      }
      if (!foldXForRegistryTokenMatch(win).includes(tl)) continue;
      enriched++;
      return { ...g, positionId: rid };
    }
    return g;
  });
  return { items: out, enriched };
}

/** КТРУ с суффиксом в поле `codes` (предпочтительный якорь; без «голого» ОКПД). */
const KTRU_SUFFIX_IN_CODES_RE = /\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{3,5}(?!\d)/g;

function ktruSuffixAnchorsFromCodesForRegistryEnrich(codes: string): string[] {
  const t = (codes ?? "").trim();
  if (!t) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const seg of t.split(/\s*;\s*/)) {
    const s = seg.trim();
    if (!s) continue;
    const r = new RegExp(KTRU_SUFFIX_IN_CODES_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = r.exec(s)) !== null) {
      const a = m[0]!;
      const k = a.replace(/\s/g, "").toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(a);
    }
  }
  out.sort((a, b) => b.length - a.length);
  return out;
}

function compactForCodesAnchorMatch(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}

/**
 * Второй проход: реестровый pid по КТРУ из `codes` в корпусе извещения/ПФ.
 * Только `tech_spec_deterministic`, только пустой pid. Для якоря ищем строки и пары соседних строк,
 * где якорь есть; id берём только из этой строки / пары; подставляем только если все такие однозначные
 * фрагменты согласуются в один и тот же id.
 */
function enrichTechSpecRegistryPositionIdsByCodesCorpusPairLines(
  items: TenderAiGoodItem[],
  corpusText: string
): { items: TenderAiGoodItem[]; enriched: number } {
  if (!corpusText.trim() || items.length === 0) return { items, enriched: 0 };
  const lines = corpusText.split("\n");
  const reGlobal = new RegExp(REGISTRY_POSITION_ID_CAPTURE_RE.source, "g");
  let enriched = 0;
  const out = items.map((g) => {
    const pid = (g.positionId ?? "").trim();
    if (pid) return g;
    if (!(g.sourceHint ?? "").toLowerCase().includes("tech_spec_deterministic")) return g;
    const anchors = ktruSuffixAnchorsFromCodesForRegistryEnrich(g.codes ?? "");
    if (anchors.length === 0) return g;
    for (const anchor of anchors) {
      const needle = compactForCodesAnchorMatch(anchor);
      if (needle.length < 12) continue;
      const singletons: string[] = [];
      for (const ln of lines) {
        if (!compactForCodesAnchorMatch(ln).includes(needle)) continue;
        const local = new Set<string>();
        for (const m of (ln ?? "").matchAll(reGlobal)) {
          if (m[1]) local.add(m[1]!);
        }
        if (local.size === 1) singletons.push([...local][0]!);
      }
      for (let i = 0; i < lines.length; i++) {
        const chunk = `${lines[i] ?? ""}\n${lines[i + 1] ?? ""}`;
        if (!compactForCodesAnchorMatch(chunk).includes(needle)) continue;
        const local = new Set<string>();
        for (const m of chunk.matchAll(reGlobal)) {
          if (m[1]) local.add(m[1]!);
        }
        if (local.size === 1) singletons.push([...local][0]!);
      }
      if (singletons.length === 0) continue;
      const uniq = new Set(singletons);
      if (uniq.size !== 1) continue;
      enriched++;
      return { ...g, positionId: [...uniq][0]! };
    }
    return g;
  });
  return { items: out, enriched };
}

function findTechSpecBlockStartInSegment(segLines: string[], blockLines: string[]): number {
  if (blockLines.length === 0 || segLines.length === 0) return -1;
  const checkLen = Math.min(3, blockLines.length);
  if (!(blockLines[0] ?? "").trim()) return -1;
  for (let i = 0; i <= segLines.length - checkLen; i++) {
    let ok = true;
    for (let j = 0; j < checkLen; j++) {
      if ((segLines[i + j] ?? "").trim() !== (blockLines[j] ?? "").trim()) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return -1;
}

/**
 * Поле codes — ровно один токен вида NN.NN.NN.NNN без КТРУ-суффикса после дефиса (без вторых частей через ";").
 */
function codesIsSingleBareKtruTripleSegment(codes: string): string | null {
  const raw = (codes ?? "").trim();
  if (!raw) return null;
  /** Без флага `g`: у KTRU_SUFFIX_IN_CODES_RE глобальный флаг — .test() ненадёжен. */
  if (/\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{3,5}(?!\d)/.test(raw)) return null;
  const parts = raw.split(/\s*;\s*/).map((p) => p.trim()).filter(Boolean);
  if (parts.length !== 1) return null;
  const p = parts[0]!;
  if (!/^\d{2}\.\d{2}\.\d{2}\.\d{3}$/.test(p)) return null;
  return p;
}

function itemNameLooksLikeRealGoodsPositionForKtruSuffixPass(name: string): boolean {
  const n = name.replace(/\s+/g, " ").trim();
  if (n.length < 6) return false;
  return (
    POSITION_START_RE.test(n) ||
    MODEL_FIRST_LINE_RE.test(n) ||
    /картридж|тонер|барабан|снпч|фотобарабан|драм|расходный\s+материал|модуль|чип\b/i.test(n)
  );
}

function buildKtruSuffixAdjacentScanLines(ctx: TechSpecKtruAdjacentSegmentCtx): string[] {
  const lines: string[] = [...ctx.blockLines];
  if (ctx.blockStartInSegment >= 0) {
    const after = ctx.blockStartInSegment + ctx.blockLines.length;
    for (let k = 0; k < 2 && after + k < ctx.segLines.length; k++) {
      lines.push(ctx.segLines[after + k]!);
    }
  }
  return lines;
}

/**
 * Post-pass после parsePositionBlock: один однозначный КТРУ NN.NN.NN.NNN-xxx в окне блока+хвост сегмента → дописать в codes.
 */
function tryEnrichTechSpecItemCodesWithUniqueAdjacentKtruSuffix(
  item: TenderAiGoodItem,
  ctx: TechSpecKtruAdjacentSegmentCtx | undefined
): TenderAiGoodItem {
  if (!ctx) return item;
  if (!(item.sourceHint ?? "").toLowerCase().includes("tech_spec_deterministic")) return item;
  if ((item.positionId ?? "").trim()) return item;
  const base = codesIsSingleBareKtruTripleSegment(item.codes ?? "");
  if (!base) return item;
  if (!itemNameLooksLikeRealGoodsPositionForKtruSuffixPass(item.name ?? "")) return item;

  const scan = buildKtruSuffixAdjacentScanLines(ctx);
  const re = /\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{3,5}(?!\d)/g;
  const baseKey = base.replace(/\s/g, "").toLowerCase();
  const found = new Map<string, string>();
  for (const ln of scan) {
    for (const m of ln.matchAll(re)) {
      const raw = m[0]!.replace(/\s/g, "");
      if (!raw.toLowerCase().startsWith(`${baseKey}-`)) continue;
      const k = raw.toLowerCase();
      if (!found.has(k)) found.set(k, m[0]!.replace(/\s/g, ""));
    }
  }
  if (found.size !== 1) return item;
  const only = [...found.values()][0]!;
  return { ...item, codes: `${base}; ${only}` };
}

function parsePositionBlock(
  blockLines: string[],
  rejectionReasons: string[],
  techSpecRowsRejected: string[],
  logicalPath = "",
  relaxWeakHeader = false,
  verticalBareOrdinalSpecSegment = false,
  verticalBareQtyBelowBlockCtx?: VerticalBareQtyBelowBlockCtx | null
): {
  item: TenderAiGoodItem;
  quantityDiag: { attachedAtRow: number | null; attachSource: string };
} | null {
  const strict = parsePositionBlockStrictInternal(
    blockLines,
    rejectionReasons,
    techSpecRowsRejected,
    logicalPath,
    relaxWeakHeader,
    verticalBareOrdinalSpecSegment,
    verticalBareQtyBelowBlockCtx
  );
  if (strict) return strict;
  return tryParseProseTechPositionBlockFallback(
    blockLines,
    logicalPath,
    rejectionReasons,
    techSpecRowsRejected,
    verticalBareOrdinalSpecSegment
  );
}

function tryParseProseTechPositionBlockFallback(
  blockLines: string[],
  logicalPath: string,
  rejectionReasons: string[],
  techSpecRowsRejected: string[],
  verticalBareOrdinalSpecSegment: boolean
): {
  item: TenderAiGoodItem;
  quantityDiag: { attachedAtRow: number | null; attachSource: string };
} | null {
  if (verticalBareOrdinalSpecSegment) return null;
  const bareOrdinalHead = /^\d{1,3}$/.test((blockLines[0] ?? "").trim());
  if (bareOrdinalHead) return null;

  const cat = classifyDocumentByLogicalPath(logicalPath);
  if (cat !== "technical_spec" && cat !== "technical_part") return null;

  const head0 = (blockLines[0] ?? "").trim();
  if (POSITION_START_RE.test(head0) || MODEL_FIRST_LINE_RE.test(head0)) return null;
  if (/картридж|тонер-туба|тонер|фотобарабан|снпч|барабан-картридж/i.test(head0)) return null;

  const blockText = blockLines.join("\n");
  if (!proseTechGoodsSignalsInBlockText(blockText)) return null;

  let name = "";
  for (const raw of blockLines) {
    const t = raw.trim();
    if (lineIsProseTechFallbackNoiseLine(t)) continue;
    if (t.length < 18 || t.length > 520) continue;
    name = t;
    break;
  }
  if (!name) {
    techSpecRowsRejected.push((blockLines[0] ?? "").trim().slice(0, 100));
    return null;
  }

  if (/^\[\s*Код\s+позиции\s+КТРУ/i.test(name) && name.length < 96) {
    const idx = blockLines.findIndex((raw) => raw.trim() === name);
    let alt = "";
    for (let j = Math.max(0, idx) + 1; j < blockLines.length; j++) {
      const t = blockLines[j]!.trim();
      if (lineIsProseTechFallbackNoiseLine(t)) continue;
      if (t.length < 18) continue;
      alt = t;
      break;
    }
    if (alt.length >= 18) name = alt;
  }

  const codes = collectKtruOkpdCodesFromBlockLines(blockLines);
  const rq = extractProseTechFallbackQuantity(blockLines);

  const nameIdx = blockLines.findIndex((raw) => raw.trim() === name);
  const tail = nameIdx >= 0 ? blockLines.slice(nameIdx + 1) : blockLines.slice(1);
  const charRows: TenderAiCharacteristicRow[] = [];
  for (const raw of tail) {
    const t = raw.trim();
    if (!t || lineIsProseTechFallbackNoiseLine(t)) continue;
    if (t === name) continue;
    if (t.length < 8) continue;
    if (charRows.length >= 3) break;
    charRows.push({
      name: "Фрагмент ТЗ",
      value: normalizeCelsiusRangeGarbles(t.slice(0, 650)),
      sourceHint: "tech_spec"
    });
  }

  rejectionReasons.push(`prose_tech_fallback:${(blockLines[0] ?? "").trim().slice(0, 48)}`);
  const lp = logicalPath.replace(/\s+/g, " ").trim().slice(0, 220);
  const sourceHint = lp ? `tech_spec_deterministic|lp:${lp}` : "tech_spec_deterministic";
  const unitOut = (rq.unitStr || "шт").trim() || "шт";

  return {
    item: {
      name: normalizeCelsiusRangeGarbles(name.slice(0, 800)),
      positionId: "",
      codes,
      unit: unitOut,
      quantity: rq.quantityStr,
      unitPrice: "",
      lineTotal: "",
      sourceHint,
      characteristics: mergeCharacteristics(charRows),
      ...(rq.quantityValue != null ? { quantityValue: rq.quantityValue } : {}),
      quantityUnit: rq.quantityUnit || unitOut,
      quantitySource: rq.quantityStr.trim() ? ("tech_spec" as const) : ("unknown" as const)
    },
    quantityDiag: {
      attachedAtRow: rq.quantityAttachedAtRow,
      attachSource: rq.attachSource
    }
  };
}

function proseTechGoodsSignalsInBlockText(s: string): boolean {
  const t = (s ?? "").replace(/\s+/g, " ");
  if (/ГОСТ\s*\d/i.test(t)) return true;
  if (!!extractKtruOrOkpd(t)) return true;
  if (/(?:\bбензин\b|дизельн|топливо\s+дизельное|\bАИ-(?:92|95|98|100)\b|\bДТ-)/i.test(t)) return true;
  return false;
}

function lineIsProseTechFallbackNoiseLine(t: string): boolean {
  const s = t.trim();
  if (!s || s.length < 12) return true;
  if (lineHasRub(s)) return true;
  if (TABLE_HEADER_RE.test(s)) return true;
  if (/^Подраздел\s+/i.test(s)) return true;
  if (/^Маркировка\b/i.test(s)) return true;
  if (/^ОПИСАНИЕ\s+ОБЪЕКТА\s+ЗАКУПКИ/i.test(s)) return true;
  if (/^Наименование\s+товара/i.test(s)) return true;
  if (/^---+/.test(s) || /^###/.test(s)) return true;
  if (/^УТВЕРЖДАЮ$/i.test(s)) return true;
  if (/утверждаю/i.test(s) && s.length < 48) return true;
  return false;
}

function extractProseTechFallbackQuantity(blockLines: string[]): {
  quantityStr: string;
  quantityUnit: string;
  unitStr: string;
  quantityValue: number | null;
  quantityAttachedAtRow: number | null;
  attachSource: string;
} {
  const text = blockLines.join("\n");
  const m1 = text.match(/Количество\s+поставки\s*:\s*([^\n]+?)(?=\n|$)/i);
  if (m1) {
    const seg = m1[1]!.trim();
    const mqty = seg.match(/(\d+(?:[.,]\d+)?)\s*(тонн|т(?![а-яёa-z])|кг|литр|л(?![а-яёa-z])|шт\.?)/i);
    if (mqty) {
      const qRaw = mqty[1]!.replace(",", ".").replace(/\s/g, "");
      const uRaw = mqty[2]!.toLowerCase();
      let unitStr = "шт";
      if (/тонн/i.test(uRaw)) unitStr = "т";
      else if (/литр|^л$/i.test(uRaw)) unitStr = "л";
      else if (/кг/i.test(uRaw)) unitStr = "кг";
      let quantityValue: number | null = null;
      const nv = parseFloat(qRaw);
      if (Number.isFinite(nv) && nv > 0 && nv < 1_000_000) quantityValue = Math.trunc(nv);
      return {
        quantityStr: quantityValue != null ? String(quantityValue) : qRaw,
        quantityUnit: unitStr,
        unitStr: unitStr,
        quantityValue,
        quantityAttachedAtRow: null,
        attachSource: "prose_tech_fallback_qty_supply"
      };
    }
  }
  for (let i = 0; i < blockLines.length; i++) {
    const ln = blockLines[i]!.trim();
    const m = ln.match(/(\d+(?:[.,]\d+)?)\s*(тонн|литр|л(?![а-яёa-z])|кг|шт\.?)(?=\s|;|\.|,|$)/i);
    if (!m) continue;
    if (!/(?:бензин|дизель|топливо)/i.test(ln)) continue;
    const qRaw = m[1]!.replace(",", ".").replace(/\s/g, "");
    const uRaw = m[2]!.toLowerCase();
    const unitStr = /тонн/i.test(uRaw) ? "т" : uRaw.startsWith("л") ? "л" : uRaw.includes("кг") ? "кг" : "шт";
    let quantityValue: number | null = null;
    const nv = parseFloat(qRaw);
    if (Number.isFinite(nv) && nv > 0 && nv < 1_000_000) quantityValue = Math.trunc(nv);
    return {
      quantityStr: quantityValue != null ? String(quantityValue) : qRaw,
      quantityUnit: unitStr,
      unitStr: unitStr,
      quantityValue,
      quantityAttachedAtRow: i,
      attachSource: "prose_tech_fallback_qty_line"
    };
  }
  return {
    quantityStr: "",
    quantityUnit: "",
    unitStr: "",
    quantityValue: null,
    quantityAttachedAtRow: null,
    attachSource: "prose_tech_fallback_qty_none"
  };
}

function parsePositionBlockStrictInternal(
  blockLines: string[],
  rejectionReasons: string[],
  techSpecRowsRejected: string[],
  logicalPath = "",
  relaxWeakHeader = false,
  verticalBareOrdinalSpecSegment = false,
  verticalBareQtyBelowBlockCtx?: VerticalBareQtyBelowBlockCtx | null
): {
  item: TenderAiGoodItem;
  quantityDiag: { attachedAtRow: number | null; attachSource: string };
} | null {
  if (verticalBareOrdinalSpecSegment && /^\d{1,3}$/.test((blockLines[0] ?? "").trim())) {
    blockLines = truncateVerticalBareOrdinalBlockAtMinimizedCorpusBoundary(blockLines);
  }
  const blockText = blockLines.join("\n");
  const head = (blockLines[0] ?? "").trim();
  const bareOrdinalHead = verticalBareOrdinalSpecSegment && /^\d{1,3}$/.test(head.trim());
  const posFromHead = bareOrdinalHead
    ? head.trim()
    : (head.match(/^\s*(\d{1,4})\s*[\.)]\s+/)?.[1]?.trim() ?? "");
  let name = head.replace(/^\d{1,4}\s*[.)]\s+/, "").trim();
  const fullVerticalOrdTitle =
    bareOrdinalHead && verticalBareOrdinalSpecSegment ? verticalSpecBareOrdinalBlockTitle(blockLines) : "";
  let layoutExtra: TenderAiCharacteristicRow[] = [];
  if (bareOrdinalHead) {
    const spl = verticalSpecBareOrdinalShortTitleFromBlock(blockLines);
    name = spl.shortTitle;
    layoutExtra = spl.extraCharacteristicRows;
    if (name.length < 6) name = fullVerticalOrdTitle || spl.shortTitle;
  }
  if (name.length < 6) {
    rejectionReasons.push(`short_name:${head.slice(0, 60)}`);
    techSpecRowsRejected.push(head.slice(0, 100));
    return null;
  }
  const nameForWeakGate =
    bareOrdinalHead && fullVerticalOrdTitle.length > 0
      ? Math.max(name.length, fullVerticalOrdTitle.length)
      : name.length;
  const strongHeader =
    POSITION_START_RE.test(head) ||
    MODEL_FIRST_LINE_RE.test(head) ||
    /картридж|тонер|барабан|снпч|модуль|чип|canon|hp\b|brother|kyocera|lexmark|ricoh|xerox|sharp|oki\b|tk-|cf\d|ce\d|tn-/i.test(
      name
    );
  const numberedHead = /^(?:\d{1,4}\s*[.)]\s+)/.test(head.trim()) || bareOrdinalHead;
  if (!strongHeader) {
    /** Без \\b: в JS граница слова для кириллицы ненадёжна; ед. изм. — см. verticalSpecBlockHasUnitOrQtySignals. */
    const verticalQtySignals =
      verticalBareOrdinalSpecSegment &&
      bareOrdinalHead &&
      verticalSpecBlockHasUnitOrQtySignals(blockText);
    const allowLoose =
      relaxWeakHeader &&
      numberedHead &&
      nameForWeakGate >= verticalSpecMinLooseNameLen(verticalBareOrdinalSpecSegment, bareOrdinalHead) &&
      (/(?:КТРУ|ОКПД|наименован|товар|модел|издели|характеристик)/i.test(blockText) ||
        !!extractKtruOrOkpd(blockText) ||
        verticalQtySignals);
    if (!allowLoose) {
      rejectionReasons.push(`weak_header:${head.slice(0, 60)}`);
      techSpecRowsRejected.push(head.slice(0, 100));
      return null;
    }
  }

  const codes = collectKtruOkpdCodesFromBlockLines(blockLines);
  let rq = resolveDeterministicGoodsQuantity(
    blockLines,
    blockText,
    relaxWeakHeader,
    numberedHead,
    verticalBareOrdinalSpecSegment && bareOrdinalHead
  );
  if (
    !rq &&
    verticalBareQtyBelowBlockCtx &&
    verticalBareOrdinalSpecSegment &&
    !bareOrdinalHead &&
    blockLines.length > 0 &&
    blockLines.length <= VERTICAL_BARE_PEEK_QTY_MAX_BLOCK_LINES &&
    POSITION_START_RE.test(head)
  ) {
    const peekRq = tryVerticalBareDeterministicQtyBelowPositionBlock(verticalBareQtyBelowBlockCtx);
    if (peekRq) rq = peekRq;
  }
  if (!rq) {
    /**
     * Bypass для вертикальной bare-ordinal таблицы без колонки «Количество» (Тенд32:
     * «Описание объекта закупки» имеет колонки №/Наименование/ОКПД2/КТРУ без кол-ва).
     * Условие: bareOrdinalHead + ОКПД/КТРУ в блоке + relaxWeakHeader (allowGenericNumbered).
     * Позиция принимается с пустым количеством.
     */
    const allowNoQtyBypass =
      verticalBareOrdinalSpecSegment &&
      bareOrdinalHead &&
      !!codes.trim() &&
      relaxWeakHeader;
    if (!allowNoQtyBypass) {
      rejectionReasons.push(`no_qty:${name.slice(0, 50)}`);
      techSpecRowsRejected.push(name.slice(0, 100));
      return null;
    }
    rq = {
      quantityValue: null,
      quantityUnit: "шт",
      quantityStr: "",
      unitStr: "шт",
      quantityAttachedAtRow: null,
      quantityAttachSource: "no_qty_column_bypass"
    };
  }

  const bodyTail = blockLines.slice(1);
  const preMerged = mergeContinuationLinesForCharacteristics(bodyTail);
  const fromDetect = parseCharacteristicsForPositionBody(preMerged);
  const relaxed = parseRelaxedColonAndTabCharacteristicLines(preMerged);
  const bodyGraphNames = new Set(
    [...fromDetect.rows, ...relaxed].map((r) => r.name.replace(/\s+/g, " ").trim().toLowerCase())
  );
  const layoutExtraDeduped =
    verticalBareOrdinalSpecSegment && bareOrdinalHead
      ? layoutExtra.filter((r) => {
          const k = r.name.replace(/\s+/g, " ").trim().toLowerCase();
          return !bodyGraphNames.has(k);
        })
      : layoutExtra;
  const packRows: TenderAiCharacteristicRow[] = [];
  if (verticalBareOrdinalSpecSegment) {
    const packs: string[] = [];
    for (const ln of blockLines) {
      const pack = extractPackagingNoteFromLine(ln);
      if (pack) packs.push(pack);
    }
    if (packs.length > 0) {
      const packList =
        verticalBareOrdinalSpecSegment && bareOrdinalHead ? dedupePackagingExtracts(packs) : [...new Set(packs)];
      packRows.push({
        name: "Комплектация / фасовка",
        value: normalizeCelsiusRangeGarbles(packList.join(". ")),
        sourceHint: "tech_spec"
      });
    }
  }
  const extraBareInject =
    verticalBareOrdinalSpecSegment && bareOrdinalHead ? collectVerticalBareDeterministicInjections(preMerged) : [];
  const mergeCharsRows = [
    ...fromDetect.rows,
    ...relaxed,
    ...extraBareInject,
    ...layoutExtraDeduped,
    ...packRows
  ];
  let mergedChars =
    verticalBareOrdinalSpecSegment && bareOrdinalHead
      ? mergeCharacteristicsVerticalBareOrdinal(mergeCharsRows, name)
      : mergeCharacteristics(mergeCharsRows);
  if (verticalBareOrdinalSpecSegment && bareOrdinalHead) {
    mergedChars = healVerticalBareGluedСоставCharacteristicName(mergedChars);
    mergedChars = mergeCharacteristicsVerticalBareOrdinal(mergedChars, name);
  }
  const stripped = stripVerticalSpecTitleEchoFromCharacteristics(name, mergedChars);
  mergedChars =
    verticalBareOrdinalSpecSegment && bareOrdinalHead
      ? mergeCharacteristicsVerticalBareOrdinal(stripped, name)
      : mergeCharacteristics(stripped);
  if (verticalBareOrdinalSpecSegment && bareOrdinalHead) {
    name = tryEnrichVerticalBareNameWithQuotedBrand(name, preMerged);
    mergedChars = injectVerticalBareBodyWhenMissing(mergedChars, preMerged, name);
    mergedChars = detachEmbeddedColorAndPackFromMaterialRow(mergedChars, name);
    mergedChars = stripVerticalSpecTitleEchoFromCharacteristics(name, mergedChars);
    mergedChars = mergeCharacteristicsVerticalBareOrdinal(mergedChars, name);
    mergedChars = healVerticalBareOrdinalDescriptionAfterStrip(name, mergedChars, preMerged);
    mergedChars = mergeCharacteristicsVerticalBareOrdinal(mergedChars, name);
    mergedChars = injectVerticalBareWeightFromCardNameIfMissing(name, mergedChars);
    mergedChars = mergeCharacteristicsVerticalBareOrdinal(mergedChars, name);
    mergedChars = finalizeVerticalBareOrdinalCharacteristicLayers(mergedChars, name);
    mergedChars = expandVerticalBareOrdinalDescriptionIfStunted(name, mergedChars, preMerged);
    mergedChars = mergeCharacteristicsVerticalBareOrdinal(mergedChars, name);
    mergedChars = expandVerticalBareOrdinalDescriptionFromCardNameTail(name, mergedChars);
    mergedChars = mergeCharacteristicsVerticalBareOrdinal(mergedChars, name);
  }
  if (verticalBareOrdinalSpecSegment) {
    mergedChars = mergedChars.map((r) => ({
      ...r,
      name: normalizeCelsiusRangeGarbles(r.name),
      value: normalizeCelsiusRangeGarbles(r.value)
    }));
  }
  const lp = logicalPath.replace(/\s+/g, " ").trim().slice(0, 220);
  const sourceHint = lp ? `tech_spec_deterministic|lp:${lp}` : "tech_spec_deterministic";

  let positionIdOut = (posFromHead ?? "").trim();
  /** Вертикальная спека: реестровый id часто в теле блока; раньше скан был отключён из‑за `!verticalBareOrdinalSpecSegment` → pid пустой без enrich. */
  const registryBlockLinesOk =
    !verticalBareOrdinalSpecSegment || blockLines.length >= 3;
  if (strongHeader && !bareOrdinalHead && !positionIdOut && registryBlockLinesOk) {
    const fromBlock = extractRegistryPositionIdNearStartOfTechSpecBlock(blockLines, 32);
    if (fromBlock) positionIdOut = fromBlock;
  }

  return {
    item: {
      name: normalizeCelsiusRangeGarbles(name.slice(0, 800)),
      positionId: positionIdOut,
      codes,
      unit: rq.unitStr,
      quantity: rq.quantityStr,
      unitPrice: "",
      lineTotal: "",
      sourceHint,
      characteristics: mergedChars,
      ...(rq.quantityValue != null ? { quantityValue: rq.quantityValue } : {}),
      quantityUnit: rq.quantityUnit,
      quantitySource: "tech_spec" as const
    },
    quantityDiag: {
      attachedAtRow: rq.quantityAttachedAtRow,
      attachSource: rq.quantityAttachSource
    }
  };
}

/**
 * Fallback-границы позиции по якорям PositionBlock (Идентификатор / КТРУ: / модель «Картридж…эквивалент»);
 * характеристики — parseCharacteristicsForPositionBody по телу блока.
 */
function parsePositionBlockFromBackbone(
  pb: PositionBlock,
  rejectionReasons: string[],
  techSpecRowsRejected: string[],
  logicalPath: string,
  relaxQtyHeader: boolean
): {
  item: TenderAiGoodItem;
  quantityDiag: { attachedAtRow: number | null; attachSource: string };
} | null {
  const blockLines = [pb.headerLine, ...pb.lines];
  const blockText = blockLines.join("\n");
  const hdr = pb.headerLine.trim();
  const pid = (pb.pid ?? "").trim();

  let name = "";
  if (LINE_CARTRIDGE_MODEL_EQUIV_ANCHOR.test(hdr)) {
    name = hdr;
  } else {
    for (const ln of pb.lines) {
      const t = ln.trim();
      const nsm = t.match(/^наименование\s*(?:товара)?\s*:\s*(.+)$/i);
      if (nsm?.[1]) {
        const c = nsm[1].trim();
        if (c.length > name.length) name = c;
      }
    }
    if (name.length < 6) {
      for (const ln of pb.lines) {
        const t = ln.trim();
        if (!t || t.length < 8) continue;
        if (POSITION_START_RE.test(t) || MODEL_FIRST_LINE_RE.test(t)) {
          name = t.replace(/^\d{1,4}\s*[.)]\s+/, "").trim();
          break;
        }
      }
    }
    if (name.length < 6 && pid) {
      name = `Позиция ${pid}`;
    }
    if (name.length < 6) {
      name = hdr.length >= 6 ? hdr : "Товарная позиция";
    }
  }

  let codes = "";
  for (const ln of blockLines) {
    const fullKtru = ln.trim().match(LINE_KTRU_COLON_ANCHOR)?.[1];
    if (fullKtru) {
      codes = fullKtru;
      break;
    }
  }
  if (!codes) {
    codes = collectKtruOkpdCodesFromBlockLines(blockLines);
  }

  let positionIdOut = "";
  if (pid && isRegistryStylePositionId(pid)) {
    positionIdOut = pid.replace(/^№\s*/i, "").trim().slice(0, 80);
  }
  if (!positionIdOut) {
    const cartridgeLikeHdr =
      LINE_CARTRIDGE_MODEL_EQUIV_ANCHOR.test(hdr) ||
      POSITION_START_RE.test(hdr) ||
      MODEL_FIRST_LINE_RE.test(hdr);
    if (cartridgeLikeHdr) {
      const fromBlock = extractRegistryPositionIdNearStartOfTechSpecBlock(blockLines, 32);
      if (fromBlock) positionIdOut = fromBlock;
    }
  }

  const rq = resolveDeterministicGoodsQuantity(blockLines, blockText, relaxQtyHeader, false);
  if (!rq) {
    rejectionReasons.push(`position_block_backbone_no_qty:${(pid || hdr).slice(0, 40)}`);
    techSpecRowsRejected.push(pb.headerLine.slice(0, 100));
    return null;
  }

  const preMerged = mergeContinuationLinesForCharacteristics(pb.lines);
  const fromDetect = parseCharacteristicsForPositionBody(preMerged);
  const relaxed = parseRelaxedColonAndTabCharacteristicLines(preMerged);
  const mergedChars = mergeCharacteristics([...fromDetect.rows, ...relaxed]);

  const lp = logicalPath.replace(/\s+/g, " ").trim().slice(0, 220);
  const sourceHint = lp
    ? `tech_spec_deterministic|position_block_backbone|lp:${lp}`
    : "tech_spec_deterministic|position_block_backbone";

  return {
    item: {
      name: name.slice(0, 800),
      positionId: positionIdOut,
      codes,
      unit: rq.unitStr,
      quantity: rq.quantityStr,
      unitPrice: "",
      lineTotal: "",
      sourceHint,
      characteristics: mergedChars,
      ...(rq.quantityValue != null ? { quantityValue: rq.quantityValue } : {}),
      quantityUnit: rq.quantityUnit,
      quantitySource: "tech_spec" as const
    },
    quantityDiag: {
      attachedAtRow: rq.quantityAttachedAtRow,
      attachSource: rq.quantityAttachSource
    }
  };
}

/** Таблица ТЗ: есть заголовки и/или несколько стартов позиций подряд. */
function detectTechSpecTable(
  techText: string,
  positionStartCount: number,
  headerHits: number
): boolean {
  if (positionStartCount >= 2) return true;
  if (headerHits >= 2 && positionStartCount >= 1) return true;
  if (SECTION_MARK_RE.test(techText) && positionStartCount >= 1 && headerHits >= 1) return true;
  return false;
}

export function shouldUseTechSpecBackbone(r: ExtractGoodsFromTechSpecResult): boolean {
  if (r.techSpecExtractedCount >= 2) return true;
  if (r.parseAudit.techSpecTableDetected && r.techSpecExtractedCount >= 1) return true;
  return false;
}

export type TechSpecBackboneSegmentDiagnostic = {
  logicalPath: string;
  lineCount: number;
  normalParsedCount: number;
  positionBlockStarts: number;
  explain: PositionBlockBackboneSegmentExplain;
};

/**
 * По сегментам strict-tech: сколько позиций даёт штатный разбор и почему backbone не включается.
 * Для отладки архивных тендеров (см. harness experiment2-backbone-diagnostic).
 */
export function diagnosePositionBlockBackboneSegments(techText: string): TechSpecBackboneSegmentDiagnostic[] {
  const segments = splitStrictTechTextByLogicalPathSegments(techText);
  const out: TechSpecBackboneSegmentDiagnostic[] = [];
  for (const seg of segments) {
    const { allowGenericNumbered: allowGen, verticalBareTable: verticalBare } = splitOptsForTechSpecSegment(
      seg.logicalPath,
      seg.lines
    );
    const { blocks, starts } = splitTechTextIntoPositionBlocks(seg.lines, {
      allowGenericNumbered: allowGen,
      logicalPath: seg.logicalPath
    });
    const rejectionReasons: string[] = [];
    const techSpecRowsRejected: string[] = [];
    let normalParsed = 0;
    if (blocks.length > 0) {
      for (let bi = 0; bi < blocks.length; bi++) {
        const block = blocks[bi]!;
        if (
          parsePositionBlock(
            block,
            rejectionReasons,
            techSpecRowsRejected,
            seg.logicalPath,
            allowGen,
            verticalBare,
            verticalBareQtyBelowBlockCtxForSplitBlock(seg.lines, starts, bi, allowGen, verticalBare, block)
          )
        ) {
          normalParsed++;
        }
      }
    }
    out.push({
      logicalPath: seg.logicalPath,
      lineCount: seg.lines.length,
      normalParsedCount: normalParsed,
      positionBlockStarts: starts.length,
      explain: explainPositionBlockBackboneForSegment(seg.lines, normalParsed)
    });
  }
  return out;
}

/** Сводка по одному сегменту strict-tech (аудит потерь позиций). */
export function getTechSpecSegmentPositionStats(
  segLines: string[],
  logicalPath: string
): {
  logicalPath: string;
  positionStarts: number;
  splitBlocks: number;
  normalParsedOk: number;
  backboneWouldUse: boolean;
  backboneRowsParsedOk: number;
  positionBlockAnchored: number;
} {
  const { allowGenericNumbered: allowGen, verticalBareTable: verticalBare } = splitOptsForTechSpecSegment(
    logicalPath,
    segLines
  );
  const rejectionReasons: string[] = [];
  const techSpecRowsRejected: string[] = [];
  const { blocks, starts } = splitTechTextIntoPositionBlocks(segLines, {
    allowGenericNumbered: allowGen,
    logicalPath
  });
  let normalParsedOk = 0;
  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi]!;
    if (
      parsePositionBlock(
        block,
        rejectionReasons,
        techSpecRowsRejected,
        logicalPath,
        allowGen,
        verticalBare,
        verticalBareQtyBelowBlockCtxForSplitBlock(segLines, starts, bi, allowGen, verticalBare, block)
      )
    ) {
      normalParsedOk++;
    }
  }
  let backboneRowsParsedOk = 0;
  const pbs = extractPositionBlocksFromTechSpec(segLines);
  const anchored = pbs.filter((b) => positionBlockHeaderIsKnownAnchor(b.headerLine));
  for (const pb of pbs) {
    if (!positionBlockHeaderIsKnownAnchor(pb.headerLine)) continue;
    if (parsePositionBlockFromBackbone(pb, rejectionReasons, techSpecRowsRejected, logicalPath, allowGen)) {
      backboneRowsParsedOk++;
    }
  }
  const backboneWouldUse = shouldUsePositionBlockBackboneForSegment(segLines, normalParsedOk);
  return {
    logicalPath,
    positionStarts: starts.length,
    splitBlocks: blocks.length,
    normalParsedOk,
    backboneWouldUse,
    backboneRowsParsedOk,
    positionBlockAnchored: anchored.length
  };
}

/**
 * Harness: локализация потери строк «Тонер/Барабан-картридж…» в одном strict-tech сегменте (напр. Тенд32).
 * Только чтение — тот же split/parse, что и в extractGoodsFromTechSpec, без изменения пайплайна.
 */
export type TechSpecRealProductLineTraceHit = {
  lineIndex: number;
  linePreview: string;
  blockIndex: number;
  blockStartLineIndex: number;
  blockLineCount: number;
  blockHeadPreview: string;
  parseOk: boolean;
  parseRejectionSample: string[];
  parsedPositionId: string | null;
  parsedNamePreview: string | null;
  parsedCharacteristicsCount: number | null;
  survivesVerticalBareDedupe: boolean | null;
  wouldSkipInExtractSeenDedupe: boolean;
};

export type TechSpecSegmentRealProductLossDiag = {
  logicalPath: string;
  segmentLineCount: number;
  allowGenericNumbered: boolean;
  verticalBareTable: boolean;
  blockCount: number;
  startCount: number;
  startIndicesHead: number[];
  normalParsedOkCount: number;
  usePositionBlockBackbone: boolean;
  backboneRowsParsedOkCount: number;
  realProductLineHitsTotal: number;
  hits: TechSpecRealProductLineTraceHit[];
};

function diagLineLooksLikeRealProductCandidate(ln: string): boolean {
  const t = ln.trim();
  if (t.length < 14) return false;
  if (lineHasRub(t)) return false;
  return POSITION_START_RE.test(t) || MODEL_FIRST_LINE_RE.test(t) || /(?:Тонер-картридж|Барабан-картридж|Тонер-туба)/i.test(t);
}

function diagBlockIndexForLine(starts: number[], lineIdx: number): number {
  let b = 0;
  for (let i = 0; i < starts.length; i++) {
    if (starts[i]! <= lineIdx) b = i;
    else break;
  }
  return b;
}

export function diagnoseTechSpecSegmentRealProductLoss(
  segLines: string[],
  logicalPath: string
): TechSpecSegmentRealProductLossDiag {
  const { allowGenericNumbered: allowGen, verticalBareTable: verticalBare } = splitOptsForTechSpecSegment(
    logicalPath,
    segLines
  );
  const { blocks, starts } = splitTechTextIntoPositionBlocks(segLines, {
    allowGenericNumbered: allowGen,
    logicalPath
  });

  type PB =
    | {
        ok: true;
        item: TenderAiGoodItem;
        quantityDiag: { attachedAtRow: number | null; attachSource: string };
        head: string;
        rr: string[];
      }
    | { ok: false; head: string; rr: string[] };

  const perBlock: PB[] = [];
  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi]!;
    const rr: string[] = [];
    const tr: string[] = [];
    const head = (block[0] ?? "").trim().slice(0, 120);
    const p = parsePositionBlock(
      block,
      rr,
      tr,
      logicalPath,
      allowGen,
      verticalBare,
      verticalBareQtyBelowBlockCtxForSplitBlock(segLines, starts, bi, allowGen, verticalBare, block)
    );
    if (!p) perBlock.push({ ok: false, head, rr: rr.slice(0, 10) });
    else perBlock.push({ ok: true, item: p.item, quantityDiag: p.quantityDiag, head, rr: rr.slice(0, 6) });
  }

  const normalParsedOkCount = perBlock.filter((x) => x.ok).length;

  const rejectionBB: string[] = [];
  const techSpecRowsRejectedBB: string[] = [];
  let backboneRowsParsedOkCount = 0;
  const pbs = extractPositionBlocksFromTechSpec(segLines);
  for (const pb of pbs) {
    if (!positionBlockHeaderIsKnownAnchor(pb.headerLine)) continue;
    if (parsePositionBlockFromBackbone(pb, rejectionBB, techSpecRowsRejectedBB, logicalPath, allowGen)) {
      backboneRowsParsedOkCount++;
    }
  }
  const usePositionBlockBackbone = shouldUsePositionBlockBackboneForSegment(segLines, normalParsedOkCount);

  const okRows: VerticalBareDedupeRow[] = [];
  const okRowBlockIdx: number[] = [];
  for (let bi = 0; bi < perBlock.length; bi++) {
    const x = perBlock[bi]!;
    if (!x.ok) continue;
    okRows.push({ item: x.item, quantityDiag: x.quantityDiag, head: x.head });
    okRowBlockIdx.push(bi);
  }
  const afterDedupe =
    verticalBare && okRows.length > 0 ? dedupeVerticalBareOrdinalParsedRows(okRows) : okRows;
  const survivedBlock = new Set<number>();
  for (const row of afterDedupe) {
    const i = okRows.indexOf(row);
    if (i >= 0) survivedBlock.add(okRowBlockIdx[i]!);
  }

  const seenTok = new Set<string>();
  const skippedBySeen = new Set<number>();
  for (let bi = 0; bi < perBlock.length; bi++) {
    const x = perBlock[bi]!;
    if (!x.ok) continue;
    const g = x.item;
    const tok = normalizeNameKey(g.name) + "|" + g.quantity + "|" + g.codes;
    if (seenTok.has(tok)) skippedBySeen.add(bi);
    else seenTok.add(tok);
  }

  const hits: TechSpecRealProductLineTraceHit[] = [];
  for (let i = 0; i < segLines.length; i++) {
    if (!diagLineLooksLikeRealProductCandidate(segLines[i] ?? "")) continue;
    const bi = diagBlockIndexForLine(starts, i);
    const block = blocks[bi]!;
    const pb = perBlock[bi]!;
    const bStart = starts[bi] ?? 0;
    hits.push({
      lineIndex: i,
      linePreview: (segLines[i] ?? "").trimEnd().slice(0, 140),
      blockIndex: bi,
      blockStartLineIndex: bStart,
      blockLineCount: block.length,
      blockHeadPreview: (block[0] ?? "").trim().slice(0, 100),
      parseOk: pb.ok,
      parseRejectionSample: pb.ok ? pb.rr : pb.rr,
      parsedPositionId: pb.ok ? (pb.item.positionId ?? "").trim().slice(0, 40) : null,
      parsedNamePreview: pb.ok ? (pb.item.name ?? "").trim().slice(0, 120) : null,
      parsedCharacteristicsCount: pb.ok ? pb.item.characteristics?.length ?? 0 : null,
      survivesVerticalBareDedupe: verticalBare ? (pb.ok ? survivedBlock.has(bi) : null) : null,
      wouldSkipInExtractSeenDedupe: pb.ok ? skippedBySeen.has(bi) : false
    });
  }

  return {
    logicalPath,
    segmentLineCount: segLines.length,
    allowGenericNumbered: allowGen,
    verticalBareTable: verticalBare,
    blockCount: blocks.length,
    startCount: starts.length,
    startIndicesHead: starts.slice(0, 40),
    normalParsedOkCount,
    usePositionBlockBackbone,
    backboneRowsParsedOkCount,
    realProductLineHitsTotal: hits.length,
    hits: hits.slice(0, 35)
  };
}

/** Маркеры реальной товарной строки (не строка матрицы «показатель х значение»). */
const TECH_SPEC_MATRIX_DROP_GOODS_NAME_MARKERS_RE =
  /картридж|тонер|барабан|драм|\bdrum\b|\btoner\b|\bcartridge\b|фотобарабан|снпч|\bsnpc\b|расходный\s+материал/i;

/**
 * Строка наименования как ячейка матрицы характеристик: «Тип х …», «Марка х …» (без маркеров картриджа/тонера).
 * Узко: только после нормализации пробелов, начало с фиксированного списка + разделитель х/x/Х/X.
 */
function techSpecItemNameLooksLikeExplodedCharacteristicMatrixRow(name: string): boolean {
  const t = name.replace(/\s+/g, " ").trim();
  if (t.length < 8) return false;
  if (TECH_SPEC_MATRIX_DROP_GOODS_NAME_MARKERS_RE.test(t)) return false;
  return /^(?:тип|назначение|форм-фактор|марка|модель)\s+[хХxX](?:\s|$|[,.;:!])/i.test(t);
}

function dominantTechSpecLogicalPathFromItems(items: TenderAiGoodItem[]): string {
  const counts = new Map<string, number>();
  for (const g of items) {
    const p = logicalPathFromSourceHint(g.sourceHint ?? "").trim();
    if (!p) continue;
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  let best = "";
  let bestN = 0;
  for (const [k, v] of counts) {
    if (v > bestN) {
      bestN = v;
      best = k;
    }
  }
  return best;
}

function techSpecSegmentByLogicalPath(
  segments: Array<{ logicalPath: string; lines: string[] }>,
  lp: string
): { logicalPath: string; lines: string[] } | undefined {
  const t = lp.replace(/\s+/g, " ").trim();
  return segments.find((s) => s.logicalPath.replace(/\s+/g, " ").trim() === t);
}

/**
 * Жёсткий гейт «Тенд32-подобно»: вертикальная спецификация ЕИС + узкий диапазон числа позиций +
 * массовый pid «1» + доля имён-матрицы + все строки из детерминированного ТЗ.
 */
function shouldApplyTechSpecMatrixCharacteristicRowPostFilter(
  items: TenderAiGoodItem[],
  segments: Array<{ logicalPath: string; lines: string[] }>
): boolean {
  const n = items.length;
  if (n < 10 || n > 22) return false;
  if (!items.length || !items.every((g) => /tech_spec/i.test(g.sourceHint ?? ""))) return false;

  const lp = dominantTechSpecLogicalPathFromItems(items);
  if (!lp) return false;
  const seg = techSpecSegmentByLogicalPath(segments, lp);
  if (!seg) return false;
  if (!segmentLooksLikeVerticalEisSpecification(seg.logicalPath, seg.lines)) return false;

  const pidOne = items.filter((g) => (g.positionId ?? "").trim() === "1").length;
  if (pidOne < 8) return false;

  const matrixLike = items.filter((g) => techSpecItemNameLooksLikeExplodedCharacteristicMatrixRow(g.name ?? "")).length;
  const minMatrix = Math.max(7, Math.ceil(n * 0.45));
  if (matrixLike < minMatrix) return false;

  return true;
}

function applyTechSpecMatrixCharacteristicRowPostFilter(
  items: TenderAiGoodItem[],
  segments: Array<{ logicalPath: string; lines: string[] }>,
  diagnostics: string[]
): TenderAiGoodItem[] {
  if (!shouldApplyTechSpecMatrixCharacteristicRowPostFilter(items, segments)) return items;
  const out = items.filter((g) => !techSpecItemNameLooksLikeExplodedCharacteristicMatrixRow(g.name ?? ""));
  if (out.length === 0) {
    diagnostics.push("tech_spec_matrix_char_row_post_filter_skipped_all_would_be_removed");
    return items;
  }
  const removed = items.length - out.length;
  if (removed > 0) {
    diagnostics.push(`tech_spec_matrix_char_row_post_filter_removed=${removed}`);
  }
  return out;
}

function applyTechSpecMatrixCharacteristicRowPostFilterWithQtyAttach(
  items: TenderAiGoodItem[],
  qtyAttach: string[],
  segments: Array<{ logicalPath: string; lines: string[] }>,
  diagnostics: string[]
): { items: TenderAiGoodItem[]; qtyAttach: string[] } {
  if (!shouldApplyTechSpecMatrixCharacteristicRowPostFilter(items, segments)) {
    return { items, qtyAttach };
  }
  const out: TenderAiGoodItem[] = [];
  const outAttach: string[] = [];
  for (let i = 0; i < items.length; i++) {
    const g = items[i]!;
    if (techSpecItemNameLooksLikeExplodedCharacteristicMatrixRow(g.name ?? "")) continue;
    out.push(g);
    outAttach.push(qtyAttach[i] ?? "unknown");
  }
  if (out.length === 0) {
    diagnostics.push("tech_spec_matrix_char_row_post_filter_skipped_all_would_be_removed");
    return { items, qtyAttach };
  }
  const removed = items.length - out.length;
  if (removed > 0) {
    diagnostics.push(`tech_spec_matrix_char_row_post_filter_removed=${removed}`);
  }
  return { items: out, qtyAttach: outAttach };
}

/**
 * ШАГ 3.3: остаточные строки-«ячейки» матрицы («Тип х …», «Марка х …») без маркеров товара.
 * Всегда узко, без условия n/pid из shouldApplyTechSpecMatrixCharacteristicRowPostFilter (там n>22 отключает гейт).
 * Тот же предикат, что и у жёсткого matrix post-filter — не трогает bare_3_2 картриджи (в имени есть тонер/картридж/…).
 */
function applyTechSpecResidualExplodedMatrixNamePostFilter(
  items: TenderAiGoodItem[],
  qtyAttach: string[],
  diagnostics: string[]
): { items: TenderAiGoodItem[]; qtyAttach: string[] } {
  const matrixLikeBefore = items.filter((g) => techSpecItemNameLooksLikeExplodedCharacteristicMatrixRow(g.name ?? ""))
    .length;
  const out: TenderAiGoodItem[] = [];
  const outAttach: string[] = [];
  let dropped = 0;
  for (let i = 0; i < items.length; i++) {
    const g = items[i]!;
    if (techSpecItemNameLooksLikeExplodedCharacteristicMatrixRow(g.name ?? "")) {
      dropped++;
      continue;
    }
    out.push(g);
    outAttach.push(qtyAttach[i] ?? "unknown");
  }
  if (matrixLikeBefore > 0) {
    diagnostics.push(`tech_spec_residual_matrix_name_step33_matrix_like_survivors_before=${matrixLikeBefore}`);
  }
  if (dropped > 0) {
    diagnostics.push(`tech_spec_residual_matrix_name_step33_removed=${dropped}`);
  }
  return { items: out, qtyAttach: outAttach };
}

/**
 * Полный проход по маскированному корпусу: ТЗ-текст → блоки позиций → goodsItems.
 */
export function extractGoodsFromTechSpec(maskedFullCorpus: string): ExtractGoodsFromTechSpecResult {
  const diagnostics: string[] = [];
  const rejectionReasons: string[] = [];
  const techSpecRowsParsed: string[] = [];
  const techSpecRowsRejected: string[] = [];

  const slice = extractPriorityLayersForGoodsTech(maskedFullCorpus ?? "");
  let classification = buildGoodsCorpusClassification(slice.corpusForGoodsTechExtraction);
  let techText = classification.strictTechText;
  let usedPriorityInput = slice.usedPrioritySlice;
  if (!techText.trim() && slice.usedPrioritySlice) {
    diagnostics.push("priority_slice_strict_tech_empty_fallback_full_corpus_classification");
    classification = buildGoodsCorpusClassification(maskedFullCorpus ?? "");
    techText = classification.strictTechText;
    usedPriorityInput = false;
  }
  diagnostics.push(
    `priority_slice_input=${slice.usedPrioritySlice},used_for_extract=${usedPriorityInput},priority_paths_n=${slice.logicalPathsInPriority.length},strict_tech_chars=${techText.length},ancillary_excluded=[${classification.ancillaryExcludedFileIndexes.join(",")}]`
  );
  if (!techText.trim()) {
    diagnostics.push("strict_tech_corpus_empty");
  }

  const lines = techText.split("\n");
  let headerHits = 0;
  for (const ln of lines) {
    if (TABLE_HEADER_RE.test(ln.trim())) headerHits++;
  }

  const segments = splitStrictTechTextByLogicalPathSegments(techText);
  const items: TenderAiGoodItem[] = [];
  const techSpecQuantityAttachSources: string[] = [];
  const positionSamples: Array<{
    positionId: string;
    namePreview: string;
    characteristicsCount: number;
    logicalPath: string;
    quantityValue: number | null;
    quantityUnit: string;
    quantityAttachedAtRow: number | null;
    quantityAttachSource: string;
  }> = [];
  const seen = new Set<string>();
  let totalStarts = 0;
  let techSpecClusterCount = 0;

  const runFallbackClusterOnLines = (segLines: string[], logicalPath: string) => {
    const rowIndices: number[] = [];
    for (let i = 0; i < segLines.length; i++) {
      if (lineLooksLikeTechSpecGoodsRow(segLines[i]!)) rowIndices.push(i);
    }
    if (rowIndices.length === 0) return;
    const groups = clusterLineIndices(rowIndices);
    const seenKeys = new Set<string>();
    const seenCodeOnlyCodeQty = new Set<string>();
    const lp = logicalPath.replace(/\s+/g, " ").trim().slice(0, 220);
    const isCodeOnlyAnchor = (t: string): boolean =>
      /^\s*\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{3,12}(?!\d)\s*$/i.test(t) ||
      /^\s*\d{2}\.\d{2}\.\d{2}\.\d{2,3}(?:\.\d{3})?(?!\d)\s*$/i.test(t);

    const segmentHasVerticalQtyHeaders = (() => {
      let hasUnit = false;
      let hasQty = false;
      for (const ln of segLines) {
        const t = (ln ?? "").trim();
        if (!t) continue;
        if (!hasUnit && (/^ед\.?\s*изм\.?$/i.test(t) || /^единиц/i.test(t))) hasUnit = true;
        if (!hasQty && /^(?:кол-?\s*во|количеств)/i.test(t)) hasQty = true;
        if (hasUnit && hasQty) return true;
      }
      return false;
    })();
    const codeOnlyAnchorsInSegment = (() => {
      let n = 0;
      for (const ln of segLines) if (isCodeOnlyAnchor((ln ?? "").trim())) n++;
      return n;
    })();

    for (const g of groups) {
      const sortedGroup = [...g].sort((a, b) => a - b);
      for (const li of g) {
        const single = (segLines[li] ?? "").trim();
        let parsed = parseTechSpecTableLine(single);
        let ctxLines: string[] = [];
        if (!parsed) {
          const lo = Math.max(0, li - 8);
          const hi = Math.min(segLines.length, li + 22);
          const windowLines = segLines.slice(lo, hi).map((s) => s.trimEnd());
          /** Merged-окно пробуем только для code-only anchor и только в “вертикальном OOZ” с явными заголовками. */
          if (!isCodeOnlyAnchor(single)) continue;
          if (!segmentHasVerticalQtyHeaders) continue;
          /**
           * Узкий анти-false-positive: merged-режим включаем только когда в сегменте явно «вертикальная таблица»
           * (несколько код-якорей). Иначе одиночный код в тексте/характеристиках может родить лишнюю позицию.
           */
          if (codeOnlyAnchorsInSegment < 4) continue;
          const merged = windowLines.join(" ").replace(/\s+/g, " ").trim();
          if (merged.length > single.length + 8) {
            parsed = parseTechSpecTableLine(merged, {
              quantitySourceLines: windowLines,
              codeAnchorLine: single
            });
            if (parsed) ctxLines = sliceContextLinesUntilNextCodeAnchor(windowLines, single);
          }
        }
        if (!parsed) continue;
        if (ctxLines.length === 0) {
          const pos = sortedGroup.indexOf(li);
          const nextStart =
            pos >= 0 && pos < sortedGroup.length - 1 ? sortedGroup[pos + 1]! : Math.min(segLines.length, li + 36);
          ctxLines = segLines.slice(li + 1, Math.max(li + 1, nextStart)).map((s) => s.trimEnd());
        }
        parsed = enrichTechSpecTableLineItemCharacteristicsFromContextLines(parsed, ctxLines);
        techSpecRowsParsed.push(single.slice(0, 120));
        const codeOnlyKey =
          isCodeOnlyAnchor(single) && parsed.codes
            ? `code_only|${parsed.codes.replace(/\s/g, "").toLowerCase()}|${(parsed.quantity ?? "").trim()}|${(parsed.unit || parsed.quantityUnit || "").trim()}`
            : "";
        if (codeOnlyKey && seenCodeOnlyCodeQty.has(codeOnlyKey)) continue;
        if (codeOnlyKey) seenCodeOnlyCodeQty.add(codeOnlyKey);

        const key = `${parsed.quantity}|${normalizeNameKey(parsed.name)}|${parsed.codes}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        const withHint: TenderAiGoodItem = {
          ...parsed,
          sourceHint: lp ? `tech_spec_table_line|lp:${lp}` : "tech_spec_table_line"
        };
        const gk = normalizeNameKey(withHint.name) + "|" + withHint.quantity + "|" + withHint.codes;
        if (seen.has(gk)) continue;
        seen.add(gk);
        items.push(withHint);
        techSpecQuantityAttachSources.push("tech_spec_table_line");
        if (positionSamples.length < 8) {
          positionSamples.push({
            positionId: withHint.positionId ?? "",
            namePreview: (withHint.name ?? "").slice(0, 80),
            characteristicsCount: withHint.characteristics?.length ?? 0,
            logicalPath: lp,
            quantityValue: withHint.quantityValue ?? null,
            quantityUnit: (withHint.quantityUnit || withHint.unit || "").trim(),
            quantityAttachedAtRow: 0,
            quantityAttachSource: "tech_spec_table_line"
          });
        }
      }
    }
  };

  for (const seg of segments) {
    const segLines = seg.lines;
    const { allowGenericNumbered: allowGen, verticalBareTable: verticalBare } = splitOptsForTechSpecSegment(
      seg.logicalPath,
      segLines
    );
    const { blocks, starts } = splitTechTextIntoPositionBlocks(segLines, {
      allowGenericNumbered: allowGen,
      logicalPath: seg.logicalPath
    });
    totalStarts += starts.length;

    type SegmentParsedRow = VerticalBareDedupeRow;

    const segmentNormalRows: SegmentParsedRow[] = [];
    if (blocks.length > 0) {
      for (let bi = 0; bi < blocks.length; bi++) {
        const block = blocks[bi]!;
        const head = (block[0] ?? "").trim().slice(0, 120);
        const parsed = parsePositionBlock(
          block,
          rejectionReasons,
          techSpecRowsRejected,
          seg.logicalPath,
          allowGen,
          verticalBare,
          verticalBareQtyBelowBlockCtxForSplitBlock(segLines, starts, bi, allowGen, verticalBare, block)
        );
        if (parsed) {
          segmentNormalRows.push({
            ...parsed,
            head,
            ktruAdjacentSegmentCtx: {
              blockLines: [...block],
              segLines,
              blockStartInSegment: starts[bi] ?? -1
            }
          });
        }
      }
    }
    const normalRowsForSegment =
      verticalBare && segmentNormalRows.length > 0
        ? dedupeVerticalBareOrdinalParsedRows(segmentNormalRows)
        : segmentNormalRows;

    let chosenRows: SegmentParsedRow[] = [];
    let usedPositionBlockBackbone = false;
    const useBackbone = shouldUsePositionBlockBackboneForSegment(segLines, normalRowsForSegment.length);

    if (useBackbone) {
      const pbs = extractPositionBlocksFromTechSpec(segLines);
      const backboneRows: SegmentParsedRow[] = [];
      for (const pb of pbs) {
        if (!positionBlockHeaderIsKnownAnchor(pb.headerLine)) continue;
        const parsed = parsePositionBlockFromBackbone(
          pb,
          rejectionReasons,
          techSpecRowsRejected,
          seg.logicalPath,
          allowGen
        );
        if (parsed) {
          const bl = [pb.headerLine, ...pb.lines];
          backboneRows.push({
            ...parsed,
            head: pb.headerLine.trim().slice(0, 120),
            ktruAdjacentSegmentCtx: {
              blockLines: bl,
              segLines,
              blockStartInSegment: findTechSpecBlockStartInSegment(segLines, bl)
            }
          });
        }
      }
      if (backboneRows.length > 0) {
        chosenRows = backboneRows;
        usedPositionBlockBackbone = true;
        diagnostics.push(
          `position_block_backbone:lp=${seg.logicalPath || "(none)"},norm=${normalRowsForSegment.length},backbone=${backboneRows.length}`
        );
      }
    }

    if (chosenRows.length === 0) {
      if (blocks.length === 0) {
        diagnostics.push(`segment_fallback_cluster:lp=${seg.logicalPath || "(none)"}`);
        runFallbackClusterOnLines(segLines, seg.logicalPath);
        continue;
      }
      chosenRows = normalRowsForSegment;
    }

    techSpecClusterCount += usedPositionBlockBackbone
      ? Math.max(blocks.length, chosenRows.length)
      : blocks.length;

    for (const row of chosenRows) {
      const head = row.head;
      const g = tryEnrichTechSpecItemCodesWithUniqueAdjacentKtruSuffix(row.item, row.ktruAdjacentSegmentCtx);
      techSpecRowsParsed.push(head);
      const toks = normalizeNameKey(g.name) + "|" + g.quantity + "|" + g.codes;
      if (seen.has(toks)) {
        rejectionReasons.push(`duplicate_block:${head.slice(0, 40)}`);
        continue;
      }
      seen.add(toks);
      items.push(g);
      techSpecQuantityAttachSources.push(row.quantityDiag.attachSource);
      if (positionSamples.length < 8) {
        positionSamples.push({
          positionId: g.positionId ?? "",
          namePreview: (g.name ?? "").slice(0, 80),
          characteristicsCount: g.characteristics?.length ?? 0,
          logicalPath: logicalPathFromSourceHint(g.sourceHint ?? ""),
          quantityValue: g.quantityValue ?? null,
          quantityUnit: (g.quantityUnit || g.unit || "").trim(),
          quantityAttachedAtRow: row.quantityDiag.attachedAtRow,
          quantityAttachSource: row.quantityDiag.attachSource
        });
      }
    }
  }

  if (items.length === 0 && segments.length > 0) {
    diagnostics.push("fallback_single_line_cluster_full_strict_tech");
    runFallbackClusterOnLines(lines, "");
  }
  if (items.length === 0) rejectionReasons.push("no_position_start_lines");

  const noticeTextForRegistry = (() => {
    if (items.length === 0) return "";
    const cls = buildGoodsCorpusClassification(maskedFullCorpus ?? "");
    const strict = (cls.strictNoticeText ?? "").trim();
    /** Реестровые id часто только в полном корпусе, когда strict-notice пуст (см. match-goods mergeDedupeNoticeAnchors). */
    if (strict.length >= 80) return strict;
    const full = (maskedFullCorpus ?? "").trim();
    return full.length > strict.length ? full : strict;
  })();
  const noticeRegistryEnrich = enrichCartridgeRegistryPositionIdsFromNoticeCorpus(items, noticeTextForRegistry);
  if (noticeRegistryEnrich.enriched > 0) {
    diagnostics.push(`registry_position_id_from_notice_enriched=${noticeRegistryEnrich.enriched}`);
  }
  const codesPairEnrich = enrichTechSpecRegistryPositionIdsByCodesCorpusPairLines(
    noticeRegistryEnrich.items,
    noticeTextForRegistry
  );
  if (codesPairEnrich.enriched > 0) {
    diagnostics.push(`registry_position_id_from_codes_pair_lines=${codesPairEnrich.enriched}`);
  }
  let itemsOut = codesPairEnrich.items;
  let techSpecQtyAttachOut = techSpecQuantityAttachSources;
  if (techSpecQtyAttachOut.length !== itemsOut.length) {
    diagnostics.push(`tech_spec_qty_attach_len_mismatch=${techSpecQtyAttachOut.length}_vs_${itemsOut.length}`);
    techSpecQtyAttachOut = itemsOut.map(() => "unknown");
  }
  const postMatrix = applyTechSpecMatrixCharacteristicRowPostFilterWithQtyAttach(
    itemsOut,
    techSpecQtyAttachOut,
    segments,
    diagnostics
  );
  itemsOut = postMatrix.items;
  techSpecQtyAttachOut = postMatrix.qtyAttach;

  const postResidualMatrix = applyTechSpecResidualExplodedMatrixNamePostFilter(
    itemsOut,
    techSpecQtyAttachOut,
    diagnostics
  );
  itemsOut = postResidualMatrix.items;
  techSpecQtyAttachOut = postResidualMatrix.qtyAttach;

  const canon067hPidStrip = stripDuplicateRegistryPidFromConsecutiveCanon067hColorVariantRows(itemsOut);
  itemsOut = canon067hPidStrip.items;
  if (canon067hPidStrip.cleared > 0) {
    diagnostics.push(`tech_spec_strip_dup_pid_canon067h_variants=${canon067hPidStrip.cleared}`);
  }

  const canon067hOrderRestore = restoreCanon067hConsecutiveVariantPidsFromTechCorpus(itemsOut, techText);
  itemsOut = canon067hOrderRestore.items;
  if (canon067hOrderRestore.restored > 0) {
    diagnostics.push(`tech_spec_canon067h_order_pid_restore=${canon067hOrderRestore.restored}`);
  }
  const strictLinePid = enrichCartridgeRegistryPositionIdsStrictSameLineTechCorpus(itemsOut, techText);
  itemsOut = strictLinePid.items;
  if (strictLinePid.enriched > 0) {
    diagnostics.push(`tech_spec_strict_line_registry_pid_restore=${strictLinePid.enriched}`);
  }
  let techBlockText = "";
  if (lines.length > 0) {
    const startsAll: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const L = lines[i]!.trim();
      if (!L || lineHasRub(L)) continue;
      if (lineStartsPosition(L, { allowGenericNumbered: true })) startsAll.push(i);
    }
    if (startsAll.length > 0) {
      const a = Math.max(0, startsAll[0]! - 5);
      const b = Math.min(lines.length - 1, (startsAll[startsAll.length - 1] ?? 0) + 40);
      techBlockText = lines.slice(a, b + 1).join("\n");
    }
  }

  const techSpecTableDetected = detectTechSpecTable(techText, Math.max(totalStarts, itemsOut.length), headerHits);
  diagnostics.push(
    `position_starts=${totalStarts},header_hits=${headerHits},table_detected=${techSpecTableDetected},segments=${segments.length}`
  );

  const charRowsAtTechSpecParse = itemsOut.reduce((acc, g) => acc + (g.characteristics?.length ?? 0), 0);
  const pathsWithItems = new Set<string>();
  for (const it of itemsOut) {
    const p = logicalPathFromSourceHint(it.sourceHint ?? "");
    if (p) pathsWithItems.add(p);
  }
  const parseAudit: GoodsTechSpecParseAudit = {
    techSpecTableDetected,
    techSpecClusterCount: Math.max(techSpecClusterCount, totalStarts, itemsOut.length),
    techSpecExtractedCount: itemsOut.length,
    techSpecRowsParsed,
    techSpecRowsRejected,
    rejectionReasons,
    finalRetainedFromTechSpecCount: itemsOut.length,
    prioritySliceDiagnostics: {
      usedRoutedPrioritySlice: usedPriorityInput,
      logicalPathsInPriorityCorpus: slice.logicalPathsInPriority,
      logicalPathsWithExtractedItems: [...pathsWithItems],
      goodsExtractedCount: itemsOut.length,
      charRowsAtTechSpecParse,
      notePostParse:
        "charRowsAtTechSpecParse — после детерминированного разбора ТЗ; reconcile/sanitize могут уменьшить число строк в финальном analysis",
      positionSamples
    }
  };

  return {
    items: itemsOut,
    techBlockText,
    techSpecExtractedCount: itemsOut.length,
    diagnostics,
    parseAudit,
    strictTechCorpusChars: techText.length,
    techSpecQuantityAttachSources: techSpecQtyAttachOut
  };
}

/** Harness: блоки в том же порядке, что и в extractGoodsFromTechSpec (strict-tech + split). */
export function listDeterministicTechSpecBlocksForHarness(maskedFullCorpus: string): Array<{
  logicalPath: string;
  block: string[];
}> {
  const slice = extractPriorityLayersForGoodsTech(maskedFullCorpus ?? "");
  const classification = buildGoodsCorpusClassification(slice.corpusForGoodsTechExtraction);
  const techText = classification.strictTechText;
  const out: Array<{ logicalPath: string; block: string[] }> = [];
  for (const seg of splitStrictTechTextByLogicalPathSegments(techText)) {
    const { allowGenericNumbered: allowGen } = splitOptsForTechSpecSegment(seg.logicalPath, seg.lines);
    const { blocks } = splitTechTextIntoPositionBlocks(seg.lines, {
      allowGenericNumbered: allowGen,
      logicalPath: seg.logicalPath
    });
    for (const block of blocks) {
      out.push({ logicalPath: seg.logicalPath, block });
    }
  }
  return out;
}

function normalizeNameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .slice(0, 96)
    .trim();
}

function isTechSpecStandaloneKtruOrOkpdCodeLine(t: string): boolean {
  const u = t.trim();
  return (
    /^\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{3,12}(?!\d)$/i.test(u) ||
    /^\d{2}\.\d{2}\.\d{2}\.\d{2,3}(?:\.\d{3})?(?!\d)$/i.test(u)
  );
}

/** Строки между якорем-кодом и следующим кодом в вертикальном окне — тело одной позиции. */
function sliceContextLinesUntilNextCodeAnchor(windowLines: string[], anchorLine: string): string[] {
  const all = windowLines.map((s) => s.trimEnd().trim());
  const ax = all.findIndex((x) => x === anchorLine.trim());
  if (ax < 0) return [];
  const after = all.slice(ax + 1);
  let end = after.length;
  for (let i = 0; i < after.length; i++) {
    if (isTechSpecStandaloneKtruOrOkpdCodeLine(after[i]!)) {
      end = i;
      break;
    }
  }
  return after.slice(0, end).slice(0, 24);
}

/** Строка похожа на значение графа ТЗ, а не на подпись для loose-пары «строка / следующая строка». */
function lineLooksLikeLooseTechSpecValueOnlyLine(t: string): boolean {
  const L = t.replace(/\s+/g, " ").trim();
  if (L.length < 4) return true;
  /** `\b` после кириллицы в JS ненадёжен — граница через явный пробел/цифру. */
  if (/^(?:не\s+менее|не\s+более|не\s+ниже|не\s+выше)\s/i.test(L)) return true;
  if (/^(?:да|нет)(?:[.,]\s*|\s*)$/i.test(L)) return true;
  if (/^(?:для|под)\s+[а-яёА-ЯЁ]/i.test(L) && L.length <= 90) return true;
  if (/^\d+[.,]\d+/.test(L)) return true;
  if (/^\d+\s*[–-]\s*\d+/.test(L)) return true;
  if (/^\d+(?:[.,]\d+)?\s*(?:%|°|кг|г|л|мл)(?=\s|[.,;)]|$)/i.test(L)) return true;
  if (/^(?:от\s+\d|до\s+\d)/i.test(L)) return true;
  if (/^\d+\s*(?:суток|сут|часов|час|дн[еяей]|месяц|лет)(?=\s|[.,;)]|$)/i.test(L)) return true;
  return false;
}

/** Следующая строка похожа на новую подпись графа (без «:»), а не на значение к текущей подписи. */
function lineLooksLikeLooseTechSpecHeaderWithoutColon(t: string): boolean {
  const L = t.replace(/\s+/g, " ").trim();
  if (L.length < 6 || L.length > 150) return false;
  if (
    /^(?:вид|тип|наличие|массовая|срок|условия|температур|назначен|объ[её]м|количеств|степень|уровень|содержан|качеств|характеристик)(?=\s|[,;(])/i.test(
      L
    )
  ) {
    return true;
  }
  if (/, %\s*$/.test(L)) return true;
  if (/(?:^|\s)%\s*$/.test(L)) return true;
  return false;
}

/**
 * Вертикальный tech-spec / OOZ: после `mergeContinuationLinesForCharacteristics` часть граф
 * идёт двумя строками «подпись» / «значение» без «:». Тогда `parseRelaxedColonAndTabCharacteristicLines`
 * склеивает хвост в один `relaxedOrphan` → одно «Описание товара». Здесь поднимаем реальные пары
 * из тех же строк (без домысла значений).
 */
function tryExtractVerticalOozeLooseGraphRowsFromContext(mergedLines: string[]): TenderAiCharacteristicRow[] {
  const out: TenderAiCharacteristicRow[] = [];
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  for (let i = 0; i < mergedLines.length; i++) {
    const raw = mergedLines[i]!;
    const L = norm(raw);
    if (L.length < 4 || PROC_CHAR_JUNK.test(L)) continue;
    if (isTechSpecStandaloneKtruOrOkpdCodeLine(L)) continue;

    if (L.includes(":")) {
      for (const piece of splitVerticalSpecGluedGraphLines(raw.trim())) {
        const tp = piece.replace(/\s+/g, " ").trim();
        const m = tp.match(/^([А-Яа-яЁёA-Za-z0-9][^:]{0,400}?)\s*:\s*(.+)$/);
        if (!m?.[1] || !m[2]) continue;
        let name = canonicalCharacteristicName(m[1]!.trim());
        if (CHARACTERISTIC_NAME_SIGNATORY_LINE_RE.test(name)) continue;
        if (PROC_CHAR_JUNK.test(name)) continue;
        let value = stripCorpusRoutingMarkerFromTechSpecValue(
          truncateAppendedLegalBoilerplateFromDescriptionValue(name, m[2]!.trim())
        );
        if (name.length < 2 || value.length < 1) continue;
        out.push({ name, value, sourceHint: "tech_spec" });
      }
      continue;
    }

    const next = i + 1 < mergedLines.length ? norm(mergedLines[i + 1]!) : "";
    if (!next || next.length < 1) continue;
    if (next.includes("\t") || next.includes(":")) continue;
    if (/^\d{1,4}\s*[.)]\s+\S/.test(next)) continue;
    if (isTechSpecStandaloneKtruOrOkpdCodeLine(next)) continue;
    if (PROC_CHAR_JUNK.test(next)) continue;
    if (/^(?:кг\.?|л\.?|шт\.?|г\.?|мл\.?|м2|м²|м3)$/i.test(next.replace(/\s/g, ""))) continue;
    if (/^(?:количеств|кол-?\s*во|ед\.?\s*изм\.?|quantity)(?=\s|:|,)/i.test(L)) continue;
    if (lineLooksLikeQtyLabelRow(L) || lineLooksLikeQuantityLabelButMeansPackageFilling(L)) continue;
    if (lineLooksLikeCharacteristicRow(L)) continue;
    if (lineLooksLikeLooseTechSpecValueOnlyLine(L)) continue;

    const labelish =
      /[а-яёa-z]{5,}/i.test(L) &&
      L.length >= 8 &&
      L.length <= 140 &&
      !/^\d+[.,]\d+/.test(L) &&
      !isNumericQuantityCell(L.replace(/\s/g, " "));

    if (!labelish) continue;

    if (lineLooksLikeLooseTechSpecHeaderWithoutColon(next)) continue;

    const nextLooksQtyOnly = /^\d+(?:[.,]\d+)?\s*(?:кг|л|мл|г|шт\.?)?\s*$/i.test(next);
    const valish =
      nextLooksQtyOnly ||
      /\d|%|°/.test(next) ||
      (next.length <= 95 && /[а-яёa-z]{3,}/i.test(next) && next.length <= L.length + 35);

    if (!valish) continue;

    const name = canonicalCharacteristicName(L.slice(0, 200));
    if (PROC_CHAR_JUNK.test(name)) continue;
    const value = normalizeCelsiusRangeGarbles(
      stripCorpusRoutingMarkerFromTechSpecValue(
        truncateAppendedLegalBoilerplateFromDescriptionValue(name, next.slice(0, 1200))
      )
    );
    if (value.length < 1) continue;
    out.push({ name, value, sourceHint: "tech_spec" });
    i++;
  }
  return out;
}

/**
 * Для `parseTechSpecTableLine` позиция часто выделяется без тела блока → characteristics пустые.
 * Поднимаем пары из соседних строк того же локального контекста (без выдумывания значений).
 */
function enrichTechSpecTableLineItemCharacteristicsFromContextLines(
  item: TenderAiGoodItem,
  contextLines: string[]
): TenderAiGoodItem {
  if ((item.characteristics?.length ?? 0) > 0) return item;
  const nm = (item.name ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  const codeCompact = (item.codes ?? "").replace(/\s/g, "").trim().toLowerCase();
  const cleaned = contextLines
    .map((s) => s.replace(/\s+$/, "").trim())
    .filter((t) => t.length >= 3)
    .filter((t) => !lineHasRub(t))
    .filter((t) => !TABLE_HEADER_RE.test(t))
    .filter((t) => {
      if (nm && t.toLowerCase().replace(/\s+/g, " ").trim() === nm) return false;
      if (/^\d{1,4}\s*[.)]\s+\S/.test(t)) return false;
      return true;
    })
    .filter((t) => {
      const tc = t.replace(/\s/g, "").toLowerCase();
      if (codeCompact && tc === codeCompact) return false;
      if (isTechSpecStandaloneKtruOrOkpdCodeLine(t)) return false;
      return true;
    });
  if (cleaned.length === 0) return item;
  const preMerged = mergeContinuationLinesForCharacteristics(cleaned);
  const loose = tryExtractVerticalOozeLooseGraphRowsFromContext(preMerged);
  const fromDetect = parseCharacteristicsForPositionBody(preMerged);
  const relaxed = parseRelaxedColonAndTabCharacteristicLines(preMerged);
  const structured = loose.length >= 2;
  const relaxedFiltered = structured
    ? relaxed.filter((r) => {
        const kn = (r.name ?? "").trim().toLowerCase();
        if (/^описание/.test(kn) && (r.value ?? "").length > 120) return false;
        return true;
      })
    : relaxed;
  let rows = mergeCharacteristics([...fromDetect.rows, ...relaxedFiltered, ...loose]);
  rows = rows.filter((r) => !lineLooksLikeLooseTechSpecValueOnlyLine(r.name ?? ""));
  if (rows.length === 0) return item;
  return { ...item, characteristics: rows };
}

export type ParseTechSpecTableLineOpts = {
  /** Реальные строки окна (а не одна склеенная строка): для вертикального OOZ, где unit/qty разнесены. */
  quantitySourceLines?: string[];
  /** Строка-якорь позиции (часто только код): допускает парсинг merged-окна при строгих структурных гейтах. */
  codeAnchorLine?: string;
};

/** Однострочный fallback (старая логика), если блоки не нашлись — для мелких ТЗ. */
export function parseTechSpecTableLine(line: string, opts?: ParseTechSpecTableLineOpts): TenderAiGoodItem | null {
  const raw = line.trim();
  const anchor = (opts?.codeAnchorLine ?? "").trim();
  const anchorIsCodeOnly =
    /^\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{3,12}(?!\d)$/i.test(anchor) ||
    /^\d{2}\.\d{2}\.\d{2}\.\d{2,3}(?:\.\d{3})?(?!\d)$/i.test(anchor);

  if (!lineLooksLikeTechSpecGoodsRow(raw)) {
    /**
     * Merged-окно без «N шт» в одной строке не похоже на goods row, но anchor-код надёжен.
     * Разрешаем только когда anchor — код-строка целиком.
     */
    if (!anchor || !anchorIsCodeOnly) return null;
  }
  const pos = raw.match(/^\s*(\d{1,4})\s*[\.)]\s/)?.[1] ?? "";
  let rest = raw.replace(/^\s*\d{1,4}\s*[\.)]\s+/, "");
  const codeFromAnchor = anchor ? extractKtruOrOkpd(anchor) : "";
  const codeFromRest = extractKtruOrOkpd(rest);
  const codes = (codeFromAnchor || codeFromRest).trim();
  if (codes) rest = rest.replace(codes, " ");
  const qtyLines =
    opts?.quantitySourceLines?.length && opts.quantitySourceLines.length > 0
      ? opts.quantitySourceLines.map((s) => s.trim())
      : [raw];
  const rq = resolveDeterministicGoodsQuantity(qtyLines, raw, false, false, opts?.quantitySourceLines ? true : false);

  const fallbackVerticalUnitThenNumber = (): { quantity: string; unit: string; quantityValue: number | null } | null => {
    if (!opts?.quantitySourceLines || !anchorIsCodeOnly) return null;
    const all = opts.quantitySourceLines.map((s) => s.trim());
    /**
     * Заголовки «Ед. изм.» / «Кол-во» могут находиться выше локального окна вокруг кода (вертикальная таблица),
     * поэтому гейт по заголовкам применяется на уровне сегмента (см. runFallbackClusterOnLines).
     * Здесь — только локальная проверка unit→число рядом с якорем.
     */

    /** В окне может быть 2 кода (соседние позиции). Чтобы не «схватить» qty/ед.изм. от соседа — сканируем локально вокруг якоря. */
    const anchorIdx = anchor ? all.findIndex((x) => x.trim() === anchor) : -1;
    const lo = anchorIdx >= 0 ? Math.max(0, anchorIdx - 8) : 0;
    const hi = anchorIdx >= 0 ? Math.min(all.length, anchorIdx + 14) : all.length;
    const L = all.slice(lo, hi).map((s) => s.trim()).filter(Boolean);

    for (let i = 0; i < L.length; i++) {
      const uRaw = L[i] ?? "";
      if (!uRaw) continue;
      const uNorm = uRaw.replace(/\s+/g, " ").trim();
      const unitTok = uNorm.toLowerCase().replace(/\s/g, "");
      const unitOk = isUnitTableCell(uNorm) || /^(?:кг\.?|л\.?|шт\.?|м2|м²|г\.?|м\.?|м3)$/i.test(unitTok);
      if (!unitOk) continue;
      for (let j = i + 1; j <= Math.min(L.length - 1, i + 4); j++) {
        const qRaw = (L[j] ?? "").trim();
        if (!qRaw) continue;
        const qCompact = qRaw.replace(/\s/g, "");
        if (!isNumericQuantityCell(qCompact)) continue;
        if (cellLooksLikeKtruOkpdOrRegistry(qCompact)) continue;
        const n = parseDeterministicQuantityNumberFragment(qCompact);
        if (n == null || n <= 0 || n > 999_999) continue;
        const unit = uNorm.replace(/\.+$/g, "").trim();
        return { quantity: formatQuantityValueForStorage(n), unit, quantityValue: n };
      }
    }
    return null;
  };

  const rq2 = rq
    ? { quantity: rq.quantityStr, unit: rq.unitStr, quantityValue: rq.quantityValue ?? null }
    : fallbackVerticalUnitThenNumber();
  if (!rq2) return null;
  const quantity = rq2.quantity;
  const unit = rq2.unit;
  rest = rest
    .replace(
      new RegExp(
        `${quantity.replace(".", "[.,]")}\\s*${unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        "i"
      ),
      " "
    )
    .trim();
  let name = rest.replace(/\s+/g, " ").replace(/^[\d\s.,;:|-]+/, "").trim();
  /**
   * Вертикальный OOZ: название — строкой над кодом. В merged-строке хвост характеристик может быть «товарнее»
   * и давать ложные name → лишние позиции. Поэтому для code-only anchor берём только строку над кодом
   * (и не позволяем характеристику стать названием).
   */
  if (opts?.quantitySourceLines?.length && anchorIsCodeOnly) {
    const lines = opts.quantitySourceLines.map((s) => s.trim());
    const anchorIdx = lines.findIndex((x) => x.trim() === anchor);
    if (anchorIdx > 0) {
      for (let i = anchorIdx - 1; i >= 0; i--) {
        const t = (lines[i] ?? "").trim();
        if (!t) continue;
        if (/^(?:кол-?\s*во|ед\.?\s*изм|единиц\w+\s+измерен|наименование)\b/i.test(t)) continue;
        if (/^\d{2}\.\d{2}\.\d{2}/.test(t)) continue;
        if (isNumericQuantityCell(t.replace(/\s/g, ""))) continue;
        const tok = t.toLowerCase().replace(/\s/g, "");
        if (isUnitTableCell(t) || /^(?:кг\.?|л\.?|шт\.?|м2|м²|г\.?|м\.?|м3)$/i.test(tok)) continue;
        if (lineLooksLikeCharacteristicRow(t)) continue;
        if (t.length >= 3) {
          name = t.replace(/\s+/g, " ").trim();
          break;
        }
      }
    }
  }
  if (name.length < 3) return null;
  if (/^(наименование|п\/п|ед\.?\s*изм|количество|код)\s*$/i.test(name)) return null;
  /** Заголовки/итоги таблиц и «денежные» ячейки не должны становиться товарами. */
  if (/(?:\bруб\b|руб\.|сумма|итого|цена\s+за\s+единиц|стоимость\s+позиции)/i.test(name)) return null;
  if (!/[а-яёa-z]{3,}/i.test(name)) return null;
  return {
    name: name.slice(0, 800),
    positionId: pos || (anchorIsCodeOnly ? codes.replace(/\s/g, "") : ""),
    codes,
    unit,
    quantity,
    unitPrice: "",
    lineTotal: "",
    sourceHint: "tech_spec_table_line",
    characteristics: [],
    ...(rq2.quantityValue != null ? { quantityValue: rq2.quantityValue } : {}),
    quantityUnit: unit,
    quantitySource: "tech_spec" as const
  };
}
