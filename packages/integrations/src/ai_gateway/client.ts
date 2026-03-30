import { z } from "zod";

/** Опционально от ai-gateway при AI_PARSE_DIAGNOSTIC_SNIPPET / AI_TENDER_ANALYZE_DIAG (только tender_analyze). */
const AnalyzeResponse = z.object({
  model: z.string(),
  outputText: z.string(),
  usage: z.unknown().nullable(),
  analyzeDiagnostics: z.any().optional()
});

export type AnalyzeInput = {
  operation: "tender_analyze" | "draft_generate";
  sensitivity: "no_pii" | "maybe_pii" | "corp_sensitive" | "too_much_pii";
  modelRoute?: "nano" | "mini" | "escalate";
  prompt: string;
  maxOutputTokens?: number;
};

export type AiGatewayClientOptions = {
  baseUrl: string;
  apiKey: string;
  /**
   * Например undici + Agent({ connect: { family: 4 } }) в Node, чтобы не упираться в IPv6 ::1
   * при обращении к шлюзу на localhost/127.0.0.1.
   */
  fetchFn?: (input: string | URL, init?: RequestInit) => Promise<Response>;
};

export class AiGatewayClient {
  constructor(private readonly opts: AiGatewayClientOptions) {}

  async analyze(input: AnalyzeInput): Promise<z.infer<typeof AnalyzeResponse>> {
    const doFetch =
      this.opts.fetchFn ??
      ((url: string | URL, init?: RequestInit) => globalThis.fetch(url, init));

    const url = `${this.opts.baseUrl}/v1/analyze`;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.opts.apiKey}`
        },
        body: JSON.stringify(input)
      });
    } catch (e) {
      let msg = e instanceof Error ? e.message : String(e);
      if (e instanceof Error && e.cause != null) {
        const c = e.cause;
        msg += ` | cause: ${c instanceof Error ? c.message : String(c)}`;
        if (c instanceof Error && c.cause != null) {
          const inner = c.cause;
          msg += ` | ${inner instanceof Error ? inner.message : String(inner)}`;
        }
      }
      throw new Error(msg);
    }

    const json = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(
        `AI gateway error ${res.status}: ${JSON.stringify(json)}`
      );
    }

    return AnalyzeResponse.parse(json);
  }
}

