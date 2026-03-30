import { TenderAnalysisStructuredBlockSchema } from "@tendery/contracts";
import { maskPiiForAi } from "@/lib/ai/mask-pii-for-ai";
import { prisma } from "@/lib/db";
import { getAiGatewayClient } from "@/lib/ai/gateway-client";
import { assertCanAiOperation, recordAiOperationDraft } from "@/lib/billing/usage";
import { writeAuditLog } from "@/lib/audit/log";
import { canSendToExternalAiForCompany } from "@/lib/ai/policy";

export const DRAFT_GENERATE_PROMPT_VERSION = "draft_generate_v4";

function formatStructuredBlockForDraft(raw: unknown): string {
  const p = TenderAnalysisStructuredBlockSchema.safeParse(raw);
  if (!p.success) return "";
  const { goodsItems, servicesOfferings, procurementMethod } = p.data;
  const chunks: string[] = [];
  if (procurementMethod?.trim()) {
    chunks.push(`Способ закупки (из разбора): ${procurementMethod.trim()}`);
  }
  if (goodsItems.length) {
    chunks.push("Раздел «Товары и характеристики» (из AI-разбора, сверьте с документами):");
    for (const g of goodsItems) {
      const head = [
        g.name && `Наименование: ${g.name}`,
        g.positionId && `Позиция/№: ${g.positionId}`,
        g.codes && `Коды: ${g.codes}`,
        (g.quantity || g.unit) &&
          `Кол-во: ${[g.quantity, g.unit].filter((x) => x.trim()).join(" ")}`,
        g.unitPrice && `Цена за ед.: ${g.unitPrice}`,
        g.lineTotal && `Сумма позиции: ${g.lineTotal}`
      ]
        .filter(Boolean)
        .join("; ");
      chunks.push(head ? `- ${head}` : "- (позиция без названия)");
      for (const c of g.characteristics) {
        if (c.name.trim() || c.value.trim()) {
          chunks.push(`  • ${c.name}: ${c.value}`);
        }
      }
    }
  }
  if (servicesOfferings.length) {
    chunks.push("Раздел «Оказываемые услуги / состав услуг» (из AI-разбора):");
    for (const s of servicesOfferings) {
      const parts = [
        s.title && `Услуга/блок: ${s.title}`,
        s.volumeOrScope && `Объём и scope: ${s.volumeOrScope}`,
        s.deadlinesOrStages && `Сроки и этапы: ${s.deadlinesOrStages}`,
        s.resultRequirements && `Требования к результату: ${s.resultRequirements}`,
        s.otherTerms && `Прочие условия: ${s.otherTerms}`
      ].filter(Boolean);
      chunks.push(parts.length ? `- ${parts.join("; ")}` : "- (пустой блок)");
    }
  }
  return chunks.length ? `\n${chunks.join("\n")}\n` : "";
}

export type GenerateDraftContext = {
  user: { id: string; email: string };
  companyId: string;
};

/**
 * Двухэтапная логика MVP: локально собираем каркас из реквизитов и профиля,
 * во внешний контур уходит только сжатый промпт (не полный комплект документов компании).
 *
 * В промпт намеренно включаем минимум для каркаса заявки: наименование, ИНН, юр. адрес, ФИО руководителя.
 * Телефон, email и контактное лицо не передаём во внешний AI (остаются в профиле для UI/локальных шаблонов).
 */
