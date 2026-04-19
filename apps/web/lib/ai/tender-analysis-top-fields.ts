/**
 * Канонический порядок верхних полей разбора в UI (по fieldKey), независимо от порядка в ответе модели.
 * Поддерживаются устаревшие key из промпта v5 для уже сохранённых разборов.
 */

export const TENDER_ANALYSIS_TOP_FIELD_ORDER = [
  "customer",
  "etrading_platform",
  "tender_no",
  "subject",
  "nmck",
  "currency",
  "dates_stages",
  "delivery_term",
  "delivery_place",
  "bid_security",
  "performance_security",
  "participant_requirements",
  "application_composition",
  "warranty",
  "risks"
] as const;

export type TenderAnalysisTopFieldKey = (typeof TENDER_ANALYSIS_TOP_FIELD_ORDER)[number];

const DEFAULT_LABELS: Record<TenderAnalysisTopFieldKey, string> = {
  customer: "Заказчик",
  etrading_platform: "Наименование электронной площадки",
  tender_no: "Номер / идентификатор закупки",
  subject: "Предмет закупки",
  nmck: "НМЦК",
  currency: "Валюта",
  dates_stages: "Даты и этапы",
  delivery_term: "Срок поставки",
  delivery_place: "Место поставки",
  bid_security: "Обеспечение заявки",
  performance_security: "Обеспечение исполнения контракта",
  participant_requirements: "Требования к участнику",
  application_composition: "Состав заявки",
  warranty: "Гарантия",
  risks: "Риски и спорные моменты"
};

/** Старые key → канонический key (разборы до обновления промпта). */
const LEGACY_TO_CANONICAL: Record<string, TenderAnalysisTopFieldKey> = {
  customer: "customer",
  etrading_platform: "etrading_platform",
  tender_no: "tender_no",
  subject: "subject",
  nmck: "nmck",
  currency: "currency",
  dates_stages: "dates_stages",
  dates: "dates_stages",
  delivery_term: "delivery_term",
  delivery_deadline: "delivery_term",
  delivery_place: "delivery_place",
  bid_security: "bid_security",
  performance_security: "performance_security",
  contract_performance_security: "performance_security",
  participant_requirements: "participant_requirements",
  requirements: "participant_requirements",
  application_composition: "application_composition",
  application_parts: "application_composition",
  warranty: "warranty",
  risks: "risks"
};

const TOP_FIELD_KEY_SET = new Set<string>(TENDER_ANALYSIS_TOP_FIELD_ORDER);

export function canonicalTenderAnalysisFieldKey(fieldKey: string): string {
  return LEGACY_TO_CANONICAL[fieldKey] ?? fieldKey;
}

export type TenderAnalysisFieldRow = {
  /** Стабильный ключ строки в таблице */
  rowKey: string;
  fieldKey: TenderAnalysisTopFieldKey | string;
  fieldLabel: string;
  valueText: string;
  confidence: number | null;
  /** id из БД, если строка привязана к сохранённому полю */
  id?: string;
};

type TopFieldInputRow = {
  id: string;
  fieldKey: string;
  fieldLabel: string;
  valueText: string;
  confidence: number;
};

function pickBetterField(a: TopFieldInputRow, b: TopFieldInputRow): TopFieldInputRow {
  const av = a.valueText.trim().length;
  const bv = b.valueText.trim().length;
  if (bv > av) return b;
  if (av > bv) return a;
  return b.confidence >= a.confidence ? b : a;
}

/**
 * 15 фиксированных строк по канону + в конце — любые поля с неизвестными key (без дублей с каноном).
 */
export function buildTenderAnalysisTopFieldRows(fields: TopFieldInputRow[]): TenderAnalysisFieldRow[] {
  const byCanon = new Map<string, TopFieldInputRow>();

  for (const f of fields) {
    const canon = canonicalTenderAnalysisFieldKey(f.fieldKey);
    const prev = byCanon.get(canon);
    if (!prev) {
      byCanon.set(canon, f);
      continue;
    }
    const best = pickBetterField(prev, f);
    byCanon.set(canon, best);
  }

  const ordered: TenderAnalysisFieldRow[] = [];

  for (const canon of TENDER_ANALYSIS_TOP_FIELD_ORDER) {
    const f = byCanon.get(canon);
    ordered.push({
      rowKey: canon,
      fieldKey: canon,
      fieldLabel: f?.fieldLabel?.trim() || DEFAULT_LABELS[canon],
      valueText: f?.valueText ?? "",
      confidence: f != null ? f.confidence : null,
      id: f?.id
    });
  }

  const extras: TenderAnalysisFieldRow[] = [];
  const seenExtraIds = new Set<string>();
  for (const f of fields) {
    const canon = canonicalTenderAnalysisFieldKey(f.fieldKey);
    if (TOP_FIELD_KEY_SET.has(canon)) continue;
    if (seenExtraIds.has(f.id)) continue;
    seenExtraIds.add(f.id);
    extras.push({
      rowKey: f.id,
      fieldKey: f.fieldKey,
      fieldLabel: f.fieldLabel,
      valueText: f.valueText,
      confidence: f.confidence,
      id: f.id
    });
  }

  extras.sort((a, b) => a.fieldLabel.localeCompare(b.fieldLabel, "ru"));

  return [...ordered, ...extras];
}
