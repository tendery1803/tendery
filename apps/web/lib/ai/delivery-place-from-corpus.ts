/**
 * Пост-разбор delivery_place: кандидаты из полного обезличенного корпуса документов,
 * ранжирование конкретики и слияние с ответом модели (контракт JSON не меняется).
 */

const MAX_MARKER_WINDOWS = 350;
const WINDOW_CHARS = 3400;
const MAX_LINES_AFTER_MARKER = 24;

/** Маркеры места поставки / исполнения (без грузополучателя; адрес заказчика не синоним). */
const DELIVERY_MARKER_RE = new RegExp(
  [
    "место\\s+поставки\\s+товара\\s*,\\s*выполнения\\s+работы?\\s+или\\s+оказания\\s+услуги",
    "мест[ао]\\s+поставки\\s+товар[а]?",
    "местоположени[ея]\\s+поставки",
    "место\\s+доставки\\s+товар[а]?",
    "адрес[аы]?\\s+поставки(?:\\s+товар[а]?)?",
    "по\\s+адресам\\s+поставки\\s+товар[а]?",
    "место\\s+передачи\\s+товар[а]?",
    "поставка\\s+по\\s+заявкам\\s+заказчика\\s+по\\s+адресам",
    "место\\s+выполнения\\s+работ",
    "место\\s+оказания\\s+услуг",
    "адрес\\s+оказания\\s+услуг",
    "место\\s+исполнения\\s+(?:договора?|контракта?)",
    "объекты?\\s+заказчика\\s*,\\s*расположенн[ыь][еёх]?\\s+по\\s+адресам",
    "адресная\\s+ведомость",
    "график\\s+поставки",
    "разнарядк[аи]",
    "отгрузочн(?:ая|ой)?\\s+разнарядк",
    "адрес\\s+доставки"
  ].join("|"),
  "gi"
);

/** В JS `\w` не покрывает кириллицу — только явные русские окончания. */
const RE_UNIVERSAL_TRANSFER_DOC =
  /универсальн[а-яё]*\s+передаточн[а-яё]*(?:\s+документ[а-яё]*)?/i;

/**
 * Хвосты после реального адреса: закон 44-ФЗ, ЕИС/ЕСИА, оператор ЭТП, УКЭП, обязанности сторон, приёмка и т.п.
 * Все шаблоны с ведущим пробелом/запятой, чтобы не резать середину слова.
 */
const LEGAL_PROCEDURE_TAIL_KILLERS: RegExp[] = [
  /\s*,\s*с\s+(?:предварительным\s+)?уведомлен/i,
  /\s+с\s+предварительным\s+уведомлен/i,
  /\s+Федеральн[а-яё]*\s+закона?\s+№/i,
  /\s+№\s*44[-\s]?ФЗ/i,
  /\s+оператор[а]?\s+электронн[а-яё]*\s+площадк/i,
  /\s+един(?:ой|ая)\s+информационн[а-яё]*\s+систем/i,
  /\s+ЕИС(?:[\s.,;)]|$)/i,
  /\s+ЕСИА(?:[\s.,;)]|$)/i,
  /\s+официальн[а-яё]*\s+реестр/i,
  /\s+реестр[а]?\s+(?:участник|недобросовестн|размещен|закупк)/i,
  /\s+усиленн[а-яё]*\s+(?:квалифицированн[а-яё]*\s+)?электронн[а-яё]*\s+подпис/i,
  /\s+электронн[а-яё]*\s+документ(?:е|а|ы|ов)?(?!ооборот)(?:[\s,;.]|$)/i,
  /\s+поставщик[а]?\s+обязу/i,
  /\s+заказчик[а]?\s+направля/i,
  /\s+(?:приёмк|приемк)[аи]\s+(?:товар|работ|услуг|результат)/i,
  /\s+экспертиз[аы]\s+(?:товар|образц|качеств|проведен)/i,
  /\s+уведомлени[яе]\s+(?:участник|заказчик|о\s+подач|о\s+результат)/i
];

const DELIVERY_CONTEXT_RE =
  /поставк|доставк|мест[ао]\s*поставк|передач[аи]\s+товар|оказан[а-яё]*\s+услуг|выполнен[а-яё]*\s+работ|исполнен[а-яё]*\s+(?:договор|контракт)|график\s+поставк|адресная\s+ведомост|разнарядк|мест[ао]\s+исполнен/i;

