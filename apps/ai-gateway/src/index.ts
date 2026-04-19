import http from "node:http";
import { z } from "zod";
import { HttpsProxyAgent } from "https-proxy-agent";
import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError
} from "openai";
import type { ChatCompletion } from "openai/resources/chat/completions";
import type { Response as OpenAIResponse } from "openai/resources/responses/responses";
import pino from "pino";
import { TENDER_ANALYZE_RESPONSE_JSON_SCHEMA } from "./tender-analyze-schema.js";
import {
  buildTenderAnalyzeResponseDiag,
  rebuildOutputTextFromMessages
} from "./analyze-response-diagnostics.js";
import { redactDiagnosticPreview, redactSecrets } from "./pii-redact.js";
import { extractJson } from "./utils/extract-json.js";
import {
  CLOUDRU_FM_HTTP_TIMEOUT_MS,
  CLOUDRU_FM_OFFICIAL_QUICKSTART_CHAT,
  cloudRuFmBaseUrl,
  cloudRuFmPingOk,
  createCloudRuFmOpenAIClient,
  isCloudRuFmEnvConfigured,
  serializeUpstreamError
} from "./cloudru-fm-client.js";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport:
    process.env.NODE_ENV === "production"
      ? undefined
      : { target: "pino-pretty", options: { colorize: true } }
});

const port = Number(process.env.PORT ?? 4010);
const apiKey = process.env.AI_GATEWAY_API_KEY?.trim();
if (!apiKey) {
  logger.fatal("AI_GATEWAY_API_KEY is required (set in root .env)");
  process.exit(1);
}
const openaiApiKey = process.env.OPENAI_API_KEY;

/** Дедлайн одного HTTP-запроса к api.openai.com (длинные structured outputs + медленный канал). */
const OPENAI_HTTP_TIMEOUT_MS = (() => {
  const raw = process.env.AI_GATEWAY_OPENAI_TIMEOUT_MS;
  if (raw == null || raw === "") return 360_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 10_000 ? Math.floor(n) : 360_000;
})();

/**
 * SDK OpenAI в Node по умолчанию не читает HTTPS_PROXY — трафик шёл мимо корпоративного прокси → таймауты.
 * Явный HttpsProxyAgent при наличии URL в env (логин/пароль прокси — в URL: https://user:pass@host:port).
 *
 * OPENAI_NO_PROXY=1 — не использовать прокси для OpenAI даже если в shell заданы HTTPS_PROXY/HTTP_PROXY
 * (типично WSL: глобальный прокси для npm, а до api.openai.com — напрямую).
 */
