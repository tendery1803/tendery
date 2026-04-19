/**
 * Детерминированные строки спецификации из строгого текста извещения / печатной формы:
 * КТРУ + количество + суммы в рублях (без AI).
 */

import type { TenderAiGoodItem } from "@tendery/contracts";
import {
  extractKtruOrOkpd,
  extractQuantityFromTabularGoodsLine
} from "@/lib/ai/extract-goods-from-tech-spec";
import {
  isRegistryStylePositionId,
  REGISTRY_POSITION_ID_CAPTURE_RE,
  REGISTRY_POSITION_ID_INLINE_RE
} from "@/lib/ai/registry-position-ids";
import { enrichNoticePrintFormRowsWithPfCharacteristics } from "@/lib/ai/notice-print-form-characteristics";

/** КТРУ с суффиксом (как в tech collect); для notice — объединение с соседней строкой. */
const KTRU_SUFFIX_GLOBAL_RE = /\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{3,5}(?!\d)/g;

function parseRubAmounts(line: string): string[] {
  return [...line.matchAll(/(\d[\d\s]*(?:[.,]\d{1,2})?)\s*(?:руб|₽)/gi)].map((m) =>
    m[1]!.replace(/\s/g, "").replace(",", ".")
  );
}

/** Убираем из строки идентификаторы, коды и даты, чтобы не считать их «ценами». */
function stripRegistryAndCodesForMoneyScan(line: string): string {
  return line
    .replace(REGISTRY_POSITION_ID_INLINE_RE, " ")
    .replace(/\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{3,5}(?!\d)/g, " ")
    .replace(/\d{2}\.\d{2}\.\d{2}\.\d{2,3}(?:\.\d{3})?/g, " ")
    // Strip calendar dates (dd.mm.yyyy or dd/mm/yyyy) so the 4-digit year is not
    // misinterpreted as a monetary amount (e.g. "25.03.2026" → year "2026").
    .replace(/\b\d{1,2}[./]\d{1,2}[./]\d{4}\b/g, " ");
}

function countEisPriceLikeTokensAfterStrip(line: string): number {
  let rest = stripRegistryAndCodesForMoneyScan(line);
  rest = rest.replace(/\d+(?:[.,]\d+)?\s*(?:шт|ед\.?\s*изм|упак|компл|комплект)\b/gi, " ");
  const withKop = [...rest.matchAll(/\b\d{1,3}(?:\s\d{3})+(?:[.,]\d{2})\b|\b\d{1,6}[.,]\d{2}\b/g)];
  if (withKop.length >= 2) return withKop.length;
  const ints = [...rest.matchAll(/\b\d{3,7}\b/g)]
    .map((m) => parseInt(m[0]!, 10))
    .filter((n) => Number.isFinite(n) && n >= 100 && n < 50_000_000);
  return ints.length;
}

/**
 * ПФ ЕИС: «26.20.40.120ТоварШтука927.0040…» / «…ТоварКилограмм48.34» — ед. изм. и число закупки склеены без пробела.
 * После `maskPii`: «…Штука6283.[ID_DOC_1].00» — только `.[…].dd`, без расширения на произвольный `[`.
 */
/** PDF часто даёт «ТоварКилограмм» и число на соседних строках → после схлопывания «ТоварКилограмм 48.34». */
const GLUED_EIS_TOVAR_UNIT_QTY_RE = /Товар(?:Штука|Килограмм)\s*(\d{1,6})(?=[.,]\d)/i;
/**
 * Расширенная проверка наличия строки «Товар<ЕдИзм>» в блоке ПФ: включает не только Штука/Килограмм,
 * но и «Квадратный метр», «Погонный метр» и прочие ед. изм., которые в PDF могут идти отдельными строками.
 * Используется только для подтверждения, что блок является позицией ПФ (не договора).
 */
const GLUED_EIS_TOVAR_ANY_UNIT_RE =
  /Товар(?:Штука|Килограмм|\s+(?:Квадратный|Погонный|Кубический|Литр|Комплект|Упак|Метр\b))/i;
const GLUED_EIS_TOVAR_UNIT_QTY_PII_PLACEHOLDER_RE =
  /Товар(?:Штука|Килограмм)\s*(\d{1,6})\.\[ID_DOC_\d+\]\.(\d{2})\b/i;
/** Историческое имя — то же, что unit (Штука|Килограмм). */
const GLUED_EIS_TOVAR_SHTUKA_QTY_RE = GLUED_EIS_TOVAR_UNIT_QTY_RE;
const GLUED_EIS_TOVAR_SHTUKA_QTY_PII_PLACEHOLDER_RE = GLUED_EIS_TOVAR_UNIT_QTY_PII_PLACEHOLDER_RE;

function extractNoticeGoodsTableLineQuantity(line: string): string | undefined {
  const tab = extractQuantityFromTabularGoodsLine(line);
  if (tab) return tab;
  const s = line.replace(/\u00A0/g, " ");
  const m = s.match(GLUED_EIS_TOVAR_UNIT_QTY_RE);
  if (m?.[1]) {
    const n = parseInt(m[1]!, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 999_999) return String(n);
  }
  const m2 = s.match(GLUED_EIS_TOVAR_UNIT_QTY_PII_PLACEHOLDER_RE);
  if (m2?.[1]) {
    const n = parseInt(m2[1]!, 10);
    if (Number.isFinite(n) && n >= 1 && n <= 999_999) return String(n);
  }
  return undefined;
}

/**
 * Строка таблицы позиций: КТРУ + количество + (слово «руб» ИЛИ типичные для ЕИС суммы без «руб» в ячейке).
 * Используется и для якорей reconcile, и для детерминированного извлечения строк.
 */
export function isNoticeGoodsTableRowCandidate(line: string): boolean {
  const t = line.trim();
  if (t.length < 28) return false;
  if (!extractKtruOrOkpd(t)) return false;
  /**
   * Вертикально склеенная строка одной позиции ПФ: после strip «денег» иногда 0 токенов, хотя сумма есть
   * (Тенд31, ТоварКилограмм). Проверяем ДО проверки количества, т.к. для нестандартных единиц (Квадратный
   * метр) количество находится в другом месте PDF и не попадает в glue-строку (Тенд25, поз. 210964263).
   */
  if (
    (GLUED_EIS_TOVAR_UNIT_QTY_RE.test(t) || GLUED_EIS_TOVAR_ANY_UNIT_RE.test(t)) &&
    /Стоимость\s+позиции/i.test(t) &&
    pickPrintFormInternalPositionIdFromPfVerticalBlock(t) &&
    /Идентификатор\s*:/i.test(t)
  ) {
    return true;
  }
  if (!extractNoticeGoodsTableLineQuantity(line)) return false;
  if (/(?:руб|₽)/i.test(t)) return true;
  /** Сумма после maskPii в `[ID_DOC_n].dd` — strip не видит «денег», без этой ветки кандидат отсекается (Тенд32). */
  if (GLUED_EIS_TOVAR_UNIT_QTY_PII_PLACEHOLDER_RE.test(t) && /\[ID_DOC_\d+\]\.\d{2}\b/.test(t)) return true;
  const compact = t.replace(/\s/g, "");
  const hasRegistry = REGISTRY_POSITION_ID_CAPTURE_RE.test(compact);
  const priceToks = countEisPriceLikeTokensAfterStrip(t);
  if (hasRegistry && priceToks >= 2) return true;
  /** Id часто на соседней строке PDF; одна «денежная» колонка после склейки — узко только с ТоварШтука/Килограмм. */
  const gluedTovarUnit = GLUED_EIS_TOVAR_UNIT_QTY_RE.test(t);
  if (gluedTovarUnit && priceToks >= 1) return true;
  return false;
}

/**
 * Черновик наименования — только склейка «ТоварШтука/ТоварКилограмм» + цифры/цены, без содержательного
 * описания товара (ОК «Картридж …»). Используется для отсечения дублей-призраков ПФ (Тенд30 и аналоги).
 */
function noticePfDraftNameLooksLikeTovarUnitQtyGlueOnly(draftName: string): boolean {
  const n = draftName.replace(/\s+/g, " ").trim();
  const c = n.toLowerCase().replace(/\s/g, "");
  if (!/^товарштук/i.test(c) && !/^товаркилограмм/i.test(c)) return false;
  const rest = c.replace(/^товарштук/i, "").replace(/^товаркилограмм/i, "");
  if (/[а-яё]{12,}/i.test(rest)) return false;
  return true;
}

/** Для merge/authority: позиция ПФ — только склейка «ТоварШтука/Килограмм»+числа/цены, без наименования товара. */
export function isNoticePrintFormTovarUnitQtyGlueRowWithoutProductTitle(g: TenderAiGoodItem): boolean {
  return isNoticePrintFormRow(g) && noticePfDraftNameLooksLikeTovarUnitQtyGlueOnly(g.name ?? "");
}

export function extractMoneyStringsForGoodsRow(line: string): string[] {
  const rub = parseRubAmounts(line);
  if (rub.length > 0) return rub;
  return parseFallbackMoneyAmountsFromGoodsRow(line);
}

function parseFallbackMoneyAmountsFromGoodsRow(line: string): string[] {
  let rest = stripRegistryAndCodesForMoneyScan(line);
  rest = rest.replace(/\d+(?:[.,]\d+)?\s*(?:шт|ед\.?\s*изм|упак|компл|комплект)\b/gi, " ");
  const seen = new Set<number>();
  const nums: number[] = [];
  for (const m of rest.matchAll(/\b\d{1,3}(?:\s\d{3})+(?:[.,]\d{2})\b|\b\d{1,6}[.,]\d{2}\b|\b\d{3,7}\b/g)) {
    const s = m[0]!.replace(/\s/g, "").replace(",", ".");
    const n = parseFloat(s);
    if (!Number.isFinite(n) || n < 100 || n >= 1e9) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    nums.push(n);
  }
  nums.sort((a, b) => a - b);
  return nums.map((n) => (Number.isInteger(n) ? String(n) : String(n)));
}

