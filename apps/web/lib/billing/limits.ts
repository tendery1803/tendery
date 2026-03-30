import type { BillingPlanCode as CorePlanCode } from "@tendery/core";

export type PlanCode = CorePlanCode;

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Месячный лимит AI-операций для пользователя с правами системного админа
 * (`User.isSystemAdmin` или email в `SYSTEM_ADMIN_EMAILS`), независимо от тарифа компании.
 */
export function monthlyAiOperationsLimitForBillingAdmin(): number {
  return intEnv("BILLING_ADMIN_AI_OPS_PER_MONTH", 100);
}

/**
 * Единый месячный лимит AI-операций (ТЗ п. 18.1–18.2): разбор закупки и генерация черновика
 * каждые списывают одну операцию из этой квоты.
 *
 * Демо: 3 операции/мес (ТЗ). Стартер: 30 операций/мес (ТЗ).
 */
export function monthlyAiOperationsLimit(plan: PlanCode): number {
  if (plan === "starter") {
    return intEnv("BILLING_STARTER_AI_OPS_PER_MONTH", 30);
  }
  return intEnv("BILLING_DEMO_AI_OPS_PER_MONTH", 3);
}

/** @deprecated Используйте monthlyAiOperationsLimit — отдельных лимитов разбор/черновик по ТЗ нет. */
export function monthlyAiAnalyzeLimit(plan: PlanCode): number {
  return monthlyAiOperationsLimit(plan);
}

/** @deprecated Используйте monthlyAiOperationsLimit. */
export function monthlyDraftLimit(plan: PlanCode): number {
  return monthlyAiOperationsLimit(plan);
}
