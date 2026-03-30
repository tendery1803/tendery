import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCompanyAdmin } from "@/lib/tenders/api-guard";
import { isStubBillingUpgradeEnabled } from "@/lib/billing/billing-provider-runtime";
import { writeAuditLog } from "@/lib/audit/log";

export const runtime = "nodejs";

/**
 * Демо-«оплата» Стартера без внешней кассы. Включается только при BILLING_PROVIDER=stub в .env.
 */
export async function POST() {
  if (!isStubBillingUpgradeEnabled()) {
    return NextResponse.json({ error: "billing_provider_not_stub" }, { status: 403 });
  }

  const ctx = await requireCompanyAdmin();
  if ("error" in ctx) return ctx.error;

  const sub = await prisma.companySubscription.findUnique({
    where: { companyId: ctx.companyId },
    select: { planCode: true }
  });
  if (sub?.planCode === "starter") {
    return NextResponse.json({ ok: true, planCode: "starter", already: true });
  }

  await prisma.companySubscription.upsert({
    where: { companyId: ctx.companyId },
    create: { companyId: ctx.companyId, planCode: "starter" },
    update: { planCode: "starter" }
  });

  await writeAuditLog({
    actorUserId: ctx.user.id,
    action: "billing.stub_upgrade_starter",
    targetType: "Company",
    targetId: ctx.companyId,
    meta: { via: "BILLING_PROVIDER=stub" }
  });

  return NextResponse.json({ ok: true, planCode: "starter" });
}
