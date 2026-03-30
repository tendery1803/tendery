/**
 * Конфигурация Robokassa из env (секреты не логировать).
 */

export function isRobokassaEnabled(): boolean {
  return (process.env.ROBOKASSA_ENABLED ?? "").trim().toLowerCase() === "true";
}

export function robokassaUseTestMode(): boolean {
  return (process.env.ROBOKASSA_USE_TEST_MODE ?? "").trim().toLowerCase() === "true";
}

export function robokassaMerchantLogin(): string | null {
  const v = process.env.ROBOKASSA_MERCHANT_LOGIN?.trim();
  return v || null;
}

export function robokassaPassword1(): string | null {
  const test = robokassaUseTestMode();
  const v = test
    ? process.env.ROBOKASSA_TEST_PASSWORD_1?.trim()
    : process.env.ROBOKASSA_PASSWORD_1?.trim();
  return v || null;
}

export function robokassaPassword2(): string | null {
  const test = robokassaUseTestMode();
  const v = test
    ? process.env.ROBOKASSA_TEST_PASSWORD_2?.trim()
    : process.env.ROBOKASSA_PASSWORD_2?.trim();
  return v || null;
}

export function robokassaHashAlgorithm(): "MD5" {
  const raw = (process.env.ROBOKASSA_HASH_ALGORITHM ?? "MD5").trim().toUpperCase();
  if (raw !== "MD5") {
    throw new Error("ROBOKASSA_HASH_ALGORITHM: only MD5 is supported in MVP");
  }
  return "MD5";
}

export function robokassaResultUrl(): string | null {
  const v = process.env.ROBOKASSA_RESULT_URL?.trim();
  return v || null;
}

export function robokassaSuccessUrl(): string | null {
  const v = process.env.ROBOKASSA_SUCCESS_URL?.trim();
  return v || null;
}

export function robokassaFailUrl(): string | null {
  const v = process.env.ROBOKASSA_FAIL_URL?.trim();
  return v || null;
}

/** Сумма к оплате за тариф Стартер (руб., в форме 1234.56). */
export function robokassaStarterPriceRub(): string {
  const raw = process.env.ROBOKASSA_STARTER_PRICE_RUB?.trim();
  if (!raw) return "3900.00";
  const n = Number.parseFloat(raw.replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return "3900.00";
  return n.toFixed(2);
}

const PAY_BASE = "https://auth.robokassa.ru/Merchant/Index.aspx";

export function robokassaPaymentBaseUrl(): string {
  return process.env.ROBOKASSA_PAYMENT_BASE_URL?.trim() || PAY_BASE;
}

export function assertRobokassaConfiguredForCreate(): void {
  robokassaHashAlgorithm();
  if (!isRobokassaEnabled()) throw new Error("robokassa_disabled");
  if (!robokassaMerchantLogin()) throw new Error("robokassa_config_incomplete");
  if (!robokassaPassword1()) throw new Error("robokassa_config_incomplete");
  if (!robokassaPassword2()) throw new Error("robokassa_config_incomplete");
}

export function assertRobokassaConfiguredForResult(): void {
  robokassaHashAlgorithm();
  if (!isRobokassaEnabled()) throw new Error("robokassa_disabled");
  if (!robokassaMerchantLogin()) throw new Error("robokassa_config_incomplete");
  if (!robokassaPassword2()) throw new Error("robokassa_config_incomplete");
}

/** Достаточно ли env для кнопки «Оплатить» (без исключений наружу). */
export function robokassaReadyForCheckout(): boolean {
  if (!isRobokassaEnabled()) return false;
  try {
    robokassaHashAlgorithm();
  } catch {
    return false;
  }
  return Boolean(robokassaMerchantLogin() && robokassaPassword1() && robokassaPassword2());
}