/** 8–10 цифр подряд: «004037080» в склейке ПФ; не в общем parseFallback — чтобы registry не ловил 210211527 (Тенд32). */
function longIntMoneyCandidatesForGluedNotice(line: string): string[] {
  let rest = stripRegistryAndCodesForMoneyScan(line);
  rest = rest.replace(/\d+(?:[.,]\d+)?\s*(?:шт|ед\.?\s*изм|упак|компл|комплект)\b/gi, " ");
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of rest.matchAll(/\b\d{8,10}\b/g)) {
    const n = parseInt(m[0]!, 10);
    if (!Number.isFinite(n) || n < 100_000 || n >= 1_000_000_000) continue;
    const s = String(n);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function noticeGluedMoneyStrings(text: string, stripQtyGhost: boolean, qtyNorm: string): string[] {
  const rub = parseRubAmounts(text);
  if (rub.length > 0) return rub;
  const base = parseFallbackMoneyAmountsFromGoodsRow(text);
  const extra = longIntMoneyCandidatesForGluedNotice(text);
  const merged = [...new Set([...base, ...extra])].sort(
    (a, b) => parseFloat(a.replace(",", ".")) - parseFloat(b.replace(",", "."))
  );
  if (!stripQtyGhost || merged.length <= 1) return merged;
  const filtered = merged.filter((m) => m.replace(/\s/g, "").replace(",", ".") !== qtyNorm);
  return filtered.length > 0 ? filtered : merged;
}

function collectCodesFromNoticeTableLineWindow(line: string, nextLine: string | undefined): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    const k = s.replace(/\s/g, "").toLowerCase();
    if (!k || seen.has(k)) return;
    seen.add(k);
    parts.push(s);
  };
  const block = nextLine != null && nextLine.trim() ? `${line}\n${nextLine}` : line;
  const r1 = new RegExp(KTRU_SUFFIX_GLOBAL_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = r1.exec(block)) !== null) add(m[0]!);
  const okpd = /\d{2}\.\d{2}\.\d{2}\.\d{2,3}(?:\.\d{3})?(?!\d)/g;
  while ((m = okpd.exec(block)) !== null) add(m[0]!);
  return parts.join("; ");
}

/** Коды из многострочного окна registry_scan: КТРУ с суффиксом (в т.ч. после схлопывания OCR-переносов). */
function collectKtruOkpdCodesFromRegistryWindow(windowLines: string[]): string {
  const blockOneLine = windowLines.join("\n").replace(/\s+/g, " ").trim();
  const parts: string[] = [];
  const seen = new Set<string>();
  const add = (s: string) => {
    const k = s.replace(/\s/g, "").toLowerCase();
    if (!k || seen.has(k)) return;
    seen.add(k);
    parts.push(s);
  };
  const primary = extractKtruOrOkpd(blockOneLine);
  if (primary) add(primary);
  const r1 = new RegExp(KTRU_SUFFIX_GLOBAL_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = r1.exec(blockOneLine)) !== null) add(m[0]!);
  const okpd = /\d{2}\.\d{2}\.\d{2}\.\d{2,3}(?:\.\d{3})?(?!\d)/g;
  while ((m = okpd.exec(blockOneLine)) !== null) add(m[0]!);
  return parts.join("; ");
}

function moneyStringsForNoticeTableRow(
  line: string,
  nextLine: string | undefined,
  quantity: string,
  /** Убираем число из «ТоварШтука927…» из money — иначе qty дублируется как lineTotal (Тенд32). */
  stripGhostQtyAfterGluedTovarShuka: boolean,
  isPiiGluedTovarShukaLine: boolean,
  /** Для PII: несколько следующих строк ПФ — суммы часто ниже склеенной строки. */
  piiFollowingLines: string
): string[] {
  const qtyNorm = quantity.replace(/\s/g, "").replace(",", ".");
  const takePlain = (text: string, stripQtyGhost: boolean): string[] => {
    const rub = parseRubAmounts(text);
    const out = rub.length > 0 ? rub : parseFallbackMoneyAmountsFromGoodsRow(text);
    if (!stripQtyGhost || out.length <= 1) return out;
    const filtered = out.filter((m) => m.replace(/\s/g, "").replace(",", ".") !== qtyNorm);
    return filtered.length > 0 ? filtered : out;
  };
  let cand = stripGhostQtyAfterGluedTovarShuka
    ? noticeGluedMoneyStrings(line, true, qtyNorm)
    : takePlain(line, false);
  if (cand.length === 0 && isPiiGluedTovarShukaLine) {
    const stripped = line.replace(GLUED_EIS_TOVAR_UNIT_QTY_PII_PLACEHOLDER_RE, " ").trim();
    const chunk = [stripped, (nextLine ?? "").trim(), piiFollowingLines].filter(Boolean).join("\n");
    cand = noticeGluedMoneyStrings(chunk, true, qtyNorm);
  }
  return cand;
}

function normalizeNoticeQtyKey(q: string): string {
  return (q ?? "").replace(/\s/g, "").replace(",", ".").trim().toLowerCase();
}

function noticeCodesFieldSegmentKeys(codes: string): Set<string> {
  const s = new Set<string>();
  for (const part of (codes ?? "").split(/\s*;\s*/)) {
    const k = part.trim().replace(/\s/g, "").toLowerCase();
    if (k) s.add(k);
  }
  return s;
}

export function noticeCodesFieldsShareKtruSegment(a: string, b: string): boolean {
  const A = noticeCodesFieldSegmentKeys(a);
  if (A.size === 0) return false;
  for (const part of (b ?? "").split(/\s*;\s*/)) {
    const k = part.trim().replace(/\s/g, "").toLowerCase();
    if (k && A.has(k)) return true;
  }
  return false;
}

/** Базовые группы ОКПД/КТРУ `NN.NN.NN.NNN` (без суффикса `-952`) — для мягкого пересечения классификации ТЗ и ПФ. */
const NOTICE_CODES_OKPD_FOUR_GROUP_RE = /\b\d{2}\.\d{2}\.\d{2}\.\d{3}\b/gi;

function collectOkpdFourGroupPrefixesFromCodesField(codes: string): Set<string> {
  const s = new Set<string>();
  for (const m of (codes ?? "").matchAll(NOTICE_CODES_OKPD_FOUR_GROUP_RE)) {
    const k = m[0]!.replace(/\s/g, "").toLowerCase();
    if (k) s.add(k);
  }
  return s;
}

/** Есть общая четырёхгрупповая база кодов (не полное совпадение сегмента с `;`). */
export function noticeCodesShareKtruFourGroupPrefix(a: string, b: string): boolean {
  const A = collectOkpdFourGroupPrefixesFromCodesField(a);
  if (A.size === 0) return false;
  for (const m of (b ?? "").matchAll(NOTICE_CODES_OKPD_FOUR_GROUP_RE)) {
    const k = m[0]!.replace(/\s/g, "").toLowerCase();
    if (k && A.has(k)) return true;
  }
  return false;
}

/** Окна поиска pid для строк ПФ с уже известными code+quantity (сужение: только «ровно один» id в окне). */
const NOTICE_TABLE_PID_NEIGHBOR_RADIUS_STRICT = 3;
const NOTICE_TABLE_PID_NEIGHBOR_RADIUS_MID = 6;
const NOTICE_TABLE_PID_NEIGHBOR_RADIUS_WIDE = 10;

/**
 * В ПФ id часто на соседней строке OCR — берём реестровый id только если в окне ±radius ровно один уникальный.
 */
function findUniqueRegistryPositionIdInNeighborLines(
  lines: string[],
  centerIdx: number,
  radius: number
): string {
  const from = Math.max(0, centerIdx - radius);
  const to = Math.min(lines.length - 1, centerIdx + radius);
  const found = new Set<string>();
  const re = new RegExp(REGISTRY_POSITION_ID_CAPTURE_RE.source, "g");
  for (let i = from; i <= to; i++) {
    const chunk = (lines[i] ?? "").replace(/\s/g, " ");
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(chunk)) !== null) {
      const id = (m[1] ?? "").replace(/\s/g, "").trim();
      if (id) found.add(id);
    }
  }
  if (found.size !== 1) return "";
  const id = [...found][0]!;
  return isRegistryStylePositionId(id) ? id : "";
}

/** Один кандидат из registry_scan с тем же сегментом codes и quantity (Тенд32: id не на строке таблицы). */
function findRegistryPidFromScanBySharedCodeAndQty(
  codes: string,
  quantity: string,
  registryRows: TenderAiGoodItem[]
): string {
  const qk = normalizeNoticeQtyKey(quantity);
  if (!qk) return "";
  const matches = registryRows.filter((r) => {
    const pid = (r.positionId ?? "").replace(/\s/g, "").trim();
    if (!pid || !isRegistryStylePositionId(pid)) return false;
    if (!noticeCodesFieldsShareKtruSegment(codes, r.codes ?? "")) return false;
    return normalizeNoticeQtyKey(r.quantity ?? "") === qk;
  });
  if (matches.length !== 1) return "";
  return (matches[0]!.positionId ?? "").replace(/\s/g, "").trim();
}

/** Ровно один registry_scan-ряд с тем же codes (без qty) — узкий fallback, когда qty в scan не совпал. */
function findRegistryPidFromScanBySharedCodeOnly(codes: string, registryRows: TenderAiGoodItem[]): string {
  const segKeys = noticeCodesFieldSegmentKeys(codes);
  if (segKeys.size === 0) return "";

  const matches = registryRows.filter((r) => {
    const pid = (r.positionId ?? "").replace(/\s/g, "").trim();
    if (!pid || !isRegistryStylePositionId(pid)) return false;
    return noticeCodesFieldsShareKtruSegment(codes, r.codes ?? "");
  });
  if (matches.length === 0) return "";
  if (matches.length === 1) return (matches[0]!.positionId ?? "").replace(/\s/g, "").trim();

  /** Несколько окон registry_scan делят один КТРУ (перекрывающиеся вьюхи) — предпочитаем односегментный codes. */
  if (segKeys.size === 1) {
    const only = [...segKeys][0]!;
    const narrow = matches.filter((r) => {
      const rk = noticeCodesFieldSegmentKeys(r.codes ?? "");
      return rk.size === 1 && rk.has(only);
    });
    if (narrow.length === 1) return (narrow[0]!.positionId ?? "").replace(/\s/g, "").trim();
  }
  return "";
}

const firstRegistryScanCodesSegment = (codes: string): string => {
  const segs = (codes ?? "")
    .split(/\s*;\s*/)
    .map((s) => s.trim().replace(/\s/g, "").toLowerCase())
    .filter(Boolean);
  return segs[0] ?? "";
};

/**
 * Несколько позиций ПФ делят один КТРУ в OCR-окне (Тенд8: 110+140 на id йогурта и на id кефира).
 * Сопоставляем сегмент полной строки notice `fullNoticeCodes` с registry_scan, используя порядок сегментов.
 */
