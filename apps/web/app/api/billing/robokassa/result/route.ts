import { NextResponse } from "next/server";
import { Prisma } from "@tendery/db";
import { prisma } from "@/lib/db";
import {
  assertRobokassaConfiguredForResult,
  isRobokassaEnabled,
  robokassaPassword2,
  robokassaUseTestMode
} from "@/lib/billing/robokassa/env";
import { verifyRobokassaResultSignature } from "@/lib/billing/robokassa/sign";
import { writeAuditLog } from "@/lib/audit/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function amountsMatch(expected: Prisma.Decimal, outSumRaw: string): boolean {
  const received = Number.parseFloat((outSumRaw ?? "").replace(",", "."));
  if (!Number.isFinite(received)) return false;
  const exp = expected.toNumber();
  return Math.abs(received - exp) < 0.009;
}

/**
 * Result URL (POST от Robokassa). Только подпись и БД — источник истины для активации тарифа.
 */
export async function POST(req: Request) {
  if (!isRobokassaEnabled()) {
    return new NextResponse("DISABLED", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  try {
    assertRobokassaConfiguredForResult();
  } catch {
    return new NextResponse("CONFIG", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  let outSum: string;
  let invIdStr: string;
  let signatureValue: string;

  try {
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("application/x-www-form-urlencoded")) {
      const text = await req.text();
      const p = new URLSearchParams(text);
      outSum = (p.get("OutSum") ?? "").trim();
      invIdStr = (p.get("InvId") ?? "").trim();
      signatureValue = (p.get("SignatureValue") ?? p.get("crc") ?? "").trim();
    } else {
      const fd = await req.formData();
      outSum = String(fd.get("OutSum") ?? "").trim();
      invIdStr = String(fd.get("InvId") ?? "").trim();
      signatureValue = String(fd.get("SignatureValue") ?? fd.get("crc") ?? "").trim();
    }
  } catch {
    return new NextResponse("BAD_BODY", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  if (!outSum || !invIdStr || !signatureValue) {
    // eslint-disable-next-line no-console
    console.warn("[robokassa/result] missing fields");
    return new NextResponse("BAD_FIELDS", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  const invId = Number.parseInt(invIdStr, 10);
  if (!Number.isFinite(invId)) {
    return new NextResponse("BAD_INV", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  const pass2 = robokassaPassword2();
  if (!pass2) {
    return new NextResponse("CONFIG", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  if (!verifyRobokassaResultSignature(outSum, invIdStr, pass2, signatureValue)) {
    // eslint-disable-next-line no-console
    console.warn("[robokassa/result] bad signature", { invId, outSumLen: outSum.length });
    return new NextResponse("BAD_SIGN", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  const payment = await prisma.payment.findUnique({
    where: { invId },
    select: {
      id: true,
      companyId: true,
      userId: true,
      planTarget: true,
      amountExpected: true,
      status: true,
      testMode: true
    }
  });

  if (!payment) {
    // eslint-disable-next-line no-console
    console.warn("[robokassa/result] unknown invId", { invId });
    return new NextResponse("UNKNOWN", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  const testNow = robokassaUseTestMode();
  if (payment.testMode !== testNow) {
    // eslint-disable-next-line no-console
    console.warn("[robokassa/result] test mode mismatch", { invId, paymentTest: payment.testMode, envTest: testNow });
    return new NextResponse("MODE_MISMATCH", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  if (!amountsMatch(payment.amountExpected, outSum)) {
    // eslint-disable-next-line no-console
    console.warn("[robokassa/result] amount mismatch", { invId, outSum });
    return new NextResponse("BAD_AMOUNT", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  if (payment.status === "paid") {
    return new NextResponse(`OK${invId}`, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8" }
    });
  }

  if (payment.status === "failed") {
    return new NextResponse("FAILED_STATE", { status: 409, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  let activatedSubscription = false;

  try {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.payment.updateMany({
        where: { invId, status: "pending" },
        data: { status: "paid", paidAt: new Date() }
      });
      if (updated.count === 1) {
        activatedSubscription = true;
        await tx.companySubscription.upsert({
          where: { companyId: payment.companyId },
          create: { companyId: payment.companyId, planCode: payment.planTarget },
          update: { planCode: payment.planTarget }
        });
      }
    });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error("[robokassa/result] transaction error", e instanceof Error ? e.message : e);
    return new NextResponse("ERR", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  const fresh = await prisma.payment.findUnique({
    where: { invId },
    select: { status: true }
  });
  if (fresh?.status !== "paid") {
    return new NextResponse("NOT_PAID", { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }

  if (activatedSubscription) {
    await writeAuditLog({
      actorUserId: null,
      action: "billing.robokassa_paid",
      targetType: "Company",
      targetId: payment.companyId,
      meta: {
        invId,
        planTarget: payment.planTarget,
        testMode: payment.testMode
      }
    });
  }

  return new NextResponse(`OK${invId}`, {
    status: 200,
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}
