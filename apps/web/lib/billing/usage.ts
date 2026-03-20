import { prisma } from "@/lib/db";
import { monthlyAiAnalyzeLimit, monthlyDraftLimit, type PlanCode } from "./limits";

export function currentYearMonth(): string {
  return new Date().toISOString().slice(0, 7);
}

export async function ensureCompanySubscription(companyId: string): Promise<{
  planCode: PlanCode;
}> {
  const sub = await prisma.companySubscription.upsert({
    where: { companyId },
    create: { companyId, planCode: "demo" },
    update: {},
    select: { planCode: true }
  });
  return { planCode: sub.planCode as PlanCode };
}

export async function getMonthlyUsage(companyId: string, yearMonth = currentYearMonth()) {
  return prisma.usageMonthly.upsert({
    where: {
      companyId_yearMonth: { companyId, yearMonth }
    },
    create: { companyId, yearMonth },
    update: {},
    select: { aiAnalyzeCount: true, draftGenCount: true, yearMonth: true }
  });
}

export async function incrementAiAnalyze(companyId: string): Promise<void> {
  const ym = currentYearMonth();
  await prisma.usageMonthly.upsert({
    where: { companyId_yearMonth: { companyId, yearMonth: ym } },
    create: { companyId, yearMonth: ym, aiAnalyzeCount: 1 },
    update: { aiAnalyzeCount: { increment: 1 } }
  });
}

export async function incrementDraftGen(companyId: string): Promise<void> {
  const ym = currentYearMonth();
  await prisma.usageMonthly.upsert({
    where: { companyId_yearMonth: { companyId, yearMonth: ym } },
    create: { companyId, yearMonth: ym, draftGenCount: 1 },
    update: { draftGenCount: { increment: 1 } }
  });
}

export async function assertCanAiAnalyze(companyId: string): Promise<
  | { ok: true; planCode: PlanCode; used: number; limit: number }
  | { ok: false; reason: "limit_exceeded"; limit: number; used: number }
> {
  const { planCode } = await ensureCompanySubscription(companyId);
  const limit = monthlyAiAnalyzeLimit(planCode);
  const row = await getMonthlyUsage(companyId);
  const used = row.aiAnalyzeCount;
  if (used >= limit) {
    return { ok: false, reason: "limit_exceeded", limit, used };
  }
  return { ok: true, planCode, used, limit };
}

export async function assertCanDraft(companyId: string): Promise<
  | { ok: true; planCode: PlanCode; used: number; limit: number }
  | { ok: false; reason: "limit_exceeded"; limit: number; used: number }
> {
  const { planCode } = await ensureCompanySubscription(companyId);
  const limit = monthlyDraftLimit(planCode);
  const row = await getMonthlyUsage(companyId);
  const used = row.draftGenCount;
  if (used >= limit) {
    return { ok: false, reason: "limit_exceeded", limit, used };
  }
  return { ok: true, planCode, used, limit };
}