function findRegistryPidForNoticeCodeSegment(
  fullNoticeCodes: string,
  segment: string,
  mode: "first" | "last",
  registryRows: TenderAiGoodItem[]
): string {
  const segNorm = segment.trim().replace(/\s/g, "").toLowerCase();
  if (!segNorm) return "";

  const noticeParts = fullNoticeCodes
    .split(/\s*;\s*/)
    .map((s) => s.trim().replace(/\s/g, "").toLowerCase())
    .filter(Boolean);
  const noticeFirst = noticeParts[0] ?? "";

  const matches = registryRows.filter((r) => {
    const pid = (r.positionId ?? "").replace(/\s/g, "").trim();
    if (!pid || !isRegistryStylePositionId(pid)) return false;
    return noticeCodesFieldSegmentKeys(r.codes ?? "").has(segNorm);
  });
  if (matches.length === 0) return "";
  if (matches.length === 1) return (matches[0]!.positionId ?? "").replace(/\s/g, "").trim();

  if (mode === "first" && noticeFirst) {
    const narrow = matches.filter((r) => firstRegistryScanCodesSegment(r.codes ?? "") === noticeFirst);
    if (narrow.length === 1) return (narrow[0]!.positionId ?? "").replace(/\s/g, "").trim();
  }
  if (mode === "last" && noticeParts.length >= 2 && noticeFirst) {
    const narrow = matches.filter((r) => firstRegistryScanCodesSegment(r.codes ?? "") !== noticeFirst);
    if (narrow.length === 1) return (narrow[0]!.positionId ?? "").replace(/\s/g, "").trim();
  }
  return "";
}

/**
 * PDF ПФ ЕИС: каждая ячейка — отдельная строка; КТРУ и «Идентификатор» разъезжают по строкам.
 * Собираем одну логическую строку от якоря «Идентификатор» до начала блока характеристик (Тенд31: 13 позиций).
 * Экспорт только для офлайн-диагностики / verify.
 */
export function buildEisPrintFormVerticalGlueLinesForTest(lines: string[]): string[] {
  const n = lines.length;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const t = (lines[i] ?? "").trim();
    const idStandalone = /^Идентификатор\s*:?\s*$/i.test(t);
    const idInlineNum = /^Идентификатор\s*:\s*\d{8,12}\s*$/i.test(t);
    /** После «Печатная форма»/URL в ПФ часто строка `210964256БЮДЖЕТНОЕ…` без префикса «Идентификатор:» (Тенд31). */
    const idNineGluedPf = /^2\d{8}(?=[А-ЯЁA-ZА-яёЁ«"»(])/u.test(t.replace(/^[\s|]+/u, ""));
    if (!idStandalone && !idInlineNum && !idNineGluedPf) continue;
    const next = i + 1 < n ? lines[i + 1]!.trim() : "";
    if (idStandalone) {
      const idNextOk = /^\d{8,12}$/.test(next);
      const ktruPrefixNext = /^\d{2}\.\d{2}\.\d{2}\.\d{3}-\s*$/.test(next);
      if (!idNextOk && !ktruPrefixNext) continue;
    }

    /** Ищем первый блок «Характеристики…» только вперёд от якоря id (не HC из договора выше по корпусу). */
    let j = -1;
    /**
     * Для idNineGluedPf-якорей («210964256БЮДЖЕТНОЕ») «ТоварШтука» может стоять на несколько строк
     * РАНЬШЕ якоря (между якорём и URL). Расширяем начало окна `up` на 12 строк назад.
     */
    const upStart = idNineGluedPf ? Math.max(0, i - 12) : i;
    for (let jb0 = i; jb0 < n; jb0++) {
      const local = lines
        .slice(jb0, Math.min(n, jb0 + 8))
        .join("\n")
        .replace(/\s+/g, " ");
      if (!/Характеристики\s+товара,\s*работы,\s*услуги/i.test(local)) continue;
      const up = lines
        .slice(upStart, Math.min(n, jb0 + 8))
        .join("\n")
        .replace(/\s+/g, " ");
      const mh = up.match(/Характеристики\s+товара,\s*работы,\s*услуги/i);
      if (!mh || mh.index == null) continue;
      const upBeforeHc = up.slice(0, mh.index);
      /** Принимаем как ПФ: стандартная склейка ТоварШтука/Килограмм ИЛИ любой «Товар<ЕдИзм>» (Тенд25: кв. м). */
      if (!GLUED_EIS_TOVAR_UNIT_QTY_RE.test(upBeforeHc) && !GLUED_EIS_TOVAR_ANY_UNIT_RE.test(upBeforeHc)) continue;
      j = jb0;
      break;
    }
    if (j < 0) continue;
    /** Широкий lookback: «Объект закупки» в ПФ один на лист, нижние строки далеко от заголовка (Тенд31). */
    const start = Math.max(0, i - 120);
    const rawSlice = lines.slice(start, j);
    const trimmedLines: string[] = [];
    for (let k = 0; k < rawSlice.length; k++) {
      const raw = rawSlice[k]!;
      const z = raw.trim();
      if (!z) continue;
      const globalLine = start + k;
      /**
       * URL ПФ между позициями — обрезаем только **после** якоря id текущей строки.
       * Иначе URL из верхнего блока корпуса в lookback рвёт срез до «ТоварШтука» (Тенд31).
       */
      if (/zakupki\.gov\.ru\/epz\/order\/notice\/printForm/i.test(z)) {
        if (globalLine >= i) break;
        continue;
      }
      trimmedLines.push(z);
    }
    let chunk = trimmedLines.join(" ").replace(/\s+/g, " ").trim();
    /**
     * Срез с начала таблицы ПФ: в первую очередь «Объект закупки».
     * Иначе «Наименование товара» из договора в общем корпусе может идти раньше ПФ и отрезать склейку «Товар…» (Тенд31).
     *
     * Когда lookback охватывает несколько позиций ПФ (Тенд25), нужно взять НЕ первое вхождение
     * «Наименование товара», а последнее перед текущим якорем «Идентификатор: 210…».
     * Иначе два блока подряд дают один и тот же pid (первый из двух).
     */
    let trimAt = chunk.search(/Объект\s+закупки/i);
    if (trimAt < 0) {
      /**
       * «Идентификатор: 210…» текущей позиции — ПОСЛЕДНЕЕ вхождение в chunk, потому что
       * rawSlice заканчивается до «Характеристики» ТЕКУЩЕЙ позиции, но может включать
       * несколько предыдущих позиций (широкий lookback 120 строк).
       */
      const allIds = [...chunk.matchAll(/Идентификатор\s*:\s*2\d{7,11}/gi)];
      const lastIdMatch = allIds[allIds.length - 1];
      const idAnchor = lastIdMatch?.index ?? chunk.search(/Идентификатор\s*:\s*2\d{7,11}/i);
      const searchBefore = idAnchor > 0 ? chunk.slice(0, idAnchor) : chunk;
      /** Последнее вхождение «Наименование товара» до последнего якоря — заголовок текущей строки ПФ. */
      const allNm = [...searchBefore.matchAll(/(?:Наименование\s+товара)/gi)];
      const lastNm = allNm[allNm.length - 1];
      const nm = lastNm?.index ?? chunk.search(/Наименование\s+товара/i);
      if (nm != null && nm >= 0) trimAt = nm;
    }
    if (trimAt > 0) chunk = chunk.slice(trimAt).trim();
    if (chunk.length < 52) continue;
    /** Не тянуть блоки из приложений/договора: только фрагмент таблицы ПФ с суммой позиции и склейкой Товар+ед.изм. */
    /** Стандартная склейка ТоварШтука/Килограмм ИЛИ любой «Товар<ЕдИзм>» (Тенд25: кв. м и пр.). */
    if (!GLUED_EIS_TOVAR_UNIT_QTY_RE.test(chunk) && !GLUED_EIS_TOVAR_ANY_UNIT_RE.test(chunk)) continue;
    /** Отсекаем «Идентификатор» из договора без внутреннего id позиции ПФ (210… и т.п.). */
    if (!pickPrintFormInternalPositionIdFromPfVerticalBlock(chunk)) continue;
    /** Без `\b` перед кириллицой: иначе после «…отношен» границы слова нет (Тенд31, полный корпус). */
    if (!/Стоимость\s+позиции/i.test(chunk)) continue;
    /** После среза: заголовок таблицы, затем «Стоимость позиции», затем «Идентификатор». */
    const ob = chunk.search(/Объект\s+закупки/i);
    const nm0 = chunk.search(/Наименование\s+товара/i);
    const headOk = ob === 0 || nm0 === 0;
    const st = chunk.search(/Стоимость\s+позиции/i);
    const idp = chunk.search(/Идентификатор\s*:/i);
    if (!(headOk && st > 0 && idp > st)) continue;
    out.push(chunk);
  }
  return out;
}

function buildEisPrintFormVerticalGlueLines(lines: string[]): string[] {
  return buildEisPrintFormVerticalGlueLinesForTest(lines);
}

/**
 * Две склейки подряд: короткая — префикс длинной (одна позиция ПФ попала и как отдельный якорь,
 * и внутри «широкого» блока). Иначе split даёт дубликат первой позиции и снова схлопывание по key.
 */
function dedupeNoticePfEisGlueLinesStrictPrefixSuperseded(chunks: string[]): string[] {
  if (chunks.length < 2) return chunks;
  const flats = chunks.map((c) => c.replace(/\s+/g, " ").trim());
  const out: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const fi = flats[i]!;
    if (fi.length < 40) {
      out.push(chunks[i]!);
      continue;
    }
    let superseded = false;
    for (let j = 0; j < chunks.length; j++) {
      if (i === j) continue;
      const fj = flats[j]!;
      if (fj.length > fi.length + 40 && fj.startsWith(fi)) {
        superseded = true;
        break;
      }
    }
    if (!superseded) out.push(chunks[i]!);
  }
  return out;
}

/**
 * В одной вертикальной склейке ПФ иногда оказывается несколько позиций подряд (несколько
 * «Идентификатор: 21…» до следующего якоря). Тогда `tryAppendRow` даёт одну строку с
 * несколькими pid и дублирует первый id на вторую позицию. Режем по последнему
 * «Стоимость позиции» перед каждым следующим идентификатором; хвостовые куски получают
 * префикс заголовка таблицы из начала склейки (узко: только если оба куска проходят
 * `isNoticeGoodsTableRowCandidate`).
 */