const CUSTOMER_ADDR_LABEL_RE =
  /юридическ(?:ий|ого|ом)?\s+адрес|почтов(?:ый|ого|ом)?\s+адрес|фактическ(?:ий|ого|ом)?\s+адрес/i;

const JUNK_LINE_RE =
  /^(поле|значение|примечание|№|номер|подпись|дата)\s*$/i;

function streetHint(t: string): boolean {
  return /(\bул\.?\s|\bулица\s|просп\.|проспект|переул|шоссе|наб\.|набережн|бульвар|\bд\.?\s*\d|[,\s]дом\s*\d|корп\.|корпус|строен|\bкв\.?\s*\d|литер\s*[А-Яа-яA-Z])/i.test(
    t
  );
}

function settlementHint(t: string): boolean {
  return /\b(г\.|город|поселок|пгт|пос\.|с\.|село|деревн|р\.п\.)\s*[А-Яа-яЁё]/i.test(t);
}

/** Сильные признаки адреса (индекс, улица, дом, корпус, объект + населённый пункт). */
export function hasStrongAddressSignal(t: string): boolean {
  const s = t.replace(/\s+/g, " ");
  if (/\b\d{6}\b/.test(s) && s.length > 14) return true;
  if (streetHint(s)) return true;
  if (settlementHint(s) && /(?:обл\.|область|край|респ\.|республика)/i.test(s)) return true;
  if (
    /\b(?:корп\.|корпус|стр\.|строение|пом\.|помещен)/i.test(s) &&
    (settlementHint(s) || /\b\d{6}\b/.test(s) || /[,.]\s*[А-Яа-яЁё]{3,}/.test(s))
  ) {
    return true;
  }
  if (
    /\b(?:филиал|здание|объект|учрежден|школ|детск|сад|больниц|поликлин)/i.test(s) &&
    (settlementHint(s) || streetHint(s) || /\b\d{6}\b/.test(s))
  ) {
    return true;
  }
  return false;
}

