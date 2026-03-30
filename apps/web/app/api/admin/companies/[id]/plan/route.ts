import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireSystemAdmin } from "@/lib/admin/require-admin";
import { writeAuditLog } from "@/lib/audit/log";

export const runtime = "nodejs";

const PatchBody = z.object({
  planCode: z.enum(["demo", "starter"])
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireSystemAdmin();
  if ("error" in admin) return admin.error;

  const companyId = (await params).id;
  const json = await req.json().catch(() => null);
  const parsed = PatchBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { id: true, name: true }
  });
  if (!company) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const prev = await prisma.companySubscription.findUnique({
    where: { companyId },
    select: { planCode: true }
  });

  await prisma.companySubscription.upsert({
    where: { companyId },
    create: { companyId, planCode: parsed.data.planCode },
    update: { planCode: parsed.data.planCode }
  });

  await writeAuditLog({
    actorUserId: admin.user.id,
    action: "admin.company_plan_set",
    targetType: "Company",
    targetId: companyId,
    meta: {
      companyName: company.name,
      from: prev?.planCode ?? null,
      to: parsed.data.planCode
    }
  });

  return NextResponse.json({ ok: true, planCode: parsed.data.planCode });
}
