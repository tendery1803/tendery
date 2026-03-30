/**
 * Выставить тариф компании в БД (без входа в админку).
 *
 * Использование из корня репозитория:
 *   node --env-file=.env packages/db/scripts/set-company-plan.mjs starter --exhausted-demo
 *   node --env-file=.env packages/db/scripts/set-company-plan.mjs starter <companyId>
 *
 * --exhausted-demo — все компании с plan demo, у которых за текущий месяц
 *   aiOperationsCount >= лимита демо (BILLING_DEMO_AI_OPS_PER_MONTH или 3), переводятся на starter.
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

const plan = process.argv[2];
const arg3 = process.argv[3];

if (plan !== "starter") {
  console.error(
    "Usage: node packages/db/scripts/set-company-plan.mjs starter --exhausted-demo\n       node packages/db/scripts/set-company-plan.mjs starter <companyId>"
  );
  process.exit(1);
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL не задан (нужен корневой .env)");
  process.exit(1);
}

function demoLimit() {
  const raw = process.env.BILLING_DEMO_AI_OPS_PER_MONTH;
  if (!raw) return 3;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 3;
}

const prisma = new PrismaClient();

try {
  const yearMonth = new Date().toISOString().slice(0, 7);

  if (arg3 === "--exhausted-demo") {
    const limit = demoLimit();
    const subs = await prisma.companySubscription.findMany({
      where: { planCode: "demo" },
      select: { companyId: true }
    });
    let upgraded = 0;
    for (const { companyId } of subs) {
      const u = await prisma.usageMonthly.findUnique({
        where: {
          companyId_yearMonth: { companyId, yearMonth }
        },
        select: { aiOperationsCount: true }
      });
      const used = u?.aiOperationsCount ?? 0;
      if (used < limit) continue;
      await prisma.companySubscription.update({
        where: { companyId },
        data: { planCode: "starter" }
      });
      console.log(
        `OK: company ${companyId} demo → starter (usage ${yearMonth}: ${used}/${limit})`
      );
      upgraded += 1;
    }
    if (upgraded === 0) {
      console.log(
        `Нет компаний demo с использованием ≥ ${limit} за ${yearMonth}. Проверьте companyId вручную.`
      );
    }
    process.exit(0);
  }

  if (!arg3 || arg3.startsWith("-")) {
    console.error("Укажите companyId или флаг --exhausted-demo");
    process.exit(1);
  }

  const companyId = arg3;
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { id: true, name: true }
  });
  if (!company) {
    console.error("Компания не найдена:", companyId);
    process.exit(1);
  }
  await prisma.companySubscription.upsert({
    where: { companyId },
    create: { companyId, planCode: "starter" },
    update: { planCode: "starter" }
  });
  console.log(`OK: ${company.name} (${companyId}) → starter`);
} finally {
  await prisma.$disconnect();
}