function openAiProxyExplicitlyDisabled(): boolean {
  const v = process.env.OPENAI_NO_PROXY?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function createOpenAiHttpAgent(): InstanceType<typeof HttpsProxyAgent> | undefined {
  if (openAiProxyExplicitlyDisabled()) {
    logger.info(
      { event: "openai_proxy_skipped" },
      "OPENAI_NO_PROXY: исходящие запросы к OpenAI без прокси (игнор HTTPS_PROXY/HTTP_PROXY)"
    );
    return undefined;
  }
  const proxyUrl =
    process.env.OPENAI_HTTPS_PROXY?.trim() ||
    process.env.HTTPS_PROXY?.trim() ||
    process.env.HTTP_PROXY?.trim();
  if (!proxyUrl) return undefined;
  try {
    const u = new URL(proxyUrl);
    logger.info(
      {
        event: "openai_https_proxy",
        host: u.hostname,
        port: u.port || "(default)",
        hasAuth: Boolean(u.username)
      },
      "OpenAI: исходящие запросы через HTTPS-прокси"
    );
    return new HttpsProxyAgent(proxyUrl);
  } catch (e) {
    logger.error(
      { err: e, proxyPreview: proxyUrl.replace(/:[^:@/]+@/, ":****@") },
      "Некорректный URL прокси (OPENAI_HTTPS_PROXY / HTTPS_PROXY)"
    );
    return undefined;
  }
}

const openAiHttpAgent = createOpenAiHttpAgent();

const openai = openaiApiKey
  ? new OpenAI({
      apiKey: openaiApiKey,
      timeout: OPENAI_HTTP_TIMEOUT_MS,
      /** Иначе SDK по умолчанию ретраит таймауты (до 2 повторов) — суммарно легко выйти за лимит web→gateway. */
      maxRetries: 0,
      ...(openAiHttpAgent ? { httpAgent: openAiHttpAgent } : {})
    })
  : null;

function cloudRuOpenAiFallbackEnabled(): boolean {
  const a = process.env.AI_GATEWAY_CLOUDRU_FALLBACK_OPENAI?.trim().toLowerCase();
  const b = process.env.AI_CLOUDRU_FALLBACK_OPENAI?.trim().toLowerCase();
  return a === "1" || a === "true" || b === "1" || b === "true";
}

function cloudRuTransportMaxAttempts(): number {
  const raw = process.env.AI_GATEWAY_CLOUDRU_TRANSPORT_RETRIES?.trim();
  const n = raw == null || raw === "" ? 3 : Number(raw);
  if (!Number.isFinite(n)) return 3;
  return Math.min(5, Math.max(1, Math.floor(n)));
}

function isCloudRuTransportRetriable(err: unknown): boolean {
  if (err instanceof APIConnectionTimeoutError || err instanceof APIConnectionError) return true;
  if (err instanceof APIError) {
    const s = err.status;
    if (s === 408 || s === 429) return true;
    if (s != null && s >= 500 && s <= 599) return true;
  }
  return false;
}

/** Повтор при нестабильном транспорте / 5xx у Cloud.ru FM (отдельно от retry «верни JSON»). */
async function cloudRuChatCompletionsWithTransportRetries(
  fmClient: OpenAI,
  args: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming
): Promise<ChatCompletion> {
  const maxAttempts = cloudRuTransportMaxAttempts();
  const delaysMs = [0, 900, 2200, 4000, 6500];
  let lastErr: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    const wait = delaysMs[i] ?? 3000 * (i + 1);
    if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait));
    try {
      const chat = await fmClient.chat.completions.create({ ...args, stream: false });
      if (i > 0) {
        logger.info(
          { event: "cloudru_transport_retry_ok", attempt: i + 1, maxAttempts },
          "cloudru_transport_retry_ok"
        );
      }
      return chat;
    } catch (e) {
      lastErr = e;
      if (!isCloudRuTransportRetriable(e) || i === maxAttempts - 1) throw e;
      logger.warn(
        {
          event: "cloudru_transport_retry",
          attempt: i + 1,
          maxAttempts,
          ...serializeUpstreamError(e),
          message: safeClientMessage(e)
        },
        "cloudru_transport_retry"
      );
    }
  }
  throw lastErr;
}

type AnalyzeBody = z.infer<typeof AnalyzeRequest>;

async function executeOpenAiResponses(
  client: OpenAI,
  body: AnalyzeBody
): Promise<{
  model: string;
  outputText: string;
  usage: unknown | null;
  completion: OpenAIResponse | null;
}> {
  const model = routeModel(body.modelRoute);
  logger.info(
    {
      event: "openai_call_start",
      operation: body.operation,
      modelRoute: body.modelRoute,
      model,
      openaiTimeoutMs: OPENAI_HTTP_TIMEOUT_MS
    },
    "openai_call_start"
  );

  const completion = await client.responses.create({
    model,
    input: body.prompt,
    max_output_tokens: body.maxOutputTokens,
    ...(body.operation === "tender_analyze"
      ? {
          text: {
            format: {
              type: "json_schema",
              name: "tender_analysis",
              strict: true,
              schema: structuredClone(TENDER_ANALYZE_RESPONSE_JSON_SCHEMA) as Record<string, unknown>
            }
          }
        }
      : {})
  });

  let outputText = completion.output_text ?? "";
  if (body.operation === "tender_analyze") {
    const rebuilt = rebuildOutputTextFromMessages(completion);
    if (!outputText.length && rebuilt.length) {
      logger.warn(
        { event: "tender_analyze_output_text_empty_used_rebuild", model },
        "completion.output_text пустой, взят текст из message.output_text вручную"
      );
      outputText = rebuilt;
    }
    const diagBase = buildTenderAnalyzeResponseDiag(completion, outputText);
    logger.info(
      {
        event: "tender_analyze_openai_shape",
        model,
        operation: body.operation,
        ...diagBase,
        ...(tenderAnalyzeDeepDiagEnabled()
          ? { outputPreview: redactDiagnosticPreview(outputText.slice(0, 2000)) }
          : {})
      },
      "tender_analyze_openai_shape"
    );
    if (!diagBase.rebuiltMatchesSdk && (outputText.length || rebuilt.length)) {
      logger.warn(
        {
          event: "tender_analyze_output_text_sdk_mismatch",
          model,
          sdkLen: diagBase.sdkOutputTextLen,
          rebuiltLen: rebuilt.length
        },
        "расхождение output_text SDK и ручной сборки message.content"
      );
    }
  }
  const usage = completion.usage ?? null;
  return { model, outputText, usage, completion };
}

