/**
 * Самопроверка пост-разбора delivery_place / delivery_term (apps/web):
 *   pnpm dlx tsx apps/web/lib/ai/delivery-place-and-term-post-parse.verify.ts
 */
import assert from "node:assert/strict";
import {
  dedupeDeliveryPlaces,
  normalizeDeliveryPlaceForDedupe,
  normalizeDeliveryPlaceSegments
} from "./delivery-place-from-corpus";
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

// ──────────────────────────────────────────────────────────────────────────────
// Dedupe tests — dedupeDeliveryPlaces + normalizeDeliveryPlaceForDedupe
// ──────────────────────────────────────────────────────────────────────────────

// D1: same address twice (literal duplicate) → only one kept
{
  const addr = "620000, г. Екатеринбург, ул. Мира, д. 5";
  const result = dedupeDeliveryPlaces([addr, addr]);
  assert.equal(result.length, 1, "D1: literal duplicate → one result");
  assert.equal(result[0], addr, "D1: the kept address is the original");
  console.log("PASS D1: literal duplicate deduplicated");
}

// D2: two genuinely different addresses → both preserved
{
  const a1 = "620000, г. Екатеринбург, ул. Мира, д. 5";
  const a2 = "620000, г. Екатеринбург, ул. Мира, д. 7";
  const result = dedupeDeliveryPlaces([a1, a2]);
  assert.equal(result.length, 2, "D2: different addresses → both preserved");
  console.log("PASS D2: different addresses both preserved");
}

// D3: same address with different spacing / punctuation → one kept
{
  // "г. Москва" vs "г.Москва", "ул. Садовая" vs "ул.Садовая", with trailing comma variant
  const canonical = "г. Москва, ул. Садовая, д. 1";
  const noSpaces  = "г.Москва,ул.Садовая,д.1";          // no spaces after punctuation
  const extraSp   = "г. Москва , ул. Садовая , д. 1";   // spaces before commas
  const trailingD = "г. Москва, ул. Садовая, д. 1.";    // trailing period
  const result = dedupeDeliveryPlaces([canonical, noSpaces, extraSp, trailingD]);
  assert.equal(result.length, 1, `D3: formatting variants → one address; got ${JSON.stringify(result)}`);
  // normalizeDeliveryPlaceForDedupe key check
  const k1 = normalizeDeliveryPlaceForDedupe(canonical);
  const k2 = normalizeDeliveryPlaceForDedupe(noSpaces);
  const k3 = normalizeDeliveryPlaceForDedupe(extraSp);
  const k4 = normalizeDeliveryPlaceForDedupe(trailingD);
  assert.equal(k1, k2, "D3: canonical ≡ noSpaces key");
  assert.equal(k1, k3, "D3: canonical ≡ extraSpaces key");
  assert.equal(k1, k4, "D3: canonical ≡ trailingPeriod key");
  console.log("PASS D3: punctuation/spacing variants collapsed to one");
}

// D4: same address from two sources (notice + contract), possible formatting difference
//     → only one entry in the final normalizeDeliveryPlaceSegments output
{
  // Notice uses "г.Екатеринбург", contract uses "г. Екатеринбург" — logically the same.
  const fromNotice   = "620000, г.Екатеринбург, ул.Мира, д.5";
  const fromContract = "620000, г. Екатеринбург, ул. Мира, д. 5";
  // Simulate what happens when both end up in a joined blob:
  const joined = [fromNotice, fromContract].join("; ");
  const segs = normalizeDeliveryPlaceSegments(joined);
  assert.equal(segs.length, 1, `D4: notice+contract formatting variant → one segment; got ${JSON.stringify(segs)}`);
  console.log("PASS D4: notice + contract address variant collapsed to one segment");
}
