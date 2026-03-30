import { NextResponse } from "next/server";
import { Prisma } from "@tendery/db";
import { prisma } from "@/lib/db";
import { requireCompanyAdmin } from "@/lib/tenders/api-guard";
import { ensureCompanySubscription } from "@/lib/billing/usage";
import {
  assertRobokassaConfiguredForCreate,
  isRobokassaEnabled,
  robokassaFailUrl,
  robokassaStarterPriceRub,
  robokassaSuccessUrl,
  robokassaUseTestMode
} from "@/lib/billing/robokassa/env";
import { buildRobokassaPaymentUrl } from "@/lib/billing/robokassa/build-url";

export const runtime = "nodejs";

/**
 * Создаёт счёт (Payment) и URL перехода в Robokassa. Только админ компании.
 */
export async function POST() {
  if (!isRobokassaEnabled()) {
    return NextResponse.json({ error: "robokassa_disabled" }, { status: 403 });
  }

  try {
    assertRobokassaConfiguredForCreate();
  } catch {
    return NextResponse.json({ error: "robokassa_config_incomplete" }, { status: 503 });
  }

  const ctx = await requireCompanyAdmin();
  if ("error" in ctx) return ctx.error;

  const { planCode } = await ensureCompanySubscription(ctx.companyId);
  if (planCode === "starter") {
    return NextResponse.json({ error: "already_starter" }, { status: 409 });
  }

  const outSum = robokassaStarterPriceRub();
  const amount = new Prisma.Decimal(outSum);

  const payment = await prisma.payment.create({
    data: {
      companyId: ctx.companyId,
      userId: ctx.user.id,
      planTarget: "starter",
      amountExpected: amount,
      testMode: robokassaUseTestMode(),
      status: "pending"
    },
    select: { invId: true }
  });

  const description = `Тариф Стартер Tendery (счёт ${payment.invId})`;
  const paymentUrl = buildRobokassaPaymentUrl({
    outSum,
    invId: payment.invId,
    description,
    successUrl: robokassaSuccessUrl(),
    failUrl: robokassaFailUrl()
  });

  return NextResponse.json({
    paymentUrl,
    invId: payment.invId,
    outSum,
    testMode: robokassaUseTestMode()
  });
}
