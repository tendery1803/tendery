export type PlanCode = "demo" | "starter";

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function monthlyAiAnalyzeLimit(plan: PlanCode): number {
  if (plan === "starter") {
    return intEnv("BILLING_STARTER_AI_PER_MONTH", 500);
  }
  return intEnv("BILLING_DEMO_AI_PER_MONTH", 20);
}

export function monthlyDraftLimit(plan: PlanCode): number {
  if (plan === "starter") {
    return intEnv("BILLING_STARTER_DRAFT_PER_MONTH", 200);
  }
  return intEnv("BILLING_DEMO_DRAFT_PER_MONTH", 10);
}
