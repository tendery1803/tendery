import { z } from "zod";

const AnalyzeResponse = z.object({
  model: z.string(),
  outputText: z.string(),
  usage: z.unknown().nullable()
});

export type AnalyzeInput = {
  operation: "tender_analyze" | "draft_generate";
  sensitivity: "no_pii" | "maybe_pii" | "corp_sensitive" | "too_much_pii";
  modelRoute?: "nano" | "mini" | "escalate";
  prompt: string;
  maxOutputTokens?: number;
};

export class AiGatewayClient {
  constructor(
    private readonly opts: { baseUrl: string; apiKey: string }
  ) {}

  async analyze(input: AnalyzeInput): Promise<z.infer<typeof AnalyzeResponse>> {
    const res = await fetch(`${this.opts.baseUrl}/v1/analyze`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.apiKey}`
      },
      body: JSON.stringify(input)
    });

    const json = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(
        `AI gateway error ${res.status}: ${JSON.stringify(json)}`
      );
    }

    return AnalyzeResponse.parse(json);
  }
}

