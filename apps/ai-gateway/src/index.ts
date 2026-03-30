import http from "node:http";
import { z } from "zod";
import { HttpsProxyAgent } from "https-proxy-agent";
import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError
} from "openai";
import pino from "pino";
import { TENDER_ANALYZE_RESPONSE_JSON_SCHEMA } from "./tender-analyze-schema.js";
import {
  buildTenderAnalyzeResponseDiag,
  rebuildOutputTextFromMessages
} from "./analyze-response-diagnostics.js";
import { redactDiagnosticPreview, redactSecrets } from "./pii-redact.js";

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
      return json(res, 200, { ok: true });
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

    if (!openai) {
      return json(res, 503, { error: "openai_not_configured" });
    }

    const model = routeModel(body.modelRoute);
    const startedAt = Date.now();

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

    /**
     * Разбор закупки: strict JSON Schema (Structured Outputs), см. tender-analyze-schema.ts.
     * Не json_object — чтобы форма совпадала с контрактом web и реже обрывалась «почти JSON».
     */
    const completion = await openai.responses.create({
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
                schema: structuredClone(
                  TENDER_ANALYZE_RESPONSE_JSON_SCHEMA
                ) as Record<string, unknown>
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

    const elapsedMs = Date.now() - startedAt;
    logger.info(
      {
        operation: body.operation,
        sensitivity: body.sensitivity,
        modelRoute: body.modelRoute,
        model,
        elapsedMs,
        outputTokens: completion.usage?.output_tokens,
        inputTokens: completion.usage?.input_tokens
      },
      "ai_call"
    );

    const responseBody: Record<string, unknown> = {
      model,
      outputText,
      usage: completion.usage ?? null
    };
    if (body.operation === "tender_analyze" && tenderAnalyzeDeepDiagEnabled()) {
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

