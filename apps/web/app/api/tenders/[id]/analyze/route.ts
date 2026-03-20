import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCompanyMember, getTenderForCompany } from "@/lib/tenders/api-guard";
import { getAiGatewayClient } from "@/lib/ai/gateway-client";
import { parseTenderAiResult } from "@/lib/ai/parse-model-json";
import { assertCanAiAnalyze, incrementAiAnalyze } from "@/lib/billing/usage";
import { writeAuditLog } from "@/lib/audit/log";

export const runtime = "nodejs";

const ANALYSIS_PROMPT = `Ты помощник для B2B-закупок. По тексту документов закупки извлеки ключевые поля.
Верни ТОЛЬКО валидный JSON без пояснений, формат:
{
  "summary": "краткое резюме закупки на русском (2-4 предложения)",
  "fields": [
    { "key": "customer", "label": "Заказчик", "value": "строка или пустая строка", "confidence": 0.0 },
    { "key": "subject", "label": "Предмет закупки", "value": "", "confidence": 0.0 },
    { "key": "deadline", "label": "Сроки / дедлайн", "value": "", "confidence": 0.0 },
    { "key": "budget", "label": "Бюджет / НМЦК", "value": "", "confidence": 0.0 },
    { "key": "delivery", "label": "Поставка / адрес", "value": "", "confidence": 0.0 },
    { "key": "requirements", "label": "Ключевые требования", "value": "", "confidence": 0.0 }
  ]
}
confidence — число от 0 до 1 насколько уверен в значении. Если данных нет, value пустая строка и confidence 0.`;

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

  const gate = await assertCanAiAnalyze(ctx.companyId);
  if (!gate.ok) {
    return NextResponse.json(
      { error: "billing_limit", limit: gate.limit, used: gate.used },
      { status: 402 }
    );
  }

  const files = await prisma.tenderFile.findMany({
    where: { tenderId, extractionStatus: "done", extractedText: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { originalName: true, extractedText: true }
  });

  const corpus = files
    .map((f) => `### ${f.originalName}\n${f.extractedText ?? ""}`)
    .join("\n\n")
    .slice(0, 120_000);

  if (!corpus.trim()) {
    return NextResponse.json({ error: "no_extracted_text" }, { status: 409 });
  }

  const analysis = await prisma.tenderAnalysis.create({
    data: {
      tenderId,
      status: "processing"
    }
  });

  let modelName: string | null = null;
  let rawOutput: string | null = null;

  try {
    const client = getAiGatewayClient();
    const prompt = `${ANALYSIS_PROMPT}\n\n--- ТЕКСТ ЗАКУПКИ ---\n${corpus}`;
    const res = await client.analyze({
      operation: "tender_analyze",
      sensitivity: "maybe_pii",
      modelRoute: "mini",
      prompt,
      maxOutputTokens: 1200
    });
    modelName = res.model;
    rawOutput = res.outputText;

    const parsed = parseTenderAiResult(res.outputText);
    if (!parsed.ok) {
      await prisma.tenderAnalysis.update({
        where: { id: analysis.id },
        data: {
          status: "failed",
          error: parsed.error,
          rawOutput,
          model: modelName
        }
      });
      return NextResponse.json({ error: "ai_parse_failed", detail: parsed.error }, { status: 502 });
    }

    const { data } = parsed;
    await prisma.$transaction(async (tx) => {
      await tx.tenderAnalysisField.deleteMany({ where: { analysisId: analysis.id } });
      await tx.tenderAnalysis.update({
        where: { id: analysis.id },
        data: {
          status: "done",
          summary: data.summary,
          rawOutput,
          model: modelName,
          error: null
        }
      });
      await tx.tenderAnalysisField.createMany({
        data: data.fields.map((f, i) => ({
          analysisId: analysis.id,
          fieldKey: f.key,
          fieldLabel: f.label,
          valueText: f.value,
          confidence: f.confidence,
          sortOrder: i
        }))
      });
    });

    await incrementAiAnalyze(ctx.companyId);
    await writeAuditLog({
      actorUserId: ctx.user.id,
      action: "tender.ai_analyze",
      targetType: "Tender",
      targetId: tenderId,
      meta: { analysisId: analysis.id }
    });

    const full = await prisma.tenderAnalysis.findUniqueOrThrow({
      where: { id: analysis.id },
      include: { fields: { orderBy: { sortOrder: "asc" } } }
    });

    return NextResponse.json({ ok: true, analysis: full });
  } catch (e) {
    const msg = String(e);
    await prisma.tenderAnalysis.update({
      where: { id: analysis.id },
      data: {
        status: "failed",
        error: msg,
        rawOutput,
        model: modelName
      }
    });
    return NextResponse.json({ error: "ai_gateway_failed", detail: msg }, { status: 502 });
  }
}
