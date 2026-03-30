/**
 * Читает JSON ответа шлюза из файла и гоняет тот же parse, что use case.
 * node ../ai-gateway/node_modules/tsx/dist/cli.mjs scripts/parse-gateway-response.mts /tmp/tendery-gateway-analyze-resp.json
 */
import fs from "node:fs";
import { parseTenderAiResult, traceTenderAiParseStages } from "../lib/ai/parse-model-json";

const path = process.argv[2];
if (!path) {
  console.error("usage: parse-gateway-response.mts <path-to-gateway-json>");
  process.exit(1);
}
const raw = fs.readFileSync(path, "utf8");
const j = JSON.parse(raw) as { outputText?: string; analyzeDiagnostics?: unknown };
const text = j.outputText ?? "";
console.log(
  JSON.stringify(
    {
      trace: traceTenderAiParseStages(text),
      parse: parseTenderAiResult(text),
      analyzeDiagnosticsFromGateway: j.analyzeDiagnostics ?? null
    },
    null,
    2
  )
);
