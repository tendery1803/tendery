import {
  TenderAiParseResultSchema,
  type TenderAiGoodItem,
  type TenderAiParseResult
} from "@tendery/contracts";
import { formatQuantityValueForStorage } from "@/lib/ai/extract-goods-from-tech-spec";
import { coerceGoodsQuantityUnitFields } from "@/lib/ai/match-goods-across-sources";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";

/** Обрезка для логов при AI_PARSE_DIAGNOSTIC_SNIPPET (фрагмент ответа модели). */
const MAX_DIAG_SNIPPET = 2000;

function stripLeadingBom(s: string): string {
  return s.replace(/^\uFEFF/, "");
}

function toOptionalPositionIdStatus(
  value: unknown
): "resolved" | "resolved_auto" | "resolved_manual" | "ambiguous" | "missing" | undefined {
  const s = typeof value === "string" ? value.trim() : "";
  if (
    s === "resolved" ||
    s === "resolved_auto" ||
    s === "resolved_manual" ||
    s === "ambiguous" ||
    s === "missing"
  ) {
    return s;
  }
  return undefined;
}

function toOptionalPositionIdCandidates(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const x of value) {
    const s = typeof x === "string" ? x.trim() : x != null ? String(x).trim() : "";
    if (s) out.push(s);
  }
  return out.length ? out : undefined;
}

function toOptionalPositionIdUserConfirmed(value: unknown): boolean | undefined {
  if (value === true) return true;
  if (value === false) return false;
  return undefined;
}

function toOptionalPositionIdAutoAssigned(value: unknown): boolean | undefined {
  if (value === true) return true;
  if (value === false) return false;
  return undefined;
}

function toOptionalCharacteristicsStatus(value: unknown): "not_present" | undefined {
  const s = typeof value === "string" ? value.trim() : "";
  return s === "not_present" ? "not_present" : undefined;
}

/** Для серверных логов: без сырых ПДн и секретов (ТЗ п. 2.3 / 15). */
export function redactSnippetForLog(s: string): string {
  const withSecrets = s
    .replace(/\bsk-[a-zA-Z0-9_-]{8,}\b/gi, "[sk-redacted]")
    .replace(/Bearer\s+[a-zA-Z0-9._-]+/gi, "Bearer [redacted]");
  return maskPiiForAi(withSecrets).slice(0, MAX_DIAG_SNIPPET);
}

/**
 * Строка целиком обёрнута в один markdown-fence (как раньше в stripCodeFence).
 */
export function stripCodeFence(text: string): string {
  const t = text.trim();
  if (t.startsWith("```")) {
    return t
      .replace(/^```[a-zA-Z0-9]*\s*/m, "")
      .replace(/\s*```\s*$/m, "")
      .trim();
  }
  return t;
}

/** Все блоки ``` или ```json … ``` в тексте (в любом месте). */
export function extractMarkdownCodeBlocks(text: string): string[] {
  const re = /```(?:json)?\s*([\s\S]*?)```/gi;
  const blocks: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const inner = m[1].trim();
    if (inner) blocks.push(inner);
  }
  return blocks;
}

/**
 * Первый сбалансированный JSON-объект по фигурным скобкам (учёт строк в двойных кавычках).
 */
