import { prisma } from "@/lib/db";
import { getAiGatewayClient } from "@/lib/ai/gateway-client";
import {
  parseTenderAiResult,
  redactSnippetForLog,
  traceTenderAiParseStages
} from "@/lib/ai/parse-model-json";
import { assertCanAiOperation, recordAiOperationAnalyze } from "@/lib/billing/usage";
import { writeAuditLog } from "@/lib/audit/log";
import {
  canSendToExternalAiForCompany,
  canSendMaskedTenderPayloadToExternalAi
} from "@/lib/ai/policy";
import { buildMinimizedTenderTextForAi } from "@/lib/ai/build-minimized-tender-text-for-ai";
import { normalizeTenderAiFields } from "@/lib/ai/normalize-tender-ai-fields";

export const TENDER_ANALYZE_PROMPT_VERSION = "tender_analyze_v4";

/** По умолчанию false: полный ответ модели в БД не храним (снижение риска ПДн в TenderAnalysis.rawOutput). */
function shouldStoreAiRawOutput(): boolean {
  return process.env.AI_STORE_RAW_OUTPUT === "true";
}

const ANALYSIS_PROMPT = `Ты помощник для B2B-закупок. По фрагментам текста закупки извлеки поля.

Ответ только JSON-объект по схеме API (без markdown, без \`\`\`, без текста до/после, без комментариев).

Поле summary: краткое резюме на русском (2–4 предложения).

Поле fields: массив объектов с ключами key, label, value, confidence. Обязательные key (в таком порядке): customer, tender_no, subject, nmck, currency, dates, delivery_deadline, delivery_place, requirements, application_parts, mandatory_docs, guarantees, risks.
Подписи label на русском как в шаблоне: «Заказчик», «Номер / идентификатор закупки», «Предмет закупки», «НМЦК / начальная цена», «Валюта», «Даты и этапы», «Срок поставки», «Место поставки», «Требования к участнику», «Состав заявки», «Обязательные документы», «Обеспечение заявки / гарантии», «Риски и спорные места».
value — строка; если данных нет — пустая строка. confidence — число от 0 до 1.`;

export type TenderAiAnalyzeContext = {
  user: { id: string; email: string };
  companyId: string;
};

export type RunTenderAiAnalyzeOptions = {
  /** Различие в AuditLog между POST /analyze и POST /parse (одинаковый сценарий MVP). */
  auditAction?: "tender.ai_analyze" | "tender.parse";
};

