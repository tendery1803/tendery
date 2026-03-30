import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCompanyMember, getTenderForCompany } from "@/lib/tenders/api-guard";
import { runGenerateTenderDraft } from "@/lib/use-cases/generate-tender-draft";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireCompanyMember();
  if ("error" in ctx) return ctx.error;
  const { id: tenderId } = await params;
  const tender = await getTenderForCompany(tenderId, ctx.companyId);
  if (!tender) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const draft = await prisma.tenderDraft.findUnique({ where: { tenderId } });
  return NextResponse.json({ draft });
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireCompanyMember();
  if ("error" in ctx) return ctx.error;
  const { id: tenderId } = await params;
  const tender = await getTenderForCompany(tenderId, ctx.companyId);
  if (!tender) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const result = await runGenerateTenderDraft(
    { user: ctx.user, companyId: ctx.companyId },
    tenderId
  );

  if (!result.ok) {
    return NextResponse.json(result.body, { status: result.status });
  }

  return NextResponse.json({ ok: true, draft: result.draft });
}
