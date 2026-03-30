/**
 * Пост-разбор delivery_term: убрать процедурный шум закупки, сохранить срок поставки
 * и операционные условия (по заявкам заказчика, партии, дни до поставки и т.д.).
 */

/** Маркеры именно исполнения поставки / заявок заказчика на поставку. */
const SUPPLY_EXECUTION_HINT =
  /по\s+заявкам\s+заказчик|заявк[аи]\s+заказчик|партия|партиями|отдельн[а-яё]+\s+партий|поставк[аи]\s+(?:осуществля|производится|отгружа|выполня)|не\s+позднее|не\s+ранее|за\s+\d+\s+(?:рабоч|календарн)|рабочих?\s+дн|календарных?\s+дн|срок\s+поставки|период\s+поставки|дата\s+окончани[яе]\s+поставки|до\s+\d{1,2}[./]\d{1,2}[./]\d{2,4}|с\s+даты\s+заключен|по\s+\d{1,2}[./]\d{1,2}[./]\d{2,4}/i;

/** Согласование характеристик — оставляем только если связано со сроком/порядком поставки. */
const SPECS_AFFECTS_SUPPLY =
  /согласован[а-яё]*\s+характеристик.{0,80}(?:поставк|парт|заявк|срок|график|отгрузк)/i;

