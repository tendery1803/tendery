/**
 * Узкая раскладка вертикальной спецификации ЕИС: короткое наименование, описание, фасовка vs закупка, °C.
 * Не трогает картриджный / табличный путь — вызывается только из parsePositionBlock при bare-ordinal.
 */

import type { TenderAiCharacteristicRow } from "@tendery/contracts";

const FIELD_HEAD_RE = /^[А-Яа-яЁёA-Za-z0-9][^:\n]{0,220}?:\s*\S/;

/** «100 штук в упаковке», «50 пар в упаковке», «50 шт/упак», «100 шт „Brand»» — фасовка, не закупка. */
export function lineLooksLikePackOnlyQtyInProse(line: string): boolean {
  const t = line.replace(/\s+/g, " ").trim();
  if (t.length < 8) return false;
  if (/\d+(?:[.,]\d+)?\s*пар\w*\s+в\s+упаковк/i.test(t)) return true;
  if (
    /(?:в\s+упаковк[а-яё]*|упаковк[а-яё]*)\s+\d+(?:[.,]\d+)?\s*(?:шт\.?|штук\w*|пар\w*|компл\w*)/i.test(t)
  ) {
    return true;
  }
  /** «… 100 шт „Master…»» / «100 шт "…"» — типичная фасовка в описании, не колонка закупки. */
  if (/\b\d+(?:[.,]\d+)?\s*шт\.?\s*[«""''`]/i.test(t)) return true;
  if (
    /\d+(?:[.,]\d+)?\s*(?:шт\.?|штук\w*|пар\w*|компл\w*|ед\.?\s*изм\.?)\s*(?:в\s+упаковк|в\s+упак|\/упак|на\s+упак|в\s+пачк|в\s+наборе|на\s+лист|фасовк|упаковке\s*\(|упак\.\s*$)/i.test(
      t
    )
  ) {
    return true;
  }
  if (/\(\s*\d+\s*(?:шт|штук|пар)\w*\s*\/\s*\d+\s*(?:шт|штук)/i.test(t)) return true;
  if (/\d+\s*(?:шт|штук|пар)\w*\s*\/\s*\d+\s*(?:шт|штук)\s*\/\s*упак/i.test(t)) return true;
  /** «10 шт./рулоне», «30 шт./рулон» — фасовка в описании мешков/рулонов. */
  if (/\d+\s*шт\.?\s*\/\s*(?:рулон|рулоне|упак)/i.test(t)) return true;
  return false;
}

/**
 * Артефакт «30-500 С» / «30 до 500 С» при потере ° между 50 и C: трёхзначное «высокое» число, оканчивающееся на 0.
 * Узко: только если нижняя граница в разумном диапазоне для °C.
 * Дополнительно: ⁰/º/° и похожие знаки сразу перед С — как градусы, не как лишняя цифра «…500».
 */
export function normalizeCelsiusRangeGarbles(text: string): string {
  const tailC = (full: string, lo: string, hi2: number) => {
    const f = full.trim();
    const hasOt = /^от\s/i.test(f);
    /** `\b` в JS не граничит кириллицу — проверяем явно «N до M». */
    const hasDo = /^(\d{1,2})\s+до\s+/i.test(f);
    if (hasOt) return `от ${lo} до ${hi2} °C`;
    if (hasDo) return `${lo} до ${hi2} °C`;
    return `${lo}–${hi2} °C`;
  };

  const fixThreeDigitHighBound = (full: string, a: string, b: string) => {
    const lo = parseInt(a, 10);
    const hi3 = parseInt(b, 10);
    if (lo < 5 || lo > 90) return full;
    if (hi3 < 100 || hi3 > 999 || hi3 % 10 !== 0) return full;
    const hi2 = hi3 / 10;
    if (hi2 <= lo || hi2 > 120) return full;
    return tailC(full, a, hi2);
  };

  let s = text;
  /** «50⁰С» / «50º С» — надстрочный ноль / кружок как °, не как сотни в «500». */
  s = s.replace(
    /\b(\d{1,2})\s*([\u00B0\u2070\u00BA\u2218\u02DA\u25E6\u25CB]{1,3})\s*([СC])(?=\s|$|[,.;:])/gu,
    (_full, lo: string) => `${lo}°C`
  );
  /** Диапазон: дефис / «до» / «от … до» + трёхзначный верхний предел с лишним нулём. */
  s = s.replace(
    /(?:от\s+)?(\d{1,2})\s*(?:(?:[-–—]\s*)|(?:до\s+))(\d{3})\s*°?\s*[СC](?=\s|$|[,.;:])/giu,
    (full, a: string, b: string) => fixThreeDigitHighBound(full, a, b)
  );
  /**
   * Одиночная температура без °: «40 С», «+30 C», «−5 С» (OCR/вертикальная спека).
   * Подписанные и неподписанные — отдельно: иначе «40-60 С» даёт ложное «-60 С».
   * Не трогает «40-60 С» (после цифры — дефис/минус диапазона) и «… до 50 С».
   */
  const singleCelsiusFromParts = (full: string, sign: string, n: string): string => {
    const num = parseInt(n, 10);
    if (Number.isNaN(num) || num < -80 || num > 200) return full;
    const sig =
      sign === "+" || sign === "\u002b"
        ? "+"
        : sign === "-" || sign === "\u2212" || sign === "\u002d" || sign === "−"
          ? "\u2212"
          : "";
    return `${sig}${num} °C`;
  };
  s = s.replace(
    /(?<!\d[\u002d\u2212–—−])(?<!до\s)(?<![\d.])([+\u002d\u2212−])(\d{1,3})\s+([СC])(?=\s|$|[,.;:!?])/giu,
    (full, sign: string, n: string) => singleCelsiusFromParts(full, sign, n)
  );
  s = s.replace(
    /(?<!\d)(?<!\d[\u002d\u2212–—−])(?<!до\s)(?<![+\u2212−\u002d])(\d{1,3})\s+([СC])(?=\s|$|[,.;:!?])/giu,
    (full, n: string) => singleCelsiusFromParts(full, "", n)
  );
  return s;
}

/**
 * OCR/ПФ: «°C» прилипает к «NхM» (разветвитель) или к «A.b» как к версии (USB 3.0).
 * Вызывать на финальных goods-строках (sanitize/UI), не внутри parse ТЗ — иначе ломается слияние характеристик.
 * Десятичный случай — только при ближайшем контексте кабеля/блока/интерфейса (не «1.5°C хранить»).
 */
export function stripOcrFalseDegreeMarkAfterPortCountOrUsbLikeMinorVersion(text: string): string {
  let s = text;
  s = s.replace(
    /(\d)\s*([хx×])\s*(\d{1,2})\s*[\u00B0\u2070\u00BA\u2218\u02DA]{1,3}\s*[СC](?=\s|$|[,.;:!()?])/giu,
    "$1$2$3"
  );
  s = s.replace(
    /\b([1-9])\.(\d)\s*[\u00B0\u2070\u00BA\u2218\u02DA]{1,3}\s*[СC](?=\s|$|[,.;:!()?])(?=[\s\S]{0,64}?(?:блоком|кабелем|адаптер|интерфейс|SATA|USB|RJ|HDD|SSD|Gbit|Gb|Gbps))/giu,
    "$1.$2"
  );
  return s;
}

/** Схлопнуть «A» + «A …продолжение» / «A»+«A» из вертикальной вёрстки одной строки наименования. */
function dedupeVerticalSpecTitleContinuationLines(lines: string[]): string[] {
  if (lines.length < 2) return lines;
  const out: string[] = [lines[0]!.replace(/\s+/g, " ").trim()];
  for (let i = 1; i < lines.length; i++) {
    const cur = lines[i]!.replace(/\s+/g, " ").trim();
    if (!cur) continue;
    const prev = out[out.length - 1]!;
    const pl = prev.toLowerCase();
    const cl = cur.toLowerCase();
    if (cl === pl) continue;
    if (cl.startsWith(pl) && cur.length >= prev.length) {
      /**
       * Отдельная короткая строка наименования + следующая — длинный абзац с тем же началом (типичная вёрстка ЕИС):
       * вторую строку нельзя сливать в заголовок карточки — это тело позиции, остаётся в blockLines для разбора граф.
       */
      const shortCardHead = prev.length >= 6 && prev.length <= 140;
      /** Абзац тела короче 200 символов всё ещё не заголовок карточки (освежители, кремы в одну строку). */
      const longBodyParagraph =
        cur.length > prev.length + 50 &&
        cur.length >= Math.max(115, prev.length + 45) &&
        (cur.length > prev.length + 85 || cur.length >= 140);
      if (shortCardHead && longBodyParagraph) {
        /** Абзац не включаем в строки заголовка — дальше тоже (хвост абзаца / следующая графа). */
        break;
      }
      out[out.length - 1] = cur;
      continue;
    }
    if (pl.startsWith(cl) && prev.length >= cur.length) continue;
    out.push(cur);
  }
  return out;
}

/** Строки заголовка позиции (после п/п) до первой явной графы «…: значение» — без съедания комплектации/описания. */
export function verticalSpecBareOrdinalTitleRawLines(blockLines: string[]): string[] {
  const titleRawLines: string[] = [];
  const maxScan = Math.min(blockLines.length, 52);
  const headOrd = (blockLines[0] ?? "").trim();
  for (let bi = 1; bi < maxScan; bi++) {
    const row = (blockLines[bi] ?? "").trim();
    if (!row) continue;
    /** Дубликат номера позиции в теле («31» под «31») — не конец заголовка, пропускаем. */
    if (/^\d{1,3}$/.test(row)) {
      if (titleRawLines.length === 0 && /^\d{1,3}$/.test(headOrd) && row === headOrd) continue;
      break;
    }
    if (/^(?:штука|штуки?|шт\.?|единица(?:\s+измерен)?|пач(?:к\w*)?\.?)$/i.test(row)) break;
    if (/^упак\.?$/i.test(row)) break;
    if (/^количеств/i.test(row)) break;
    if (/^\d{1,6}$/.test(row) && titleRawLines.length > 0) break;
    if (FIELD_HEAD_RE.test(row)) break;
    if (/^кусок\b/i.test(row)) break;
    if (/упаковано\s+в/i.test(row)) break;
    if (titleRawLines.length > 0) {
      const prev = titleRawLines[titleRawLines.length - 1]!.replace(/\s+/g, " ").trim();
      const cur2 = row.replace(/\s+/g, " ").trim();
      const pl = prev.toLowerCase();
      const cl = cur2.toLowerCase();
      const normHy = (s: string) => s.replace(/\s*([,–—-])\s*/g, "$1").replace(/\s+/g, " ");
      const pref = normHy(pl).slice(0, Math.min(26, pl.length));
      const cln = normHy(cl);
      const shortHead = prev.length >= 6 && prev.length <= 140;
      const longCont =
        cur2.length > prev.length + 50 &&
        cur2.length >= Math.max(115, prev.length + 45) &&
        (cur2.length > prev.length + 85 || cur2.length >= 140);
      if (shortHead && longCont && pref.length >= 8 && cln.startsWith(pref)) break;
      const looksLikeSkuTitle =
        /перчатк|средств|мыло|крем|гель|таблетк|антисептик|освежител|полотенц|туалетн|хозяйственн|ополаскивател|очистител|дезинфиц|серветк|бумаг|стекол|зеркал|посудомоечн|\bсол[ьи]\b|нитрилов/i.test(
          prev
        );
      if (
        looksLikeSkuTitle &&
        prev.length <= 112 &&
        cur2.length >= prev.length + 75 &&
        pref.length >= 8 &&
        !cln.startsWith(pref)
      )
        break;
      /** Маркетинговые абзацы после полного наименования — не заголовок (эксп.3, п/п 19). */
      const firstRow = titleRawLines[0]!.replace(/\s+/g, " ").trim();
      const prefFirst = normHy(firstRow.toLowerCase()).slice(0, Math.min(18, firstRow.length));
      const clnFirst = normHy(cl.toLowerCase());
      if (
        prefFirst.length >= 8 &&
        !clnFirst.startsWith(prefFirst) &&
        /^(?:Легко|Высокоэффективн|Ухаживает|Обладает|Придает|Защищает|Антибактериальн|"Таблетки|Упаковка\s*[–—-])/iu.test(
          cur2
        )
      )
        break;
    }
    titleRawLines.push(row);
    if (titleRawLines.join(" ").length > 720) break;
  }
  return dedupeVerticalSpecTitleContinuationLines(titleRawLines);
}

/** Лимит карточки name (см. verify:tech-spec-vertical-goods-layout, эксп.3). */
const VERTICAL_SPEC_CARD_NAME_MAX = 220;

const PARAM_HEAD =
  /^(?:размер|объ[её]м|плотность|диаметр|длина|ширина|толщина|вес|габарит\w*|масса)\b/i;

function tryPullTrailingVerticalSpecTitleKeywordClause(full: string): {
  coreTitle: string;
  rows: TenderAiCharacteristicRow[];
} | null {
  const t = full.replace(/\s+/g, " ").trim();
  const rules: Array<{
    re: RegExp;
    name: string;
    strip: RegExp;
  }> = [
    { re: /\s+(назначени[ея]\s*:\s*.+)$/iu, name: "назначение", strip: /^назначени[ея]\s*:\s*/iu },
    { re: /\s+(способ\s+применения\s*:\s*.+)$/iu, name: "Способ применения", strip: /^способ\s+применения\s*:\s*/iu },
    { re: /\s+(применение\s*:\s*.+)$/iu, name: "Применение", strip: /^применение\s*:\s*/iu },
    { re: /\s+(цвет\s*:\s*.+)$/iu, name: "Цвет", strip: /^цвет\s*:\s*/iu },
    { re: /\s+(материал\s*:\s*.+)$/iu, name: "Материал", strip: /^материал\s*:\s*/iu }
  ];
  for (const { re, name, strip } of rules) {
    const m = t.match(re);
    if (!m?.[1]) continue;
    const idx = m.index ?? -1;
    if (idx < 6) continue;
    const head = t.slice(0, idx).trim();
    if (head.length < 6) continue;
    const val = m[1].replace(strip, "").trim().slice(0, 12_000);
    if (val.length < 2) continue;
    return { coreTitle: head, rows: [{ name, value: val, sourceHint: "tech_spec" }] };
  }
  return null;
}

/**
 * Выносит из полного заголовка позиции (до первой графы тела) явные атрибуты в отдельные строки характеристик.
 * Разделитель — запятая/точка с запятой между смысловыми частями, как в печатной спецификации ЕИС.
 */
export function extractVerticalSpecTitleAttributeRows(fullJoin: string): {
  coreTitle: string;
  rows: TenderAiCharacteristicRow[];
} {
  const raw = fullJoin.replace(/\s+/g, " ").trim();
  if (raw.length < 8) return { coreTitle: raw, rows: [] };

  const segments = raw
    .split(/\s*[,;]\s*/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  if (segments.length <= 1) {
    const trail = tryPullTrailingVerticalSpecTitleKeywordClause(raw);
    if (trail) return { coreTitle: trail.coreTitle, rows: trail.rows };
    return { coreTitle: raw, rows: [] };
  }

  const rows: TenderAiCharacteristicRow[] = [];
  const paramParts: string[] = [];
  const packParts: string[] = [];
  const coreParts: string[] = [];

  const pushParam = (seg: string) => {
    const t = seg.replace(/\s+/g, " ").trim();
    if (t.length >= 3 && t.length <= 600) paramParts.push(t);
  };

  for (const seg of segments) {
    const s = seg.replace(/\s+/g, " ").trim();
    if (!s) continue;

    if (lineLooksLikePackOnlyQtyInProse(s)) {
      /** Длинная строка «наименование … 20 шт в упаковке» без запятой между ними — не выкидывать название в фасовку. */
      const packNote = extractPackagingNoteFromLine(s);
      if (packNote && s.length > packNote.length + 30) {
        packParts.push(packNote);
        const pl = s.toLowerCase();
        const pi = pl.indexOf(packNote.toLowerCase());
        const rest =
          pi >= 0
            ? `${s.slice(0, pi)} ${s.slice(pi + packNote.length)}`.replace(/\s+/g, " ").trim()
            : s.replace(/\s+/g, " ").trim();
        if (rest.length >= 4) coreParts.push(rest);
        continue;
      }
      packParts.push(s);
      continue;
    }

    let consumed = false;

    const mNaz = s.match(/^назначени[ея]\s*:\s*(.+)$/iu);
    if (mNaz?.[1]) {
      rows.push({ name: "назначение", value: mNaz[1]!.trim().slice(0, 12_000), sourceHint: "tech_spec" });
      consumed = true;
    }
    if (!consumed) {
      const mPr = s.match(/^способ\s+применения\s*:\s*(.+)$/iu);
      if (mPr?.[1]) {
        rows.push({ name: "Способ применения", value: mPr[1]!.trim().slice(0, 12_000), sourceHint: "tech_spec" });
        consumed = true;
      }
    }
    if (!consumed) {
      const mAp = s.match(/^применение\s*:\s*(.+)$/iu);
      if (mAp?.[1]) {
        rows.push({ name: "Применение", value: mAp[1]!.trim().slice(0, 12_000), sourceHint: "tech_spec" });
        consumed = true;
      }
    }
    if (!consumed) {
      const mCol = s.match(/^цвет\s*:\s*(.+)$/iu);
      if (mCol?.[1]) {
        rows.push({ name: "Цвет", value: mCol[1]!.trim().slice(0, 2000), sourceHint: "tech_spec" });
        consumed = true;
      }
    }
    if (!consumed) {
      const mCol2 = s.match(/^цвет\s+[-–—]\s*(.+)$/iu);
      if (mCol2?.[1]) {
        rows.push({ name: "Цвет", value: mCol2[1]!.trim().slice(0, 2000), sourceHint: "tech_spec" });
        consumed = true;
      }
    }
    if (!consumed) {
      const mMat = s.match(/^материал\s*:\s*(.+)$/iu);
      if (mMat?.[1]) {
        rows.push({ name: "Материал", value: mMat[1]!.trim().slice(0, 4000), sourceHint: "tech_spec" });
        consumed = true;
      }
    }
    if (!consumed) {
      const mIz = s.match(/^изготовлен[ыоа]?\s+из\s+(.+)$/iu);
      if (mIz?.[1]) {
        rows.push({ name: "Материал", value: s.slice(0, 4000), sourceHint: "tech_spec" });
        consumed = true;
      }
    }
    if (!consumed && PARAM_HEAD.test(s) && /:\s*\S/.test(s)) {
      pushParam(s);
      consumed = true;
    }
    if (!consumed) {
      const mPl =
        s.match(/^плотность\s+[\d.,]+\s*(?:мкм|мкр)\.?$/i) ||
        s.match(/^плотность\s+[\d.,]+\s*гр\.?\s*\/\s*м2\.?$/i);
      if (mPl) {
        pushParam(s);
        consumed = true;
      }
    }
    if (!consumed) {
      const mRz = s.match(/^размер\s+[\d\s.,хx×]+\s*см\.?$/i);
      if (mRz) {
        pushParam(s);
        consumed = true;
      }
    }
    if (!consumed) {
      const stCol = s.replace(/\.\s*Упак\.?\s*$/i, "").replace(/\.$/, "").trim();
      if (/^(?:черн|бел|син|красн|желт|зел)[ыаяоиеё]+$/i.test(stCol)) {
        rows.push({ name: "Цвет", value: stCol.slice(0, 2000), sourceHint: "tech_spec" });
        consumed = true;
      }
    }
    if (!consumed && /^с\s+ручк/i.test(s)) {
      pushParam(s);
      consumed = true;
    }

    if (!consumed) {
      const tU = s.replace(/\.$/, "").trim();
      if (/^упак\.?$/i.test(tU)) consumed = true;
    }

    if (!consumed) coreParts.push(s);
  }

  let coreTitle = coreParts.join(", ").replace(/\s+/g, " ").trim();
  if (coreTitle.length < 4) return { coreTitle: raw, rows: [] };

  /** «…ПНД 60л, плотность 9 мкм» — параметр прилип к хвосту названия без отдельного сегмента. */
  const trailPeels = [
    /,\s*(плотность\s+[\d.,]+\s*(?:мкм|мкр)\.?)$/iu,
    /,\s*(размер\s+[\d\s.,хx×]+\s*см\.?)$/iu,
    /,\s*(диаметр\s+[\d\s.,]+\s*см\.?)$/iu
  ];
  for (const pe of trailPeels) {
    const m = coreTitle.match(pe);
    if (!m?.[1]) continue;
    const frag = m[1].trim();
    if (frag.length < 4) continue;
    pushParam(frag);
    coreTitle = coreTitle.replace(pe, "").trim();
  }

  if (rows.length === 0) {
    const trail = tryPullTrailingVerticalSpecTitleKeywordClause(coreTitle);
    if (trail) {
      coreTitle = trail.coreTitle;
      rows.push(...trail.rows);
    }
  }

  if (packParts.length) {
    rows.push({
      name: "Комплектация / фасовка",
      value: [...new Set(packParts)].join(". ").slice(0, 4000),
      sourceHint: "tech_spec"
    });
  }
  if (paramParts.length) {
    rows.push({
      name: "Параметры товара",
      value: [...new Set(paramParts)].join("; ").slice(0, 12_000),
      sourceHint: "tech_spec"
    });
  }

  return { coreTitle, rows };
}

/**
 * Наименование для карточки + опциональный хвост заголовка в «Описание товара».
 * Полный заголовок собирается по всем строкам до графы; обрезка только по лимиту карточки, не по первой строке.
 */
export function verticalSpecBareOrdinalShortTitleFromBlock(blockLines: string[]): {
  shortTitle: string;
  extraCharacteristicRows: TenderAiCharacteristicRow[];
} {
  const titleRawLines = verticalSpecBareOrdinalTitleRawLines(blockLines);
  if (titleRawLines.length === 0) return { shortTitle: "", extraCharacteristicRows: [] };

  const fullJoin = titleRawLines.join(" ").replace(/\s+/g, " ").trim();
  const extracted = extractVerticalSpecTitleAttributeRows(fullJoin);
  const fullCore = normalizeCelsiusRangeGarbles(extracted.coreTitle);
  let shortTitle = fullCore;
  const prefetchedAttrRows = extracted.rows;
  if (shortTitle.length > VERTICAL_SPEC_CARD_NAME_MAX) {
    const cut = shortTitle.slice(0, VERTICAL_SPEC_CARD_NAME_MAX);
    const lb = Math.max(
      cut.lastIndexOf(" "),
      cut.lastIndexOf(","),
      cut.lastIndexOf("."),
      cut.lastIndexOf(";")
    );
    const at = lb >= Math.min(120, VERTICAL_SPEC_CARD_NAME_MAX - 40) ? lb + 1 : VERTICAL_SPEC_CARD_NAME_MAX;
    shortTitle = shortTitle.slice(0, at).trim();
  }

  /** Хвост обрезки — только от уже очищенного coreTitle, не от fullJoin (иначе расходится после вырезания сегментов). */
  const extraText =
    fullCore.length > shortTitle.length && fullCore.toLowerCase().startsWith(shortTitle.toLowerCase())
      ? fullCore.slice(shortTitle.length).trim().replace(/^[,;.\s–-]+/, "")
      : "";

  const rows: TenderAiCharacteristicRow[] = [...prefetchedAttrRows];
  if (extraText.length >= 10) {
    rows.push({
      name: "Описание товара",
      value: normalizeCelsiusRangeGarbles(extraText).slice(0, 12_000),
      sourceHint: "tech_spec"
    });
  }

  return { shortTitle, extraCharacteristicRows: rows };
}

/**
 * Убирает повтор полного наименования в начале «Описание товара» / значениях, совпадающих с title.
 */
/** «Название Название …» в начале описания — склейка короткой строки наименования с полным абзацем в вертикальной спеке. */
function stripDescriptionDuplicateHeadFromNamePrefix(value: string, nameForAnchors: string): string {
  const v = value.replace(/\s+/g, " ").trim();
  const words = nameForAnchors.replace(/\s+/g, " ").trim().split(/\s+/).filter(Boolean);
  if (words.length < 2 || v.length < 24) return value;
  for (let k = Math.min(12, words.length); k >= 2; k--) {
    const phrase = words.slice(0, k).join(" ");
    if (phrase.length < 10 || phrase.length > 160) continue;
    const esc = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^(${esc})\\s+\\1(?=\\s)`, "i");
    if (re.test(v)) return v.replace(re, "").trim();
  }
  return value;
}