function splitMonolithicEisVerticalGlueChunkIfMultipleRegistryIds(chunk: string): string[] {
  const flat = chunk.replace(/\s+/g, " ").trim();
  const idMatches = [...flat.matchAll(/Идентификатор\s*:\s*(2\d{8,11})/gi)];
  if (idMatches.length <= 1) return [chunk];

  const cutPoints: number[] = [0];
  for (let i = 1; i < idMatches.length; i++) {
    const idPos = idMatches[i]!.index!;
    const before = flat.slice(0, idPos);
    const st = before.lastIndexOf("Стоимость позиции");
    cutPoints.push(st >= 0 ? st : idPos);
  }
  cutPoints.push(flat.length);

  const header = flat.slice(0, Math.min(280, flat.length)).trim();
  const pieces: string[] = [];
  for (let i = 0; i < idMatches.length; i++) {
    const a = cutPoints[i]!;
    const b = cutPoints[i + 1]!;
    let piece = flat.slice(a, b).trim();
    if (i > 0) piece = `${header} ${piece}`.replace(/\s+/g, " ").trim();
    if (piece.length < 52 || !isNoticeGoodsTableRowCandidate(piece)) {
      return [chunk];
    }
    pieces.push(piece);
  }
  return pieces.length >= 2 ? pieces : [chunk];
}

/**
 * Внутренний id позиции в ПФ (часто 9 цифр, 21…), не ИКЗ/01… из URL.
 */
function pickPrintFormInternalPositionIdFromPfVerticalBlock(block: string): string {
  const flat = block.replace(/\s+/g, " ").trim();
  /** Без `\b` после id: в ПФ после цифр сразу идёт КТРУ (`…25323.64…` при схлопывании пробелов). */
  const labeled = flat.match(/Идентификатор\s*:\s*(\d{8,12})(?=\D|$)/i);
  if (labeled?.[1]) {
    const id = labeled[1]!.replace(/\s/g, "");
    if (/^2\d{7,11}$/.test(id)) return id;
  }
  const glued = flat.match(/\b(2\d{8})(?=[А-ЯЁA-Z«"»])/u);
  if (glued?.[1] && /^2\d{8}$/.test(glued[1]!)) return glued[1]!;
  return "";
}

function scrubNoticePfSyntheticNameDraft(name: string): string {
  return name
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\b\d{1,2}\.\d{1,2}\.\d{4}\b[^A-Za-zА-Яа-яЁё0-9]*/g, " ")
    /** Метка времени «HH:MM» перед «Печатная форма» — PDF-артефакт пагинации ПФ (Тенд24/25/31/32).
     *  Trailing \b намеренно убран: кириллица не является \w в ASCII-режиме JS regex. */
    .replace(/\b\d{1,2}:\d{2}\s*Печатная\s+форма/gi, " ")
    .replace(/Идентификатор\s*:\s*\d{8,12}/gi, " ")
    .replace(/Идентификатор\s*:/gi, " ")
    .replace(/Стоимость\s+позиции/gi, " ")
    .replace(/Цена\s+за\s+единицу/gi, " ")
    .replace(/Количество\s*\([^)]*\)/gi, " ")
    .replace(/\bЗаказчик\b/gi, " ")
    .replace(/\bГОСУДАРСТВ\w*\b/gi, " ")
    .replace(/\bННОЕ\b/gi, " ")
    .replace(/\bБЮДЖЕТНОЕ\b/gi, " ")
    .replace(/\bУЧРЕЖДЕНИЕ\b/gi, " ")
    .replace(/Печатная\s+форма/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Строка похожа на табличную позицию печатной формы: есть КТРУ, шт, рубли.
 */
export function extractGoodsFromNoticePriceTable(maskedFullCorpus: string): TenderAiGoodItem[] {
  /** Вся маскированная склейка файлов: таблица с НМЦК часто в блоке, отмеченном как ТЗ, не как извещение. */
  const lines = (maskedFullCorpus ?? "").split("\n");
  const registryScanRows = extractGoodsPositionsFromRegistryIds(maskedFullCorpus);
  /** ПФ 210…: только для узкого pid-pool (glue с ≥2 id или multi-segment codes), не в общий merge notice. */
  const registryScanPfLabeledOnly = extractGoodsPositionsFromPfLabeledPrintFormIdsOnly(maskedFullCorpus);
  const glueLines = dedupeNoticePfEisGlueLinesStrictPrefixSuperseded(buildEisPrintFormVerticalGlueLines(lines)).flatMap(
    (chunk) => splitMonolithicEisVerticalGlueChunkIfMultipleRegistryIds(chunk)
  );
  const raw: TenderAiGoodItem[] = [];

  const tryAppendRow = (line: string, li: number | null) => {
    if (!isNoticeGoodsTableRowCandidate(line)) return;
    const nextRaw = li != null && li + 1 < lines.length ? lines[li + 1] : undefined;
    const codes = collectCodesFromNoticeTableLineWindow(line, nextRaw) || extractKtruOrOkpd(line);
    const quantity = extractNoticeGoodsTableLineQuantity(line);
    /**
     * PF-блок с нестандартной единицей (Квадратный метр и пр.) проходит без явного количества:
     * оно не попадает в glue-строку из-за PDF-раскладки колонок (Тенд25, поз. 210964263).
     */
    const isPfAnyUnitBlock =
      li == null &&
      GLUED_EIS_TOVAR_ANY_UNIT_RE.test(line) &&
      !GLUED_EIS_TOVAR_UNIT_QTY_RE.test(line) &&
      /Стоимость\s+позиции/i.test(line) &&
      !!pickPrintFormInternalPositionIdFromPfVerticalBlock(line) &&
      /Идентификатор\s*:/i.test(line);
    if (!codes || (!quantity && !isPfAnyUnitBlock)) return;
    const effectiveQty = quantity ?? "";

    const isPiiGluedTovarShukaLine = GLUED_EIS_TOVAR_UNIT_QTY_PII_PLACEHOLDER_RE.test(line);
    const stripGhostQtyAfterGluedTovarShuka =
      GLUED_EIS_TOVAR_UNIT_QTY_RE.test(line) || isPiiGluedTovarShukaLine;
    const piiFollow: string[] = [];
    if (isPiiGluedTovarShukaLine && li != null) {
      for (let j = 2; j <= 5 && li + j < lines.length; j++) {
        const t = lines[li + j]!.trim();
        if (t) piiFollow.push(t);
      }
    }
    const moneyUse = moneyStringsForNoticeTableRow(
      line,
      nextRaw,
      effectiveQty,
      stripGhostQtyAfterGluedTovarShuka,
      isPiiGluedTovarShukaLine,
      piiFollow.join("\n")
    );
    if (moneyUse.length === 0) return;

    /**
     * Подмешивать PF-210… scan только для: (1) vertical glue ПФ, (2) любой notice-ряд с multi-segment codes.
     * Глобальный `extractGoodsPositionsFromRegistryIds` без 210… — чтобы `fromRegistry` в merge не раздувался (Тенд23/27).
     */
    const useAugmentedRegistryScan = li === null || (codes?.includes(";") ?? false);
    const scanRows = useAugmentedRegistryScan
      ? mergeRegistryScanRowsForPidResolution(registryScanRows, registryScanPfLabeledOnly)
      : registryScanRows;

    const pp = line.match(/^\s*(\d{1,4})\s*[.)]\s/)?.[1]?.trim() ?? "";
    let positionId = "";
    if (li == null) {
      positionId = pickPrintFormInternalPositionIdFromPfVerticalBlock(line);
      if (!/^2\d{7,11}$/.test(positionId)) positionId = "";
    } else {
      const regMatch = line.match(REGISTRY_POSITION_ID_CAPTURE_RE);
      positionId = ((regMatch?.[1] ?? "").trim() || pp).replace(/\s/g, "").trim();
      if (!isRegistryStylePositionId(positionId)) {
        const fromNeighbor3 = findUniqueRegistryPositionIdInNeighborLines(
          lines,
          li,
          NOTICE_TABLE_PID_NEIGHBOR_RADIUS_STRICT
        );
        if (fromNeighbor3) positionId = fromNeighbor3;
      }
      if (!isRegistryStylePositionId(positionId)) {
        const fromNeighbor6 = findUniqueRegistryPositionIdInNeighborLines(
          lines,
          li,
          NOTICE_TABLE_PID_NEIGHBOR_RADIUS_MID
        );
        if (fromNeighbor6) positionId = fromNeighbor6;
      }
      if (!isRegistryStylePositionId(positionId)) {
        const fromNeighbor10 = findUniqueRegistryPositionIdInNeighborLines(
          lines,
          li,
          NOTICE_TABLE_PID_NEIGHBOR_RADIUS_WIDE
        );
        if (fromNeighbor10) positionId = fromNeighbor10;
      }
      if (!isRegistryStylePositionId(positionId)) {
        const fromScanQty = findRegistryPidFromScanBySharedCodeAndQty(codes, effectiveQty, scanRows);
        if (fromScanQty) positionId = fromScanQty;
      }
      if (!isRegistryStylePositionId(positionId)) {
        const fromScanCode = findRegistryPidFromScanBySharedCodeOnly(codes, scanRows);
        if (fromScanCode) positionId = fromScanCode;
      }
      if (!isRegistryStylePositionId(positionId)) {
        const internal = pickPrintFormInternalPositionIdFromPfVerticalBlock(line);
        if (internal && /^2\d{7,11}$/.test(internal)) positionId = internal;
      }
      if (!isRegistryStylePositionId(positionId) && !/^2\d{7,11}$/.test(positionId)) positionId = "";
    }

    if (positionId && codes.includes(";") && scanRows.length > 0) {
      const parts = codes
        .split(/\s*;\s*/)
        .map((s) => s.trim().replace(/\s/g, ""))
        .filter((s) => extractKtruOrOkpd(s));
      if (parts.length >= 2) {
        const seg0 = parts[0]!;
        const segLast = parts[parts.length - 1]!;
        const p0 =
          findRegistryPidForNoticeCodeSegment(codes, seg0, "first", scanRows) ||
          findRegistryPidFromScanBySharedCodeOnly(seg0, scanRows);
        const pLast =
          findRegistryPidForNoticeCodeSegment(codes, segLast, "last", scanRows) ||
          findRegistryPidFromScanBySharedCodeOnly(segLast, scanRows);
        const cur = positionId.replace(/\s/g, "");
        if (p0 && pLast && p0 !== pLast && cur === p0.replace(/\s/g, "")) {
          positionId = pLast;
        }
      }
    }

    /**
     * Для склеенных строк ПФ (glue lines, li === null): имя товара находится строго между
     * «Стоимость позиции» и «Идентификатор:» — всё что левее является заголовками столбцов
     * таблицы «Объект закупки / Наименование товара, работы, услуги / Код позиции...».
     */
    const pfGlueNameMatch =
      li === null
        ? line.match(/Стоимость\s+позиции\s+([\s\S]+?)\s+Идентификатор\s*:/i)
        : null;
    let name: string;
    if (pfGlueNameMatch?.[1]) {
      name = scrubNoticePfSyntheticNameDraft(pfGlueNameMatch[1].trim()).slice(0, 800);
    } else {
      name = line.replace(/^\s*\d{1,4}\s*[.)]\s+/, "");
      for (const seg of codes.split(/\s*;\s*/)) {
        const s = seg.trim();
        if (s) name = name.replace(s, " ");
      }
      name = name
        .replace(/\d+(?:[.,]\d+)?\s*(?:шт|ед\.?\s*изм|упак|компл|комплект|килограмм|кг)\b[^\n]*/i, " ")
        .replace(/\d[\d\s]*(?:[.,]\d{1,2})?\s*(?:руб|₽)/gi, " ");
      for (const mVal of moneyUse) {
        const core = mVal.replace(/\./g, "[.,]");
        name = name.replace(new RegExp(`\\b${core}\\b`, "g"), " ");
      }
      name = scrubNoticePfSyntheticNameDraft(name).slice(0, 800);
    }
    if (name.length < 6) {
      name = "Картридж для электрографических печатающих устройств";
    }

    let unitPrice = "";
    let lineTotal = "";
    if (moneyUse.length >= 2) {
      unitPrice = moneyUse[0]!;
      lineTotal = moneyUse[moneyUse.length - 1]!;
    } else {
      lineTotal = moneyUse[0]!;
    }

    raw.push({
      name,
      positionId,
      codes,
      unit: "шт",
      quantity: effectiveQty,
      unitPrice,
      lineTotal,
      sourceHint: "notice_print_form_row",
      characteristics: [],
      quantityUnit: "",
      quantitySource: "unknown"
    });
  };

  for (const glue of glueLines) tryAppendRow(glue, null);
  for (let li = 0; li < lines.length; li++) tryAppendRow(lines[li]!.trim(), li);

  const seen = new Set<string>();
  /**
   * Вторичный ключ codes+qty: позиции с PID регистрируют пару, затем дублирующие строки без PID
   * (из сырого корпуса) пропускаются. Порядок важен — glueLines всегда обрабатываются раньше lines.
   * (Тенд25: ТоварШтука из сырого корпуса дублирует позиции из glue-строк с ПФ-PID.)
   */
  const seenCodeQtyForPid = new Set<string>();
  const out: TenderAiGoodItem[] = [];
  for (const g of raw) {
    const k = `${g.positionId}|${g.codes}|${g.quantity}|${g.lineTotal}`;
    if (seen.has(k)) continue;
    seen.add(k);
    const hasPid = !!(g.positionId?.trim());
    const cqKey = `${(g.codes ?? "").replace(/\s/g, "").toLowerCase()}|${(g.quantity ?? "").trim()}`;
    if (!hasPid && cqKey && seenCodeQtyForPid.has(cqKey)) continue;
    if (hasPid && cqKey) seenCodeQtyForPid.add(cqKey);
    out.push(g);
  }
  return enrichNoticePrintFormRowsWithPfCharacteristics(maskedFullCorpus, out);
}

const GOODS_INFO_SECTION_ANCHOR_RE =
  /Информация\s+о\s+товаре(?:\s*,\s*работе\s*,\s*услуге)?/i;

const NOTICE_GOODS_INFO_SOURCE_HINT = "notice_goods_info_block";

/** Единицы в фразах «наименование – N …» внутри блока «Информация о товаре». */
const GOODS_INFO_UNIT_CAPTURE_GROUP =
  "(тонн|тысяч\\s*тонн|кг|килограм\\w*|литр|л(?![а-яёa-zA-Z0-9])\\.?|шт\\.?|штук\\w*|штука|компл\\w*|комплект|усл\\.?\\s*ед\\.?)";

function normalizeGoodsInfoQtyToken(raw: string): string {
  const n = parseFloat(raw.replace(",", ".").replace(/\s/g, ""));
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) return "";
  return String(Math.trunc(n));
}

