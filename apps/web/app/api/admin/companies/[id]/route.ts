import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireSystemAdmin } from "@/lib/admin/require-admin";
import { writeAuditLog } from "@/lib/audit/log";

export const runtime = "nodejs";

const PatchBody = z.object({
  aiExternalDisabled: z.boolean().optional()
});

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireSystemAdmin();
  if ("error" in admin) return admin.error;

  const { id } = await params;
  const json = await req.json().catch(() => null);
  const parsed = PatchBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  if (parsed.data.aiExternalDisabled === undefined) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const company = await prisma.company.update({
    where: { id },
    data: { aiExternalDisabled: parsed.data.aiExternalDisabled },
    select: { id: true, name: true, aiExternalDisabled: true }
  });

  await writeAuditLog({
    actorUserId: admin.user.id,
    action: "admin.company_ai_toggle",
    targetType: "Company",
    targetId: id,
    meta: { aiExternalDisabled: company.aiExternalDisabled }
  });

  return NextResponse.json({ ok: true, company });
}
