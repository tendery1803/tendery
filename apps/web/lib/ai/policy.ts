import { mergeProcurementSpans, procurementProtectedSpans } from "@tendery/core";

/**
 * Предикат «можно / нельзя отправлять во внешний AI-контур» (ТЗ п. 12.5).
 * Проверка флага компании.
 */
export function canSendToExternalAiForCompany(
  aiExternalDisabled: boolean
): { ok: true } | { ok: false; reason: string } {
  if (aiExternalDisabled) {
    return { ok: false, reason: "company_ai_external_disabled" };
  }
  return { ok: true };
}

function matchAllStrings(re: RegExp, text: string): string[] {
  const flags = re.flags.includes("g") ? re.flags : `${re.flags}g`;
  const r = new RegExp(re.source, flags);
  return [...text.matchAll(r)].map((m) => m[0] ?? "");
}

/**
 * Подсчёт остаточных «сигналов» чувствительности в УЖЕ замаскированном тексте.
 * Email/телефоны — по уникальным совпадениям (один и тот же контакт в 30 фрагментах = один сигнал).
 * Длинные цифры: не считаем участки внутри procurementProtectedSpans (закупочные id намеренно не маскируем)
 * и не раздуваем счётчик повтором одной и той же последовательности в разных <<<фрагментах>>>.
 */
function countResidualSensitiveSignals(maskedText: string): number {
  let score = 0;
  const emailRe = /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/gi;
  score += new Set(matchAllStrings(emailRe, maskedText).map((s) => s.toLowerCase())).size;

  const ruPhone =
    /\+7[\s(]*\d{3}[\s)]*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b|\b8[\s(]*\d{3}[\s)]*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b|\b9\d{9}\b/g;
  score += new Set(matchAllStrings(ruPhone, maskedText)).size;

  const intlPhone = /(?<![\dA-Za-z])\+(?!7)\d{1,3}[\s().-]*\d{6,14}\b/g;
  score += new Set(matchAllStrings(intlPhone, maskedText)).size;

  const spans = mergeProcurementSpans(procurementProtectedSpans(maskedText));
  const longDigitUniq = new Set<string>();
  const longDigitRe = /\d{16,}/g;
  let m: RegExpExecArray | null;
  longDigitRe.lastIndex = 0;
  while ((m = longDigitRe.exec(maskedText)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (spans.some((sp) => sp.start <= start && end <= sp.end)) continue;
    longDigitUniq.add(m[0]);
  }
  score += longDigitUniq.size;

  return score;
}

function sensitiveSignalThreshold(): number {
  const raw = process.env.AI_EXTERNAL_SENSITIVE_SIGNAL_THRESHOLD;
  if (raw === undefined || raw === "") return 24;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 24;
}

/**
 * Rule-based gate после минимизации и maskPiiForAi: если в тексте всё ещё много
 * незамаскированных числовых/идентификационных хвостов — не отправляем наружу.
 *
 * Используется только для потока разбора закупки (кусок текста тендера), не для draft,
 * где ИНН и адрес намеренно передаются в промпт.
 */
export function canSendMaskedTenderPayloadToExternalAi(
  minimizedMaskedText: string
): { ok: true } | { ok: false; reason: string } {
  const threshold = sensitiveSignalThreshold();
  const n = countResidualSensitiveSignals(minimizedMaskedText);
  if (n >= threshold) {
    return {
      ok: false,
      reason: "external_ai_masked_payload_too_many_sensitive_residuals"
    };
  }
  return { ok: true };
}
