/**
 * Самопроверка redactDiagnosticPreview (как в логах и analyzeDiagnostics.outputPreview):
 *   pnpm -C apps/ai-gateway exec tsx src/pii-redact.verify.ts
 */
import assert from "node:assert/strict";
import { redactDiagnosticPreview } from "./pii-redact";

const procurement =
  'ИКЗ 123456789012345678901234567890. КТРУ 12.12.12.120-00001. ОКПД2 12.12.12.120. НМЦК: 1 234 567,89 руб. Срок поставки: 30 календарных дней. Место: г. Санкт-Петербург. Характеристика: плотность 80 г/м².';

const pii =
  "Контакт: Сидоров Алексей Петрович, ИНН 7707083893, паспорт 4510 123456, a@b.ru, +7 900 111-22-33, р/с 40702810100000000012";

const raw = `${procurement}\n${pii}`;
const out = redactDiagnosticPreview(raw);

assert.match(out, /ИКЗ 123456789012345678901234567890/, "ИКЗ не трогаем");
assert.match(out, /КТРУ 12\.12\.12\.120-00001/, "КТРУ не трогаем");
assert.match(out, /ОКПД2 12\.12\.12\.120/, "ОКПД2 не трогаем");
assert.match(out, /1 234 567,89/, "НМЦК не трогаем");
assert.match(out, /30 календарных дней/, "срок поставки не трогаем");
assert.match(out, /г\. Санкт-Петербург/, "место поставки не трогаем");
assert.match(out, /плотность 80 г\/м²/, "характеристика не трогаем");

assert.match(out, /\[PERSON_1\]/, "ФИО → PERSON");
assert.doesNotMatch(out, /Сидоров/, "фамилия не светится");
assert.doesNotMatch(out, /Алексей/, "имя не светится");
assert.doesNotMatch(out, /Петрович/, "отчество не светится");
assert.match(out, /\[INN\]/, "ИНН по метке");
assert.doesNotMatch(out, /7707083893/, "цифр ИНН нет");
assert.match(out, /\[ID_DOC\]/, "паспорт");
assert.doesNotMatch(out, /4510\s*123456/, "серия/номер паспорта нет");
assert.match(out, /\[EMAIL\]/);
assert.doesNotMatch(out, /a@b\.ru/);
assert.match(out, /\[PHONE\]/);
assert.doesNotMatch(out, /900\s*111/);
assert.match(out, /\[BANK_REF\]/);
assert.doesNotMatch(out, /40702810100000000012/);

/** Как analyzeDiagnostics.outputPreview после slice(0, 2000). */
const modelEcho =
  '{"contact":"Иванов Мария Сергеевна","mail":"x@y.com","tel":"+79001234567"}';
const prev = redactDiagnosticPreview(modelEcho.slice(0, 2000));
assert.doesNotMatch(prev, /Иванов/);
assert.doesNotMatch(prev, /Мария/);
assert.doesNotMatch(prev, /Сергеевна/);
assert.doesNotMatch(prev, /x@y/);
assert.doesNotMatch(prev, /\+79001234567/);

console.log("pii-redact.verify: OK");
