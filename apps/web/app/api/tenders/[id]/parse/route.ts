import { NextResponse } from "next/server";
import { requireCompanyMember, getTenderForCompany } from "@/lib/tenders/api-guard";
import { runTenderAiAnalyze } from "@/lib/use-cases/tender-ai-analyze";

export const runtime = "nodejs";

/**
 * POST /parse (приложение А): в MVP это тот же синхронный сценарий, что и POST /analyze.
 * Очередь `tender.parse` в worker — заглушка; фонового parse по БД здесь нет.
 */
const PARSE_MVP_CONTRACT = {
  parseMvpMode: "sync_same_as_analyze" as const,
  workerQueuedParse: false
};

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const ctx = await requireCompanyMember();
  if ("error" in ctx) return ctx.error;

  const { id: tenderId } = await params;
  const tender = await getTenderForCompany(tenderId, ctx.companyId);
  if (!tender) {
    return NextResponse.json({ error: "not_found", ...PARSE_MVP_CONTRACT }, { status: 404 });
  }

  const result = await runTenderAiAnalyze(
    { user: ctx.user, companyId: ctx.companyId },
    tenderId,
    { auditAction: "tender.parse" }
  );

  if (!result.ok) {
    return NextResponse.json(
      { ...result.body, invokedAs: "parse", ...PARSE_MVP_CONTRACT },
      { status: result.status }
    );
  }

  return NextResponse.json({
    ok: true,
    analysis: result.analysis,
    invokedAs: "parse",
    ...PARSE_MVP_CONTRACT
  });
}
