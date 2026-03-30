import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireSystemAdmin } from "@/lib/admin/require-admin";

export const runtime = "nodejs";

const Query = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  status: z
    .enum([
      "pending",
      "queued",
      "processing",
      "done",
      "failed",
      "retry_scheduled",
      "canceled"
    ])
    .optional()
});

export async function GET(req: Request) {
  const admin = await requireSystemAdmin();
  if ("error" in admin) return admin.error;

  const url = new URL(req.url);
  const parsed = Query.safeParse({
    limit: url.searchParams.get("limit") ?? undefined,
    status: url.searchParams.get("status") ?? undefined
  });
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const { limit, status } = parsed.data;

  const jobs = await prisma.backgroundJob.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      type: true,
      status: true,
      companyId: true,
      userId: true,
      entityType: true,
      entityId: true,
      error: true,
      createdAt: true,
      updatedAt: true
    }
  });

  return NextResponse.json({ jobs });
}