logger.info(
  {
    event: "ai_gateway_startup_deps",
    cloudru: {
      configured: isCloudRuFmEnvConfigured(),
      secretSet: Boolean(process.env.CLOUDRU_FM_KEY_SECRET?.trim()),
      modelSet: Boolean(process.env.CLOUDRU_FM_MODEL?.trim()),
      modelPreview: process.env.CLOUDRU_FM_MODEL?.trim()
        ? String(process.env.CLOUDRU_FM_MODEL).trim().slice(0, 48)
        : null,
      timeoutMs: CLOUDRU_FM_HTTP_TIMEOUT_MS,
      baseURL: cloudRuFmBaseUrl(),
      transportRetries: cloudRuTransportMaxAttempts(),
      httpsProxyForOutbound: Boolean(openAiHttpAgent)
    },
    openai: {
      configured: Boolean(openaiApiKey?.trim()),
      timeoutMs: OPENAI_HTTP_TIMEOUT_MS
    },
    cloudruOpenAiFallback: cloudRuOpenAiFallbackEnabled()
  },
  "ai_gateway_startup_deps"
);

const AnalyzeRequest = z.object({
  operation: z.enum(["tender_analyze", "draft_generate"]),
  sensitivity: z.enum(["no_pii", "maybe_pii", "corp_sensitive", "too_much_pii"]),
  modelRoute: z.enum(["nano", "mini", "escalate"]).default("mini"),
  prompt: z.string().min(1),
  /** tender_analyze с goodsItems/services может занимать >4k токенов; верхняя граница — запас под длинные спецификации. */
  maxOutputTokens: z.number().int().positive().max(16384).default(800)
});

