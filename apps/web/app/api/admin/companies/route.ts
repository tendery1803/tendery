import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSystemAdmin } from "@/lib/admin/require-admin";

export const runtime = "nodejs";

export async function GET() {
  const admin = await requireSystemAdmin();
  if ("error" in admin) return admin.error;

  const companies = await prisma.company.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      name: true,
      inn: true,
      aiExternalDisabled: true,
      createdAt: true,
      subscription: { select: { planCode: true } },
      _count: { select: { tenders: true, users: true } }
    }
  });

  return NextResponse.json({ companies });
}
