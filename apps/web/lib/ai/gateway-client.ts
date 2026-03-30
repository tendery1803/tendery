import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { URL } from "node:url";
import { AiGatewayClient } from "@tendery/integrations";
import "../load-root-env";

/**
 * В Node fetch часто резолвит `localhost` в ::1; шлюз может слушать только IPv4.
 * `ipv4first` + замена localhost→127.0.0.1 в URL снижает `TypeError: fetch failed`.
 */
if (typeof process !== "undefined" && process.versions?.node) {
  try {
    dns.setDefaultResultOrder("ipv4first");
  } catch {
    /* ignore */
  }
}

/**
 * Web → ai-gateway: undici даёт «Headers Timeout», т.к. шлюз отвечает только после OpenAI.
 * Свой http(s).request — ок, но без лимита запрос может висеть бесконечно → явный дедлайн.
 *
 * По умолчанию 420s: больше дедлайна OpenAI в ai-gateway (360s по умолчанию) + запас.
 */
const DEFAULT_GATEWAY_REQUEST_MS = 420_000;

function gatewayRequestTimeoutMs(): number {
  const raw = process.env.AI_GATEWAY_REQUEST_TIMEOUT_MS;
  if (raw == null || raw === "") return DEFAULT_GATEWAY_REQUEST_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 5_000 ? Math.floor(n) : DEFAULT_GATEWAY_REQUEST_MS;
}

/**
 * Глобальный `fetch` в Node (undici) ждёт заголовки ответа с коротким лимитом, а ai-gateway
 * шлёт ответ только после полного ответа OpenAI → «Headers Timeout Error».
 * Обходим через встроенный http(s): без отдельного лимита на «первые заголовки».
 */
function fetchViaNodeHttp(urlStr: string, init?: RequestInit): Promise<Response> {
  const TIMEOUT_MS = gatewayRequestTimeoutMs();
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const isHttps = u.protocol === "https:";
    const lib = isHttps ? https : http;
    const host = u.hostname === "localhost" ? "127.0.0.1" : u.hostname;
    const port = u.port ? Number(u.port) : isHttps ? 443 : 80;

    const h = new Headers(init?.headers ?? undefined);
    const headerObj: http.OutgoingHttpHeaders = {};
    h.forEach((v, k) => {
      headerObj[k] = v;
    });

    let done = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    let req!: http.ClientRequest;

    function clearDeadline() {
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
      }
    }

    function finish(err: Error): void;
    function finish(err: undefined, res: Response): void;
    function finish(err: Error | undefined, res?: Response): void {
      clearDeadline();
      if (done) return;
      done = true;
      if (err) reject(err);
      else resolve(res!);
    }

    deadlineTimer = setTimeout(() => {
      finish(
        new Error(
          `AI gateway: превышено время ожидания ответа (${TIMEOUT_MS} мс). Проверьте, что ai-gateway запущен и отвечает; при необходимости увеличьте AI_GATEWAY_REQUEST_TIMEOUT_MS.`
        )
      );
      req?.destroy();
    }, TIMEOUT_MS);

    req = lib.request(
      {
        protocol: u.protocol,
        hostname: host,
        port,
        path: `${u.pathname}${u.search}`,
        method: init?.method ?? "GET",
        headers: headerObj,
        family: 4
      },
      (inc) => {
        clearDeadline();
        const chunks: Buffer[] = [];
        inc.on("data", (c) => chunks.push(Buffer.from(c)));
        inc.on("end", () => {
          const body = Buffer.concat(chunks);
          const rh = new Headers();
          for (const [k, v] of Object.entries(inc.headers)) {
            if (v == null) continue;
            if (Array.isArray(v)) {
              for (const x of v) rh.append(k, x);
            } else {
              rh.append(k, v);
            }
          }
          finish(
            undefined,
            new Response(body, {
              status: inc.statusCode ?? 0,
              statusText: inc.statusMessage ?? "",
              headers: rh
            })
          );
        });
        inc.on("error", (e) =>
          finish(e instanceof Error ? e : new Error(String(e)))
        );
      }
    );

    req.on("error", (e) =>
      finish(e instanceof Error ? e : new Error(String(e)))
    );

    const b = init?.body;
    if (b != null) {
      if (typeof b === "string") {
        req.write(b);
      } else if (b instanceof Uint8Array) {
        req.write(b);
      } else {
        clearDeadline();
        done = true;
        reject(new Error("ai_gateway_fetch: unsupported body type"));
        return;
      }
    }
    req.end();
  });
}

function normalizeGatewayBaseUrl(raw: string): string {
  const u = raw.trim().replace(/\/+$/, "");
  return u.replace(
    /^(https?:\/\/)localhost(?=:|\/|\?|#|$)/i,
    (_full: string, proto: string) => `${proto}127.0.0.1`
  );
}

export function getAiGatewayClient(): AiGatewayClient {
  const baseUrl = process.env.AI_GATEWAY_BASE_URL;
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error("AI_GATEWAY_BASE_URL / AI_GATEWAY_API_KEY не заданы");
  }
  return new AiGatewayClient({
    baseUrl: normalizeGatewayBaseUrl(baseUrl),
    apiKey,
    fetchFn: (input, init) =>
      fetchViaNodeHttp(input instanceof URL ? input.href : String(input), init)
  });
}