/** Строка про сроки/УПД/оплату/подпункт договора без адресного содержания — не место поставки. */
function looksLikeTermOrProcedureLine(t: string): boolean {
  if (hasStrongAddressSignal(t)) return false;
  const n = t.toLowerCase();
  if (/^(?:п\.?\s*)?\d{1,2}\.\d{1,2}\.\s+(?=[А-ЯЁA-Z«"0-9])/u.test(t.trim())) return true;
  return (
    /\b(?:^|[.;]\s*)(?:срок|согласован|упд|документооборот|постановлен|приложение\s*№|форма\s+заявк|порядок\s+приёмк|порядок\s+поставки|оплат)\b/i.test(
      n
    ) ||
    RE_UNIVERSAL_TRANSFER_DOC.test(n) ||
    (/(?:^|[\s;])заявк[аи]\b/i.test(t) && !/заказчик/i.test(n)) ||
    (/\bпоставка\s+осуществляется\b/i.test(n) && !streetHint(t) && !/\b\d{6}\b/.test(t)) ||
    (/\bне\s+позднее\b/i.test(n) &&
      /(?:рабоч|календарн)[а-яё]*\s+дн/i.test(n) &&
      !streetHint(t) &&
      !/\b\d{6}\b/.test(t)) ||
    (/\bдоговор\b/i.test(n) && /\b(?:расторжен|заключен|изменен)\b/i.test(n) && !streetHint(t))
  );
}

/** Сегмент целиком — правовая/процедурная норма без адреса (не место поставки). */
function looksLikeLegalProcedureChunk(t: string): boolean {
  if (hasStrongAddressSignal(t)) return false;
  const n = t.toLowerCase().replace(/\s+/g, " ");
  return (
    /(?:^|[\s.;,(])федеральн[а-яё]*\s+закона?\s+№|(?:^|[\s.;,(])№\s*44[-\s]?фз/i.test(n) ||
    /оператор[а]?\s+электронн[а-яё]*\s+площадк/i.test(n) ||
    /(?:^|[\s.,;(])еис(?:$|[\s.,;)])/i.test(n) ||
    /(?:^|[\s.,;(])есиа(?:$|[\s.,;)])/i.test(n) ||
    /един(?:ой|ая)\s+информационн[а-яё]*\s+систем/i.test(n) ||
    /официальн[а-яё]*\s+реестр/i.test(n) ||
    /(?:^|[\s.;,(])реестр[а]?\s+(?:участник|недобросовестн|размещен|закупк)/i.test(n) ||
    /усиленн[а-яё]*\s+(?:квалифицированн[а-яё]*\s+)?электронн[а-яё]*\s+подпис/i.test(n) ||
    /электронн[а-яё]*\s+документ(?:е|а|ы|ов)?(?!ооборот)(?:[\s,;.]|$)/i.test(n) ||
    /поставщик[а]?\s+обязу/i.test(n) ||
    /заказчик[а]?\s+направля/i.test(n) ||
    /предварительн[а-яё]*\s+уведомлен/i.test(n) ||
    /(?:^|[\s.;,(])уведомлени[яе]\s+(?:участник|заказчик|о\s+подач|о\s+результат)/i.test(n) ||
    /(?:приёмк|приемк)[аи]\s+(?:товар|работ|услуг|результат)/i.test(n) ||
    /экспертиз[аы]\s+(?:товар|образц|качеств|проведен)/i.test(n)
  );
}

/** Жёстко отрезать договорный хвост после адресного блока (подпункты 3.3., оплата, УПД, …). */
function hardTrimTrailingContractNoise(s: string): string {
  const t = s.trim();
  if (t.length < 28) return t;
  const killers: RegExp[] = [
    /\s+(?:п\.?\s*)?(?:\d{1,2}\.\d{1,2}\.)\s+(?=[А-ЯЁA-Z«"])/u,
    /\s+Срок\s+согласован/i,
    /\s+Поставка\s+товара\s+осуществляется/i,
    RE_UNIVERSAL_TRANSFER_DOC,
    /\s+оплат[аы]\b/i,
    /\s+Приложение\s*№/i,
    /\s+Договор\s+(?:может|подлежит|вступает|расторга)/i,
    /\s+не\s+позднее\s+чем\s+за\s+\d+/i,
    /\s+(?:УПД|ЭДО|документооборот)\b/i,
    /\s+заявк[аи]\b(?=\s|,|;|\.)(?![^.;]{0,48}заказчик)/i,
    ...LEGAL_PROCEDURE_TAIL_KILLERS
  ];
  let cutAt = t.length;
  for (const re of killers) {
    re.lastIndex = 0;
    const m = re.exec(t);
    if (m != null && m.index >= 20 && m.index < cutAt) cutAt = m.index;
  }
  if (cutAt < t.length) return t.slice(0, cutAt).replace(/\s*[;,]\s*$/g, "").trim();
  return t;
}

function trimSingleAddressSegmentTail(seg: string): string {
  let p = seg.replace(/\s+/g, " ").trim();
  if (p.length < 25) return p;
  const inner = /\s+(?:п\.?\s*)?(?:\d{1,2}\.\d{1,2}\.)\s+(?=[А-ЯЁA-Z«"])/u;
  const mi = p.search(inner);
  if (mi > 18) p = p.slice(0, mi).trim();
  const tailAlts: RegExp[] = [
    /\s+Срок\s+согласован/i,
    /\s+Поставка\s+товара\s+осуществляется/i,
    /\s+оплат[аы]\b/i,
    /\s+УПД\b/i,
    RE_UNIVERSAL_TRANSFER_DOC,
    /\s+Приложение\s*№/i,
    /\s+не\s+позднее\s+чем\s+за\s+\d+/i,
    /\s+заявк[аи]\b(?=\s|,|;|\.)(?![^.;]{0,48}заказчик)/i,
    ...LEGAL_PROCEDURE_TAIL_KILLERS
  ];
  for (const re of tailAlts) {
    const j = p.search(re);
    if (j > 22) p = p.slice(0, j).trim();
  }
  return p;
}

/** Дробление одного куска: новый индекс ###### или подпункт «3.3.» внутри абзаца. */
function splitChunkByPostalAndSubsection(chunk: string): string[] {
  const c = chunk.trim();
  if (!c) return [];
  const byPostal = c
    .split(/(?<=[\s,;]|^)(?=\d{6}\b)/g)
    .map((x) => x.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const piece of byPostal) {
    const sub = /\s+(?:п\.?\s*)?(?:\d{1,2}\.\d{1,2}\.)\s+(?=[А-ЯЁA-Z«"])/u;
    const idx = piece.search(sub);
    if (idx > 22 && hasStrongAddressSignal(piece.slice(0, idx))) {
      out.push(piece.slice(0, idx).trim());
      const rest = piece.slice(idx).trim();
      if (rest.length > 12 && hasStrongAddressSignal(rest)) out.push(rest);
    } else {
      out.push(piece);
    }
  }
  return out;
}

function splitBlobIntoRawAddressChunks(blob: string): string[] {
  const s = blob.replace(/\s+/g, " ").trim();
  if (!s) return [];
  const bySemi = s.split(/\s*;\s*/).map((x) => x.trim()).filter(Boolean);
  const out: string[] = [];
  for (const semi of bySemi) {
    out.push(...splitChunkByPostalAndSubsection(semi));
  }
  return out;
}

function dedupePlaceStrings(arr: string[]): string[] {
  const seen = new Set<string>();
  const res: string[] = [];
  for (const x of arr) {
    const t = x.replace(/\s+/g, " ").trim();
    const k = normalizeDeliveryPlaceForDedupe(t);
    if (k.length < 8 || seen.has(k)) continue;
    seen.add(k);
    res.push(t);
  }
  return res;
}

/**
 * Выделение адресных сегментов → нормализация хвостов → дедуп → порядок для подсчёта N.
 */
export function normalizeDeliveryPlaceSegments(blob: string): string[] {
  let s = blob.replace(/^\s*Места\s+поставки\s*\(\d+\)\s*:\s*/i, "").replace(/\s+/g, " ").trim();
  if (!s) return [];
  s = hardTrimTrailingContractNoise(s);
  const raw = splitBlobIntoRawAddressChunks(s);
  const trimmed = raw.map(trimSingleAddressSegmentTail).map((x) => x.trim()).filter((x) => x.length >= 10);
  let parts = trimmed.filter(
    (p) => !looksLikeTermOrProcedureLine(p) && !looksLikeLegalProcedureChunk(p)
  );
  const anyStrong = parts.some((p) => hasStrongAddressSignal(p));
  if (anyStrong) {
    parts = parts.filter((p) => {
      if (hasStrongAddressSignal(p)) return true;
      return scoreDeliveryPlaceSpecificity(p) <= 3;
    });
    parts = parts.filter((p) => {
      if (hasStrongAddressSignal(p)) return true;
      if (/\bОКАТО\b|\bОКТМО\b/i.test(p) && !streetHint(p)) return false;
      const t = p.trim();
      if (
        scoreDeliveryPlaceSpecificity(p) >= 4 &&
        /^(?:[А-Яа-яё\-\s\,]+)(?:область|край|округ|Республика)\s*\.?\s*$/i.test(t)
      ) {
        return false;
      }
      return true;
    });
  }
  return dedupePlaceStrings(parts);
}

function buildFormattedDeliveryPlaceFromParts(parts: string[]): string {
  if (parts.length === 0) return "";
  const segs = normalizeDeliveryPlaceSegments(parts.join("; "));
  if (segs.length === 0) return parts.join("; ").replace(/\s+/g, " ").trim();
  if (segs.length === 1) return segs[0];
  return `Места поставки (${segs.length}): ${segs.join("; ")}`;
}

/** 1 — максимально конкретно … 5 — расплывчато. */
export function scoreDeliveryPlaceSpecificity(t: string): number {
  const s = t.replace(/\s+/g, " ").trim();
  if (s.length < 6) return 5;

  if (
    /^(по\s+заявкам\b|согласно\s+заявк|указывается\s+в\s+заявк|определяется\s+заявк\b)/i.test(s)
  ) {
    return 5;
  }
  if (/^по\s+адресам\s+заказчика/i.test(s) && !streetHint(s) && !/\b\d{6}\b/.test(s)) {
    return 5;
  }
  if (
    /устанавливается\s+в\s+договоре|указывается\s+в\s+договоре/i.test(s) &&
    !/\b\d{6}\b/.test(s) &&
    !streetHint(s)
  ) {
    return 5;
  }

  if (/\bОКАТО\b|\bОКТМО\b|\bокато\b|\bоктмо\b/i.test(s) && !streetHint(s) && s.length < 140) {
    return 4;
  }

  const st = streetHint(s);
  const postal = /\b\d{6}\b/.test(s);
  const sett = settlementHint(s);

  if (st && (postal || sett || s.length > 38)) return 1;
  if (postal && s.length > 26) return 1;

  if (
    /^(?:[А-Яа-яё\-\s\,]+)(?:область|край|округ|Республика|Автономный округ|Федеральный округ)\s*\.?\s*$/i.test(
      s
    ) &&
    !st
  ) {
    return 4;
  }

  if (sett && s.length > 45 && !st) return 3;
  if (
    /область|край|Республика|Федеральный округ|автономный округ/i.test(s) &&
    !st &&
    s.length < 90
  ) {
    return 4;
  }

  if (s.length > 28 && /№|учрежден|школ|детск|сад|больниц|поликлин|объект/i.test(s)) return 3;

  return 4;
}

function normalizePlaceKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,;]+$/g, "")
    .trim();
}

/**
 * Stronger normalization key for deduplication of delivery place strings.
 *
 * Extends normalizePlaceKey by also collapsing all whitespace adjacent to internal
 * punctuation (commas, periods, semicolons).  This makes formatting variants of the
 * same address produce the same key, e.g.:
 *   "г. Москва, ул. Садовая, д. 1"  →  "г.москва,ул.садовая,д.1"
 *   "г.Москва,ул.Садовая,д.1"       →  "г.москва,ул.садовая,д.1"  ← same key ✓
 *   "г. Москва , ул. Садовая ,д.1"  →  "г.москва,ул.садовая,д.1"  ← same key ✓
 *
 * Genuinely different addresses still produce different keys because the numeric
 * parts (building number, postal code, etc.) are preserved unchanged.
 */
export function normalizeDeliveryPlaceForDedupe(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")           // collapse multiple whitespace
    .replace(/\s*([.,;])\s*/g, "$1") // remove spaces adjacent to punctuation
    .replace(/[.,;]+$/g, "")        // strip trailing punctuation
    .trim();
}

/**
 * Deduplicate an array of delivery place strings.
 *
 * Preserves order and keeps genuinely different addresses while removing exact
 * duplicates and formatting variants (different spacing / punctuation around
 * abbreviations) of the same address.
 *
 * Use instead of — or alongside — the internal dedupePlaceStrings when entries
 * may originate from multiple documents with inconsistent OCR/formatting.
 */
export function dedupeDeliveryPlaces(parts: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of parts) {
    const t = p.replace(/\s+/g, " ").trim();
    if (!t) continue;
    const key = normalizeDeliveryPlaceForDedupe(t);
    if (key.length < 8) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(t);
  }
  return result;
}

export function parseDeliveryPlaceParts(value: string): string[] {
  return normalizeDeliveryPlaceSegments(value);
}

function windowLooksLikeCustomerOnlyLegalBlock(windowSlice: string): boolean {
  const head = windowSlice.slice(0, Math.min(900, windowSlice.length));
  return CUSTOMER_ADDR_LABEL_RE.test(head) && !DELIVERY_CONTEXT_RE.test(head);
}

function lineRejectedAsCustomerOnly(
  window: string,
  lineStartInWindow: number,
  lineText: string
): boolean {
  const before = window.slice(Math.max(0, lineStartInWindow - 520), lineStartInWindow);
  if (!CUSTOMER_ADDR_LABEL_RE.test(before)) return false;
  const ctx = before + lineText.slice(0, 120);
  if (DELIVERY_CONTEXT_RE.test(ctx)) return false;
  return scoreDeliveryPlaceSpecificity(lineText) >= 4;
}

function stripBullet(line: string): string {
  return line
    .replace(/^\s*(?:[−\-•*]|\d+[\.\)])\s+/, "")
    .replace(/^\s*\d+\s+/, "")
    .trim();
}

function leftLooksLikeDeliveryLabel(left: string): boolean {
  return /мест[ао]\s+поставк|адрес[аы]?\s+поставк|местоположен|доставк|передач[аи]\s+товар|оказан[а-яё]*\s+услуг|выполнен[а-яё]*\s+работ|исполнен[а-яё]*\s+(?:договор|контракт)|график\s+поставк|ведомост|разнарядк|по\s+заявкам\s+заказчика\s+по\s+адресам/i.test(
    left
  );
}

function splitValueAfterColon(line: string): string[] {
  const idx = line.indexOf(":");
  if (idx === -1) return [line];
  const left = line.slice(0, idx);
  const right = line.slice(idx + 1).trim();
  if (!right) return [line];
  if (leftLooksLikeDeliveryLabel(left)) {
    return right.split(/\s*;\s*/).map((x) => stripBullet(x.trim())).filter(Boolean);
  }
  return [line];
}

function extractLinesFromWindow(window: string): string[] {
  if (windowLooksLikeCustomerOnlyLegalBlock(window)) return [];

  const lines = window.split(/\r?\n/);
  const nlLen = window.includes("\r\n") ? 2 : 1;
  let hitIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const test = lines.slice(0, i + 1).join("\n");
    DELIVERY_MARKER_RE.lastIndex = 0;
    if (DELIVERY_MARKER_RE.test(test)) {
      hitIdx = i;
      break;
    }
  }
  if (hitIdx < 0) hitIdx = 0;

  const collected: string[] = [];
  let emptyRun = 0;
  const end = Math.min(lines.length, hitIdx + MAX_LINES_AFTER_MARKER);

  let charOffset = 0;
  for (let j = 0; j < hitIdx; j++) charOffset += lines[j].length + nlLen;

  scan: for (let i = hitIdx; i < end; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed) {
      emptyRun++;
      if (emptyRun >= 2 && collected.length > 0) break;
      charOffset += raw.length + nlLen;
      continue;
    }
    emptyRun = 0;
    if (JUNK_LINE_RE.test(trimmed)) {
      charOffset += raw.length + nlLen;
      continue;
    }

    if (
      collected.length > 0 &&
      /^(?:п\.?\s*)?\d{1,2}\.\d{1,2}\.\s+(?=[А-ЯЁA-Z«"0-9])/u.test(trimmed) &&
      !hasStrongAddressSignal(trimmed)
    ) {
      break;
    }

    if (collected.length > 0 && looksLikeTermOrProcedureLine(trimmed)) {
      break;
    }

    if (collected.length > 0 && looksLikeLegalProcedureChunk(trimmed)) {
      break;
    }

    if (
      /^(?:п\.?\s*)?\d{1,2}\.\d{1,2}\.\s+(?=[А-ЯЁA-Z«"0-9])/u.test(trimmed) &&
      !hasStrongAddressSignal(trimmed)
    ) {
      if (collected.length > 0) break;
      charOffset += raw.length + nlLen;
      continue;
    }

    const lineStart = charOffset;
    if (lineRejectedAsCustomerOnly(window, lineStart, trimmed)) {
      charOffset += raw.length + nlLen;
      continue;
    }

    const pieces = splitValueAfterColon(trimmed);
    for (const piece of pieces) {
      const p = stripBullet(piece).replace(/\s+/g, " ").trim();
      if (p.length < 10) continue;
      if (JUNK_LINE_RE.test(p)) continue;
      if (/^[_\-]{3,}$/.test(p)) continue;
      if (collected.length > 0 && looksLikeTermOrProcedureLine(p)) {
        break scan;
      }
      if (collected.length > 0 && looksLikeLegalProcedureChunk(p)) {
        break scan;
      }
      if (
        /мест[ао]\s+поставк|адресная\s+ведом|график\s+поставк|разнарядк|отгрузочн/i.test(p) &&
        !streetHint(p) &&
        !/\d{6}/.test(p) &&
        !/[.:]/.test(p)
      ) {
        continue;
      }

      if (p.includes(";")) {
        for (const sub of p.split(/\s*;\s*/)) {
          const u = sub.trim();
          if (u.length >= 10 && !looksLikeTermOrProcedureLine(u) && !looksLikeLegalProcedureChunk(u)) {
            collected.push(u);
          }
        }
      } else if (!looksLikeTermOrProcedureLine(p) && !looksLikeLegalProcedureChunk(p)) {
        collected.push(p);
      }
    }
    charOffset += raw.length + nlLen;
  }

  return collected;
}

type Scored = { text: string; score: number };

function collectScoredFromCorpus(maskedCorpus: string): Scored[] {
  const corpus = maskedCorpus;
  const out: Scored[] = [];
  let count = 0;
  let m: RegExpExecArray | null;
  const re = new RegExp(DELIVERY_MARKER_RE.source, "gi");
  while ((m = re.exec(corpus)) !== null && count < MAX_MARKER_WINDOWS) {
    count++;
    const window = corpus.slice(m.index, m.index + WINDOW_CHARS);
    const lines = extractLinesFromWindow(window);
    for (const line of lines) {
      const score = scoreDeliveryPlaceSpecificity(line);
      if (score >= 5) continue;
      out.push({ text: line, score });
    }
  }
  return out;
}

function dedupeScored(items: Scored[]): Scored[] {
  const seen = new Set<string>();
  const res: Scored[] = [];
  for (const it of items) {
    const k = normalizeDeliveryPlaceForDedupe(it.text);
    if (k.length < 8) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    res.push(it);
  }
  return res;
}

function pickBestParts(scored: Scored[]): string[] {
  if (scored.length === 0) return [];
  const hasFine = scored.some((s) => s.score <= 3);
  const pool = hasFine ? scored.filter((s) => s.score <= 3) : scored.filter((s) => s.score <= 4);
  const deduped = dedupeScored(pool);
  deduped.sort((a, b) => a.score - b.score || b.text.length - a.text.length);
  return deduped
    .filter((x) => !looksLikeTermOrProcedureLine(x.text) && !looksLikeLegalProcedureChunk(x.text))
    .map((x) => x.text);
}

function mergePlacePartsDedup(a: string[], b: string[]): string[] {
  const seen = new Set<string>();
  const res: string[] = [];
  for (const x of [...a, ...b]) {
    const t = x.replace(/\s+/g, " ").trim();
    const k = normalizeDeliveryPlaceForDedupe(t);
    if (k.length < 8 || seen.has(k)) continue;
    seen.add(k);
    res.push(t);
  }
  return res;
}

function mergedScore(parts: string[]): number {
  if (parts.length === 0) return 99;
  return Math.min(...parts.map((p) => scoreDeliveryPlaceSpecificity(p)));
}

/**
 * Финальная очистка delivery_place: сегментация адресов, обрезка договорного хвоста, дедуп, верный N.
 */
export function finalizeDeliveryPlaceOutput(value: string): string {
  const v0 = value.replace(/\s+/g, " ").trim();
  if (!v0) return "";
  const segs = normalizeDeliveryPlaceSegments(v0);
  if (segs.length === 0) return v0;
  if (segs.length === 1) return segs[0];
  return `Места поставки (${segs.length}): ${segs.join("; ")}`;
}

/**
 * Сравнивает ответ модели с кандидатами из корпуса; при более конкретных адресах в тексте заменяет value.
 */
export function enhanceDeliveryPlaceFromModelAndCorpus(
  modelValue: string,
  maskedCorpus: string
): string {
  const model = modelValue.replace(/\s+/g, " ").trim();
  if (!maskedCorpus.trim()) return model;

  const scored = collectScoredFromCorpus(maskedCorpus);
  const corpusParts = pickBestParts(scored);
  if (corpusParts.length === 0) return model;

  const modelParts = parseDeliveryPlaceParts(model);
  const modelScore = model ? mergedScore(modelParts.length ? modelParts : [model]) : 99;
  const corpusScore = mergedScore(corpusParts);

  if (corpusScore < modelScore) {
    return buildFormattedDeliveryPlaceFromParts(corpusParts);
  }

  if (corpusScore === modelScore && modelScore <= 2) {
    const merged = mergePlacePartsDedup(modelParts, corpusParts);
    if (merged.length > Math.max(modelParts.length, 1)) {
      return buildFormattedDeliveryPlaceFromParts(merged);
    }
  }

  return model;
}
