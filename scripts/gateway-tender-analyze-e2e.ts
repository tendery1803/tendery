/**
 * DEV-ONLY: ручная проверка POST /v1/analyze. Не заменяет боевой путь web → maskPiiForAi → gateway.
 * Запуск из корня: AI_PARSE_DIAGNOSTIC_SNIPPET=true node --env-file=.env scripts/gateway-tender-analyze-e2e.mjs
 */
import fs from "node:fs/promises";
import { maskPiiForAi } from "../apps/web/lib/ai/mask-pii-for-ai";

const base = (process.env.AI_GATEWAY_BASE_URL ?? "http://127.0.0.1:4010").replace(/\/+$/, "");
const key = process.env.AI_GATEWAY_API_KEY;
if (!key) {
  console.error("AI_GATEWAY_API_KEY missing");
  process.exit(1);
}

const ANALYSIS_PROMPT = `Ты помощник для B2B-закупок. Ответ — только JSON по схеме API (без markdown и комментариев).

summary: краткое резюме на русском (2–4 предложения).

fields: ровно 15 объектов {key,label,value,confidence} в порядке:
customer «Заказчик», etrading_platform «Наименование электронной площадки», tender_no «Номер / идентификатор закупки», subject «Предмет закупки», nmck «НМЦК», currency «Валюта», dates_stages «Даты и этапы», delivery_term «Срок поставки», delivery_place «Место поставки», bid_security «Обеспечение заявки», performance_security «Обеспечение исполнения контракта», participant_requirements «Требования к участнику», application_composition «Состав заявки», warranty «Гарантия», risks «Риски и спорные моменты».
Пустые значения — "".

procurementKind: goods | services | mixed | unknown.

goodsItems: массив позиций; каждая: name, positionId, codes, unit, quantity, unitPrice, lineTotal, sourceHint (строка), characteristics: [{name,value,sourceHint}].

servicesOfferings: массив; каждый: title, volumeOrScope, deadlinesOrStages, resultRequirements, otherTerms, sourceHint — строки.

Смешанные закупки: допустимо заполнить и goodsItems, и servicesOfferings. Если блок не применим — [].`;

const corpusRaw =
  "\n\n--- ТЕКСТ ЗАКУПКИ (минимизирован) ---\nЗакупка №TEST-E2E-001. Заказчик: ООО «Диагностика». Предмет: бумага офисная А4, 50 пачек. НМЦК: 50 000 руб. Валюта: RUB. Срок поставки: 30 календарных дней. Место: г. Москва. Контакт: Сидоров Алексей Петрович, +7 900 000-00-00.";

const corpus = maskPiiForAi(corpusRaw);
const prompt = `${ANALYSIS_PROMPT}${corpus}`;

const payload = {
  operation: "tender_analyze",
  sensitivity: "maybe_pii",
  modelRoute: "mini",
  maxOutputTokens: 8192,
  prompt
};

const res = await fetch(`${base}/v1/analyze`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${key}`
  },
  body: JSON.stringify(payload)
});

const json = await res.json().catch(() => ({}));
const outFile = "/tmp/tendery-gateway-analyze-resp.json";
await fs.writeFile(outFile, JSON.stringify(json, null, 2), "utf8");

console.log(
  JSON.stringify({
    httpStatus: res.status,
    gatewayResponseKeys: Object.keys(json),
    outputTextLength: typeof json.outputText === "string" ? json.outputText.length : null,
    hasAnalyzeDiagnostics: Boolean(json.analyzeDiagnostics),
    model: json.model ?? null,
    savedResponseTo: outFile
  })
);
