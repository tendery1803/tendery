/**
 * Универсальные смысловые группы характеристик (без привязки к типу товара / тендеру).
 * Классификация по лексике и структурным шаблонам (RU + латиница, коды классификаторов, числа с ед.).
 */

export const SEMANTIC_CHARACTERISTIC_GROUPS = [
  "identity_model",
  "type_category",
  "material_composition",
  "function_processing",
  "variant_color_execution",
  "quantitative_numeric",
  "compatibility_application",
  "standard_compliance"
] as const;

export type SemanticCharacteristicGroup = (typeof SEMANTIC_CHARACTERISTIC_GROUPS)[number];

function norm(s: string): string {
  return (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Возвращает набор групп, которые по тексту (ключ+значение или произвольный фрагмент)
 * выглядят как носители смысла для ручной сверки.
 */
export function detectSemanticGroupsInText(raw: string): Set<SemanticCharacteristicGroup> {
  const t = norm(raw);
  const s = new Set<SemanticCharacteristicGroup>();
  if (!t) return s;

  if (
    /артикул|арт\.?\s*\d|oem|sku|factory\s*number|заводск|индекс|обозначени|каталож|part\s*no|\bмодель\b|\bмод\.?\s*[:.]/i.test(
      raw
    ) ||
    /\b[a-z]{1,6}[-.]?\d[\w.-]{2,}\b/i.test(raw) ||
    /\d{2}\.\d{2}\.\d{2}\.\d{3}-\d{2,14}/i.test(raw)
  ) {
    s.add("identity_model");
  }

  if (/\bтип\b|\bвид\b|категори|класс\s|назначени[ея]\s*:|вид\s*издел/i.test(t)) {
    s.add("type_category");
  }

  if (/состав|материал|волокн|пластик|металл|сталь|латекс|нитрил|резин|бумаг[аы]\b|картон/i.test(t)) {
    s.add("material_composition");
  }

  if (/назначени|применени|функци|обработк|антисепт|дезинф|очищ|моечн|стиральн|обезжирив/i.test(t)) {
    s.add("function_processing");
  }

  if (/цвет|оттенок|исполнен|вариант|размер\s*:|формат\s*:/i.test(t)) {
    s.add("variant_color_execution");
  }

  if (
    /\d+(?:[.,]\d+)?\s*(?:мм|см|м[²2³]|кг|\bг\b|\bл\b|мл|шт|пар|%)/i.test(raw) ||
    /объ[её]м|масса|вес|плотност|размер|габарит|количеств|мощност/i.test(t)
  ) {
    s.add("quantitative_numeric");
  }

  if (/совместим|аналог|эквивалент|подходит|для\s+принтер|к\s+аппарат|для\s+устройств/i.test(t)) {
    s.add("compatibility_application");
  }

  if (/гост|санпин|\biso\b|тр\s*тс|сертификат|соответств|норматив|стандарт|техническ\w*\s*регламент/i.test(t)) {
    s.add("standard_compliance");
  }

  return s;
}

/** Объединение групп по списку текстовых фрагментов (например, все пары key:value). */
export function unionSemanticGroupsFromTexts(parts: string[]): Set<SemanticCharacteristicGroup> {
  const u = new Set<SemanticCharacteristicGroup>();
  for (const p of parts) {
    for (const g of detectSemanticGroupsInText(p)) u.add(g);
  }
  return u;
}

export function semanticGroupsToSortedArray(s: Set<SemanticCharacteristicGroup>): SemanticCharacteristicGroup[] {
  return SEMANTIC_CHARACTERISTIC_GROUPS.filter((g) => s.has(g));
}

/** Группы, которые видны в «карточном» тексте, но не материализованы отдельными характеристиками. */
export function missingSemanticGroups(
  presentInCharacteristics: Set<SemanticCharacteristicGroup>,
  presentInCardBlob: Set<SemanticCharacteristicGroup>
): SemanticCharacteristicGroup[] {
  return SEMANTIC_CHARACTERISTIC_GROUPS.filter((g) => presentInCardBlob.has(g) && !presentInCharacteristics.has(g));
}
