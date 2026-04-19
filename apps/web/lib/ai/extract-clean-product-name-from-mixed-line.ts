/**
 * Сужает перегруженное наименование (название + характеристики + описание в одной строке).
 * Только обрезка `name`, кардинальность позиций не меняется.
 * Опирается на реальные строки Тенд3 / тендэксперемент 3 в regression-goods (длинные смешанные имена).
 */

const MIXED_LINE_MIN_LEN = 88;
/** После среза по маркерам или мягкий предел «слишком длинный хвост». */
const MIXED_LINE_SOFT_MAX = 108;
/** Не резать, если маркер слишком близко к началу (Тенд3: «Кресло…» ≈25 символов до « Размеры»). */
const MIN_PREFIX_BEFORE_MARKER = 20;
const MIN_PREFIX_TO_KEEP = 20;

function truncateAtLastSpace(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  const head = s.slice(0, maxLen);
  const sp = head.lastIndexOf(" ");
  if (sp >= MIN_PREFIX_TO_KEEP) return head.slice(0, sp).trimEnd();
  return head.trimEnd();
}

/** Разделители слева от маркера: срез по ним убирает хвост вместе с разделителем. */
const MARKER_LEFT_DELIMS = new Set([",", ".", ";", "—"]);

/**
 * Индекс конца `slice(0, i)` после маркера: если совпадение начинается не на разделителе,
 * берём ближайший `, . ; —` слева от начала совпадения; иначе оставляем как есть.
 * Если разделителя нет — срез по пробелу непосредственно перед маркером (индекс совпадения).
 */
function refineCutAtLeftDelimiterBeforeMatch(raw: string, matchIndex: number): number {
  if (matchIndex <= 0) return matchIndex;
  const at = raw[matchIndex]!;
  if (MARKER_LEFT_DELIMS.has(at)) return matchIndex;

  const lower = Math.max(MIN_PREFIX_BEFORE_MARKER, 1);
  for (let j = matchIndex - 1; j >= lower; j--) {
    if (MARKER_LEFT_DELIMS.has(raw[j]!)) return j;
  }

  return matchIndex;
}

/**
 * Оставляет первую «товарную» часть длинной смешанной строки: до служебных маркеров или до мягкого лимита длины.
 */
export function extractCleanProductNameFromMixedLine(name: string | null | undefined): string {
  const raw = (name ?? "").replace(/\s+/g, " ").trim();
  if (raw.length < MIXED_LINE_MIN_LEN) return raw;

  let cut = raw.length;
  const tryCut = (re: RegExp) => {
    const m = re.exec(raw);
    if (m && m.index >= MIN_PREFIX_BEFORE_MARKER && m.index < cut) cut = m.index;
  };

  // Тенд3: блок габаритов после названия
  tryCut(/\s+Размеры\s*\(/i);
  // Общие маркеры описания / требований в середине строки (не трогаем короткий префикс товара)
  tryCut(/\s+характеристик[а-яё]*/i);
  tryCut(/\s+должен(?=[\s,.;]|$)/i);
  tryCut(/\s+значение(?=[\s,.;]|$)/i);
  tryCut(/\s+обеспечивает/i);
  // Тенд3 (накидка): рекламно-описательное продолжение после запятой
  // (?=…) вместо \b: после кириллицы `\b` в JS не даёт границы слова
  tryCut(/,\s+для\s+защиты\s+одежды(?=\s|$|[.,;—])/i);
  // тендэксперемент 3: второе предложение с дублирующим «Средство отбеливающее…»
  tryCut(/\.\s+Средство\s+отбеливающее(?=\s|$|[.,;—])/i);

  if (cut < raw.length) {
    cut = refineCutAtLeftDelimiterBeforeMatch(raw, cut);
  }

  let out = cut < raw.length ? raw.slice(0, cut).trimEnd() : raw;
  out = out.replace(/[;,]\s*$/u, "").trimEnd();

  if (out.length < MIN_PREFIX_TO_KEEP) return raw;

  if (out.length > MIXED_LINE_SOFT_MAX) {
    out = truncateAtLastSpace(out, MIXED_LINE_SOFT_MAX);
  }

  return out.length >= MIN_PREFIX_TO_KEEP ? out : raw;
}
