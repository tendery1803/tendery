/**
 * Внутренняя оценка ожидаемого числа позиций и номеров строк спецификации (без изменения внешнего контракта analyze).
 */

export type GoodsExpectedCoverageDetectionSource = "table_max_position" | "declared_count" | "none";

/** Пояснение для audit: откуда взялось ожидаемое число (без ПДн — только номера строк/паттерны). */
export type GoodsExpectedCoverageDiagnostics = {
  /** Как сопоставляем номер в начале строки таблицы. */
  strictLinePattern:
    | "leading_digits_dot_or_paren_then_nonspace"
    | "leading_digits_two_spaces_then_nonspace (OCR/таблица)";
  /** Сколько строк корпуса дали номер «строгим» шаблоном. */
  strictNumberedLines: number;
  /** Сколько строк дали номер «мягким» шаблоном (для сравнения; не всегда позиции п/п). */
  relaxedNumberedLines: number;
  /** До 24 значений: уникальные номера, по которым строился expected (строгий или мягкий скан таблицы). */
  strictUniqPositionIdsSample: string[];
  /** Максимум по строгому скану строк. */
  strictMaxPosition: number | null;
  /** Максимум по мягкому скану (если > strict — возможна потеря expected при только strict). */
  relaxedMaxPosition: number | null;
  /** Сработавшие объявленные формулировки «всего N позиций» и т.п. */
  declaredPhraseHits: Array<{ label: string; value: number }>;
  /** Краткая формула итогового expectedItemsCount. */
  expectedCountDerivation: string;
};

export type GoodsExpectedCoverage = {
  expectedItemsCount: number | null;
  /** Номера позиций только из явной нумерации строк; пусто, если нумерацию выделить нельзя. */
  expectedPositionIds: string[];
  detectionSource: GoodsExpectedCoverageDetectionSource;
  /** 0..1 грубая уверенность эвристики. */
  confidence: number;
  diagnostics: GoodsExpectedCoverageDiagnostics;
};

function normPosId(s: string): string {
  return s.replace(/^№\s*/i, "").replace(/\.$/, "").trim();
}

function isLikelyServiceOrCharacteristicLine(line: string): boolean {
  const t = line.toLowerCase();
  if (!t.trim()) return true;
  if (
    /характеристик|значение\s+характеристик|наименование\s+характеристик|инструкц|обосновани|дополнительн(?:ой|ую|ая)\s+информаци|участник\s+закупк|не\s+может\s+изменя|описани[ея]\s+объекта\s+закупк/.test(
      t
    )
  ) {
    return true;
  }
  if (/^(наименование|количество|ед\.?\s*изм|цена|стоимость)\b/.test(t.trim())) return true;
  return false;
}

function lineHasGoodsRowSignals(line: string): boolean {
  const t = line.toLowerCase();
  if (/\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{5,8}/.test(t)) return true; // КТРУ
  if (/\d{2}\.\d{2}\.\d{2}\.\d{2,3}(?:\.\d{3})?/.test(t)) return true; // ОКПД
  if (/\b20\d{7,11}\b/.test(t)) return true; // реестровый id позиции
  if (/\b(?:кол-?во|количество|ед\.?\s*изм|единиц[аы]\s+измерения|цена\s+за\s+ед|стоимост[ьи])\b/.test(t))
    return true;
  if (/(?:^|\s)\d+(?:[.,]\d+)?\s*(шт|пач|упак|компл|комплект|кг|л|м2|м3|усл\.?\s*ед)(?:\s|$|[|;,.])/i.test(t))
    return true;
  if (/(?:руб|₽)/i.test(line)) return true;
  if (/\|/.test(line) || /\t/.test(line)) return true;
  if (/\b(картридж|тонер|фотобарабан|барабан|расходн(?:ый|ого)\s+материал|принтер|мфу|бумаг[аи])\b/.test(t))
    return true;
  return false;
}

function hasExplicitQtyUnit(line: string): boolean {
  return /(?:^|\s)\d+(?:[.,]\d+)?\s*(шт|пач|упак|компл|комплект|кг|л|м2|м3|усл\.?\s*ед)(?:\s|$|[|;,.])/i.test(
    line
  );
}

