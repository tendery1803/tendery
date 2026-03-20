import { TenderAiParseResultSchema, type TenderAiParseResult } from "@tendery/contracts";

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

export function parseTenderAiResult(outputText: string):
  | { ok: true; data: TenderAiParseResult }
  | { ok: false; error: string } {
  const raw = stripCodeFence(outputText);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: "json_parse_failed" };
  }
  const parsed = TenderAiParseResultSchema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: "schema_mismatch" };
  }
  return { ok: true, data: parsed.data };
}
