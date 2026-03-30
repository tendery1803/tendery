import {
  forOutsideProcurementSpans,
  maskRussianFioPatronymic,
  procurementProtectedSpans
} from "@tendery/core";

/**
 * Селективное обезличивание перед отправкой текста во внешний AI (152-ФЗ, п. 2.3 ТЗ).
 * Маскируются в основном ПДн и платёжные идентификаторы физлиц; закупочно значимые фрагменты
 * (ИКЗ, КТРУ, ОКПД2, номера извещений рядом с подписями и т.п.) выделяются и не трогаются.
 *
 * Карта замен не сохраняется и никуда не передаётся — только итоговая строка уходит в gateway.
 * Маркеры: [EMAIL_1], [PHONE_1], [INN_1], … как в ТЗ.
 */

type Kind =
  | "EMAIL"
  | "PHONE"
  | "INN"
  | "KPP"
  | "OGRN"
  | "BIK"
  | "BANK_REF"
  | "BANK_ACC"
  | "ID_DOC"
  | "PERSON";

function nextToken(counters: Record<string, number>, kind: Kind): string {
  counters[kind] = (counters[kind] ?? 0) + 1;
  return `[${kind}_${counters[kind]}]`;
}

function maskSegment(segment: string, counters: Record<string, number>): string {
  let t = segment;

  t = t.replace(
    /(?:ИНН|инн|И\.?\s*Н\.?\s*Н\.?)\s*[:]?\s*(\d{10}|\d{12})(?!\d)/g,
    () => nextToken(counters, "INN")
  );
  t = t.replace(/(?:КПП|кпп)\s*[:]?\s*(\d{9})(?!\d)/g, () => nextToken(counters, "KPP"));
  t = t.replace(
    /(?:ОГРНИП|огрнип)\s*[:]?\s*(\d{15})(?!\d)/g,
    () => nextToken(counters, "OGRN")
  );
  t = t.replace(/(?:ОГРН|огрн)\s*[:]?\s*(\d{13})(?!\d)/g, () => nextToken(counters, "OGRN"));
  t = t.replace(/(?:БИК|бик)\s*[:]?\s*(\d{9})(?!\d)/g, () => nextToken(counters, "BIK"));

  t = t.replace(
    /(?:р\s*[/\\]\s*с|р\.?\s*с\.?|расч(?:ёт|ет)ный\s+сч(?:ёт|ет)?|р\.?\s*сч\.?)\s*[:]?\s*(\d{20})(?!\d)/gi,
    () => nextToken(counters, "BANK_REF")
  );
  t = t.replace(
    /(?:корр\.?\s*сч(?:ёт|ет)?|к\/с|корреспондентский\s+сч(?:ёт|ет)?)\s*[:]?\s*(\d{20})(?!\d)/gi,
    () => nextToken(counters, "BANK_REF")
  );

  t = maskRussianFioPatronymic(t, () => nextToken(counters, "PERSON"));

  t = t.replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, () => nextToken(counters, "EMAIL"));

  t = t.replace(/\+7[\s(]*\d{3}[\s)]*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b/g, () =>
    nextToken(counters, "PHONE")
  );
  t = t.replace(/\b8[\s(]*\d{3}[\s)]*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b/g, () =>
    nextToken(counters, "PHONE")
  );
  t = t.replace(/(?<![\dA-Za-z])\+(?!7)\d{1,3}[\s().-]*\d{6,14}\b/g, () =>
    nextToken(counters, "PHONE")
  );
  t = t.replace(/\b9\d{9}\b/g, () => nextToken(counters, "PHONE"));

  t = t.replace(/\b\d{4}\s?\d{6}\b/g, () => nextToken(counters, "ID_DOC"));
  t = t.replace(/\b\d{2}\s\d{2}\s\d{6}\b/g, () => nextToken(counters, "ID_DOC"));
  t = t.replace(
    /\b\d{10}\b(?=\s*(?:паспорт|пасп\.|серия|№|N\s*пасп))/gi,
    () => nextToken(counters, "ID_DOC")
  );

  t = t.replace(/\b\d{20}\b/g, () => nextToken(counters, "BANK_ACC"));
  t = t.replace(/\d{16,}/g, () => nextToken(counters, "BANK_ACC"));

  return t;
}

/**
 * Обезличивание строки перед внешним AI. Закупочные коды/ИКЗ в защищённых интервалах не режутся.
 */
export function maskPiiForAi(text: string): string {
  const spans = procurementProtectedSpans(text);
  const counters: Record<string, number> = {};
  return forOutsideProcurementSpans(text, spans, maskSegment, counters);
}
