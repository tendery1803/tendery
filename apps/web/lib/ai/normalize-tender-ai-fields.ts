import type { TenderAiParseResult } from "@tendery/contracts";

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function looksMissingTenderNo(raw: string): boolean {
  const t = raw.trim();
  if (t === "" || t === "—" || t === "-" || t === "–") return true;
  return /^(нет|не\s+указан|не\s+найден|н\/д|n\/a|отсутствует)\.?$/i.test(t);
}

/** Признаки цены, выведенной не из явного НМЦК в документе. */
function isIndirectNmckValue(v: string): boolean {
  const s = v.toLowerCase();
  if (!s.trim()) return false;
  return (
    /выведен|косвенн|placeholder/.test(s) ||
    /%\s*от|от\s+нмцк|процент\s+от/.test(s) ||
    (/%/.test(s) && /(обеспеч|заявк|гарант)/.test(s))
  );
}

function lightTrimValue(v: string): string {
  return v.replace(/\s+/g, " ").trim();
}

/** Длинная строка — не удаляем целиком из-за фразы про поставку; максимум обрезаем хвост. */
const MANDATORY_DOC_LONG_LINE = 120;

/** Снять явный хвост про исполнение/поставку в конце строки (после запятой/точки с запятой/тире). */
function stripExecutionTail(line: string): string {
  return line
    .replace(/\s*[,;]\s*при\s+(поставке|передаче|отгрузке)\b[^.;]*$/i, "")
    .replace(/\s*[—–-]\s*при\s+(поставке|передаче|отгрузке)\b[^.;]*$/i, "")
    .trim();
}

/** Удалить целиком только короткие однозначно «исполнительские» строки. */
function shouldDropShortExecutionOnlyLine(line: string): boolean {
  const t = line.trim();
  if (!t || t.length > MANDATORY_DOC_LONG_LINE) return false;
  if (/^товарн(ая)?\s+накладная\b/i.test(t)) return true;
  if (/^универсальн(ый|ого|ая)?\s+передаточн/i.test(t)) return true;
  if (/^упд\b/i.test(t) && /\b(поставк|передач|отгрузк)\b/i.test(t)) return true;
  if (t.length < 55 && /^\s*при\s+(поставке|передаче|отгрузке)\b/i.test(t)) return true;
  return false;
}

function filterMandatoryDocsValue(value: string): string {
  const chunks = value.split(/\n+/).flatMap((block) => block.split(/;\s*(?=\S)/));
  const out: string[] = [];
  for (const c of chunks) {
    let t = c.trim();
    if (!t) continue;
    if (shouldDropShortExecutionOnlyLine(t)) continue;
    if (t.length > MANDATORY_DOC_LONG_LINE && /\bпри\s+(поставке|передаче|отгрузке)\b/i.test(t)) {
      const stripped = stripExecutionTail(t);
      t = stripped || t;
    }
    if (t) out.push(t);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Только целый сегмент — служебный мусор, без вырезания подстрок из нормального текста. */
function isJunkDateFragment(s: string): boolean {
  const t = s.trim();
  if (!t) return false;
  return (
    /^placeholder$/i.test(t) ||
    /^выведен(о)?$/i.test(t) ||
    /^не\s+указан(о|ы)?$/i.test(t) ||
    /^не\s+заполнен(о|ы)?$/i.test(t) ||
    /^n\/a$/i.test(t) ||
    /^[—–-]$/.test(t)
  );
}

function cleanDatesValue(value: string, deliveryDeadline: string): string {
  const parts = value
    .split(/\n+|;\s*(?=[^\s])/)
    .map((p) => p.trim())
    .filter((p) => p && !isJunkDateFragment(p));
  const dd = deliveryDeadline.trim();
  const filtered =
    dd.length > 0 ? parts.filter((p) => p.trim() !== dd) : parts;
  return filtered.join("; ").replace(/;\s*;/g, "; ").trim();
}

function guaranteesLikelyMixed(value: string): boolean {
  const s = value.toLowerCase();
  if (!/обеспеч/i.test(s)) return false;
  const hasApplication = /заявк|участник|допуск/.test(s);
  const hasExecution = /исполнен|договор|контракт|поставк/.test(s);
  return hasApplication && hasExecution;
}

/**
 * Постобработка уже распарсенного ответа AI перед записью в БД.
 * Меняет только value/confidence известных ключей; без префиксов «Смешано:» / «Вычислено:» в тексте.
 */
export function normalizeTenderAiFields(data: TenderAiParseResult): TenderAiParseResult {
  const byKey = new Map(data.fields.map((f) => [f.key, f.value]));
  const deliveryDeadline = byKey.get("delivery_deadline") ?? "";

  const fields = data.fields.map((field) => {
    const { key, label } = field;
    const value = field.value;
    const confidence = clamp01(field.confidence);

    if (key === "tender_no") {
      if (looksMissingTenderNo(value)) {
        return { key, label, value: "—", confidence: 0 };
      }
      return { key, label, value: lightTrimValue(value) || "—", confidence };
    }

    if (key === "nmck") {
      const v = lightTrimValue(value);
      let c = confidence;
      if (isIndirectNmckValue(v)) {
        c = Math.min(c, 0.6);
      }
      return { key, label, value: v, confidence: clamp01(c) };
    }

    if (key === "mandatory_docs") {
      return {
        key,
        label,
        value: filterMandatoryDocsValue(value),
        confidence
      };
    }

    if (key === "guarantees") {
      const v = lightTrimValue(value);
      let c = confidence;
      if (guaranteesLikelyMixed(v)) {
        c = Math.min(c, 0.55);
      }
      return { key, label, value: v, confidence: clamp01(c) };
    }

    if (key === "dates") {
      return {
        key,
        label,
        value: cleanDatesValue(value, deliveryDeadline),
        confidence
      };
    }

    return { key, label, value: lightTrimValue(value), confidence };
  });

  return {
    summary: data.summary.trim(),
    fields
  };
}
