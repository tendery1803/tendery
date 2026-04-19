import { NextResponse } from "next/server";
import { applySafeGoodsNamePolishForTender } from "@/lib/use-cases/apply-safe-goods-name-polish";
import { getTenderForCompany, requireCompanyMember } from "@/lib/tenders/api-guard";

export const runtime = "nodejs";

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireCompanyMember();
  if ("error" in ctx) return ctx.error;

  const { id: tenderId } = await params;
  const tender = await getTenderForCompany(tenderId, ctx.companyId);
  if (!tender) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const result = await applySafeGoodsNamePolishForTender({
    companyId: ctx.companyId,
    tenderId
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.code, message: result.message },
      { status: result.httpStatus }
    );
  }

  return NextResponse.json({ ok: true, updatedIndices: result.updatedIndices });
}