function hasIdSignal(line: string): boolean {
  const t = line.toLowerCase();
  return (
    /\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{5,8}/.test(t) || // КТРУ
    /\d{2}\.\d{2}\.\d{2}\.\d{2,3}(?:\.\d{3})?/.test(t) || // ОКПД
    /\b20\d{7,11}\b/.test(t) // реестровый id
  );
}

function hasMoneySignal(line: string): boolean {
  return /(\d[\d\s]*(?:[.,]\d{1,2})?)\s*(?:руб|₽)/i.test(line);
}

function looksLikeItemHeaderBlockLine(line: string): boolean {
  const t = line.toLowerCase();
  if (isLikelyServiceOrCharacteristicLine(line)) return false;
  if (/\|/.test(line) || /\t/.test(line)) return true;
  return /\b(товар|позиц|картридж|тонер|фотобарабан|барабан|расходн(?:ый|ого)\s+материал)\b/.test(t);
}

function hasTopLevelGoodsSignalsAround(lines: string[], idx: number): boolean {
  const line = lines[idx] ?? "";
  const next = lines[idx + 1] ?? "";
  const block = `${line}\n${next}`;
  const hasHeader = looksLikeItemHeaderBlockLine(line) || lineHasGoodsRowSignals(line);
  if (!hasHeader) return false;
  const hasId = hasIdSignal(block);
  const hasQty = hasExplicitQtyUnit(block);
  if (!hasId || !hasQty) return false;
  const hasPrice = hasMoneySignal(block);
  const hasTableHeaderHints = /[\t|]/.test(block) || /\b(кол-?во|количество|ед\.?\s*изм|цена|стоимост)\b/i.test(block);
  return hasPrice || hasTableHeaderHints || (hasIdSignal(line) && hasExplicitQtyUnit(line));
}

function isTrustedTopLevelGoodsPositionLine(lines: string[], idx: number, posNum: number): boolean {
  const line = lines[idx] ?? "";
  if (isLikelyServiceOrCharacteristicLine(line)) return false;
  if (posNum < 1 || posNum > 5000) return false;
  /** Не доверяем "голым" нумерованным строкам без локальных сигналов товарного блока. */
  const block = `${line}\n${lines[idx + 1] ?? ""}`;
  if (!hasIdSignal(block)) return false;
  if (!hasExplicitQtyUnit(block)) return false;
  return hasTopLevelGoodsSignalsAround(lines, idx);
}

function buildContinuousAnchoredOrdinals(sorted: number[]): number[] {
  if (!sorted.length) return [];
  if (sorted[0] !== 1) return [];
  const out: number[] = [1];
  for (let i = 1; i < sorted.length; i++) {
    const prev = out[out.length - 1]!;
    const cur = sorted[i]!;
    if (cur === prev + 1) out.push(cur);
    else break;
  }
  return out.length >= 2 ? out : [];
}

/**
 * Номер в начале строки: «1. », «2) », OCR «1 .»
 * Дополнительно: колонка п/п без точки, но с отступом как в таблице («1  Наименование»).
 */
export function lineLeadingPositionNumberStrict(line: string): number | null {
  const m = line.match(/^\s*(\d{1,4})\s*[\.\)]\s*\S/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 1 || n > 5000) return null;
  return n;
}

/** Мягкий вариант: 1–3 цифры и ≥2 пробела до текста (снижает ложные срабатывания на годах в 4 цифры). */
export function lineLeadingPositionNumberRelaxed(line: string): number | null {
  const m = line.match(/^\s*(\d{1,3})(?:\s*[\.\)])?\s{2,}\S/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 1 || n > 999) return null;
  return n;
}

