import { NextResponse } from "next/server";
import { requireCompanyMember, getTenderForCompany } from "@/lib/tenders/api-guard";
import { runTenderAiAnalyze } from "@/lib/use-cases/tender-ai-analyze";

export const runtime = "nodejs";

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireCompanyMember();
  if ("error" in ctx) return ctx.error;

  const { id: tenderId } = await params;
  const tender = await getTenderForCompany(tenderId, ctx.companyId);
  if (!tender) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (process.env.NODE_ENV === "development") {
    console.info("[api/tenders/analyze] POST start", { tenderId });
  }

  const result = await runTenderAiAnalyze(
    { user: ctx.user, companyId: ctx.companyId },
    tenderId
  );

  if (!result.ok) {
    return NextResponse.json({ ...result.body, invokedAs: "analyze" }, { status: result.status });
  }

  return NextResponse.json({ ok: true, analysis: result.analysis, invokedAs: "analyze" });
}