export function stripVerticalSpecTitleEchoFromCharacteristics(
  productName: string,
  rows: TenderAiCharacteristicRow[]
): TenderAiCharacteristicRow[] {
  const pn = productName.replace(/\s+/g, " ").trim();
  const pnLower = pn.toLowerCase();
  if (!pn) return rows;
  return rows
    .map((r) => {
      const rn = (r.name ?? "").replace(/\s+/g, " ").trim();
      let v = (r.value ?? "").replace(/\s+/g, " ").trim();
      if (!v) return r;
      const vl = v.toLowerCase();
      const isDesc = /^описание\s+товара$/i.test(rn);
      if (vl === pnLower) return null;
      if (isDesc && vl.startsWith(pnLower) && v.length > pn.length + 3) {
        const stripped = v.slice(pn.length).trim().replace(/^[,;.\-–—\s]+/, "");
        if (stripped.length >= 3) {
          /**
           * Один абзац: полное наименование в карточке = начало той же товарной строки в документе,
           * дальше «для … / при … / содержит …» — не дубль заголовка, не отрезать лид (vertical-spec, конец длинной спеки).
           */
          if (
            /^(?:для|при|в\s+качестве|на\s+основе|с\s+пролонгированным|обладает|имеет|содержит|предназначен|является|это|в\s+составе|изготовлен|производится|обеспечивает|способствует|отвечает)\b/iu.test(
              stripped
            )
          )
            return r;
          return { ...r, value: stripped };
        }
        return null;
      }
      if (isDesc) {
        const unstutter = stripDescriptionDuplicateHeadFromNamePrefix(v, pn);
        if (unstutter !== v && unstutter.length >= 8) return { ...r, value: unstutter };
      }
      return r;
    })
    .filter((x): x is TenderAiCharacteristicRow => x != null);
}

