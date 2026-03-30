/**
 * Контракт слоя биллинга (ТЗ п. 5.2 — BillingProvider).
 * Реализации провайдеров оплаты живут в приложении (web), здесь — только типы и идентификаторы.
 */

export type BillingPlanCode = "demo" | "starter";

/** Подключённый «движок» оплаты. */
export type BillingProviderKind = "none" | "stub" | "robokassa";

export interface BillingProviderDescriptor {
  kind: BillingProviderKind;
  /** Человекочитаемое имя для логов / админки. */
  label: string;
}
