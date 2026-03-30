import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireUser } from "@/lib/auth/require-user";
import { getCurrentCompany } from "@/lib/auth/company-scope";

export const runtime = "nodejs";

const CreateDocumentBody = z.object({
  type: z.enum([
    "charter",
    "extract_egrul",
    "company_card",
    "power_of_attorney",
    "license",
    "certificate",
    "other"
  ]),
  title: z.string().min(2).max(200),
  expiresAt: z.string().datetime().optional().nullable()
});

export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const current = await getCurrentCompany(user);
  if (!current) return NextResponse.json({ error: "no_company" }, { status: 409 });

  const docs = await prisma.companyDocument.findMany({
    where: { companyId: current.companyId },
    orderBy: { updatedAt: "desc" },
    include: {
      versions: { orderBy: { version: "desc" }, take: 1 }
    }
  });

  return NextResponse.json({ documents: docs });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const current = await getCurrentCompany(user);
  if (!current) return NextResponse.json({ error: "no_company" }, { status: 409 });

  const json = await req.json().catch(() => null);
  const parsed = CreateDocumentBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }

  const doc = await prisma.companyDocument.create({
    data: {
      companyId: current.companyId,
      type: parsed.data.type,
      title: parsed.data.title,
      expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null
    }
  });

  return NextResponse.json({ ok: true, document: doc });
}

