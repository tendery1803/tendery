/**
 * Изолированный клиент Cloud.ru Foundation Models (OpenAI-совместимый endpoint).
 * Test route /test/cloudru-fm; при AI_PROVIDER=cloudru — также клиент для POST /v1/analyze (см. index.ts).
 *
 * Документация: https://cloud.ru/docs/foundation-models/ug/topics/quickstart
 * base URL: https://foundation-models.api.cloud.ru/v1
 * В примерах FM передаётся один API-ключ в OpenAI-клиент — это Key Secret из консоли.
 * Для тестового маршрута достаточно Secret и модели; CLOUDRU_FM_KEY_ID в UI может отсутствовать.
 */

import type { Agent } from "node:http";
import OpenAI, { APIError } from "openai";

const DEFAULT_BASE_URL = "https://foundation-models.api.cloud.ru/v1";

/** HTTP-дедлайн SDK до Cloud.ru FM (мс). Не путать с таймаутом web→gateway. */
export const CLOUDRU_FM_HTTP_TIMEOUT_MS = (() => {
  const raw = process.env.AI_GATEWAY_CLOUDRU_TIMEOUT_MS?.trim();
  if (raw == null || raw === "") return 300_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 5_000 ? Math.floor(n) : 300_000;
})();

export function cloudRuFmBaseUrl(): string {
  const u = process.env.CLOUDRU_FM_BASE_URL?.trim();
  return u && u.length > 0 ? u.replace(/\/+$/, "") : DEFAULT_BASE_URL;
}

/** Secret и модель заданы — можно вызывать FM (test route). */
export function isCloudRuFmEnvConfigured(): boolean {
  const secret = process.env.CLOUDRU_FM_KEY_SECRET?.trim();
  const model = process.env.CLOUDRU_FM_MODEL?.trim();
  return Boolean(secret && model);
}

export type CloudRuFmOpenAiClientOptions = {
  /** Тот же агент, что и для OpenAI (корпоративный HTTPS_PROXY). */
  httpAgent?: Agent;
};

export function createCloudRuFmOpenAIClient(
  opts: CloudRuFmOpenAiClientOptions = {}
): OpenAI | null {
  if (!isCloudRuFmEnvConfigured()) return null;
  const apiKey = process.env.CLOUDRU_FM_KEY_SECRET!.trim();
  return new OpenAI({
    apiKey,
    baseURL: cloudRuFmBaseUrl(),
    timeout: CLOUDRU_FM_HTTP_TIMEOUT_MS,
    maxRetries: 0,
    ...(opts.httpAgent ? { httpAgent: opts.httpAgent } : {})
  });
}

/**
 * Совпадает с официальным примером Cloud.ru FM quickstart (Python openai.chat.completions.create).
 * model задаётся из env (например Qwen/Qwen3-235B-A22B-Instruct-2507).
 */
export const CLOUDRU_FM_OFFICIAL_QUICKSTART_CHAT = {
  max_tokens: 16,
  temperature: 0,
  presence_penalty: 0,
  top_p: 1,
  userContent: "Ответь одним словом: OK"
} as const;

export type CloudRuFmTestDiagnostic = {
  baseURL: string;
  model: string;
  requestParams: {
    max_tokens: number;
    temperature: number;
    presence_penalty: number;
    top_p: number;
    messages: Array<{ role: "user"; contentPreview: string }>;
  };
};

function buildCloudRuFmTestDiagnostic(model: string): CloudRuFmTestDiagnostic {
  const { max_tokens, temperature, presence_penalty, top_p, userContent } =
    CLOUDRU_FM_OFFICIAL_QUICKSTART_CHAT;
  return {
    baseURL: cloudRuFmBaseUrl(),
    model,
    requestParams: {
      max_tokens,
      temperature,
      presence_penalty,
      top_p,
      messages: [{ role: "user", contentPreview: userContent.slice(0, 120) }]
    }
  };
}

export function serializeUpstreamError(e: unknown): {
  upstreamStatus?: number;
  upstreamErrorSnippet?: string;
} {
  if (e instanceof APIError) {
    let snippet = "";
    try {
      snippet =
        e.error !== undefined && e.error !== null
          ? JSON.stringify(e.error)
          : "";
    } catch {
      snippet = String(e.error);
    }
    if (!snippet && e.message) snippet = e.message;
    return {
      upstreamStatus: e.status,
      upstreamErrorSnippet: snippet.slice(0, 4000)
    };
  }
  return {};
}

export type CloudRuFmPingResult =
  | {
      ok: true;
      model: string;
      reply: string;
      elapsedMs: number;
      diagnostic: CloudRuFmTestDiagnostic;
    }
  | {
      ok: false;
      reason: string;
      detail?: string;
      diagnostic: CloudRuFmTestDiagnostic;
      upstreamStatus?: number;
      upstreamErrorSnippet?: string;
    };

/**
 * Вызов chat.completions в формате официального quickstart Cloud.ru FM (только test route).
 */
export async function cloudRuFmPingOk(
  client: OpenAI,
  model: string
): Promise<CloudRuFmPingResult> {
  const diagnostic = buildCloudRuFmTestDiagnostic(model);
  const started = Date.now();
  try {
    const completion = await client.chat.completions.create({
      model,
      max_tokens: CLOUDRU_FM_OFFICIAL_QUICKSTART_CHAT.max_tokens,
      temperature: CLOUDRU_FM_OFFICIAL_QUICKSTART_CHAT.temperature,
      presence_penalty: CLOUDRU_FM_OFFICIAL_QUICKSTART_CHAT.presence_penalty,
      top_p: CLOUDRU_FM_OFFICIAL_QUICKSTART_CHAT.top_p,
      messages: [
        {
          role: "user",
          content: CLOUDRU_FM_OFFICIAL_QUICKSTART_CHAT.userContent
        }
      ]
    });
    const reply =
      completion.choices[0]?.message?.content?.trim() ?? "";
    return {
      ok: true,
      model,
      reply,
      elapsedMs: Date.now() - started,
      diagnostic
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const upstream = serializeUpstreamError(e);
    return {
      ok: false,
      reason: "cloudru_fm_request_failed",
      detail: msg.slice(0, 500),
      diagnostic,
      ...upstream
    };
  }
}
