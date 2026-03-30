/**
 * Самопроверка селективного maskPiiForAi (из каталога apps/web):
 *   pnpm dlx tsx apps/web/lib/ai/mask-pii-for-ai.verify.ts
 */
import assert from "node:assert/strict";
import { maskPiiForAi } from "./mask-pii-for-ai";

const ikz = "ИКЗ 123456789012345678901234567890";
const phoneLine = "тел. +7 (900) 123-45-67";
const mixed = `${ikz}. ${phoneLine}. КТРУ 12.12.12.120-00001`;

const m = maskPiiForAi(mixed);
assert.match(m, /ИКЗ 123456789012345678901234567890/, "ИКЗ не должен маскироваться");
assert.match(m, /КТРУ 12\.12\.12\.120-00001/, "КТРУ не должен маскироваться");
assert.match(m, /\[PHONE_1\]/, "телефон должен стать маркером");
assert.doesNotMatch(m, /900.*123.*45.*67/, "сырых цифр телефона не остаётся");

const emailOnly = "пишите a.b@c.example.com";
const me = maskPiiForAi(emailOnly);
assert.match(me, /\[EMAIL_1\]/);
assert.doesNotMatch(me, /c\.example/, "домен email не светится");

const logLike = maskPiiForAi('{"x":"+79001234567","y":"u@v.com"}');
assert.doesNotMatch(logLike, /\+79001234567/);
assert.doesNotMatch(logLike, /u@v\.com/);

const fioLine =
  "Уполномочен: Иванов Мария Сергеевна. ИНН 770708389301, серия 4510 654321, счёт 40702810938000000001.";
const mf = maskPiiForAi(fioLine);
assert.match(mf, /\[PERSON_1\]/, "ФИО → маркер");
assert.doesNotMatch(mf, /Иванов/);
assert.doesNotMatch(mf, /Мария/);
assert.doesNotMatch(mf, /Сергеевна/);
assert.match(mf, /\[INN_1\]/);
assert.doesNotMatch(mf, /770708389301/);
assert.match(mf, /\[ID_DOC_1\]/);
assert.doesNotMatch(mf, /4510\s*654321/);
assert.match(mf, /\[BANK_ACC_1\]/);
assert.doesNotMatch(mf, /40702810938000000001/);

const tenderish =
  "Номер извещения: № 0373200000123000100. ОКПД2 17.12.12.100. НМЦК 99 999,00 руб. Срок: 15 рабочих дней. Место: ул. Торговая, д. 1. Товар: бумага А4, белизна 98%.";
const mt = maskPiiForAi(tenderish);
assert.match(mt, /0373200000123000100/, "номер извещения в защищённом контексте");
assert.match(mt, /ОКПД2 17\.12\.12\.100/, "ОКПД2");
assert.match(mt, /99 999,00/, "НМЦК");
assert.match(mt, /15 рабочих дней/, "срок");
assert.match(mt, /ул\. Торговая/, "место");
assert.match(mt, /белизна 98%/, "характеристика");

console.log("mask-pii-for-ai.verify: OK");