/**
 * «…24 х 24 Состав» в name и значение после «:» в value — разнести по полям.
 */
export function healVerticalBareGluedСоставCharacteristicName(
  rows: TenderAiCharacteristicRow[]
): TenderAiCharacteristicRow[] {
  return rows.flatMap((r) => {
    const t = r.name.trim();
    const m = t.match(/^(.{10,520}?)\s+(Состав)$/i);
    if (!m?.[1] || !r.value?.trim()) return [r];
    const head = m[1]!.replace(/\s+/g, " ").trim();
    return [
      { name: "Описание товара", value: head, sourceHint: r.sourceHint ?? "tech_spec" },
      { name: "Состав", value: r.value.trim(), sourceHint: r.sourceHint ?? "tech_spec" }
    ];
  });
}

/** Фасовка для карточки (не quantity закупки). */
export function extractPackagingNoteFromLine(line: string): string | null {
  const t = line.replace(/\s+/g, " ").trim();
  const m = t.match(
    /\d+(?:[.,]\d+)?\s*(?:шт\.?|штук\w*|пар\w*|компл\w*)\s*(?:в\s+упаковк[^.!?]{0,120}|\/\s*упак\w*[^.!?]{0,80}|в\s+пачк[^.!?]{0,80}|в\s+полиэтиленов\w*[^.!?]{0,80})/i
  );
  if (m?.[0]) return m[0].replace(/\s+/g, " ").trim().slice(0, 220);
  const mOb = t.match(/объ[её]м\s*:\s*\d+(?:[.,]\d+)?\s*(?:шт\.?|штук\w*)[^.!?]{0,120}/i);
  if (mOb?.[0]) return mOb[0].replace(/\s+/g, " ").trim().slice(0, 220);
  const m2 = t.match(/\(\s*\d+\s*(?:шт|штук|пар)\w*\s*\/\s*\d+\s*(?:шт|штук)\s*\/\s*упак[^.!?]{0,40}/i);
  if (m2?.[0]) return m2[0].replace(/\s+/g, " ").trim().slice(0, 220);
  return null;
}
