export type ProcurementSpan = { start: number; end: number };

export function mergeProcurementSpans(spans: ProcurementSpan[]): ProcurementSpan[] {
  if (!spans.length) return [];
  const s = [...spans].sort((a, b) => a.start - b.start);
  const out: ProcurementSpan[] = [];
  let cur = s[0];
  for (let i = 1; i < s.length; i++) {
    const n = s[i];
    if (n.start <= cur.end) cur = { start: cur.start, end: Math.max(cur.end, n.end) };
    else {
      out.push(cur);
      cur = n;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Фрагменты, которые нельзя портить маскированием длинными цифровыми последовательностями и т.п.
 * Совпадает с apps/web maskPiiForAi.
 */
const afterSep = /(?<=[\s.;:,(«"'\n\u00A0])/;

export function procurementProtectedSpans(text: string): ProcurementSpan[] {
  const patterns: RegExp[] = [
    /^ИКЗ\s*[:]?\s*[A-Za-zА-Яа-яЁё0-9\-]{18,44}(?![A-Za-zА-Яа-яЁё0-9\-])/gim,
    new RegExp(
      String(afterSep.source) +
        "ИКЗ\\s*[:]\\?\\s*[A-Za-zА-Яа-яЁё0-9\\-]{18,44}(?![A-Za-zА-Яа-яЁё0-9\\-])",
      "gim"
    ),
    /^(?:КТРУ|ктру)\s*[:]?\s*[\d.\-\s]{8,40}(?!\d)/gim,
    new RegExp(
      String(afterSep.source) + "(?:КТРУ|ктру)\\s*[:]\\?\\s*[\\d.\\-\\s]{8,40}(?!\\d)",
      "gim"
    ),
    /^ОКПД(?:\s*[-–]?\s*2)?\s*[:]?\s*[\d.\-\s]{8,32}(?!\d)/gim,
    new RegExp(
      String(afterSep.source) +
        "ОКПД(?:\\s*[-–]?\\s*2)?\\s*[:]\\?\\s*[\\d.\\-\\s]{8,32}(?!\\d)",
      "gim"
    ),
    /^(?:реестр(?:овый)?\s+номер|номер\s+(?:извещен(?:ие|ия)|процедуры|закупки))\s*[:]?\s*[№#N]?\s*[\dA-Za-z\-/.]{5,}/gim,
    new RegExp(
      String(afterSep.source) +
        "(?:реестр(?:овый)?\\s+номер|номер\\s+(?:извещен(?:ие|ия)|процедуры|закупки))\\s*[:]\\?\\s*[№#N]?\\s*[\\dA-Za-z\\-/.]{5,}",
      "gim"
    ),
    /[?&]regNumber=[A-Za-z0-9\-]{6,}/gi,
    /[?&]registrationNumber=[A-Za-z0-9\-]{6,}/gi,
    /** № + длинный идентификатор (извещение / позиция спецификации), иначе маска \d{16+} → BANK_ACC */
    /(?:^|[\s;,(])№\s*(\d{11,22})(?!\d)/gim,
    new RegExp(String(afterSep.source) + "№\\s*(\\d{11,22})(?!\\d)", "gim"),
    /** Типовой реестровый номер ЕИС / длинный id в одной «ячейке» (18–22 цифры подряд) */
    /(?<![0-9])(\d{18,22})(?![0-9])/g,
    /** Идентификатор закупки / лота рядом с ключевыми словами */
    /(?:идентификатор|реестр(?:овый)?|извещен|процедур|закупк)[^\n]{0,120}?(?<![0-9])(\d{11,22})(?![0-9])/gi
  ];
  const raw: ProcurementSpan[] = [];
  for (const re of patterns) {
    const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
    const r = new RegExp(re.source, flags);
    let m: RegExpExecArray | null;
    while ((m = r.exec(text)) !== null) {
      raw.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  return mergeProcurementSpans(raw);
}

/** Маскирует только участки вне procurementProtectedSpans. */
export function forOutsideProcurementSpans(
  text: string,
  spans: ProcurementSpan[],
  fn: (segment: string, counters: Record<string, number>) => string,
  counters: Record<string, number>
): string {
  if (!spans.length) return fn(text, counters);
  let out = "";
  let pos = 0;
  for (const sp of spans) {
    if (sp.start > pos) out += fn(text.slice(pos, sp.start), counters);
    out += text.slice(sp.start, sp.end);
    pos = sp.end;
  }
  if (pos < text.length) out += fn(text.slice(pos), counters);
  return out;
}
