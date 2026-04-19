/**
 * Финальная очистка очень длинного `name`: без смены числа позиций, без parsePositionBlock.
 * При уверенном разбиении на два «товарных» фрагмента оставляет первый как `name`, пары не порождает.
 * Реальные длинные смешанные строки: Тенд3, тендэксперемент 3 (regression-goods).
 */

const LONG_NAME_MIN_LEN = 121;
/** Минимальная длина каждого сегмента при разрезе по ", " или по « и ». */
const MIN_SPLIT_SEGMENT = 38;
const MIN_SPLIT_SEGMENT_AND = 46;
const MIN_PRODUCT_CHUNK_LEN = 14;
const MIN_PRODUCT_LETTERS = 4;
const MIN_LETTER_RATIO = 0.28;

const NON_PRODUCT_CHUNK_HEAD =
  /^(Значение|Должен|Характеристик|Обеспечивает|в\s+соответствии|по\s+ГОСТ|по\s+ТУ)(?=[\s,.;:]|$)/i;

export type SplitMixedProductLineResult = {
  name: string;
  /** Два фрагмента, только если оба прошли проверку «похоже на товар» и первый принят как `name`. */
  candidates: readonly [string, string] | null;
};

function normalizeSpaces(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function commaSpaceCount(s: string): number {
  let n = 0;
  let p = 0;
  for (;;) {
    const i = s.indexOf(", ", p);
    if (i < 0) break;
    n++;
    p = i + 2;
  }
  return n;
}

function letterMetrics(t: string): { letters: number; len: number } {
  const letters = (t.match(/[а-яёА-ЯЁa-zA-Z]/g) ?? []).length;
  return { letters, len: t.length };
}

function looksLikeProductChunk(s: string): boolean {
  const t = s.trim();
  if (t.length < MIN_PRODUCT_CHUNK_LEN) return false;
  if (NON_PRODUCT_CHUNK_HEAD.test(t)) return false;
  const { letters, len } = letterMetrics(t);
  if (letters < MIN_PRODUCT_LETTERS) return false;
  if (letters / len < MIN_LETTER_RATIO) return false;
  return true;
}

/** Список вида «… , … , …»: минимум два «, » в строке. */
function tryCommaSplits(raw: string): Array<readonly [string, string]> {
  if (commaSpaceCount(raw) < 2) return [];
  const out: Array<readonly [string, string]> = [];
  let pos = 0;
  for (;;) {
    const idx = raw.indexOf(", ", pos);
    if (idx < 0) break;
    const left = raw.slice(0, idx).trimEnd();
    const right = raw.slice(idx + 2).trimStart();
    if (left.length >= MIN_SPLIT_SEGMENT && right.length >= MIN_SPLIT_SEGMENT) {
      out.push([left, right]);
    }
    pos = idx + 1;
  }
  return out;
}

const AND_CONJ = " и ";

function tryAndSplits(raw: string): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [];
  let pos = 0;
  for (;;) {
    const idx = raw.indexOf(AND_CONJ, pos);
    if (idx < 0) break;
    const left = raw.slice(0, idx).trimEnd();
    const right = raw.slice(idx + AND_CONJ.length).trimStart();
    if (left.length >= MIN_SPLIT_SEGMENT_AND && right.length >= MIN_SPLIT_SEGMENT_AND) {
      out.push([left, right]);
    }
    pos = idx + AND_CONJ.length;
  }
  return out;
}

function structuralSignals(raw: string): boolean {
  if (commaSpaceCount(raw) >= 2) return true;
  return tryAndSplits(raw).length > 0;
}

/**
 * Очень длинная строка + признаки нескольких сегментов → при двух «товарных» частях берём первую как `name`.
 */
export function splitMixedProductLineIfNeeded(name: string | null | undefined): SplitMixedProductLineResult {
  const raw = normalizeSpaces(name ?? "");
  if (raw.length < LONG_NAME_MIN_LEN) {
    return { name: raw, candidates: null };
  }
  if (!structuralSignals(raw)) {
    return { name: raw, candidates: null };
  }

  for (const [a, b] of tryCommaSplits(raw)) {
    if (looksLikeProductChunk(a) && looksLikeProductChunk(b)) {
      const first = a.trimEnd();
      const second = b.trim();
      return { name: first, candidates: [first, second] as const };
    }
  }

  for (const [a, b] of tryAndSplits(raw)) {
    if (looksLikeProductChunk(a) && looksLikeProductChunk(b)) {
      const first = a.trimEnd();
      const second = b.trim();
      return { name: first, candidates: [first, second] as const };
    }
  }

  return { name: raw, candidates: null };
}
