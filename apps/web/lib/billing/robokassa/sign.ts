import crypto from "node:crypto";

/** Подпись для перехода на оплату: MD5(MerchantLogin:OutSum:InvId:Password1) */
export function signRobokassaPaymentRequest(
  merchantLogin: string,
  outSum: string,
  invId: number,
  password1: string
): string {
  const base = `${merchantLogin}:${outSum}:${invId}:${password1}`;
  return crypto.createHash("md5").update(base, "utf8").digest("hex").toUpperCase();
}

/** Проверка уведомления Result URL: MD5(OutSum:InvId:Password2) */
export function expectedRobokassaResultSignature(
  outSum: string,
  invId: string,
  password2: string
): string {
  const base = `${outSum}:${invId}:${password2}`;
  return crypto.createHash("md5").update(base, "utf8").digest("hex").toUpperCase();
}

export function verifyRobokassaResultSignature(
  outSum: string,
  invId: string,
  password2: string,
  signatureValue: string
): boolean {
  const expected = expectedRobokassaResultSignature(outSum, invId, password2);
  const got = (signatureValue ?? "").trim().toUpperCase();
  try {
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(got, "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
