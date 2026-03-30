/**
 * Обнуляет счётчики UsageMonthly (разборы / черновики / общая квота) для всех компаний пользователя.
 *
 * Из корня репозитория:
 *   node --env-file=.env packages/db/scripts/reset-ai-usage-by-email.mjs
 *   node --env-file=.env packages/db/scripts/reset-ai-usage-by-email.mjs admin@example.com
 *   node --env-file=.env packages/db/scripts/reset-ai-usage-by-email.mjs admin@example.com 2026-03
 *
 * По умолчанию сбрасывается только текущий календарный месяц (YYYY-MM).
 * Флаг --all-months — обнулить все строки UsageMonthly по компаниям пользователя.
 *
 * Email по умолчанию: ADMIN_APP_EMAIL из корневого .env
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "../src/generated/prisma/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootEnv = resolve(__dirname, "../../../.env");

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

loadEnvFile(rootEnv);

if (process.env.NODE_ENV !== "production" && process.env.DATABASE_URL) {
  process.env.DATABASE_URL = process.env.DATABASE_URL.replace(
    /@localhost(?=[:/?#])/g,
    "@127.0.0.1"
  );
}

const argv = process.argv.slice(2);
const allMonths = argv.includes("--all-months");
const filtered = argv.filter((a) => a !== "--all-months");
const emailArg = filtered[0]?.trim().toLowerCase();
const yearMonthArg = filtered[1]?.trim();
const email = emailArg || process.env.ADMIN_APP_EMAIL?.trim().toLowerCase();

const currentYm = new Date().toISOString().slice(0, 7);
const yearMonth = yearMonthArg && /^\d{4}-\d{2}$/.test(yearMonthArg) ? yearMonthArg : currentYm;

if (!email) {
  console.error(
    "Укажите email: node packages/db/scripts/reset-ai-usage-by-email.mjs <email>\nили задайте ADMIN_APP_EMAIL в .env"
  );
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL не задан");
  process.exit(1);
}

const prisma = new PrismaClient();

try {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true }
  });
  if (!user) {
    console.error("Пользователь не найден:", email);
    process.exit(1);
  }

  const links = await prisma.companyUser.findMany({
    where: { userId: user.id },
    select: { companyId: true, company: { select: { name: true } } }
  });

  if (links.length === 0) {
    console.error("У пользователя нет привязки к компании (CompanyUser).");
    process.exit(1);
  }

  let total = 0;
  for (const { companyId, company } of links) {
    if (allMonths) {
      const r = await prisma.usageMonthly.updateMany({
        where: { companyId },
        data: {
          aiOperationsCount: 0,
          aiAnalyzeCount: 0,
          draftGenCount: 0
        }
      });
      total += r.count;
      console.log(
        `OK: ${user.email} → "${company.name}" (${companyId}): сброс всех месяцев, строк: ${r.count}`
      );
    } else {
      await prisma.usageMonthly.upsert({
        where: {
          companyId_yearMonth: { companyId, yearMonth }
        },
        create: {
          companyId,
          yearMonth,
          aiOperationsCount: 0,
          aiAnalyzeCount: 0,
          draftGenCount: 0
        },
        update: {
          aiOperationsCount: 0,
          aiAnalyzeCount: 0,
          draftGenCount: 0
        }
      });
      total += 1;
      console.log(
        `OK: ${user.email} → "${company.name}" (${companyId}): сброс месяца ${yearMonth}`
      );
    }
  }

  console.log(
    allMonths
      ? `Всего затронуто записей UsageMonthly: ${total}`
      : `Сброшен месяц ${yearMonth} для ${links.length} компан(ии/й) (${total} upsert).`
  );
} finally {
  await prisma.$disconnect();
}
