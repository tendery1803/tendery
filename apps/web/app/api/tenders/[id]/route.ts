import { NextResponse } from "next/server";
import { requireCompanyMember, getTenderForCompany } from "@/lib/tenders/api-guard";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireCompanyMember();
  if ("error" in ctx) return ctx.error;

  const { id } = await params;
  const tender = await getTenderForCompany(id, ctx.companyId);
  if (!tender) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({ tender });
}