function json(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function unauthorized(res: http.ServerResponse) {
  return json(res, 401, { error: "unauthorized" });
}

function routeModel(modelRoute: "nano" | "mini" | "escalate") {
  switch (modelRoute) {
    case "nano":
      return "gpt-5-nano";
    case "mini":
      return "gpt-5-mini";
    case "escalate":
      return "gpt-5.4-mini";
  }
}

function aiProviderIsCloudRu(): boolean {
  return process.env.AI_PROVIDER?.trim().toLowerCase() === "cloudru";
}

function safeClientMessage(err: unknown, maxLen = 900): string {
  const base = err instanceof Error ? err.message : String(err);
  return redactSecrets(base).slice(0, maxLen);
}

/** Совпадает с web: подробный превью ответа модели только при явном флаге (ПДн в тексте закупки). */
function tenderAnalyzeDeepDiagEnabled(): boolean {
  return (
    process.env.AI_PARSE_DIAGNOSTIC_SNIPPET === "true" ||
    process.env.AI_TENDER_ANALYZE_DIAG === "true"
  );
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      return json(res, 200, {
        ok: true,
        cloudru: {
          configured: isCloudRuFmEnvConfigured(),
          secretSet: Boolean(process.env.CLOUDRU_FM_KEY_SECRET?.trim()),
          modelSet: Boolean(process.env.CLOUDRU_FM_MODEL?.trim()),
          model: process.env.CLOUDRU_FM_MODEL?.trim() ?? null,
          timeoutMs: CLOUDRU_FM_HTTP_TIMEOUT_MS,
          baseURL: cloudRuFmBaseUrl(),
          transportRetries: cloudRuTransportMaxAttempts(),
          fallbackOpenAiEnabled: cloudRuOpenAiFallbackEnabled(),
          liveCompletionTest:
            "GET /test/cloudru-fm with Authorization: Bearer <AI_GATEWAY_API_KEY> (короткий chat completion)"
        },
        openai: { configured: Boolean(openaiApiKey?.trim()), timeoutMs: OPENAI_HTTP_TIMEOUT_MS }
      });
    }

    /**
     * Локальная проверка Cloud.ru Foundation Models (Qwen и др.) — не часть /v1/analyze.
     * Тот же Bearer AI_GATEWAY_API_KEY, что и для основного API шлюза.
     */
    const pathOnly = req.url?.split("?")[0] ?? "";
    if (req.method === "GET" && pathOnly === "/test/cloudru-fm") {
      const auth = req.headers.authorization;
      if (!auth?.startsWith("Bearer ") || auth.slice("Bearer ".length) !== apiKey) {
        return unauthorized(res);
      }
      if (!isCloudRuFmEnvConfigured()) {
        return json(res, 503, {
          error: "cloudru_fm_not_configured",
          message:
            "Задайте CLOUDRU_FM_KEY_SECRET и CLOUDRU_FM_MODEL (см. docs/env или .env)."
        });
      }
      const model = process.env.CLOUDRU_FM_MODEL!.trim();
      const fmClient = createCloudRuFmOpenAIClient({ httpAgent: openAiHttpAgent });
      if (!fmClient) {
        return json(res, 503, { error: "cloudru_fm_client_unavailable" });
      }
      logger.info(
        {
          event: "cloudru_fm_test_start",
          model,
          ...(process.env.CLOUDRU_FM_KEY_ID?.trim()
            ? { keyIdPrefix: process.env.CLOUDRU_FM_KEY_ID.trim().slice(0, 8) }
            : {})
        },
        "cloudru_fm_test_start"
      );
      logger.info(
        {
          event: "cloudru_fm_test_outgoing",
          baseURL: cloudRuFmBaseUrl(),
          model,
          max_tokens: CLOUDRU_FM_OFFICIAL_QUICKSTART_CHAT.max_tokens,
          temperature: CLOUDRU_FM_OFFICIAL_QUICKSTART_CHAT.temperature,
          presence_penalty: CLOUDRU_FM_OFFICIAL_QUICKSTART_CHAT.presence_penalty,
          top_p: CLOUDRU_FM_OFFICIAL_QUICKSTART_CHAT.top_p,
          messages: [
            {
              role: "user",
              contentPreview:
                CLOUDRU_FM_OFFICIAL_QUICKSTART_CHAT.userContent.slice(0, 80)
            }
          ]
        },
        "cloudru_fm_test_outgoing"
      );
      const result = await cloudRuFmPingOk(fmClient, model);
      const envProbe = {
        secretSet: Boolean(process.env.CLOUDRU_FM_KEY_SECRET?.trim()),
        modelSet: Boolean(process.env.CLOUDRU_FM_MODEL?.trim()),
        timeoutMs: CLOUDRU_FM_HTTP_TIMEOUT_MS,
        baseURL: cloudRuFmBaseUrl(),
        transportRetries: cloudRuTransportMaxAttempts()
      };
      logger.info(
        { event: "cloudru_fm_test_diag", diagnostic: result.diagnostic, ok: result.ok, envProbe },
        "cloudru_fm_test_diag"
      );
      if (!result.ok) {
        logger.warn(
          {
            event: "cloudru_fm_test_fail",
            reason: result.reason,
            detail: result.detail,
            upstreamStatus: result.upstreamStatus,
            upstreamErrorSnippet: result.upstreamErrorSnippet,
            diagnostic: result.diagnostic,
            envProbe
          },
          "cloudru_fm_test_fail"
        );
        return json(res, 502, { ...result, envProbe });
      }
      logger.info(
        {
          event: "cloudru_fm_test_ok",
          model,
          elapsedMs: result.elapsedMs,
          replyPreview: result.reply.slice(0, 80),
          envProbe
        },
        "cloudru_fm_test_ok"
      );
      return json(res, 200, { ...result, envProbe });
    }

    if (req.method !== "POST" || req.url !== "/v1/analyze") {
      return json(res, 404, { error: "not_found" });
    }

    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ") || auth.slice("Bearer ".length) !== apiKey) {
      return unauthorized(res);
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      return json(res, 400, { error: "bad_request", message: "invalid_json_body" });
    }
    const parsed = AnalyzeRequest.safeParse(parsedJson);
    if (!parsed.success) {
      return json(res, 400, { error: "bad_request", details: parsed.error.flatten() });
    }

    const body = parsed.data;

    if (body.sensitivity === "too_much_pii") {
      return json(res, 422, { error: "rejected", reason: "too_much_pii" });
    }

    const wantCloudRu = aiProviderIsCloudRu();

    // По умолчанию при AI_PROVIDER=cloudru OpenAI не используется.
    // Fallback: AI_GATEWAY_CLOUDRU_FALLBACK_OPENAI=1 (или AI_CLOUDRU_FALLBACK_OPENAI=1) и задан OPENAI_API_KEY.

    logger.info(
      {
        event: "ai_provider_check",
        provider: process.env.AI_PROVIDER,
        cloudruConfigured: isCloudRuFmEnvConfigured(),
        cloudruTimeoutMs: CLOUDRU_FM_HTTP_TIMEOUT_MS,
        cloudruTransportRetries: cloudRuTransportMaxAttempts(),
        cloudruOpenAiFallback: cloudRuOpenAiFallbackEnabled(),
        hasOpenAI: Boolean(openai)
      },
      "ai_provider_check"
    );

    if (!wantCloudRu && !openai) {
      return json(res, 503, { error: "openai_not_configured" });
    }
    if (wantCloudRu && !isCloudRuFmEnvConfigured()) {
      return json(res, 503, { error: "cloudru_not_configured" });
    }

    const startedAt = Date.now();
    let model = "";
    let outputText = "";
    let usage: unknown | null = null;
    let completion: OpenAIResponse | null = null;
    let usedCloudRu = false;

    if (wantCloudRu) {
      const fmClient = createCloudRuFmOpenAIClient({ httpAgent: openAiHttpAgent });
      if (!fmClient) {
        logger.error({ event: "cloudru_client_null" }, "cloudru_client_null");
        return json(res, 502, {
          error: "cloudru_failed",
          detail: "Cloud.ru request failed"
        });
      }
      let jsonRetryAfterInvalidJson = false;
      let cloudPathResolved = false;
      try {
        model = process.env.CLOUDRU_FM_MODEL!.trim();
        logger.info(
          {
            event: "cloudru_call_start",
            operation: body.operation,
            modelRoute: body.modelRoute,
            model,
            maxOutputTokens: body.maxOutputTokens,
            cloudruTimeoutMs: CLOUDRU_FM_HTTP_TIMEOUT_MS,
            transportRetries: cloudRuTransportMaxAttempts()
          },
          "cloudru_call_start"
        );

        // Cloud.ru (Qwen) не гарантирует строгий JSON.
        // 1) extractJson  2) один retry с жёстким промптом  3) иначе ошибка
        // Транспортные сбои / 5xx — cloudRuChatCompletionsWithTransportRetries (отдельно от JSON-retry).

        let chat: Awaited<ReturnType<typeof fmClient.chat.completions.create>>;
        try {
          chat = await cloudRuChatCompletionsWithTransportRetries(fmClient, {
            model,
            messages: [{ role: "user", content: body.prompt }],
            max_tokens: body.maxOutputTokens
          });
          const rawText = (chat.choices[0]?.message?.content ?? "").trim();
          const extracted = extractJson(rawText);
          if (!extracted) {
            throw new Error("invalid_json_from_cloudru");
          }
          outputText = extracted;
        } catch (innerErr) {
          const im = innerErr instanceof Error ? innerErr.message : String(innerErr);
          if (!im.includes("invalid_json_from_cloudru")) {
            throw innerErr;
          }
          jsonRetryAfterInvalidJson = true;
          logger.warn(
            {
              event: "cloudru_json_retry_prompt",
              model,
              maxOutputTokens: body.maxOutputTokens
            },
            "cloudru_json_retry_prompt"
          );
          chat = await cloudRuChatCompletionsWithTransportRetries(fmClient, {
            model,
            messages: [
              {
                role: "user",
                content:
                  body.prompt +
                  "\n\nВерни ТОЛЬКО JSON. Без текста, без пояснений."
              }
            ],
            max_tokens: body.maxOutputTokens
          });
          const rawTextRetry = (chat.choices[0]?.message?.content ?? "").trim();
          const extractedRetry = extractJson(rawTextRetry);
          if (!extractedRetry) {
            throw new Error("invalid_json_from_cloudru");
          }
          outputText = extractedRetry;
        }

        usage = chat.usage
          ? {
              input_tokens: chat.usage.prompt_tokens,
              output_tokens: chat.usage.completion_tokens,
              total_tokens: chat.usage.total_tokens
            }
          : null;
        usedCloudRu = true;
        cloudPathResolved = true;
        if (body.operation === "tender_analyze") {
          logger.info(
            {
              event: "tender_analyze_cloudru_shape",
              model,
              outputLen: outputText.length,
              startsWithBrace: outputText.trimStart().startsWith("{"),
              markdownFence: /```/.test(outputText)
            },
            "tender_analyze_cloudru_shape"
          );
        }
      } catch (cloudErr) {
        const elapsedMsCloud = Date.now() - startedAt;
        const up = serializeUpstreamError(cloudErr);
        logger.error(
          {
            event: "cloudru_failed",
            elapsedMs: elapsedMsCloud,
            jsonRetryAfterInvalidJson,
            transportRetries: cloudRuTransportMaxAttempts(),
            ...up,
            message: safeClientMessage(cloudErr),
            errName: cloudErr instanceof Error ? cloudErr.name : typeof cloudErr,
            code: cloudErr instanceof APIError ? cloudErr.code : undefined,
            requestId: cloudErr instanceof APIError ? cloudErr.request_id : undefined
          },
          "cloudru_failed"
        );

        if (cloudRuOpenAiFallbackEnabled() && openai) {
          logger.warn(
            {
              event: "cloudru_openai_fallback_start",
              elapsedMs: elapsedMsCloud,
              jsonRetryAfterInvalidJson
            },
            "cloudru_openai_fallback_start"
          );
          try {
            const r = await executeOpenAiResponses(openai, body);
            model = r.model;
            outputText = r.outputText;
            usage = r.usage;
            completion = r.completion;
            usedCloudRu = false;
            cloudPathResolved = true;
            logger.info(
              {
                event: "cloudru_openai_fallback_ok",
                model: r.model,
                elapsedMs: Date.now() - startedAt
              },
              "cloudru_openai_fallback_ok"
            );
          } catch (fbErr) {
            logger.error(
              {
                event: "cloudru_openai_fallback_fail",
                ...serializeUpstreamError(fbErr),
                message: safeClientMessage(fbErr)
              },
              "cloudru_openai_fallback_fail"
            );
            return json(res, 502, {
              error: "cloudru_failed",
              detail: safeClientMessage(cloudErr),
              fallbackOpenAiFailed: true,
              fallbackDetail: safeClientMessage(fbErr),
              elapsedMs: Date.now() - startedAt,
              jsonRetryAfterInvalidJson,
              ...up
            });
          }
        }

        if (!cloudPathResolved) {
          return json(res, 502, {
            error: "cloudru_failed",
            detail: safeClientMessage(cloudErr),
            elapsedMs: elapsedMsCloud,
            jsonRetryAfterInvalidJson,
            ...up
          });
        }
      }
    } else {
      if (!openai) {
        return json(res, 503, { error: "openai_not_configured" });
      }
      const r = await executeOpenAiResponses(openai, body);
      model = r.model;
      outputText = r.outputText;
      usage = r.usage;
      completion = r.completion;
    }

    const elapsedMs = Date.now() - startedAt;
    const openaiAfterCloudRuFallback = wantCloudRu && !usedCloudRu;
    logger.info(
      {
        operation: body.operation,
        sensitivity: body.sensitivity,
        modelRoute: body.modelRoute,
        model,
        elapsedMs,
        outputTokens: usedCloudRu
          ? (usage as { output_tokens?: number } | null)?.output_tokens
          : completion?.usage?.output_tokens,
        inputTokens: usedCloudRu
          ? (usage as { input_tokens?: number } | null)?.input_tokens
          : completion?.usage?.input_tokens,
        aiProvider: usedCloudRu ? "cloudru" : "openai",
        usedCloudRu,
        openaiAfterCloudRuFallback
      },
      "ai_call"
    );

    const responseBody: Record<string, unknown> = {
      model,
      outputText,
      usage
    };
    if (
      body.operation === "tender_analyze" &&
      tenderAnalyzeDeepDiagEnabled() &&
      completion
    ) {
      responseBody.analyzeDiagnostics = {
        ...buildTenderAnalyzeResponseDiag(completion, outputText),
        outputPreview: redactDiagnosticPreview(outputText.slice(0, 2000)),
        parseHint:
          "См. также лог ai-gateway tender_analyze_openai_shape; превью может содержать фрагменты закупки."
      };
    }

    return json(res, 200, responseBody);
  } catch (err) {
    if (err instanceof APIConnectionTimeoutError) {
      logger.error(
        {
          err,
          cause: err instanceof Error ? err.cause : undefined,
          event: "openai_connection_timeout",
          openaiTimeoutMs: OPENAI_HTTP_TIMEOUT_MS
        },
        "openai_connection_timeout"
      );
      return json(res, 502, {
        error: "openai_unreachable",
        message: safeClientMessage(err),
        hint:
          "Таймаут до api.openai.com. Увеличьте AI_GATEWAY_OPENAI_TIMEOUT_MS (сейчас по умолчанию 360000 мс) и AI_GATEWAY_REQUEST_TIMEOUT_MS в web (должен быть больше). Длинные ответы модели после увеличения max_output_tokens требуют запаса."
      });
    }
    if (err instanceof APIConnectionError) {
      logger.error(
        {
          err,
          cause: err instanceof Error ? err.cause : undefined,
          event: "openai_connection_error",
          openaiTimeoutMs: OPENAI_HTTP_TIMEOUT_MS,
          openaiNoProxy: openAiProxyExplicitlyDisabled()
        },
        "openai_connection_error"
      );
      return json(res, 502, {
        error: "openai_unreachable",
        message: safeClientMessage(err),
        hint:
          "Нет устойчивого TCP/TLS до api.openai.com (фаервол, DNS, VPN, прокси). Проверьте: curl -I https://api.openai.com из той же среды, где запущен ai-gateway. За корпоративным прокси задайте OPENAI_HTTPS_PROXY (логин в URL). Если OPENAI_NO_PROXY=1 — прокси для OpenAI отключён; уберите его, если выход в интернет только через прокси. См. docs/env.md."
      });
    }

    if (err instanceof APIError && typeof err.status === "number") {
      logger.error(
        {
          err,
          openaiStatus: err.status,
          code: err.code,
          requestId: err.request_id
        },
        "openai_upstream_http_error"
      );
      return json(res, 502, {
        error: "openai_upstream_error",
        openaiStatus: err.status,
        code: err.code ?? null,
        type: err.type ?? null,
        requestId: err.request_id ?? null,
        message: safeClientMessage(err)
      });
    }

    logger.error({ err }, "unhandled_error");
    return json(res, 500, {
      error: "internal_error",
      message: safeClientMessage(err)
    });
  }
});

/** 0.0.0.0 — чтобы к шлюзу стучался тот же хост из любого сетевого namespace (WSL/Docker/IPv4). */
server.listen(port, "0.0.0.0", () => {
  logger.info({ port, host: "0.0.0.0" }, "ai-gateway listening");
});

