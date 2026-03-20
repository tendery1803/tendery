import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireCompanyMember } from "@/lib/tenders/api-guard";

export const runtime = "nodejs";

const CreateTenderBody = z
  .object({
    title: z.string().min(1).max(300),
    description: z.string().max(8000).optional().nullable(),
    sourceType: z.enum(["manual", "url", "file_upload"]),
    sourceUrl: z.string().url().optional().nullable()
  })
  .superRefine((data, ctx) => {
    if (data.sourceType === "url" && !data.sourceUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "sourceUrl_required",
        path: ["sourceUrl"]
      });
    }
  });

export async function GET() {
  const ctx = await requireCompanyMember();
  if ("error" in ctx) return ctx.error;

  const tenders = await prisma.tender.findMany({
    where: { companyId: ctx.companyId },
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { files: true } }
    }
  });

  return NextResponse.json({ tenders });
}

export async function POST(req: Request) {
  const ctx = await requireCompanyMember();
  if ("error" in ctx) return ctx.error;

  const json = await req.json().catch(() => null);
  const parsed = CreateTenderBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const tender = await prisma.tender.create({
    data: {
      companyId: ctx.companyId,
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      sourceType: parsed.data.sourceType,
      sourceUrl: parsed.data.sourceUrl ?? null,
      status: "draft",
      createdByUserId: ctx.user.id
    }
  });

  return NextResponse.json({ ok: true, tender });
}
