import { prisma } from "@/lib/db";
import {
  monthlyAiOperationsLimit,
  monthlyAiOperationsLimitForBillingAdmin,
  type PlanCode
} from "./limits";

async function userHasBillingAdminAiQuota(userId: string): Promise<boolean> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, isSystemAdmin: true }
  });
  if (!u) return false;
  if (u.isSystemAdmin) return true;
  const envList = (process.env.SYSTEM_ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return envList.includes(u.email.toLowerCase());
}

async function effectiveMonthlyAiOperationsLimit(
  companyId: string,
  actorUserId?: string
): Promise<{ planCode: PlanCode; limit: number }> {
  const { planCode } = await ensureCompanySubscription(companyId);
  const base = monthlyAiOperationsLimit(planCode);
  if (actorUserId && (await userHasBillingAdminAiQuota(actorUserId))) {
    return { planCode, limit: monthlyAiOperationsLimitForBillingAdmin() };
  }
  return { planCode, limit: base };
}

/** Лимит для экрана «Тариф и лимиты» и согласованности с assertCanAiOperation. */
export async function getEffectiveMonthlyAiOperationsLimit(
  companyId: string,
  actorUserId: string
): Promise<{ planCode: PlanCode; limit: number }> {
  return effectiveMonthlyAiOperationsLimit(companyId, actorUserId);
}

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
    select: {
      aiOperationsCount: true,
      aiAnalyzeCount: true,
      draftGenCount: true,
      yearMonth: true
    }
  });
}

/** После успешного AI-разбора закупки: один инкремент на весь сценарий (включая внутренние проходы по товарам). */
export async function recordAiOperationAnalyze(companyId: string): Promise<void> {
  const ym = currentYearMonth();
  await prisma.usageMonthly.upsert({
    where: { companyId_yearMonth: { companyId, yearMonth: ym } },
    create: {
      companyId,
      yearMonth: ym,
      aiOperationsCount: 1,
      aiAnalyzeCount: 1
    },
    update: {
      aiOperationsCount: { increment: 1 },
      aiAnalyzeCount: { increment: 1 }
    }
  });
}

/** После успешной генерации черновика (одна AI-операция по ТЗ). */
export async function recordAiOperationDraft(companyId: string): Promise<void> {
  const ym = currentYearMonth();
  await prisma.usageMonthly.upsert({
    where: { companyId_yearMonth: { companyId, yearMonth: ym } },
    create: {
      companyId,
      yearMonth: ym,
      aiOperationsCount: 1,
      draftGenCount: 1
    },
    update: {
      aiOperationsCount: { increment: 1 },
      draftGenCount: { increment: 1 }
    }
  });
}

/** @deprecated используйте recordAiOperationAnalyze */
export async function incrementAiAnalyze(companyId: string): Promise<void> {
  await recordAiOperationAnalyze(companyId);
}

/** @deprecated используйте recordAiOperationDraft */
export async function incrementDraftGen(companyId: string): Promise<void> {
  await recordAiOperationDraft(companyId);
}

export async function assertCanAiOperation(
  companyId: string,
  options?: { actorUserId?: string }
): Promise<
  | { ok: true; planCode: PlanCode; used: number; limit: number }
  | { ok: false; reason: "limit_exceeded"; limit: number; used: number }
> {
  const { planCode, limit } = await effectiveMonthlyAiOperationsLimit(
    companyId,
    options?.actorUserId
  );
  const row = await getMonthlyUsage(companyId);
  const used = row.aiOperationsCount;
  if (used >= limit) {
    return { ok: false, reason: "limit_exceeded", limit, used };
  }
  return { ok: true, planCode, used, limit };
}

/** @deprecated используйте assertCanAiOperation */
export async function assertCanAiAnalyze(companyId: string) {
  return assertCanAiOperation(companyId);
}

/** @deprecated используйте assertCanAiOperation */
export async function assertCanDraft(companyId: string) {
  return assertCanAiOperation(companyId);
}