export async function runGenerateTenderDraft(ctx: GenerateDraftContext, tenderId: string) {
  const tender = await prisma.tender.findFirst({
    where: { id: tenderId, companyId: ctx.companyId }
  });
  if (!tender) {
    return { ok: false, status: 404, body: { error: "not_found" } };
  }

  const company = await prisma.company.findUnique({
    where: { id: ctx.companyId },
    select: { name: true, inn: true, aiExternalDisabled: true }
  });
  const pol = canSendToExternalAiForCompany(Boolean(company?.aiExternalDisabled));
  if (!pol.ok) {
    return { ok: false, status: 403, body: { error: pol.reason } };
  }

  const gate = await assertCanAiOperation(ctx.companyId, { actorUserId: ctx.user.id });
  if (!gate.ok) {
    return {
      ok: false,
      status: 402,
      body: { error: "billing_limit", limit: gate.limit, used: gate.used }
    };
  }

  const profile = await prisma.companyProfile.findUnique({
    where: { companyId: ctx.companyId }
  });

  const analysis = await prisma.tenderAnalysis.findFirst({
    where: { tenderId, status: "done" },
    orderBy: { createdAt: "desc" },
    select: {
      structuredBlock: true,
      fields: { orderBy: { sortOrder: "asc" } }
    }
  });

  const fieldsBlockRaw =
    analysis?.fields
      .map((f) => `- ${f.fieldLabel}: ${f.valueText} (уверенность ${f.confidence})`)
      .join("\n") ?? "(разбор ещё не выполнен — черновик по заголовку и описанию)";

  /** Повторная отправка фрагментов разбора во внешний AI — та же маскировка ПДн, что при analyze (152-ФЗ, эвристика). */
  const fieldsBlock =
    fieldsBlockRaw.startsWith("(разбор ещё не выполнен")
      ? fieldsBlockRaw
      : maskPiiForAi(fieldsBlockRaw);

  const structuredExtraRaw = formatStructuredBlockForDraft(analysis?.structuredBlock ?? null);
  const structuredExtra = structuredExtraRaw ? maskPiiForAi(structuredExtraRaw) : "";

  const tenderTitleForAi = maskPiiForAi(tender.title);
  const tenderDescriptionForAi = maskPiiForAi(tender.description ?? "—");

  const localSkeleton = [
    `Наименование участника: ${company?.name ?? "—"}`,
    company?.inn ? `ИНН: ${company.inn}` : null,
    profile?.legalAddress ? `Юридический адрес: ${profile.legalAddress}` : null,
    profile?.directorName ? `Руководитель: ${profile.directorName}` : null
  ]
    .filter(Boolean)
    .join("\n");

  const prompt = `Составь черновик заявки на участие в закупке на русском языке (структурированный текст с разделами: реквизиты участника, предмет, сроки, соответствие требованиям, перечень приложений, подпись).
Ниже — ЛОКАЛЬНО СОБРАННЫЕ РЕКВИЗИТЫ УЧАСТНИКА (уже из системы, не выдумывай другие):
${localSkeleton}

Закупка: ${tenderTitleForAi}.
Описание: ${tenderDescriptionForAi}
Ключевые поля из разбора:
${fieldsBlock}
${structuredExtra ? `Дополнительно (если есть — используй в отдельных подразделах черновика, не выдумывай отсутствующее):${structuredExtra}` : ""}

Правила: не добавляй банковские реквизиты и паспортные данные, если их нет в локальном блоке. Не выдумывай номера контрактов и лоты, если их нет в данных. Если блока товаров/услуг нет — игнорируй.`;

  try {
    const client = getAiGatewayClient();
    const res = await client.analyze({
      operation: "draft_generate",
      sensitivity: "maybe_pii",
      modelRoute: "mini",
      prompt,
      maxOutputTokens: 2500
    });

    await prisma.aiRequestLog.create({
      data: {
        companyId: ctx.companyId,
        userId: ctx.user.id,
        operation: "draft_generate",
        sensitivity: "maybe_pii",
        /**
         * Колонка `masked`: в строке лога нет полного промпта/ответа.
         * Промпт в gateway не прогоняется через mask-pii (намеренно есть ИНН/адрес) — см. meta.
         */
        masked: true,
        model: res.model,
        promptVersion: DRAFT_GENERATE_PROMPT_VERSION,
        inputCharCount: prompt.length,
        validationOk: true,
        meta: {
          tenderId,
          promptStoredInLog: false,
          payloadWasMaskedBeforeSend: false,
          maskedColumnSemantics: "no_full_prompt_or_model_output_in_ai_request_log_row"
        }
      }
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

    await recordAiOperationDraft(ctx.companyId);
    await writeAuditLog({
      actorUserId: ctx.user.id,
      action: "tender.draft_generate",
      targetType: "Tender",
      targetId: tenderId,
      meta: { draftId: draft.id }
    });

    return { ok: true, draft };
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
    return { ok: false, status: 502, body: { error: "draft_failed", detail: msg } };
  }
}
