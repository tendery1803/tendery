import type { Response as OpenAIResponse } from "openai/resources/responses/responses";

/** Собираем видимый текст из message так же, как addOutputText в SDK (для сверки). */
export function rebuildOutputTextFromMessages(response: OpenAIResponse): string {
  const texts: string[] = [];
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const c of item.content) {
      if (c.type === "output_text") texts.push(c.text);
    }
  }
  return texts.join("");
}

export function collectRefusalPreview(response: OpenAIResponse, maxTotal = 800): string {
  const parts: string[] = [];
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const c of item.content) {
      if (c.type === "refusal" && c.refusal) parts.push(c.refusal);
    }
  }
  const joined = parts.join(" | ");
  return joined.length <= maxTotal ? joined : joined.slice(0, maxTotal);
}

export type TenderAnalyzeResponseDiag = {
  outputItemTypes: string[];
  messageContentTypes: string[];
  hasRefusal: boolean;
  refusalPreview?: string;
  incompleteDetails: unknown | null;
  responseError: unknown | null;
  outputTextLen: number;
  sdkOutputTextLen: number;
  rebuiltMatchesSdk: boolean;
  startsWithBrace: boolean;
  markdownFence: boolean;
};

export function buildTenderAnalyzeResponseDiag(
  response: OpenAIResponse,
  outputText: string
): TenderAnalyzeResponseDiag {
  const outputItemTypes = (response.output ?? []).map((o) => o.type);
  const messageContentTypes: string[] = [];
  let hasRefusal = false;
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const c of item.content) {
      messageContentTypes.push(c.type);
      if (c.type === "refusal") hasRefusal = true;
    }
  }
  const rebuilt = rebuildOutputTextFromMessages(response);
  return {
    outputItemTypes,
    messageContentTypes,
    hasRefusal,
    refusalPreview: hasRefusal ? collectRefusalPreview(response, 500) : undefined,
    incompleteDetails: response.incomplete_details ?? null,
    responseError: response.error ?? null,
    outputTextLen: outputText.length,
    sdkOutputTextLen: (response.output_text ?? "").length,
    rebuiltMatchesSdk: rebuilt === (response.output_text ?? ""),
    startsWithBrace: outputText.trimStart().startsWith("{"),
    markdownFence: /```/.test(outputText)
  };
}
