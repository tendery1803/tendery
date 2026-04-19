import { NextResponse } from "next/server";
import { requireCompanyMember, getTenderForCompany } from "@/lib/tenders/api-guard";
import { confirmGoodsPositionIdForTender } from "@/lib/use-cases/confirm-goods-position-id";

export const runtime = "nodejs";

type Body = {
  goodsItemIndex?: unknown;
  positionId?: unknown;
};

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireCompanyMember();
  if ("error" in ctx) return ctx.error;

  const { id: tenderId } = await params;
  const tender = await getTenderForCompany(tenderId, ctx.companyId);
  if (!tender) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const goodsItemIndex =
    typeof body.goodsItemIndex === "number"
      ? body.goodsItemIndex
      : typeof body.goodsItemIndex === "string"
        ? Number.parseInt(body.goodsItemIndex, 10)
        : NaN;
  const positionId = typeof body.positionId === "string" ? body.positionId : "";

  if (!Number.isFinite(goodsItemIndex) || !positionId.trim()) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const result = await confirmGoodsPositionIdForTender({
    companyId: ctx.companyId,
    tenderId,
    goodsItemIndex,
    positionId: positionId.trim()
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.code, message: result.message },
      { status: result.httpStatus }
    );
  }

  return NextResponse.json({ ok: true });
}
