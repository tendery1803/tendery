import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSystemAdmin } from "@/lib/admin/require-admin";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const admin = await requireSystemAdmin();
  if ("error" in admin) return admin.error;

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 200);

  const logs = await prisma.auditLog.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { actor: { select: { email: true } } }
  });

  return NextResponse.json({ logs });
}
