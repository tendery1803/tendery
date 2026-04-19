/**
 * Узкая очистка служебного хвоста в уже извлечённом `name` (кардинальность позиций не меняется).
 * Фразы взяты из реальных имён в `samples/regression-goods/Тенд14` (извлечение ТЗ).
 */

const PROCUREMENT_CHARACTERISTIC_PARTICIPATION_TAIL_RE =
  /(?:\s+Назначение\s+для\s+.+?)?\s+Значение\s+характеристик[аио]?\s+не\s+может\s+изменяться\s+участником\s+закупк[аиыя]?\s*\.?\s*$/iu;

/**
 * ПФ/таблица: два и более подряд «услуг…» и «)» перед фактическим наименованием товара (OCR/склейка колонок).
 * Иначе в конце `title\\ndesc` остаётся «…услуги» в окне 120 символов и эвристика `service_tail` даёт ложноположительное срабатывание.
 * Намеренно узко: только префикс строки, минимум два слова «услуг…» и закрывающая скобка.
 */
const LEADING_DUPLICATE_SERVICE_COLUMN_BEFORE_PAREN_RE =
  /^(?:услуг[а-яё]{0,4}){2,}\)\s*/iu;

const MIN_PREFIX_LEN_AFTER_TAIL_TRIM = 12;

/**
 * Срезает только описанный дублирующийся служебный префикс в начале `name`; кардинальность позиций не меняется.
 */
export function stripLeadingDuplicateServiceColumnHeaderBeforeProductName(
  name: string | null | undefined
): string {
  const raw = (name ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return raw;
  const next = raw.replace(LEADING_DUPLICATE_SERVICE_COLUMN_BEFORE_PAREN_RE, "").trim();
  if (next.length < 3) return raw;
  return next;
}

/**
 * Срезает только типовой хвост требований закупки в конце наименования; префикс не трогает.
 * Если после среза остаётся слишком короткая строка — возвращает исходное имя без изменений.
 */
export function trimNonProductRequirementTailFromName(name: string | null | undefined): string {
  const raw = (name ?? "").replace(/\s+/g, " ").trim();
  if (raw.length < MIN_PREFIX_LEN_AFTER_TAIL_TRIM + 20) return raw;

  if (!PROCUREMENT_CHARACTERISTIC_PARTICIPATION_TAIL_RE.test(raw)) return raw;

  const next = raw.replace(PROCUREMENT_CHARACTERISTIC_PARTICIPATION_TAIL_RE, "").trimEnd();
  if (next.length < MIN_PREFIX_LEN_AFTER_TAIL_TRIM) return raw;
  return next;
}
