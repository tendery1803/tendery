import http from "node:http";
import { z } from "zod";
import OpenAI from "openai";
import pino from "pino";

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

const openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;

const AnalyzeRequest = z.object({
  operation: z.enum(["tender_analyze", "draft_generate"]),
  sensitivity: z.enum(["no_pii", "maybe_pii", "corp_sensitive", "too_much_pii"]),
  modelRoute: z.enum(["nano", "mini", "escalate"]).default("mini"),
  prompt: z.string().min(1),
  maxOutputTokens: z.number().int().positive().max(4096).default(800)
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

    const parsedJson = JSON.parse(raw);
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

    const completion = await openai.responses.create({
      model,
      input: body.prompt,
      max_output_tokens: body.maxOutputTokens
    });

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

    return json(res, 200, {
      model,
      outputText: completion.output_text,
      usage: completion.usage ?? null
    });
  } catch (err) {
    logger.error({ err }, "unhandled_error");
    return json(res, 500, { error: "internal_error" });
  }
});

server.listen(port, () => {
  logger.info({ port }, "ai-gateway listening");
});