export async function runTenderAiAnalyze(
  ctx: TenderAiAnalyzeContext,
  tenderId: string,
  options?: RunTenderAiAnalyzeOptions
) {
  const auditAction = options?.auditAction ?? "tender.ai_analyze";
  const tender = await prisma.tender.findFirst({
    where: { id: tenderId, companyId: ctx.companyId }
  });
  if (!tender) {
    return { ok: false, status: 404, body: { error: "not_found" } };
  }

  const company = await prisma.company.findUnique({
    where: { id: ctx.companyId },
    select: { aiExternalDisabled: true }
  });
  const gatePolicy = canSendToExternalAiForCompany(Boolean(company?.aiExternalDisabled));
  if (!gatePolicy.ok) {
    return { ok: false, status: 403, body: { error: gatePolicy.reason } };
  }

  const gateBilling = await assertCanAiOperation(ctx.companyId);
  if (!gateBilling.ok) {
    return {
      ok: false,
      status: 402,
      body: { error: "billing_limit", limit: gateBilling.limit, used: gateBilling.used }
    };
  }

  const files = await prisma.tenderFile.findMany({
    where: { tenderId, extractionStatus: "done", extractedText: { not: null } },
    orderBy: { createdAt: "asc" },
    select: { originalName: true, extractedText: true }
  });

  const { text: corpus, stats } = buildMinimizedTenderTextForAi(
    files.map((f) => ({ extractedText: f.extractedText ?? "" }))
  );

  if (!corpus.trim()) {
    return { ok: false, status: 409, body: { error: "no_extracted_text" } };
  }

  const gateResidual = canSendMaskedTenderPayloadToExternalAi(corpus);
  if (!gateResidual.ok) {
    return { ok: false, status: 422, body: { error: gateResidual.reason } };
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
    const prompt = `${ANALYSIS_PROMPT}\n\n--- ТЕКСТ ЗАКУПКИ (минимизирован) ---\n${corpus}`;
    const res = await client.analyze({
      operation: "tender_analyze",
      sensitivity: "maybe_pii",
      modelRoute: "mini",
      prompt,
      maxOutputTokens: 4096
    });
    modelName = res.model;
    rawOutput = res.outputText;

    const parsed = parseTenderAiResult(res.outputText);
    const persistRaw = shouldStoreAiRawOutput();
    const parseStagesOnFailure =
      !parsed.ok ? traceTenderAiParseStages(rawOutput ?? "") : null;

    if (!parsed.ok) {
      const diag = parsed.diagnostics;
      const deepDiag =
        process.env.AI_PARSE_DIAGNOSTIC_SNIPPET === "true" ||
        process.env.AI_TENDER_ANALYZE_DIAG === "true";
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "tender_analyze_parse_failed",
          operation: "tender_analyze",
          model: modelName,
          tenderId,
          parseError: parsed.error,
          responseLength: diag.responseLength,
          responseEmpty: diag.responseEmpty,
          markdownFenceFound: diag.markdownFenceFound,
          jsonParsedAt: diag.jsonParsedAt,
          lastJsonError: diag.lastJsonError ?? null,
          parseStages: parseStagesOnFailure,
          gatewayAnalyzeDiagnostics: res.analyzeDiagnostics ?? null,
          outputPreviewIncluded: deepDiag
        })
      );
      if (deepDiag) {
        console.warn(
          JSON.stringify({
            level: "warn",
            event: "tender_analyze_parse_failed_output_preview",
            operation: "tender_analyze",
            model: modelName,
            tenderId,
            preview: redactSnippetForLog(rawOutput ?? "")
          })
        );
      }
    }

    await prisma.aiRequestLog.create({
      data: {
        companyId: ctx.companyId,
        userId: ctx.user.id,
        operation: "tender_analyze",
        sensitivity: "maybe_pii",
        /**
         * Колонка `masked` в БД: для этой строки НЕ храним ни промпт, ни ответ модели.
         * Семантика «payload замаскирован перед отправкой» — в meta.payloadWasMaskedBeforeSend.
         */
        masked: true,
        model: modelName,
        promptVersion: TENDER_ANALYZE_PROMPT_VERSION,
        inputCharCount: stats.outChars,
        validationOk: parsed.ok,
        meta: {
          tenderId,
          minimization: stats,
          promptStoredInLog: false,
          payloadWasMaskedBeforeSend: true,
          maskedColumnSemantics: "no_full_prompt_or_model_output_in_ai_request_log_row",
          ...(!parsed.ok
            ? {
                parseError: parsed.error,
                parseDiagnostics: {
                  responseLength: parsed.diagnostics.responseLength,
                  responseEmpty: parsed.diagnostics.responseEmpty,
                  markdownFenceFound: parsed.diagnostics.markdownFenceFound,
                  jsonParsedAt: parsed.diagnostics.jsonParsedAt,
                  lastJsonError: parsed.diagnostics.lastJsonError ?? null,
                  parseStages: parseStagesOnFailure,
                  gatewayAnalyzeDiagnostics: res.analyzeDiagnostics ?? null
                }
              }
            : {})
        }
      }
    });

    if (!parsed.ok) {
      await prisma.tenderAnalysis.update({
        where: { id: analysis.id },
        data: {
          status: "failed",
          error: parsed.error,
          rawOutput: persistRaw ? rawOutput : null,
          model: modelName
        }
      });
      return { ok: false, status: 502, body: { error: "ai_parse_failed", detail: parsed.error } };
    }

    const normalized = normalizeTenderAiFields(parsed.data);
    const persistRawOk = shouldStoreAiRawOutput();
    await prisma.$transaction(async (tx) => {
      await tx.tenderAnalysisField.deleteMany({ where: { analysisId: analysis.id } });
      await tx.tenderAnalysis.update({
        where: { id: analysis.id },
        data: {
          status: "done",
          summary: normalized.summary,
          rawOutput: persistRawOk ? rawOutput : null,
          model: modelName,
          error: null
        }
      });
      await tx.tenderAnalysisField.createMany({
        data: normalized.fields.map((f, i) => ({
          analysisId: analysis.id,
          fieldKey: f.key,
          fieldLabel: f.label,
          valueText: f.value,
          confidence: f.confidence,
          sortOrder: i
        }))
      });
    });

    await recordAiOperationAnalyze(ctx.companyId);
    await writeAuditLog({
      actorUserId: ctx.user.id,
      action: auditAction,
      targetType: "Tender",
      targetId: tenderId,
      meta: { analysisId: analysis.id, minimization: stats }
    });

    const full = await prisma.tenderAnalysis.findUniqueOrThrow({
      where: { id: analysis.id },
      include: { fields: { orderBy: { sortOrder: "asc" } } }
    });

    return { ok: true, analysis: full };
  } catch (e) {
    const msg = String(e);
    const persistRawErr = shouldStoreAiRawOutput();
    await prisma.tenderAnalysis.update({
      where: { id: analysis.id },
      data: {
        status: "failed",
        error: msg,
        rawOutput: persistRawErr ? rawOutput : null,
        model: modelName
      }
    });
    return { ok: false, status: 502, body: { error: "ai_gateway_failed", detail: msg } };
  }
}
