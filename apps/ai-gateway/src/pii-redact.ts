import {
  forOutsideProcurementSpans,
  maskRussianFioPatronymic,
  procurementProtectedSpans
} from "@tendery/core";

/** Убираем из текста типичные секреты перед отдачей в JSON клиенту (web). */
export function redactSecrets(s: string): string {
  return s
    .replace(/\bsk-[a-zA-Z0-9_-]{8,}\b/gi, "[sk-redacted]")
    .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, "Bearer [redacted]");
}

function redactDiagnosticChunk(segment: string, nextPerson: () => string): string {
  let t = redactSecrets(segment);
  t = maskRussianFioPatronymic(t, nextPerson);
  t = t.replace(
    /(?:ИНН|инн|И\.?\s*Н\.?\s*Н\.?)\s*[:]?\s*(\d{10}|\d{12})(?!\d)/g,
    "[INN]"
  );
  t = t.replace(/(?:КПП|кпп)\s*[:]?\s*(\d{9})(?!\d)/g, "[KPP]");
  t = t.replace(/(?:ОГРНИП|огрнип)\s*[:]?\s*(\d{15})(?!\d)/g, "[OGRN]");
  t = t.replace(/(?:ОГРН|огрн)\s*[:]?\s*(\d{13})(?!\d)/g, "[OGRN]");
  t = t.replace(/(?:БИК|бик)\s*[:]?\s*(\d{9})(?!\d)/g, "[BIK]");
  t = t.replace(
    /(?:р\s*[/\\]\s*с|р\.?\s*с\.?|расч(?:ёт|ет)ный\s+сч(?:ёт|ет)?|р\.?\s*сч\.?)\s*[:]?\s*(\d{20})(?!\d)/gi,
    "[BANK_REF]"
  );
  t = t.replace(
    /(?:корр\.?\s*сч(?:ёт|ет)?|к\/с|корреспондентский\s+сч(?:ёт|ет)?)\s*[:]?\s*(\d{20})(?!\d)/gi,
    "[BANK_REF]"
  );
  t = t.replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/gi, "[EMAIL]");
  t = t.replace(/\+7[\s(]*\d{3}[\s)]*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b/g, "[PHONE]");
  t = t.replace(/\b8[\s(]*\d{3}[\s)]*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b/g, "[PHONE]");
  t = t.replace(/\b9\d{9}\b/g, "[PHONE]");
  t = t.replace(/(?<![\dA-Za-z])\+(?!7)\d{1,3}[\s().-]*\d{6,14}\b/g, "[PHONE]");
  t = t.replace(/\b\d{4}\s?\d{6}\b/g, "[ID_DOC]");
  t = t.replace(/\b\d{2}\s\d{2}\s\d{6}\b/g, "[ID_DOC]");
  t = t.replace(
    /\b\d{10}\b(?=\s*(?:паспорт|пасп\.|серия|№|N\s*пасп))/gi,
    "[ID_DOC]"
  );
  t = t.replace(/\b\d{20}\b/g, "[BANK_ACC]");
  t = t.replace(/\d{16,}/g, "[BANK_ACC]");
  return t;
}

/**
 * Превью ответа модели (логи и analyzeDiagnostics.outputPreview): без сырых ПДн.
 * Закупочные интервалы — как у web maskPiiForAi, чтобы ИКЗ/КТРУ не резались 20-значными правилами.
 */
export function redactDiagnosticPreview(s: string): string {
  const spans = procurementProtectedSpans(s);
  let personN = 0;
  const nextPerson = () => `[PERSON_${++personN}]`;
  const noop: Record<string, number> = {};
  return forOutsideProcurementSpans(s, spans, (seg, _c) => redactDiagnosticChunk(seg, nextPerson), noop);
}
