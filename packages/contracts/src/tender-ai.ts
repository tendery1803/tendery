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

export const TenderAiGoodItemSchema = z.object({
  name: z.string(),
  positionId: z.string(),
  codes: z.string(),
  unit: z.string(),
  quantity: z.string(),
  unitPrice: z.string(),
  lineTotal: z.string(),
  sourceHint: z.string().optional().default(""),
  characteristics: z.array(TenderAiCharacteristicRowSchema)
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