function declaredPhraseScan(corpus: string): Array<{ label: string; value: number }> {
  const c = corpus.replace(/\s+/g, " ");
  const defs: Array<{ label: string; re: RegExp }> = [
    { label: "всего_позиций_N", re: /всего\s+позиций\s*[:\s]+(\d{1,4})\b/i },
    { label: "количество_позиций_N", re: /количеств(?:о|а)\s+позиций\s*[:\s]+(\d{1,4})\b/i },
    { label: "итого_N_позиц", re: /итого\s+(\d{1,4})\s*позиц/i },
    { label: "всего_N_позиц_или_наим", re: /всего\s+(\d{1,4})\s*(?:позиц|наименован)(?:ий|ия|и)?\b/i },
    { label: "спецификация_N_позиц", re: /спецификаци[яи][^.\d]{0,40}(\d{1,4})\s*позиц/i }
  ];
  const hits: Array<{ label: string; value: number }> = [];
  for (const { label, re } of defs) {
    const m = c.match(re);
    if (!m?.[1]) continue;
    const v = parseInt(m[1], 10);
    if (!Number.isFinite(v) || v < 1 || v > 5000) continue;
    hits.push({ label, value: v });
  }
  return hits;
}

function extractDeclaredTotalCount(corpus: string): number | null {
  const hits = declaredPhraseScan(corpus);
  let best: number | null = null;
  for (const h of hits) {
    best = best == null ? h.value : Math.max(best, h.value);
  }
  return best;
}

/**
 * Ожидаемое покрытие позиций по минимизированному корпусу.
 */
export function inferExpectedGoodsCoverage(corpus: string): GoodsExpectedCoverage {
  const lines = corpus.split(/\n/);
  const numsStrict: number[] = [];
  const numsRelaxed: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const ns = lineLeadingPositionNumberStrict(line);
    if (ns != null && isTrustedTopLevelGoodsPositionLine(lines, i, ns)) numsStrict.push(ns);
    const nr = lineLeadingPositionNumberRelaxed(line);
    if (nr != null && isTrustedTopLevelGoodsPositionLine(lines, i, nr)) numsRelaxed.push(nr);
  }
  const uniqSorted = [...new Set(numsStrict)].sort((a, b) => a - b);
  const declaredHits = declaredPhraseScan(corpus);
  const declared = extractDeclaredTotalCount(corpus);

  const strictMax = uniqSorted.length ? Math.max(...uniqSorted) : null;
  const relaxedUniq = [...new Set(numsRelaxed)];
  const relaxedMax = relaxedUniq.length ? Math.max(...relaxedUniq) : null;

  const sampleCap = 24;

  const buildDiagnostics = (
    detectionSource: GoodsExpectedCoverageDetectionSource,
    expectedItemsCount: number | null,
    pattern: GoodsExpectedCoverageDiagnostics["strictLinePattern"],
    positionIdsSample: string[]
  ): GoodsExpectedCoverageDiagnostics => {
    const parts: string[] = [];
    if (strictMax != null) parts.push(`strict_max=${strictMax}`);
    if (relaxedMax != null) parts.push(`relaxed_max=${relaxedMax}`);
    if (declared != null) parts.push(`declared_max=${declared}`);
    if (expectedItemsCount != null) parts.push(`result=${expectedItemsCount}`);
    return {
      strictLinePattern: pattern,
      strictNumberedLines: numsStrict.length,
      relaxedNumberedLines: numsRelaxed.length,
      strictUniqPositionIdsSample: positionIdsSample,
      strictMaxPosition: strictMax,
      relaxedMaxPosition: relaxedMax,
      declaredPhraseHits: declaredHits,
      expectedCountDerivation: `${detectionSource}: ${parts.join(", ")}`
    };
  };

  /** Если в таблице только «мягкая» нумерация, но ≥2 строк — используем её для expected list (минимальный патч против «всего 5»). */
  const tableNumsRaw =
    uniqSorted.length >= 2
      ? uniqSorted
      : numsRelaxed.length >= 2
        ? [...new Set(numsRelaxed)].sort((a, b) => a - b)
        : uniqSorted;
  const tableNums = buildContinuousAnchoredOrdinals(tableNumsRaw);

  if (tableNums.length >= 2) {
    const maxFromTable = Math.max(...tableNums);
    let count = maxFromTable;
    let confidence = 0.82;
    if (declared != null) {
      count = Math.max(count, declared);
      if (declared === maxFromTable) confidence = 0.92;
      else if (Math.abs(declared - maxFromTable) <= 2) confidence = 0.78;
      else confidence = 0.65;
    }
    const usedRelaxedList = uniqSorted.length < 2 && numsRelaxed.length >= 2;
    const patternUsed: GoodsExpectedCoverageDiagnostics["strictLinePattern"] = usedRelaxedList
      ? "leading_digits_two_spaces_then_nonspace (OCR/таблица)"
      : "leading_digits_dot_or_paren_then_nonspace";
    return {
      expectedItemsCount: count,
      expectedPositionIds: tableNums.map(String),
      detectionSource: "table_max_position",
      confidence: usedRelaxedList ? Math.min(confidence, 0.72) : confidence,
      diagnostics: buildDiagnostics(
        "table_max_position",
        count,
        patternUsed,
        tableNums.map(String).slice(0, sampleCap)
      )
    };
  }

  if (declared != null && declared >= 1) {
    return {
      expectedItemsCount: declared,
      expectedPositionIds: [],
      detectionSource: "declared_count",
      confidence: tableNums.length === 1 ? 0.55 : 0.7,
      diagnostics: buildDiagnostics(
        "declared_count",
        declared,
        "leading_digits_dot_or_paren_then_nonspace",
        uniqSorted.map(String).slice(0, sampleCap)
      )
    };
  }

  return {
    expectedItemsCount: null,
    expectedPositionIds: [],
    detectionSource: "none",
    confidence: 0,
    diagnostics: buildDiagnostics(
      "none",
      null,
      "leading_digits_dot_or_paren_then_nonspace",
      uniqSorted.map(String).slice(0, sampleCap)
    )
  };
}

