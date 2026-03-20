import { z } from "zod";

/** Ответ модели при разборе закупки (строгий JSON в тексте ответа). */
export const TenderAiFieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  value: z.string(),
  confidence: z.number().min(0).max(1)
});

export const TenderAiParseResultSchema = z.object({
  fields: z.array(TenderAiFieldSchema),
  summary: z.string()
});

export type TenderAiParseResult = z.infer<typeof TenderAiParseResultSchema>;
