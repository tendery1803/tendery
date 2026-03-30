import { TenderAiParseResultSchema, type TenderAiParseResult } from "@tendery/contracts";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";

/** Обрезка для логов при AI_PARSE_DIAGNOSTIC_SNIPPET (фрагмент ответа модели). */
const MAX_DIAG_SNIPPET = 2000;

function stripLeadingBom(s: string): string {
  return s.replace(/^\uFEFF/, "");
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
    const parsed = TenderAiParseResultSchema.safeParse(r.value);
    if (!parsed.success) {
      lastSchemaFailStage = stage;
      continue;
    }

    return { ok: true, data: parsed.data };
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
