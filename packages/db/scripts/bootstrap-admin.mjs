/**
 * Создаёт или обновляет пользователя-админа по ADMIN_APP_EMAIL / ADMIN_APP_PASSWORD из корневого .env.
 * Запуск из корня репозитория: pnpm bootstrap-admin
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "../src/generated/prisma/index.js";
import argon2 from "argon2";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function loadEnvFile(p) {
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

loadEnvFile(resolve(repoRoot, ".env"));

const email = process.env.ADMIN_APP_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_APP_PASSWORD;
if (!email || !password) {
  console.error(
    "Задайте ADMIN_APP_EMAIL и ADMIN_APP_PASSWORD в корневом .env"
  );
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("В .env отсутствует DATABASE_URL");
  process.exit(1);
}

const prisma = new PrismaClient();
try {
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, passwordHash, isSystemAdmin: true },
    update: { passwordHash, isSystemAdmin: true }
  });
  console.log("OK:", user.email, "isSystemAdmin=", user.isSystemAdmin);
} finally {
  await prisma.$disconnect();
}
