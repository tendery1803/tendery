/**
 * JSON Schema для Structured Outputs (Responses API) — по смыслу совпадает с
 * TenderAiParseResultSchema в @tendery/contracts (подмножество OpenAI strict schema).
 */
const tenderAiCharacteristicRow = {
  type: "object",
  properties: {
    name: { type: "string" },
    value: { type: "string" },
    sourceHint: { type: "string" }
  },
  required: ["name", "value", "sourceHint"],
  additionalProperties: false
} as const;

const tenderAiGoodItem = {
  type: "object",
  properties: {
    name: { type: "string" },
    positionId: { type: "string" },
    codes: { type: "string" },
    unit: { type: "string" },
    quantity: { type: "string" },
    unitPrice: { type: "string" },
    lineTotal: { type: "string" },
    sourceHint: { type: "string" },
    characteristics: {
      type: "array",
      items: tenderAiCharacteristicRow
    }
  },
  required: [
    "name",
    "positionId",
    "codes",
    "unit",
    "quantity",
    "unitPrice",
    "lineTotal",
    "sourceHint",
    "characteristics"
  ],
  additionalProperties: false
} as const;

const tenderAiServiceOffering = {
  type: "object",
  properties: {
    title: { type: "string" },
    volumeOrScope: { type: "string" },
    deadlinesOrStages: { type: "string" },
    resultRequirements: { type: "string" },
    otherTerms: { type: "string" },
    sourceHint: { type: "string" }
  },
  required: [
    "title",
    "volumeOrScope",
    "deadlinesOrStages",
    "resultRequirements",
    "otherTerms",
    "sourceHint"
  ],
  additionalProperties: false
} as const;

export const TENDER_ANALYZE_RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    fields: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          label: { type: "string" },
          value: { type: "string" },
          confidence: { type: "number" }
        },
        required: ["key", "label", "value", "confidence"],
        additionalProperties: false
      }
    },
    procurementKind: {
      type: "string",
      enum: ["goods", "services", "mixed", "unknown"]
    },
    /** Способ закупки (вне массива fields). Пустая строка, если в документе не указан. */
    procurementMethod: { type: "string" },
    goodsItems: {
      type: "array",
      items: tenderAiGoodItem
    },
    servicesOfferings: {
      type: "array",
      items: tenderAiServiceOffering
    }
  },
  required: [
    "summary",
    "fields",
    "procurementKind",
    "procurementMethod",
    "goodsItems",
    "servicesOfferings"
  ],
  additionalProperties: false
} as const;
