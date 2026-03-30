/**
 * Загружает корневой `.env` монорепозитория и запускает Prisma CLI.
 * Без этого `pnpm -C packages/db prisma migrate deploy` часто идёт без DATABASE_URL
 * (файл лежит в корне репозитория, а не в packages/db).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgDbDir = path.resolve(__dirname, "..");
const rootEnv = path.resolve(__dirname, "../../../.env");

if (existsSync(rootEnv)) {
  for (const line of readFileSync(rootEnv, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let value = t.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

if (process.env.NODE_ENV !== "production" && process.env.DATABASE_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_URL.replace(
    /@localhost(?=[:/?#])/g,
    "@127.0.0.1"
  );
}

const prismaCli = path.join(pkgDbDir, "node_modules", "prisma", "build", "index.js");
const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: node with-root-env.mjs <prisma-args…>  e.g. migrate deploy");
  process.exit(1);
}

const r = spawnSync(process.execPath, [prismaCli, ...args], {
  cwd: pkgDbDir,
  stdio: "inherit",
  env: process.env
});

process.exit(r.status ?? 1);