/** Нормализация positionId для сравнения «1» / «01» / «№1». */
export function normalizeGoodsPositionIdForMatch(raw: string): string {
  const t = normPosId(raw.toLowerCase().replace(/\s+/g, ""));
  if (!t || t === "—" || t === "-") return "";
  const m = t.match(/^0*(\d{1,4})(?:\.|$)?$/);
  if (m) return m[1]!;
  const digits = t.replace(/\D/g, "");
  if (digits.length >= 1 && digits.length <= 4) return String(parseInt(digits, 10));
  return t;
}

/**
 * Строки корпуса, похожие на начало строки спецификации с номером п/п (строго или мягко).
 * Для диагностики покрытия чанками (совпадает с логикой добора expected при «таблица без точки»).
 */
export function listCorpusTablePositionLineMarkers(corpus: string): Array<{
  line1Based: number;
  posNum: number;
  via: "strict" | "relaxed";
}> {
  const lines = corpus.split(/\n/);
  const out: Array<{ line1Based: number; posNum: number; via: "strict" | "relaxed" }> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const ns = lineLeadingPositionNumberStrict(line);
    if (ns != null) {
      out.push({ line1Based: i + 1, posNum: ns, via: "strict" });
      continue;
    }
    const nr = lineLeadingPositionNumberRelaxed(line);
    if (nr != null) out.push({ line1Based: i + 1, posNum: nr, via: "relaxed" });
  }
  return out;
}

function positionIdLooksLikeRegistryOrLongId(raw: string): boolean {
  const d = raw.replace(/\D/g, "");
  return d.length >= 6;
}

/** Множество извлечённых номеров позиций из goodsItems. */
export function extractedPositionIdSet(
  goods: Array<{ positionId?: string; name?: string }>
): Set<string> {
  const s = new Set<string>();
  for (const g of goods) {
    const pid = (g.positionId ?? "").trim();
    const k = normalizeGoodsPositionIdForMatch(pid);
    if (k) s.add(k);
    const needPpFromName =
      !k || positionIdLooksLikeRegistryOrLongId(pid) || (pid.length >= 5 && /^\d{5,}/.test(pid));
    if (needPpFromName) {
      const m = (g.name ?? "").match(/^\s*(\d{1,4})\s*[\.)]\s+/);
      if (m) {
        const n = normalizeGoodsPositionIdForMatch(m[1]!);
        if (n) s.add(n);
      }
    }
  }
  return s;
}