/** Оплата и прочие расчётные условия — не срок поставки. */
function isPaymentOrIrrelevantCommercialClause(s: string): boolean {
  const t = s.trim();
  if (!t) return true;
  // Сначала явная оплата: иначе «N рабочих дней» в SUPPLY_EXECUTION_HINT цепляет фразы про оплату.
  // `\b` в JS не работает с кириллицей — границы через начало/пробел/знаки.
  const paymentLike =
    /(?:^|[\s.;,(])оплат[аы]/i.test(t) ||
    /(?:^|[\s.;,(])расч[её]т/i.test(t) ||
    /аккредитив/i.test(t) ||
    /(?:^|[\s.;,(])плат[её]ж/i.test(t) ||
    /предоплат/i.test(t) ||
    /постоплат/i.test(t) ||
    /(?:^|[\s.;,(])ндс(?:[\s.,;)]|$)/i.test(t) ||
    /ставк[аи]\s+ндс/i.test(t) ||
    /цен[аы]\s+единиц/i.test(t) ||
    /стоимост/i.test(t) ||
    /банковск[а-яё]*\s+реквизит/i.test(t) ||
    /к\s+оплат[еы]/i.test(t) ||
    /сумм[аы]\s+оплат/i.test(t);
  if (paymentLike) return true;
  if (SUPPLY_EXECUTION_HINT.test(t)) return false;
  if (SPECS_AFFECTS_SUPPLY.test(t)) return false;
  if (
    /согласован[а-яё]*\s+характеристик/i.test(t) &&
    /(?:поставк|парт|срок|отгруз|заявк\s+заказчик)/i.test(t)
  ) {
    return false;
  }
  return false;
}

/** Чисто процедурные формулировки (этапы закупки), без исполнения поставки. */
function isProcedureOnlyClause(s: string): boolean {
  const t = s.trim();
  if (!t) return true;
  if (SUPPLY_EXECUTION_HINT.test(t)) return false;
  if (SPECS_AFFECTS_SUPPLY.test(t)) return false;
  return (
    /окончани[ея]\s+(?:подач[аи]|приёма)\s+заявок|начал[оа]\s+подач[аи]\s+заявок|подач[аи]\s+заявок\s+(?:участник|на\s+участи)|подведен[а-яё]*\s+итогов|вскрыти[а-яё]*|рассмотрен[а-яё]*\s+заявок(?:\s+участник)?|протокол\s+(?:об\s+)?итог|итог[а-яё]*\s+(?:конкурс|аукцион|закупк)|этап\s+процедур|дата\s+(?:вскрыти|рассмотрен)|приём\s+заявок\s+на\s+участи/i.test(
      t
    ) ||
    /(?:^|\s)упд(?:\s|$)/i.test(t) ||
    /универсальн[а-яё]*\s+передаточн[а-яё]*(?:\s+документ[а-яё]*)?/i.test(t) ||
    (/документооборот/i.test(t) && !SUPPLY_EXECUTION_HINT.test(t)) ||
    (/приёмк[аи]\s+товар/i.test(t) && !SUPPLY_EXECUTION_HINT.test(t) && t.length < 120)
  );
}

/** Разгрузка / расстановка / «своими силами» / «за счёт» — не срок поставки, если нет явных сроковых маркеров. */
function isLogisticsExecutionNoiseClause(s: string): boolean {
  const t = s.trim();
  if (!t) return true;
  if (SUPPLY_EXECUTION_HINT.test(t)) return false;
  if (SPECS_AFFECTS_SUPPLY.test(t)) return false;
  if (
    /согласован[а-яё]*\s+характеристик/i.test(t) &&
    /(?:поставк|парт|срок|отгруз|заявк\s+заказчик)/i.test(t)
  ) {
    return false;
  }
  const logisticsAnchor =
    /разгрузк[а-яё]*|расстановк[а-яё]*\s+по\s+местам|погрузк[а-яё]*\s+и\s+разгрузк/i.test(t);
  const whoPaysOrDoes =
    /своими\s+силами|за\s+(?:его|её|свой|свою)\s+сч[её]т|за\s+сч[её]т\s+поставщик/i.test(t);
  return logisticsAnchor && whoPaysOrDoes;
}

/** Граница предложения после даты ДД.ММ.ГГГГ. (точка после года не «ломает» разрез). */
const RE_DOT_AFTER_FULL_DATE = /(?<=\d{2}\.\d{2}\.\d{4})\.\s+(?=[А-ЯЁЁ])/gu;
/** Обычная граница: точка не сразу после цифры даты. */
const RE_DOT_SENTENCE_PLAIN = /(?<!\d)\.\s+(?=[А-ЯЁЁ])/gu;

function splitSentencesWithinClause(clause: string): string[] {
  const c = clause.trim();
  if (!c) return [];

  const stage1 = c.split(RE_DOT_AFTER_FULL_DATE).map((x) => x.trim()).filter(Boolean);
  const out: string[] = [];
  for (const piece of stage1) {
    const stage2 = piece.split(RE_DOT_SENTENCE_PLAIN).map((x) => x.trim()).filter(Boolean);
    out.push(...(stage2.length ? stage2 : [piece]));
  }
  return out.length ? out : [c];
}

function splitTermClauses(s: string): string[] {
  const t = s.replace(/\s+/g, " ").trim();
  if (!t) return [];
  const bySemi = t.split(/\s*;\s*/).map((x) => x.trim()).filter(Boolean);
  if (bySemi.length > 1) {
    return bySemi.flatMap((x) => splitSentencesWithinClause(x));
  }
  return splitSentencesWithinClause(t);
}

export function refineDeliveryTermAfterSanitize(value: string): string {
  const t = value.replace(/\s+/g, " ").trim();
  if (!t) return "";
  const clauses = splitTermClauses(t);
  const parts = clauses.filter(
    (p) =>
      !isProcedureOnlyClause(p) &&
      !isPaymentOrIrrelevantCommercialClause(p) &&
      !isLogisticsExecutionNoiseClause(p)
  );
  if (parts.length === 0) {
    const allNoise =
      clauses.length > 0 &&
      clauses.every(
        (c) =>
          isProcedureOnlyClause(c) ||
          isPaymentOrIrrelevantCommercialClause(c) ||
          isLogisticsExecutionNoiseClause(c)
      );
    return allNoise ? "" : t;
  }
  return parts.join("; ").replace(/\s*;\s*;/g, ";").replace(/\s{2,}/g, " ").trim();
}
