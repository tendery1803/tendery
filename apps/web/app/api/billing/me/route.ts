import { NextResponse } from "next/server";
import { Prisma } from "@tendery/db";
import { requireCompanyMember } from "@/lib/tenders/api-guard";
import {
  getMonthlyUsage,
  currentYearMonth,
  getEffectiveMonthlyAiOperationsLimit
} from "@/lib/billing/usage";
import { isStubBillingUpgradeEnabled, resolveBillingProviderDescriptor } from "@/lib/billing/billing-provider-runtime";
import {
  isRobokassaEnabled,
  robokassaReadyForCheckout,
  robokassaStarterPriceRub,
  robokassaUseTestMode
} from "@/lib/billing/robokassa/env";

export const runtime = "nodejs";

export async function GET() {
  try {
    const ctx = await requireCompanyMember();
    if ("error" in ctx) return ctx.error;

    const ym = currentYearMonth();
    const usage = await getMonthlyUsage(ctx.companyId, ym);
    const { planCode, limit: aiOpsLimit } = await getEffectiveMonthlyAiOperationsLimit(
      ctx.companyId,
      ctx.user.id
    );
    const desc = resolveBillingProviderDescriptor();

    const robokassaCheckoutAvailable =
      isRobokassaEnabled() &&
      robokassaReadyForCheckout() &&
      planCode === "demo";

    return NextResponse.json({
      planCode,
      yearMonth: ym,
      billingProvider: desc.kind,
      billingProviderLabel: desc.label,
      stubUpgradeAvailable:
        isStubBillingUpgradeEnabled() && planCode === "demo",
      robokassaCheckoutAvailable,
      robokassaTestMode: robokassaUseTestMode(),
      robokassaStarterPriceRub: robokassaStarterPriceRub(),
      usage: {
        aiOperationsCount: usage.aiOperationsCount,
        aiOperationsLimit: aiOpsLimit,
        aiAnalyzeCount: usage.aiAnalyzeCount,
        draftGenCount: usage.draftGenCount
      }
    });
  } catch (e) {
    console.error("[billing/me]", e);
    if (e instanceof Prisma.PrismaClientKnownRequestError) {
      if (e.code === "P2021" || e.code === "P2022") {
        return NextResponse.json({ error: "billing_schema_outdated" }, { status: 503 });
      }
    }
    if (e instanceof Prisma.PrismaClientInitializationError) {
      return NextResponse.json({ error: "server_error" }, { status: 503 });
    }
    return NextResponse.json({ error: "server_error" }, { status: 500 });
  }
}
