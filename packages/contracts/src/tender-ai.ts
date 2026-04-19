import { z } from "zod";

/** Ответ модели при разборе закупки (строгий JSON в тексте ответа). */
export const TenderAiFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.string(),
  confidence: z.number().min(0).max(1)
});

/** Пара «характеристика → значение» по товару (пользовательский вывод — только name/value). */
export const TenderAiCharacteristicRowSchema = z.object({
  name: z.string(),
  value: z.string(),
  /** Внутренний подсказчик источника (фрагмент документа); в UI показывать опционально. */
  sourceHint: z.string().optional().default("")
});

export type TenderAiCharacteristicRow = z.infer<typeof TenderAiCharacteristicRowSchema>;

export const GoodsQuantitySourceSchema = z.enum([
  "tech_spec",
  "ai",
  "notice",
  "merged",
  "unknown"
]);

/**
 * Статус реестрового positionId после извлечения/сверки:
 * `resolved_auto` — однозначно суженный до одного кандидата список, pid проставлен без догадок;
 * `resolved_manual` — пользователь выбрал pid из кандидатов в UI.
 */
export const PositionIdStatusSchema = z.enum([
  "resolved",
  "resolved_auto",
  "resolved_manual",
  "ambiguous",
  "missing"
]);

/**
 * Как получен реестровый `positionId` у позиции (прозрачность для UI/аудита).
 * `matched_by_order` — только узкий индексный fallback ТЗ↔ПФ при согласованной длине и строках.
 */
export const PositionIdMatchConfidenceSchema = z.enum([
  "matched_exact",
  "matched_by_order",
  "not_found"
]);

/** Явная отметка: в источниках закупки нет блока характеристик для позиции (не ошибка пайплайна). */
export const GoodsCharacteristicsStatusSchema = z.enum(["not_present"]);

export const TenderAiGoodItemSchema = z.object({
  name: z.string(),
  positionId: z.string(),
  codes: z.string(),
  unit: z.string(),
  quantity: z.string(),
  unitPrice: z.string(),
  lineTotal: z.string(),
  sourceHint: z.string().optional().default(""),
  characteristics: z.array(TenderAiCharacteristicRowSchema),
  /** Если характеристик нет, но по корпусу однозначно: в ПФ/ООЗ для позиции их нет — не считать «пусто» проблемой качества. */
  characteristicsStatus: GoodsCharacteristicsStatusSchema.optional(),
  /** Числовое количество из детерминированного ТЗ (приоритет над строкой quantity при отображении и merge). */
  quantityValue: z.number().min(0).max(999_999).nullable().optional(),
  /** Единица измерения, согласованная с quantityValue (из колонок ТЗ). */
  quantityUnit: z.string().optional().default(""),
  /** Источник количества: tech_spec — парсер ТЗ; остальное — модель/notice/merge. */
  quantitySource: GoodsQuantitySourceSchema.optional().default("unknown"),
  /**
   * Статус реестрового positionId в итоговой строке:
   * resolved — в строке уже есть реестровый pid; resolved_auto — после сужения один pid;
   * resolved_manual — выбор пользователя из кандидатов; ambiguous — несколько кандидатов;
   * missing — иначе (0 или 1 кандидат при пустом pid в строке).
   */
  positionIdStatus: PositionIdStatusSchema.optional(),
  /** При ambiguous — список реестровых pid из notice-слоя (для ручного выбора в UI). */
  positionIdCandidates: z.array(z.string()).optional(),
  /** Пользователь подтвердил positionId через UI (после ambiguous). */
  positionIdUserConfirmed: z.boolean().optional(),
  /** positionId проставлен автоматически при ровно одном кандидате после сужения (resolved_auto). */
  positionIdAutoAssigned: z.boolean().optional(),
  /** Уверенность сопоставления реестрового positionId (после annotate; опционально для обратной совместимости). */
  positionIdMatchConfidence: PositionIdMatchConfidenceSchema.optional()
});

export const TenderAiServiceOfferingSchema = z.object({
  title: z.string(),
  volumeOrScope: z.string(),
  deadlinesOrStages: z.string(),
  resultRequirements: z.string(),
  otherTerms: z.string(),
  sourceHint: z.string().optional().default("")
});

export const TenderAiParseResultSchema = z
  .object({
    fields: z.array(TenderAiFieldSchema),
    summary: z.string(),
    procurementKind: z.enum(["goods", "services", "mixed", "unknown"]).optional(),
    /** Способ закупки (извещение): запрос котировок, аукцион, конкурс и т.п. — вне массива fields, не ломает 15 полей верхнего блока. */
    procurementMethod: z.string().optional(),
    goodsItems: z.array(TenderAiGoodItemSchema).optional(),
    servicesOfferings: z.array(TenderAiServiceOfferingSchema).optional()
  })
  .transform((d) => ({
    ...d,
    procurementKind: d.procurementKind ?? "unknown",
    procurementMethod: (d.procurementMethod ?? "").trim(),
    goodsItems: d.goodsItems ?? [],
    servicesOfferings: d.servicesOfferings ?? []
  }));

export type TenderAiParseResult = z.output<typeof TenderAiParseResultSchema>;
export type TenderAiGoodItem = z.infer<typeof TenderAiGoodItemSchema>;
export type GoodsQuantitySource = z.infer<typeof GoodsQuantitySourceSchema>;
export type PositionIdStatus = z.infer<typeof PositionIdStatusSchema>;
export type PositionIdMatchConfidence = z.infer<typeof PositionIdMatchConfidenceSchema>;
export type GoodsCharacteristicsStatus = z.infer<typeof GoodsCharacteristicsStatusSchema>;
export type TenderAiServiceOffering = z.infer<typeof TenderAiServiceOfferingSchema>;

/** Краткая сводка полноты товаров для чек-листа и UI (опционально). */
export const GoodsCompletenessSummarySchema = z.object({
  completenessStatus: z.enum(["complete", "partial", "unknown"]),
  expectedCount: z.number().nullable(),
  extractedCount: z.number(),
  missingIdsCount: z.number(),
  checklistNote: z.string()
});

/** Фрагмент результата разбора, сохраняемый в БД (structuredBlock). */
export const TenderAnalysisStructuredBlockSchema = z.object({
  procurementKind: z.enum(["goods", "services", "mixed", "unknown"]),
  procurementMethod: z.string().optional().default(""),
  goodsItems: z.array(TenderAiGoodItemSchema),
  servicesOfferings: z.array(TenderAiServiceOfferingSchema),
  goodsCompleteness: GoodsCompletenessSummarySchema.optional()
});

export type GoodsCompletenessSummary = z.infer<typeof GoodsCompletenessSummarySchema>;
export type TenderAnalysisStructuredBlock = z.infer<typeof TenderAnalysisStructuredBlockSchema>;