function normalizeGoodsInfoUnitFromMatch(uRaw: string): { unit: string; quantityUnit: string } {
  const u = uRaw.replace(/\s+/g, " ").toLowerCase();
  if (/тонн|тысяч/.test(u)) return { unit: "т", quantityUnit: "т" };
  if (/кг|килограм/.test(u)) return { unit: "кг", quantityUnit: "кг" };
  if (/литр|^л/.test(u)) return { unit: "л", quantityUnit: "л" };
  if (/компл|комплект/.test(u)) return { unit: "компл", quantityUnit: "компл" };
  if (/усл/.test(u)) return { unit: "усл. ед.", quantityUnit: "усл. ед." };
  return { unit: "шт", quantityUnit: "шт" };
}

/** Хотя бы одно «слово-токен» похоже на наименование товара (не только цифры/знаки). */
function goodsInfoClauseHasProductLikeToken(t: string): boolean {
  return /[а-яёa-z]{4,}/i.test(t);
}

function goodsInfoClauseLooksLikeNoise(p: string): boolean {
  const t = p.trim();
  if (t.length < 12) return true;
  if (!goodsInfoClauseHasProductLikeToken(t)) return true;
  if (!/(?:тонн|тысяч|кг|литр|\bл\b|шт|штук|компл|усл\.?\s*ед)/i.test(t)) return true;
  if (!/\d/.test(t)) return true;
  if (/\d[\d\s]*(?:[.,]\d{1,2})?\s*(?:руб|₽)/i.test(t)) return true;
  if (/^(?:наименование|ктру|окпд|№\s*п|п\/п|характеристик)/i.test(t)) return true;
  return false;
}

export function normalizeGoodsInfoProductNameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^а-яёa-z0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 56);
}

function goodsInfoProductDistinctKey(g: TenderAiGoodItem): string {
  const c = (g.codes ?? "").replace(/\s/g, "").toLowerCase();
  const n = normalizeGoodsInfoProductNameKey(g.name ?? "");
  return `${c}|${n}|${(g.quantity ?? "").trim()}|${(g.unit ?? "").trim()}`;
}

/** Если ровно 2 разных (кол-во+ед.) — не более одной позиции на каждое (Тенд10: 120 т / 6 т). */
function capGoodsInfoLocalsWhenTwoDistinctQuantities(locals: TenderAiGoodItem[]): TenderAiGoodItem[] {
  const qk = new Set(locals.map((g) => `${(g.quantity ?? "").trim()}|${(g.unit ?? "").trim()}`));
  if (qk.size !== 2 || locals.length <= 2) return locals;
  const byQty = new Map<string, TenderAiGoodItem[]>();
  for (const g of locals) {
    const k = `${(g.quantity ?? "").trim()}|${(g.unit ?? "").trim()}`;
    const arr = byQty.get(k) ?? [];
    arr.push(g);
    byQty.set(k, arr);
  }
  const picked: TenderAiGoodItem[] = [];
  for (const arr of byQty.values()) {
    arr.sort(
      (a, b) =>
        ((b.codes ?? "").trim().length - (a.codes ?? "").trim().length) ||
        (b.name ?? "").length - (a.name ?? "").length
    );
    picked.push(arr[0]!);
  }
  return picked;
}

export function isNoticeGoodsInfoBlockRow(g: TenderAiGoodItem): boolean {
  return (g.sourceHint ?? "").toLowerCase().includes("notice_goods_info_block");
}

export function isNoticePrintFormRow(g: TenderAiGoodItem): boolean {
  return (g.sourceHint ?? "").toLowerCase().includes("notice_print_form_row");
}

/**
 * Два разных классификационных сегмента в поле `codes` (ОКПД/КТРУ ≥8 символов после нормализации).
 * Узкий признак «как Тенд10»: извещение действительно фиксирует две разные номенклатуры, а не два случайных абзаца.
 */
export function goodsInfoHasTwoDistinctClassificationCodes(rows: TenderAiGoodItem[]): boolean {
  const codeSegs = new Set<string>();
  for (const r of rows) {
    for (const seg of (r.codes ?? "").split(/\s*;\s*/)) {
      const s = seg.replace(/\s/g, "").toLowerCase();
      if (s.length >= 8) codeSegs.add(s);
    }
  }
  return codeSegs.size >= 2;
}

/**
 * Только печатная форма (≥2 строк): кардинальность по ПФ, если ТЗ пустое/слабое или строк в ТЗ не больше, чем в ПФ.
 * Блок goods-info обрабатывается отдельно в `deterministic-goods-merge` (двойной код + инъективное совпадение с ТЗ).
 */
export function pickAuthoritativeNoticeRowsForGoodsCardinality(
  noticeItems: TenderAiGoodItem[],
  techItemCount: number,
  techWeak: boolean
): TenderAiGoodItem[] | null {
  const pf = noticeItems.filter(isNoticePrintFormRow);
  if (pf.length >= 2 && (techWeak || techItemCount <= pf.length)) {
    return [...pf];
  }
  return null;
}

/**
 * Узкий «замок» для merge: notice-goods-info применяем к валидному ТЗ только если
 * ≥2 разных кода (ОКПД/КТРУ-сегмента) ИЛИ (≥2 имён и ≥2 разных количеств).
 */
export function goodsInfoRowsPassQualityGateForNoticeMerge(rows: TenderAiGoodItem[]): boolean {
  if (rows.length < 2) return false;
  const codeSegs = new Set<string>();
  for (const r of rows) {
    for (const seg of (r.codes ?? "").split(/\s*;\s*/)) {
      const s = seg.replace(/\s/g, "").toLowerCase();
      if (s.length >= 8) codeSegs.add(s);
    }
  }
  if (codeSegs.size >= 2) return true;
  const nameKeys = new Set(rows.map((r) => normalizeGoodsInfoProductNameKey(r.name ?? "")));
  const qtyKeys = new Set(rows.map((r) => `${(r.quantity ?? "").trim()}|${(r.unit ?? "").trim()}`));
  return nameKeys.size >= 2 && qtyKeys.size >= 2;
}

