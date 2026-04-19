/**
 * Узкий слой после polish: отрезает явное описательное/упаковочное продолжение внутри уже найденного name.
 * Маркеры взяты из реальных строк regression-goods: Тенд3 (накидка), тендэксперемент 3 (бытовая химия).
 * Не меняет число позиций; не parsePositionBlock / merge / notice.
 */

/** Ниже этого порога слой не срабатывает (Тенд32: ≤40). */
const MIN_INPUT_LEN = 48;
/** Не короче этого оставляем префикс (Тенд32 и короткие имена не попадают в MIN_INPUT_LEN). */
const MIN_PREFIX_KEEP = 22;
const MIN_PREFIX_LETTERS = 4;
const MIN_LETTER_RATIO = 0.28;

/** Маркеры хвоста «описание / фасовка / назначение» — только совпадения из архива Тенд3 / тендэксперемент 3. */
const TAIL_STARTERS: RegExp[] = [
  /\.\s*Объём/i,
  /\.\s*В\s+1\s+упаковке/i,
  /\.\s*В бумажной упаковке/i,
  /,\s*предназначен(?:о|а|ы)?\s+для/i,
  /(?<=\d{2,4}\s*гр)\s*,\s*кислородный/i,
  /\s+Практичный\s+и\s+удобный\s+пеньюар(?=[\s.,;]|$)/i,
  /\s+Для прочистки труб\s*,\s*для дезинфекции/i
];

function letterRatio(t: string): number {
  const letters = (t.match(/[а-яёА-ЯЁa-zA-Z]/g) ?? []).length;
  return t.length > 0 ? letters / t.length : 0;
}

function prefixLooksLikeProductHead(s: string): boolean {
  const t = s.trim();
  if (t.length < MIN_PREFIX_KEEP) return false;
  if ((t.match(/[а-яёА-ЯЁa-zA-Z]/g) ?? []).length < MIN_PREFIX_LETTERS) return false;
  if (letterRatio(t) < MIN_LETTER_RATIO) return false;
  return true;
}

/**
 * Если длинная строка и найден узнаваемый описательный хвост — оставляет товарный префикс.
 */
export function normalizeMixedProductDescriptionInsideName(name: string | null | undefined): string {
  const raw = (name ?? "").replace(/\s+/g, " ").trim();
  if (raw.length < MIN_INPUT_LEN) return raw;

  let cut = raw.length;
  for (const re of TAIL_STARTERS) {
    re.lastIndex = 0;
    const m = re.exec(raw);
    if (m && m.index >= MIN_PREFIX_KEEP && m.index < cut) cut = m.index;
  }
  if (cut >= raw.length) return raw;

  let out = raw.slice(0, cut).trimEnd();
  out = out.replace(/[;,]\s*$/u, "").trimEnd();
  if (!prefixLooksLikeProductHead(out)) return raw;
  if (out.length + 8 >= raw.length) return raw;
  return out;
}