export function extractBalancedJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (c === "\\") {
        escape = true;
        continue;
      }
      if (c === '"') {
        inString = false;
        continue;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export type JsonParseStage =
  | "trim_direct"
  | "outer_fence"
  | "markdown_block"
  | "balanced_object";

export type TenderAiParseDiagnostics = {
  responseLength: number;
  responseEmpty: boolean;
  markdownFenceFound: boolean;
  /** На каком шаге удалось распарсить JSON (до Zod); null если ни один кандидат не JSON. */
  jsonParsedAt: JsonParseStage | null;
  /** Сообщение JSON.parse последней неудачной попытки (для логов). */
  lastJsonError?: string;
};

function tryParseJson(str: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const normalized = stripLeadingBom(str).trim();
  try {
    return { ok: true, value: JSON.parse(normalized) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function toSafeString(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  return String(v);
}

function toConfidence(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) {
    return Math.min(1, Math.max(0, v));
  }
  if (typeof v === "string") {
    const n = Number(v.replace(",", "."));
    if (Number.isFinite(n)) return Math.min(1, Math.max(0, n));
  }
  return 0;
}

const GOODS_QTY_SOURCE_SET = new Set<string>(["tech_spec", "ai", "notice", "merged", "unknown"]);

function toOptionalGoodsQuantityValue(v: unknown): number | undefined {
  if (v == null) return undefined;
  if (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 999_999) return v;
  if (typeof v === "string") {
    const t = v.trim().replace(/\s/g, "").replace(",", ".");
    const n = parseFloat(t);
    if (Number.isFinite(n) && n >= 0 && n <= 999_999) return n;
  }
  return undefined;
}

function toGoodsQuantitySourceString(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  return GOODS_QTY_SOURCE_SET.has(s) ? s : "unknown";
}

/** Начало блока характеристик / инструкций внутри склеенного name — не входит в top-level позицию. */
const GOODS_NAME_CUT_MARKERS: RegExp[] = [
  /\n\s*Характеристик/i,
  /\n\s*Наименование\s+характеристик/i,
  /\n\s*Значение\s+характеристик/i,
  /\n\s*Инструкц(?:ия|ии)\s+по\s+заполнению/i,
  /\n\s*Обоснование\s+включен/i,
  /\n\s*Дополнительн(?:ая|ые)\s+информаци/i,
  /\n\s*Свойств[ао]\s+товар/i
];

/** Следующая строка с п/п (другая позиция в том же поле name). */
const GOODS_NAME_NEXT_ORDINAL = /\n\s*\d{1,2}\s*[\.)]\s+(?:[А-ЯЁA-Z0-9]|Картридж|Тонер|Фотобарабан|СНПЧ|Расходный)/i;

/** Без \\b после ед.изм.: в JS граница слова для кириллицы ненадёжна; хвост фиксируем lookahead. */
const QTY_WITH_UNIT_RE =
  /(\d{1,6}(?:[.,]\d{1,2})?)\s*(?:шт|ед\.?\s*изм|упак|компл|комплект)(?=\s|\.|,|;|\)|$|[\u00A0])/gi;

function trimGoodsNameToTopLevel(name: string): string {
  const n = (name ?? "").replace(/\r\n/g, "\n");
  if (!n.trim()) return "";
  let end = n.length;
  for (const re of GOODS_NAME_CUT_MARKERS) {
    const idx = n.search(re);
    if (idx >= 0) end = Math.min(end, idx);
  }
  const ordIdx = n.search(GOODS_NAME_NEXT_ORDINAL);
  if (ordIdx > 0) end = Math.min(end, ordIdx);
  return n.slice(0, end).trim();
}

function parseQtyNumberToken(raw: string): number {
  return parseFloat(raw.replace(/\s/g, "").replace(",", "."));
}

function quantityCandidateIsPlausible(num: number, fullMatch: string): boolean {
  if (!Number.isFinite(num) || num <= 0 || num > 999_999) return false;
  if (Number.isInteger(num)) {
    if (num >= 100_000) return false;
    return true;
  }
  const low = fullMatch.toLowerCase();
  if (!/(?:шт|ед|упак|компл)/i.test(low)) return false;
  return num <= 500;
}

/**
 * Количество только из верхней части позиции (header + 1–2 строки), не из характеристик.
 */
function extractQuantityFromTopLevelBlock(block: string, modelQuantity: string): string {
  const trimmed = block.trim();
  if (!trimmed) return modelQuantity.trim();

  const lines = trimmed.split("\n");
  const windowPrimary = lines.slice(0, 3).join("\n").slice(0, 600);
  const windowExtended = lines.slice(0, 5).join("\n").slice(0, 900);
  const windows = windowExtended === windowPrimary ? [windowPrimary] : [windowPrimary, windowExtended];

  for (const w of windows) {
    QTY_WITH_UNIT_RE.lastIndex = 0;
    const matches = [...w.matchAll(QTY_WITH_UNIT_RE)];
    let best: { val: string; idx: number } | null = null;
    for (const m of matches) {
      const raw = m[1]!;
      const num = parseQtyNumberToken(raw);
      if (!quantityCandidateIsPlausible(num, m[0]!)) continue;
      const idx = m.index ?? 0;
      if (!best || idx < best.idx) best = { val: normalizeQtyString(raw), idx };
    }
    if (best) return best.val;
  }

  return modelQuantity.trim();
}

function normalizeQtyString(raw: string): string {
  const t = raw.replace(/\s/g, "").replace(",", ".");
  const n = parseFloat(t);
  if (Number.isInteger(n)) return String(Math.trunc(n));
  return t;
}

export function finalizeGoodsItemsFromModelOutput(items: TenderAiGoodItem[] | undefined): TenderAiGoodItem[] {
  if (!items?.length) return items ?? [];
  const normalized = items.map((g) => {
    if (!g || typeof g !== "object") return g;
    const topName = trimGoodsNameToTopLevel(g.name ?? "");
    const nameOut = topName || (g.name ?? "").trim();
    const block = topName || (g.name ?? "").trim();
    const techLocked =
      g.quantitySource === "tech_spec" &&
      g.quantityValue != null &&
      Number.isFinite(g.quantityValue);
    if (techLocked) {
      const quantity = formatQuantityValueForStorage(g.quantityValue!);
      const unitOut =
        (g.quantityUnit || "").trim() || (g.unit || "").trim() || (quantity ? "шт" : "");
      return {
        ...g,
        name: nameOut,
        quantity,
        unit: unitOut,
        quantityUnit: (g.quantityUnit || "").trim() || unitOut,
        quantitySource: "tech_spec" as const
      };
    }
    const coerced = coerceGoodsQuantityUnitFields(g.quantity ?? "", g.unit ?? "");
    const qtyFromBlock = extractQuantityFromTopLevelBlock(block, coerced.quantity || g.quantity || "");
    const quantity = qtyFromBlock || coerced.quantity || "";
    const unit = (coerced.unit || g.unit || "").trim() || (quantity ? "шт" : "");
    return {
      ...g,
      name: nameOut,
      quantity,
      unit
    };
  });
  return normalized;
}

/**
 * Лёгкая нормализация «почти-валидного» JSON от модели.
 * Не меняет структуру кардинально: только исправляет типовые типы (null/number/string) для известных полей.
 */
function normalizeTenderAiPayloadLoosely(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const obj = value as Record<string, unknown>;

  const fields = Array.isArray(obj.fields)
    ? obj.fields.map((f) => {
        if (!f || typeof f !== "object") return f;
        const row = f as Record<string, unknown>;
        return {
          key: toSafeString(row.key),
          label: toSafeString(row.label),
          value: toSafeString(row.value),
          confidence: toConfidence(row.confidence)
        };
      })
    : obj.fields;

  const goodsItemsRaw = Array.isArray(obj.goodsItems)
    ? obj.goodsItems.map((g) => {
        if (!g || typeof g !== "object") return g;
        const item = g as Record<string, unknown>;
        const chars = Array.isArray(item.characteristics)
          ? item.characteristics.map((c) => {
              if (!c || typeof c !== "object") return c;
              const ch = c as Record<string, unknown>;
              return {
                name: toSafeString(ch.name),
                value: toSafeString(ch.value),
                sourceHint: toSafeString(ch.sourceHint)
              };
            })
          : [];
        const qVal = toOptionalGoodsQuantityValue(item.quantityValue);
        const qSrc = toGoodsQuantitySourceString(item.quantitySource);
        const pidStat = toOptionalPositionIdStatus(item.positionIdStatus);
        const pidCands = toOptionalPositionIdCandidates(item.positionIdCandidates);
        const pidUserConf = toOptionalPositionIdUserConfirmed(item.positionIdUserConfirmed);
        const pidAutoAsg = toOptionalPositionIdAutoAssigned(item.positionIdAutoAssigned);
        const chStatus = toOptionalCharacteristicsStatus(item.characteristicsStatus);
        return {
          name: toSafeString(item.name),
          positionId: toSafeString(item.positionId),
          codes: toSafeString(item.codes),
          unit: toSafeString(item.unit),
          quantity: toSafeString(item.quantity),
          unitPrice: toSafeString(item.unitPrice),
          lineTotal: toSafeString(item.lineTotal),
          sourceHint: toSafeString(item.sourceHint),
          characteristics: chars,
          quantityUnit: toSafeString(item.quantityUnit),
          quantitySource: qSrc,
          ...(qVal !== undefined ? { quantityValue: qVal } : {}),
          ...(pidStat ? { positionIdStatus: pidStat } : {}),
          ...(pidCands ? { positionIdCandidates: pidCands } : {}),
          ...(pidUserConf !== undefined ? { positionIdUserConfirmed: pidUserConf } : {}),
          ...(pidAutoAsg !== undefined ? { positionIdAutoAssigned: pidAutoAsg } : {}),
          ...(chStatus ? { characteristicsStatus: chStatus } : {})
        };
      })
    : obj.goodsItems;
  const goodsItems = Array.isArray(goodsItemsRaw)
    ? finalizeGoodsItemsFromModelOutput(goodsItemsRaw as TenderAiGoodItem[])
    : goodsItemsRaw;

  const servicesOfferings = Array.isArray(obj.servicesOfferings)
    ? obj.servicesOfferings.map((s) => {
        if (!s || typeof s !== "object") return s;
        const row = s as Record<string, unknown>;
        return {
          title: toSafeString(row.title),
          volumeOrScope: toSafeString(row.volumeOrScope),
          deadlinesOrStages: toSafeString(row.deadlinesOrStages),
          resultRequirements: toSafeString(row.resultRequirements),
          otherTerms: toSafeString(row.otherTerms),
          sourceHint: toSafeString(row.sourceHint)
        };
      })
    : obj.servicesOfferings;

  return {
    ...obj,
    summary: toSafeString(obj.summary),
    procurementMethod: toSafeString(obj.procurementMethod),
    fields,
    goodsItems,
    servicesOfferings
  };
}

/** Экспорт для диагностики: какие кандидаты пробуются и что с ними. */
export type ParseStageTrace = {
  stage: JsonParseStage;
  jsonOk: boolean;
  schemaOk: boolean;
  jsonError?: string;
};

export function traceTenderAiParseStages(outputText: string): ParseStageTrace[] {
  const raw = outputText ?? "";
  if (!raw.trim()) return [];
  const candidates = collectJsonCandidates(raw);
  const traces: ParseStageTrace[] = [];
  for (const { str, stage } of candidates) {
    const r = tryParseJson(str);
    if (!r.ok) {
      traces.push({ stage, jsonOk: false, schemaOk: false, jsonError: r.error });
      continue;
    }
    const z = TenderAiParseResultSchema.safeParse(r.value);
    traces.push({ stage, jsonOk: true, schemaOk: z.success });
  }
  return traces;
}

function collectJsonCandidates(outputText: string): { str: string; stage: JsonParseStage }[] {
  const trimmed = stripLeadingBom(outputText).trim();
  const candidates: { str: string; stage: JsonParseStage }[] = [];

  if (trimmed.length) {
    candidates.push({ str: trimmed, stage: "trim_direct" });
  }

  const outer = stripCodeFence(trimmed);
  if (outer !== trimmed && outer.length) {
    candidates.push({ str: outer, stage: "outer_fence" });
  }

  for (const block of extractMarkdownCodeBlocks(outputText)) {
    candidates.push({ str: block, stage: "markdown_block" });
  }

  const balanced = extractBalancedJsonObject(trimmed);
  if (balanced) {
    candidates.push({ str: balanced, stage: "balanced_object" });
  }

  const seen = new Set<string>();
  return candidates.filter((c) => {
    if (seen.has(c.str)) return false;
    seen.add(c.str);
    return true;
  });
}

export function parseTenderAiResult(outputText: string):
  | { ok: true; data: TenderAiParseResult }
  | {
      ok: false;
      error: string;
      diagnostics: TenderAiParseDiagnostics;
    } {
  const raw = outputText ?? "";
  const responseLength = raw.length;
  const responseEmpty = !raw.trim();

  if (responseEmpty) {
    return {
      ok: false,
      error: "empty_output",
      diagnostics: {
        responseLength,
        responseEmpty: true,
        markdownFenceFound: false,
        jsonParsedAt: null
      }
    };
  }

  const markdownFenceFound = /```/.test(raw);
  let lastJsonError: string | undefined;
  /** Был хотя бы один кандидат, который успешно распарсился как JSON (до Zod). */
  let sawValidJson = false;
  /** Последний stage, на котором JSON распарсился, но Zod отклонил (для диагностики). */
  let lastSchemaFailStage: JsonParseStage | null = null;
  const candidates = collectJsonCandidates(raw);

  for (const { str, stage } of candidates) {
    const r = tryParseJson(str);
    if (!r.ok) {
      lastJsonError = r.error;
      continue;
    }

    sawValidJson = true;
    let parsed = TenderAiParseResultSchema.safeParse(r.value);
    if (!parsed.success) {
      const normalized = normalizeTenderAiPayloadLoosely(r.value);
      parsed = TenderAiParseResultSchema.safeParse(normalized);
    }
    if (!parsed.success) {
      lastSchemaFailStage = stage;
      continue;
    }

    return {
      ok: true,
      data: {
        ...parsed.data,
        goodsItems: finalizeGoodsItemsFromModelOutput(parsed.data.goodsItems)
      }
    };
  }

  if (sawValidJson) {
    return {
      ok: false,
      error: "schema_mismatch",
      diagnostics: {
        responseLength,
        responseEmpty: false,
        markdownFenceFound,
        jsonParsedAt: lastSchemaFailStage,
        lastJsonError: undefined
      }
    };
  }

  return {
    ok: false,
    error: "json_parse_failed",
    diagnostics: {
      responseLength,
      responseEmpty: false,
      markdownFenceFound,
      jsonParsedAt: null,
      lastJsonError
    }
  };
}