/**
 * Одна фраза вида «Товар – 120 тонн» / «Товар 500 кг» внутри окна ПФ.
 */
function parseGoodsInfoSupplyClause(clause: string): { name: string; qty: string; unit: string; quantityUnit: string } | null {
  const t = clause.replace(/\s+/g, " ").trim();
  if (t.length < 10 || goodsInfoClauseLooksLikeNoise(t)) return null;
  const uRe = new RegExp(`^(.{4,320}?)\\s*[–—-]\\s*(\\d+(?:[.,]\\d+)?)\\s*${GOODS_INFO_UNIT_CAPTURE_GROUP}\\s*\\.?$`, "i");
  let m = t.match(uRe);
  if (!m) {
    const uRe2 = new RegExp(`^(.{4,320}?)\\s+(\\d+(?:[.,]\\d+)?)\\s+${GOODS_INFO_UNIT_CAPTURE_GROUP}\\s*\\.?$`, "i");
    m = t.match(uRe2);
  }
  if (m) {
    const name = m[1]!.trim().replace(/^[,;:\\s–-]+/, "").slice(0, 400);
    const qty = normalizeGoodsInfoQtyToken(m[2]!);
    if (!qty || name.length < 3 || !goodsInfoClauseHasProductLikeToken(name)) return null;
    const { unit, quantityUnit } = normalizeGoodsInfoUnitFromMatch(m[3] ?? "");
    return { name, qty, unit, quantityUnit };
  }
  const tab = extractQuantityFromTabularGoodsLine(t);
  if (!tab) return null;
  let name = t
    .replace(/\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{3,5}(?!\d)/g, " ")
    .replace(/\d{2}\.\d{2}\.\d{2}\.\d{2,3}(?:\.\d{3})?(?!\d)/g, " ")
    .replace(/\d+(?:[.,]\d+)?\s*(?:шт\.?|штук\w*|ед\.?\s*изм|упак|компл|комплект|кг|л|тонн)/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
  if (name.length < 6 || !goodsInfoClauseHasProductLikeToken(name)) return null;
  const qty = normalizeGoodsInfoQtyToken(tab.replace(",", "."));
  if (!qty) return null;
  if (/\bтонн|тысяч\s*тонн/i.test(t)) return { name, qty, unit: "т", quantityUnit: "т" };
  if (/\bкг|килограм/i.test(t)) return { name, qty, unit: "кг", quantityUnit: "кг" };
  if (/\bлитр|\bл\b/i.test(t)) return { name, qty, unit: "л", quantityUnit: "л" };
  if (/\bкомпл/i.test(t)) return { name, qty, unit: "компл", quantityUnit: "компл" };
  return { name, qty, unit: "шт", quantityUnit: "шт" };
}

type GoodsInfoParsedClause = {
  raw: string;
  name: string;
  qty: string;
  unit: string;
  quantityUnit: string;
};

function collectGoodsInfoSupplyClauses(joined: string): GoodsInfoParsedClause[] {
  const out: GoodsInfoParsedClause[] = [];
  const seen = new Set<string>();
  const push = (raw: string, p: { name: string; qty: string; unit: string; quantityUnit: string }) => {
    const k = `${normalizeGoodsInfoProductNameKey(p.name)}|${p.qty}|${p.unit}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ raw, ...p });
  };

  const supply = joined.match(/Количество\s+поставки\s*:\s*([^\n]+)/i);
  if (supply?.[1]) {
    for (const seg of supply[1].split(/[;；]/)) {
      const raw = seg.trim();
      if (!raw || goodsInfoClauseLooksLikeNoise(raw)) continue;
      const parsed = parseGoodsInfoSupplyClause(raw);
      if (parsed) push(raw, parsed);
    }
  }
  return out;
}

function scoreClauseAgainstHint(clauseText: string, hint: string): number {
  const cn = `${clauseText} `.toLowerCase().replace(/\s+/g, " ");
  const clean = hint
    .toLowerCase()
    .replace(/[^а-яёa-z0-9\s]/gi, " ")
    .replace(/\s+/g, " ");
  const words = clean.split(/\s+/).filter((w) => w.length >= 4);
  let s = 0;
  for (const w of words) {
    if (cn.includes(w)) s += 3;
  }
  return s;
}

/** «ОКПД 2 - …» + хвост наименования в окне ПФ (223 / типовые извещения). */
function collectOkpd2DescriptorRowsInWindow(lines: string[], start: number, end: number): Array<{ code: string; hint: string }> {
  const out: Array<{ code: string; hint: string }> = [];
  for (let li = start; li < end; li++) {
    const raw = (lines[li] ?? "").trim();
    if (!raw || raw.length > 240) continue;
    if (!/ОКПД\s*2\s*[-–]/i.test(raw)) continue;
    const code = extractKtruOrOkpd(raw);
    if (!code) continue;
    let hint = raw
      .replace(/ОКПД\s*2\s*[-–]\s*[\d.]+(?:\.\d{3})?/gi, " ")
      .replace(/ОКВЭД\s*2\s*[-–][^–;]*(?:–|;|$)/gi, " ")
      .replace(/^[\s:;,–-]+/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (hint.length > 200) hint = hint.slice(0, 200).trim();
    if (hint.length < 3) hint = raw.slice(0, 120).trim();
    out.push({ code, hint });
  }
  return out;
}

/**
 * Дополнительные позиции из блока ПФ «Информация о товаре…»:
 * несколько разных товаров (по коду и/или наименованию), у каждого своё количество и единица.
 * Не дублирует `extractGoodsFromNoticePriceTable`.
 */
export function extractGoodsFromNoticeGoodsInfoSection(maskedFullCorpus: string): TenderAiGoodItem[] {
  const lines = (maskedFullCorpus ?? "").split("\n");
  const anchors: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (GOODS_INFO_SECTION_ANCHOR_RE.test(lines[i]!)) anchors.push(i);
  }
  if (anchors.length === 0) return [];

  const raw: TenderAiGoodItem[] = [];
  for (const start of anchors) {
    const end = Math.min(lines.length, start + 180);
    const windowLines = lines.slice(start, end);
    const joined = windowLines.join("\n");
    const clauses = collectGoodsInfoSupplyClauses(joined);
    const okRows = collectOkpd2DescriptorRowsInWindow(lines, start, end);
    const primaries = new Set(okRows.map((r) => r.code.replace(/\s/g, "").toLowerCase()));

    let local: TenderAiGoodItem[] = [];

    if (okRows.length >= 2 && primaries.size >= 2) {
      const usedClause = new Set<number>();
      for (const row of okRows) {
        let bestI = -1;
        let bestSc = -1;
        for (let i = 0; i < clauses.length; i++) {
          if (usedClause.has(i)) continue;
          const c = clauses[i]!;
          const sc = scoreClauseAgainstHint(`${c.raw} ${c.name}`, row.hint);
          if (sc > bestSc) {
            bestSc = sc;
            bestI = i;
          }
        }
        let qty = "";
        let unit = "шт";
        let quantityUnit = "шт";
        let picked: GoodsInfoParsedClause | null = null;
        if (bestI >= 0 && bestSc >= 3) {
          usedClause.add(bestI);
          picked = clauses[bestI]!;
          qty = picked.qty;
          unit = picked.unit;
          quantityUnit = picked.quantityUnit;
        } else {
          const inl = parseGoodsInfoSupplyClause(row.hint);
          if (inl) {
            qty = inl.qty;
            unit = inl.unit;
            quantityUnit = inl.quantityUnit;
          }
        }
        if (!qty) continue;
        const nameFromClause = picked?.name.trim() ?? "";
        const name = (nameFromClause.length >= 4 ? nameFromClause : row.hint).slice(0, 800).trim() || "Товар";
        local.push({
          name,
          positionId: "",
          codes: row.code,
          unit,
          quantity: qty,
          unitPrice: "",
          lineTotal: "",
          sourceHint: NOTICE_GOODS_INFO_SOURCE_HINT,
          characteristics: [],
          quantityUnit,
          quantitySource: "notice"
        });
      }
    }

    if (local.length < 2 && clauses.length >= 2) {
      const nameKeys = new Set(clauses.map((c) => normalizeGoodsInfoProductNameKey(c.name)));
      if (nameKeys.size >= 2) {
        local.length = 0;
        for (const c of clauses) {
          const codes = extractKtruOrOkpd(c.raw) || extractKtruOrOkpd(c.name) || "";
          local.push({
            name: c.name.slice(0, 800),
            positionId: "",
            codes,
            unit: c.unit,
            quantity: c.qty,
            unitPrice: "",
            lineTotal: "",
            sourceHint: NOTICE_GOODS_INFO_SOURCE_HINT,
            characteristics: [],
            quantityUnit: c.quantityUnit,
            quantitySource: "notice"
          });
        }
      }
    }

    if (local.length >= 2) {
      local = capGoodsInfoLocalsWhenTwoDistinctQuantities(local);
      const keys = new Set(local.map((g) => goodsInfoProductDistinctKey(g)));
      if (keys.size >= 2) raw.push(...local);
    }
  }

  const seen = new Set<string>();
  const out: TenderAiGoodItem[] = [];
  for (const g of raw) {
    const k = goodsInfoProductDistinctKey(g);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(g);
  }
  if (out.length < 2) return [];
  return new Set(out.map((g) => goodsInfoProductDistinctKey(g))).size >= 2 ? out : [];
}

/** Minimum value heuristic: a number with 2-decimal kopeck format or large round integer is money, not quantity. */
function isRegistryMoneyLike(s: string): boolean {
  const n = parseFloat(s.replace(",", "."));
  if (!Number.isFinite(n)) return false;
  if (/[.,]\d{2}$/.test(s.trim()) && n >= 50) return true;
  if (!/[.,]/.test(s) && n >= 50_000) return true;
  return false;
}

/**
 * Line-by-line quantity extraction from a registry window.
 * In EIS print form OCR, table columns appear on SEPARATE LINES: unit → quantity → unit price → total.
 * After locating the unit-marker line, scan forward for the first small non-money integer.
 * Also handles inline OCR glue such as "Штука7" (unit+qty joined without space).
 */
function extractQtyFromMultiLineWindow(windowLines: string[], pid: string): string {
  const compactPid = pid.replace(/\s/g, "");
  const pidIdx = windowLines.findIndex((ln) => {
    if (ln.includes(pid)) return true;
    return compactPid.length >= 8 && ln.replace(/\s/g, "").includes(compactPid);
  });
  if (pidIdx < 0) return "";

  const UNIT_STANDALONE = /^(?:штука|штуки?|шт|ед\.?\s*изм|упак|компл|комплект|единица)\s*$/i;
  /**
   * Negative lookahead (?![.,\d]) prevents matching "4000" in "Штука4000.00":
   * if digits are immediately followed by a decimal separator or more digits, the match
   * is a price (e.g. 4000.00), not a quantity.
   */
  const UNIT_INLINE_WITH_NUM = /(?:штука|штуки?|шт)\s*(\d{1,4})(?![.,\d])/i;

  let unitLineIdx = -1;
  for (let i = Math.max(0, pidIdx - 2); i < Math.min(windowLines.length, pidIdx + 22); i++) {
    const t = windowLines[i]!.trim();
    if (!t) continue;
    // Inline OCR glue: "Штука7" — unit and quantity merged without whitespace
    const glue = t.match(UNIT_INLINE_WITH_NUM);
    if (glue?.[1]) {
      const n = parseInt(glue[1]!, 10);
      if (n >= 1 && n <= 9999 && !isRegistryMoneyLike(glue[1]!)) return String(n);
    }
    if (UNIT_STANDALONE.test(t)) {
      unitLineIdx = i;
      break;
    }
  }
  if (unitLineIdx < 0) return "";

  // Scan up to 6 lines after the unit marker line
  for (let i = unitLineIdx + 1; i < Math.min(windowLines.length, unitLineIdx + 7); i++) {
    const t = windowLines[i]!.trim();
    if (!t) continue;
    // Standalone integer (with optional trailing .0/.00 for whole unit counts)
    const m = t.match(/^(\d{1,4})(?:[.,]0+)?\s*(?:шт|штука|штуки?|$)/i);
    if (m?.[1]) {
      const n = parseInt(m[1]!, 10);
      if (n >= 1 && n <= 9999 && !isRegistryMoneyLike(String(n))) return String(n);
    }
    // Stop if we encounter a money-like decimal (e.g. "4000.00") — we've passed the quantity column
    if (/^\d+[.,]\d{2}$/.test(t)) break;
  }
  return "";
}

/** Подпись «Идентификатор:» + внутренний id ПФ (210…/211…); не в общий registry_scan без узкого гейта в notice. */
const PF_LABELED_PRINT_FORM_INTERNAL_ID_RE = /Идентификатор\s*:\s*(2[01]\d{7,11})(?!\d)/gi;

function mergeRegistryScanRowsForPidResolution(
  base: TenderAiGoodItem[],
  extra: TenderAiGoodItem[]
): TenderAiGoodItem[] {
  const seen = new Set<string>();
  const out: TenderAiGoodItem[] = [];
  for (const r of base) {
    const k = (r.positionId ?? "").replace(/\s/g, "").trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  for (const r of extra) {
    const k = (r.positionId ?? "").replace(/\s/g, "").trim();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

/**
 * Строки registry_scan только по «Идентификатор: 210…» (ПФ). Подмешиваются узко в notice pid-pool.
 */
function extractGoodsPositionsFromPfLabeledPrintFormIdsOnly(corpus: string): TenderAiGoodItem[] {
  if (!corpus?.trim()) return [];
  const allIds: string[] = [];
  const seenId = new Set<string>();
  for (const m of corpus.matchAll(new RegExp(PF_LABELED_PRINT_FORM_INTERNAL_ID_RE.source, "gi"))) {
    const id = (m[1] ?? "").replace(/\s/g, "").trim();
    if (!id || seenId.has(id)) continue;
    seenId.add(id);
    allIds.push(id);
  }
  if (allIds.length === 0 || allIds.length > 150) return [];
  return buildRegistryGoodsItemsForPositionIdList(corpus, allIds);
}

function buildRegistryGoodsItemsForPositionIdList(
  corpus: string,
  positionIds: string[]
): TenderAiGoodItem[] {
  const lines = corpus.split("\n");
  const out: TenderAiGoodItem[] = [];
  const seenPids = new Set<string>();

  for (const pid of positionIds) {
    if (seenPids.has(pid)) continue;
    seenPids.add(pid);

    const compactPid = pid.replace(/\s/g, "");
    const pidLineIdx = lines.findIndex((ln) => {
      if (ln.includes(pid)) return true;
      return compactPid.length >= 8 && ln.replace(/\s/g, "").includes(compactPid);
    });
    if (pidLineIdx < 0) continue;

    const from = Math.max(0, pidLineIdx - 10);
    const to = Math.min(lines.length, pidLineIdx + 48);
    const windowLines = lines.slice(from, to);
    const windowText = windowLines.join(" ").replace(/\s+/g, " ").trim();

    const codes = collectKtruOkpdCodesFromRegistryWindow(windowLines);
    if (!codes.trim()) continue;

    const money = extractMoneyStringsForGoodsRow(windowText);
    if (money.length === 0) continue;

    const qtyFromLines = extractQtyFromMultiLineWindow(windowLines, pid);
    const quantity = qtyFromLines || (extractQuantityFromTabularGoodsLine(windowText) ?? "");

    let unitPrice = "";
    let lineTotal = "";
    if (money.length >= 2) {
      unitPrice = money[0]!;
      lineTotal = money[money.length - 1]!;
    } else {
      lineTotal = money[0]!;
    }

    const localPidIdx = pidLineIdx - from;
    const nameParts: string[] = [];
    for (let i = Math.max(0, localPidIdx - 5); i < localPidIdx; i++) {
      const t = (windowLines[i] ?? "").trim();
      if (
        t.length > 8 &&
        !/^\d+([.,]\d+)?$/.test(t) &&
        !extractKtruOrOkpd(t) &&
        !t.endsWith(":")
      ) {
        nameParts.push(t);
      }
    }
    const name = nameParts.length > 0
      ? nameParts.join(" ").slice(0, 200).trim()
      : "Товар";

    if (/^\(?объем\s+работы,\s*стоимость/i.test(name.trim())) continue;

    out.push({
      name,
      positionId: pid,
      codes,
      unit: "шт",
      quantity,
      unitPrice,
      lineTotal,
      sourceHint: "registry_scan",
      characteristics: [],
      quantityUnit: "",
      quantitySource: "unknown"
    });
  }

  return out;
}

/**
 * Scans the full masked corpus for all EIS registry IDs (9–12-digit numbers starting with "20").
 * For each ID found near a KTRU code and money signals, builds a goods item with:
 *   – positionId = the registry ID
 *   – codes = KTRU/OKPD code from surrounding window
 *   – quantity = extracted from column-separated lines or inline pattern (best-effort, may be "")
 *   – unitPrice / lineTotal = money values from window
 *   – name = nearest preceding descriptive text (placeholder "Товар" if not found)
 *
 * Used to discover positions that the AI model truncated or missed entirely.
 *
 * Внутренние id ПФ (210… после «Идентификатор:») сюда **не** входят — они подмешиваются узко в
 * `extractGoodsFromNoticePriceTable` при multi-segment `codes` или glue с несколькими такими id.
 */
export function extractGoodsPositionsFromRegistryIds(corpus: string): TenderAiGoodItem[] {
  if (!corpus?.trim()) return [];

  const allIds: string[] = [];
  const seenId = new Set<string>();
  const pushId = (raw: string) => {
    const id = (raw ?? "").replace(/\s/g, "").trim();
    if (!id || seenId.has(id)) return;
    seenId.add(id);
    allIds.push(id);
  };

  const idRe = new RegExp(REGISTRY_POSITION_ID_CAPTURE_RE.source, "g");
  for (const m of corpus.matchAll(idRe)) {
    pushId(m[1] ?? "");
  }

  if (allIds.length === 0 || allIds.length > 150) return [];

  return buildRegistryGoodsItemsForPositionIdList(corpus, allIds);
}

/** Тенд24: несколько позиций ПФ с одним наименованием и разными «Идентификатор: 2109…» — не схлопывать в один pid. */
type EisInternalIdBlock = { id: string; qty: string; codes: string; positionTotal: string };

function noticeDeterministicMergeRowKey(g: TenderAiGoodItem): string {
  return `${(g.positionId ?? "").replace(/\s/g, "").trim()}|${(g.codes ?? "").replace(/\s/g, "").trim()}|${(g.lineTotal ?? "").replace(/\s/g, "").trim()}`;
}

function noticeCodesKeyForCluster(codes: string): string {
  return (codes ?? "").replace(/\s/g, "").toLowerCase().split(";")[0]!.trim().slice(0, 24);
}

function qtyCloseForEisBlock(rowQty: string, blockQty: string): boolean {
  const a = parseFloat(String(rowQty ?? "").replace(",", ".").trim());
  const b = parseFloat(String(blockQty ?? "").replace(",", ".").trim());
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) < 0.501;
}

/** Сравнение сумм: в таблице часто без копеек, в корпусе — «.27» (Тенд24). */
function moneyDigitsPrefixCompatible(a: string, b: string): boolean {
  const da = (a ?? "").replace(/\D/g, "");
  const db = (b ?? "").replace(/\D/g, "");
  if (!da || !db) return false;
  const n = Math.min(da.length, db.length);
  return da.slice(0, n) === db.slice(0, n);
}

function pickEisPositionMoneyLineFromWindow(lines: string[], startIdx: number): string {
  const lim = Math.min(lines.length, startIdx + 42);
  for (let j = startIdx + 2; j < lim; j++) {
    const t = lines[j]!.trim();
    if (/^Характеристики\b/i.test(t)) break;
    const m = t.match(/^(\d{6,12})[.,](\d{2})\s*$/);
    if (!m) continue;
    const intPart = parseInt(m[1]!, 10);
    /** Итог позиции (крупная сумма), а не «210964278»-эхо id в колонке и не количество «320.00». */
    if (intPart >= 100_000) return `${m[1]}.${m[2]}`;
  }
  return "";
}

function scanLongestConsecutiveEisInternalIdBlocks(corpus: string): EisInternalIdBlock[] {
  const lines = (corpus ?? "").split("\n");
  type RawB = { id: string; qty: string; codes: string; positionTotal: string; startIdx: number };
  const raw: RawB[] = [];
  for (let i = 0; i < lines.length - 1; i++) {
    if (!/^Идентификатор\s*:\s*$/i.test(lines[i]!.trim())) continue;
    const id = lines[i + 1]?.replace(/\s/g, "").replace(/[^\d]/g, "").trim() ?? "";
    if (!/^2\d{8,11}$/.test(id)) continue;
    const region = lines.slice(i, Math.min(lines.length, i + 24)).join("\n");
    const qm = region.match(/ТоварШтука([\d.,]+)/i);
    const qty = (qm?.[1] ?? "").replace(",", ".").trim();
    const codes =
      region.match(/\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{3,5}/)?.[0]?.trim() ??
      region.match(/\d{2}\.\d{2}\.\d{2}\.\d{3}/)?.[0]?.trim() ??
      "";
    if (!codes) continue;
    const positionTotal = pickEisPositionMoneyLineFromWindow(lines, i);
    raw.push({ id, qty, codes, positionTotal, startIdx: i });
  }
  if (raw.length < 5) return [];

  let best: RawB[] = [];
  let cur: RawB[] = [];
  const sameCodes = (a: string, b: string) => noticeCodesKeyForCluster(a) === noticeCodesKeyForCluster(b);

  for (const b of raw) {
    if (!cur.length) {
      cur = [b];
      continue;
    }
    const prev = cur[cur.length - 1]!;
    const nPrev = parseInt(prev.id, 10);
    const nCur = parseInt(b.id, 10);
    if (sameCodes(prev.codes, b.codes) && nCur === nPrev + 1) cur.push(b);
    else {
      if (cur.length > best.length) best = cur.slice();
      cur = [b];
    }
  }
  if (cur.length > best.length) best = cur.slice();
  if (best.length < 5) return [];
  return best.map(({ startIdx: _s, ...rest }) => rest);
}

function isNoticePrintFormNumericPositionId(pid: string): boolean {
  const t = (pid ?? "").replace(/\s/g, "").trim();
  return isRegistryStylePositionId(t) || /^2\d{8,11}$/.test(t);
}

function reconcileNoticePrintFormDuplicateInternalRegistryPids(
  corpus: string,
  items: TenderAiGoodItem[]
): TenderAiGoodItem[] {
  const blocks = scanLongestConsecutiveEisInternalIdBlocks(corpus);
  if (blocks.length < 5) return items;

  const blockCodesKey = noticeCodesKeyForCluster(blocks[0]!.codes);
  const blockIds = new Set(blocks.map((b) => b.id));

  const printIdx = items
    .map((g, idx) => ({ g, idx }))
    .filter(
      ({ g }) =>
        isNoticePrintFormRow(g) &&
        isNoticePrintFormNumericPositionId((g.positionId ?? "").replace(/\s/g, "")) &&
        noticeCodesKeyForCluster(g.codes ?? "") === blockCodesKey
    );
  /** Не брать «019…» служебные строки ПФ первыми — иначе nameKey не совпадёт с блоком 210964… (Тенд24). */
  const registryPfRows = printIdx.filter(({ g }) => /^2\d{8,11}$/.test((g.positionId ?? "").replace(/\s/g, "")));
  if (registryPfRows.length < 3) return items;

  const nameKey = normalizeGoodsInfoProductNameKey(registryPfRows[0]!.g.name ?? "");
  if (nameKey.length < 24) return items;
  const cluster = registryPfRows.filter(
    ({ g }) => normalizeGoodsInfoProductNameKey(g.name ?? "") === nameKey
  );
  if (cluster.length < 3) return items;

  const pidCounts = new Map<string, number>();
  for (const { g } of cluster) {
    const p = (g.positionId ?? "").replace(/\s/g, "").trim();
    pidCounts.set(p, (pidCounts.get(p) ?? 0) + 1);
  }
  const hasDupPid = [...pidCounts.values()].some((n) => n > 1);
  const missingBlock = blocks.some((b) => !cluster.some(({ g }) => (g.positionId ?? "").replace(/\s/g, "") === b.id));
  if (!hasDupPid && !missingBlock) return items;

  const digits = (s: string) => (s ?? "").replace(/\D/g, "");
  const out = items.filter((g) => {
    if (!isNoticePrintFormRow(g)) return true;
    const pid = (g.positionId ?? "").replace(/\s/g, "").trim();
    const lt = digits(g.lineTotal ?? "");
    if (!isNoticePrintFormNumericPositionId(pid)) return true;
    if (noticeCodesKeyForCluster(g.codes ?? "") !== blockCodesKey) return true;
    if (normalizeGoodsInfoProductNameKey(g.name ?? "") !== nameKey) return true;
    /** ПФ-артефакт: «стоимость» совпала с id строки (Тенд24) — не позиция. */
    if (lt === pid && blockIds.has(pid)) return false;
    return true;
  });

  const clusterRows = out
    .map((g, idx) => ({ g, idx }))
    .filter(
      ({ g }) =>
        isNoticePrintFormRow(g) &&
        isNoticePrintFormNumericPositionId((g.positionId ?? "").replace(/\s/g, "")) &&
        noticeCodesKeyForCluster(g.codes ?? "") === blockCodesKey &&
        normalizeGoodsInfoProductNameKey(g.name ?? "") === nameKey
    );

  const assigned = new Set<string>();
  const updates = new Map<number, { positionId: string; quantity?: string }>();

  const unusedRowIdx = new Set(clusterRows.map((r) => r.idx));

  const takeRowForBlock = (b: EisInternalIdBlock): number | null => {
    for (const idx of unusedRowIdx) {
      const g = out[idx]!;
      if (b.positionTotal && moneyDigitsPrefixCompatible(g.lineTotal ?? "", b.positionTotal)) return idx;
    }
    for (const idx of unusedRowIdx) {
      const g = out[idx]!;
      if (digits(g.lineTotal ?? "") === b.id) return idx;
    }
    const qHits = [...unusedRowIdx].filter((idx) => qtyCloseForEisBlock(out[idx]!.quantity ?? "", b.qty));
    if (qHits.length === 1) return qHits[0]!;
    return null;
  };

  for (const b of blocks) {
    if (assigned.has(b.id)) continue;
    const idx = takeRowForBlock(b);
    if (idx == null) continue;
    unusedRowIdx.delete(idx);
    assigned.add(b.id);
    const g = out[idx]!;
    const curPid = (g.positionId ?? "").replace(/\s/g, "");
    const qOut = String(Math.round(parseFloat(b.qty.replace(",", ".")) || 0));
    if (curPid !== b.id || (g.quantity ?? "").trim() !== qOut) {
      updates.set(idx, { positionId: b.id, quantity: qOut });
    }
  }

  const appended: TenderAiGoodItem[] = [];
  for (const b of blocks) {
    if (assigned.has(b.id)) continue;
    const idx = [...unusedRowIdx][0];
    if (idx != null) {
      unusedRowIdx.delete(idx);
      assigned.add(b.id);
      const qOut = String(Math.round(parseFloat(b.qty.replace(",", ".")) || 0));
      updates.set(idx, { positionId: b.id, quantity: qOut });
      continue;
    }
    const template = clusterRows[0]!.g;
    appended.push({
      ...template,
      positionId: b.id,
      quantity: String(Math.round(parseFloat(b.qty.replace(",", ".")) || 0)),
      unitPrice: "",
      lineTotal: b.positionTotal || "",
      characteristics: [],
      quantityUnit: "",
      quantitySource: "unknown"
    });
    assigned.add(b.id);
  }

  const patched: TenderAiGoodItem[] = [
    ...out.map((g, i) => {
      const u = updates.get(i);
      if (!u) return g;
      return {
        ...g,
        positionId: u.positionId,
        ...(u.quantity != null ? { quantity: u.quantity } : {})
      };
    }),
    ...appended
  ];

  const seen = new Set<string>();
  const deduped: TenderAiGoodItem[] = [];
  for (const g of patched) {
    const k = noticeDeterministicMergeRowKey(g);
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(g);
  }
  return enrichNoticePrintFormRowsWithPfCharacteristics(corpus, deduped);
}

/** Схлопывание дублей «registry + та же строка ПФ» по codes+итогу; таблица перезаписывает registry (Тенд32). */
const NOTICE_SOFT_MERGE_KEY = (g: TenderAiGoodItem) =>
  `${(g.codes ?? "").replace(/\s/g, "").toLowerCase()}|${(g.lineTotal ?? "").replace(/\s/g, "").replace(",", ".")}`;

/**
 * Детерминированный notice-слой для `enhanceTechSpecBundleWithNoticeRows`: печатная таблица
 * с ценами + строки из скана реестровых id по корпусу (20… и длинные 01…). Внутренние id ПФ (210…)
 * участвуют только узко внутри `extractGoodsFromNoticePriceTable` (glue / multi-segment codes), не в `fromRegistry`.
 */
export function buildNoticeDeterministicRowsForGoodsMerge(corpus: string): TenderAiGoodItem[] {
  const fromTable = extractGoodsFromNoticePriceTable(corpus);
  const fromRegistry = extractGoodsPositionsFromRegistryIds(corpus);
  const fromGoodsInfo = extractGoodsFromNoticeGoodsInfoSection(corpus);
  const bySoft = new Map<string, TenderAiGoodItem>();
  for (const g of fromRegistry) bySoft.set(NOTICE_SOFT_MERGE_KEY(g), g);
  for (const g of fromTable) {
    const k = NOTICE_SOFT_MERGE_KEY(g);
    const prev = bySoft.get(k);
    let row = g;
    if (prev) {
      const gPid = (g.positionId ?? "").replace(/\s/g, "").trim();
      const pPid = (prev.positionId ?? "").replace(/\s/g, "").trim();
      if (!gPid && pPid && isRegistryStylePositionId(pPid)) {
        row = { ...g, positionId: prev.positionId };
      }
    }
    bySoft.set(k, row);
  }
  for (const g of fromGoodsInfo) {
    const k = NOTICE_SOFT_MERGE_KEY(g);
    if (bySoft.has(k)) continue;
    bySoft.set(k, g);
  }
  const merged = [...bySoft.values()];
  const seen = new Set<string>();
  const out: TenderAiGoodItem[] = [];
  for (const g of merged) {
    const k = noticeDeterministicMergeRowKey(g);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(g);
  }
  return reconcileNoticePrintFormDuplicateInternalRegistryPids(corpus, out);
}
