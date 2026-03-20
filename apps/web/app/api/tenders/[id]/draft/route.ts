import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCompanyMember, getTenderForCompany } from "@/lib/tenders/api-guard";
import { getAiGatewayClient } from "@/lib/ai/gateway-client";
import { assertCanDraft, incrementDraftGen } from "@/lib/billing/usage";
import { writeAuditLog } from "@/lib/audit/log";

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

  const gate = await assertCanDraft(ctx.companyId);
  if (!gate.ok) {
    return NextResponse.json(
      { error: "billing_limit", limit: gate.limit, used: gate.used },
      { status: 402 }
    );
  }

  const company = await prisma.company.findUnique({
    where: { id: ctx.companyId },
    select: { name: true, inn: true }
  });

  const analysis = await prisma.tenderAnalysis.findFirst({
    where: { tenderId, status: "done" },
    orderBy: { createdAt: "desc" },
    include: { fields: { orderBy: { sortOrder: "asc" } } }
  });

  const fieldsBlock =
    analysis?.fields
      .map((f) => `- ${f.fieldLabel}: ${f.valueText} (уверенность ${f.confidence})`)
      .join("\n") ?? "(разбор ещё не выполнен — черновик по заголовку и описанию)";

  const prompt = `Составь черновик заявки на участие в закупке на русском языке (структурированный текст с разделами: реквизиты участника, предмет, сроки, соответствие требованиям, подпись).
Участник: ${company?.name ?? "Компания"}${company?.inn ? `, ИНН ${company.inn}` : ""}.
Закупка: ${tender.title}.
Описание: ${tender.description ?? "—"}
Ключевые поля из разбора:
${fieldsBlock}
Не выдумывай конкретные номера контрактов, если их нет в данных.`;

  try {
    const client = getAiGatewayClient();
    const res = await client.analyze({
      operation: "draft_generate",
      sensitivity: "maybe_pii",
      modelRoute: "mini",
      prompt,
      maxOutputTokens: 2500
    });

    const draft = await prisma.tenderDraft.upsert({
      where: { tenderId },
      create: {
        tenderId,
        body: res.outputText,
        model: res.model,
        error: null
      },
      update: {
        body: res.outputText,
        model: res.model,
        error: null
      }
    });

    await incrementDraftGen(ctx.companyId);
    await writeAuditLog({
      actorUserId: ctx.user.id,
      action: "tender.draft_generate",
      targetType: "Tender",
      targetId: tenderId,
      meta: { draftId: draft.id }
    });

    return NextResponse.json({ ok: true, draft });
  } catch (e) {
    const msg = String(e);
    await prisma.tenderDraft.upsert({
      where: { tenderId },
      create: {
        tenderId,
        body: "Черновик не сгенерирован (ошибка AI-gateway).",
        model: null,
        error: msg
      },
      update: { error: msg }
    });
    return NextResponse.json({ error: "draft_failed", detail: msg }, { status: 502 });
  }
}
