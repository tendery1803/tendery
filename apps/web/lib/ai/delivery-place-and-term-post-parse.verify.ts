/**
 * Самопроверка пост-разбора delivery_place / delivery_term (apps/web):
 *   pnpm dlx tsx apps/web/lib/ai/delivery-place-and-term-post-parse.verify.ts
 */
import assert from "node:assert/strict";
import { normalizeDeliveryPlaceSegments } from "./delivery-place-from-corpus";
import { refineDeliveryTermAfterSanitize } from "./delivery-term-post-parse";

const addrUpd =
  "101000, г. Москва, ул. Ленина, д. 1 универсальный передаточный документ в электронном виде";
const placesUpd = normalizeDeliveryPlaceSegments(addrUpd);
assert.equal(placesUpd.length, 1, "один сегмент адреса");
assert.match(placesUpd[0]!, /Москва|Ленина/i);
assert.doesNotMatch(placesUpd[0]!, /универсальн|передаточн/i, "хвост УПД отрезан (кириллица)");

const addrApp =
  "620000, г. Екатеринбург, ул. Мира, д. 5 Приложение № 5 к договору";
const placesApp = normalizeDeliveryPlaceSegments(addrApp);
assert.equal(placesApp.length, 1);
assert.doesNotMatch(placesApp[0]!, /Приложение\s*№/i, "хвост «Приложение №» отрезан");

const addrLawTail =
  "101000, г. Москва, ул. Ленина, д. 1, с предварительным уведомлением заказчика, Федерального закона № 44-ФЗ, оператор электронной площадки ООО РА";
const placesLaw = normalizeDeliveryPlaceSegments(addrLawTail);
assert.equal(placesLaw.length, 1);
assert.doesNotMatch(placesLaw[0]!, /44-ФЗ|оператор\s+электронн|уведомлен/i, "правовой хвост после адреса отрезан");
assert.match(placesLaw[0]!, /Москва|Ленина/i);

const twoPlaces =
  "101000, г. Москва, ул. Ленина, д. 1; 620000, г. Казань, ул. Пушкина, д. 3, с предварительным уведомлением по 44-ФЗ";
const placesTwo = normalizeDeliveryPlaceSegments(twoPlaces);
assert.equal(placesTwo.length, 2);
assert.doesNotMatch(placesTwo[1]!, /уведомлен|44-ФЗ/i, "второй адрес без правового хвоста");

const termPay =
  "Срок поставки до 31.03.2027. Оплата производится в течение 5 рабочих дней.";
const termPayRef = refineDeliveryTermAfterSanitize(termPay);
assert.match(termPayRef, /31\.03\.2027/, "дата остаётся в сроке поставки");
assert.doesNotMatch(termPayRef, /Оплат/i, "оплата отделена и отброшена");

const termProc =
  "Окончание подачи заявок 15.01.2026. Поставка партиями по заявке Заказчика в течение 10 рабочих дней.";
const termProcRef = refineDeliveryTermAfterSanitize(termProc);
assert.doesNotMatch(termProcRef, /Окончание\s+подач/i, "процедурная часть убрана");
assert.match(termProcRef, /Поставка\s+партиями|заявк/i, "поставка по заявке сохранена");
