import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCompanyMember, getTenderForCompany } from "@/lib/tenders/api-guard";
import { rebuildChecklistForTender } from "@/lib/checklist/build-tender-checklist";

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

  // Always rebuild from latest done analysis so persisted rows cannot drift after a new
  // analyze (e.g. if a prior rebuild failed or the client never called POST rebuild).
  const items = await rebuildChecklistForTender(tenderId, ctx.companyId);
  return NextResponse.json({ items });
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

  const items = await rebuildChecklistForTender(tenderId, ctx.companyId);
  return NextResponse.json({ ok: true, items });
}
