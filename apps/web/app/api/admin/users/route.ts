import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSystemAdmin } from "@/lib/admin/require-admin";

export const runtime = "nodejs";

export async function GET() {
  const admin = await requireSystemAdmin();
  if ("error" in admin) return admin.error;

  const users = await prisma.user.findMany({
    orderBy: { createdAt: "desc" },
    take: 200,
    select: {
      id: true,
      email: true,
      isSystemAdmin: true,
      createdAt: true,
      _count: { select: { companyUsers: true } }
    }
  });

  return NextResponse.json({ users });
}
