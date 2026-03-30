import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Читает корневой `.env` монорепозитория и применяет к `process.env`.
 * Значения из файла перезаписывают уже заданные переменные — иначе Next/оболочка
 * могли подставить устаревший `DATABASE_URL`, а корневой файл игнорировался.
 */
export function applyMonorepoRootEnv(fromImportMetaUrl: string) {
  const here = path.dirname(fileURLToPath(fromImportMetaUrl));
  const candidates = [
    path.resolve(here, "..", "..", ".env"),
    path.resolve(here, "..", "..", "..", ".env"),
    path.resolve(process.cwd(), "..", "..", ".env"),
    path.resolve(process.cwd(), ".env"),
  ];
  const rootEnv = candidates.find((p) => existsSync(p));
  if (!rootEnv) return;

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
