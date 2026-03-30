/**
 * DEV-ONLY лаунчер: полная логика в gateway-tender-analyze-e2e.ts (корпус прогоняется через maskPiiForAi).
 * Не использовать как доказательство безопасности боевого потока — только web → buildMinimized… → maskPiiForAi.
 *
 * Запуск из корня: AI_PARSE_DIAGNOSTIC_SNIPPET=true node --env-file=.env scripts/gateway-tender-analyze-e2e.mjs
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ts = path.join(root, "scripts", "gateway-tender-analyze-e2e.ts");
const r = spawnSync(
  "pnpm",
  ["-C", path.join(root, "apps", "ai-gateway"), "exec", "tsx", ts],
  {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    shell: false
  }
);
process.exit(r.status ?? 1);
