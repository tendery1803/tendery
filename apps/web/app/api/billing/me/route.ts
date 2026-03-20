import { NextResponse } from "next/server";
import { requireCompanyMember } from "@/lib/tenders/api-guard";
import {
  ensureCompanySubscription,
  getMonthlyUsage,
  currentYearMonth
} from "@/lib/billing/usage";
import { monthlyAiAnalyzeLimit, monthlyDraftLimit } from "@/lib/billing/limits";

export const runtime = "nodejs";

export async function GET() {
  const ctx = await requireCompanyMember();
  if ("error" in ctx) return ctx.error;

  const { planCode } = await ensureCompanySubscription(ctx.companyId);
  const ym = currentYearMonth();
  const usage = await getMonthlyUsage(ctx.companyId, ym);

  return NextResponse.json({
    planCode,
    yearMonth: ym,
    usage: {
      aiAnalyzeCount: usage.aiAnalyzeCount,
      draftGenCount: usage.draftGenCount,
      aiAnalyzeLimit: monthlyAiAnalyzeLimit(planCode),
      draftGenLimit: monthlyDraftLimit(planCode)
    }
  });
}
