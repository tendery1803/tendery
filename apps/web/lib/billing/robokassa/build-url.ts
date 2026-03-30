import { signRobokassaPaymentRequest } from "./sign";
import {
  robokassaMerchantLogin,
  robokassaPassword1,
  robokassaPaymentBaseUrl,
  robokassaUseTestMode
} from "./env";

export function buildRobokassaPaymentUrl(input: {
  outSum: string;
  invId: number;
  description: string;
  successUrl?: string | null;
  failUrl?: string | null;
}): string {
  const login = robokassaMerchantLogin();
  const pass1 = robokassaPassword1();
  if (!login || !pass1) throw new Error("robokassa_config_incomplete");

  const signatureValue = signRobokassaPaymentRequest(login, input.outSum, input.invId, pass1);

  const params = new URLSearchParams();
  params.set("MerchantLogin", login);
  params.set("OutSum", input.outSum);
  params.set("InvId", String(input.invId));
  params.set("Description", input.description);
  params.set("SignatureValue", signatureValue);
  params.set("Encoding", "utf-8");
  if (robokassaUseTestMode()) {
    params.set("IsTest", "1");
  }
  if (input.successUrl) params.set("SuccessURL", input.successUrl);
  if (input.failUrl) params.set("FailURL", input.failUrl);

  const base = robokassaPaymentBaseUrl();
  return `${base}?${params.toString()}`;
}
