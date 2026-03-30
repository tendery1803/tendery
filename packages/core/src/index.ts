export const coreVersion = "0.0.0";

export type { BillingPlanCode, BillingProviderDescriptor, BillingProviderKind } from "./billing";

export { maskRussianFioPatronymic } from "./russian-fio-mask";

export type { ProcurementSpan } from "./procurement-protected-spans";
export {
  forOutsideProcurementSpans,
  mergeProcurementSpans,
  procurementProtectedSpans
} from "./procurement-protected-spans";

