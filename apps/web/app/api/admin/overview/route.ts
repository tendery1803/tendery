import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSystemAdmin } from "@/lib/admin/require-admin";

export const runtime = "nodejs";

export async function GET() {
  const admin = await requireSystemAdmin();
  if ("error" in admin) return admin.error;

  const [users, companies, tenders, audit24h] = await Promise.all([
    prisma.user.count(),
    prisma.company.count(),
    prisma.tender.count(),
    prisma.auditLog.count({
      where: { createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } }
    })
  ]);

  return NextResponse.json({ users, companies, tenders, auditLogsLast24h: audit24h });
}
