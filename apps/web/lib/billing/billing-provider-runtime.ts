import type { BillingProviderDescriptor, BillingProviderKind } from "@tendery/core";
import { isRobokassaEnabled, robokassaReadyForCheckout } from "@/lib/billing/robokassa/env";

/**
 * Рантайм-конфигурация BillingProvider (ТЗ п. 5.2).
 * Приоритет: Robokassa (если включена и собрана) → stub → none.
 */
export function resolveBillingProviderDescriptor(): BillingProviderDescriptor {
  if (isRobokassaEnabled() && robokassaReadyForCheckout()) {
    return { kind: "robokassa", label: "Robokassa" };
  }

  const raw = (process.env.BILLING_PROVIDER ?? "none").trim().toLowerCase();
  const kind: BillingProviderKind = raw === "stub" ? "stub" : "none";
  return {
    kind,
    label: kind === "stub" ? "stub (демо-оплата)" : "none"
  };
}

/** Разрешён ли переход на Стартер через демо-эндпоинт без внешней кассы (только для песочницы). */
export function isStubBillingUpgradeEnabled(): boolean {
  return resolveBillingProviderDescriptor().kind === "stub";
}
