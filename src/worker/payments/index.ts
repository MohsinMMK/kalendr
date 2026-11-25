import type { ProviderEnvironment } from "../../server/payments/index";
import { REFUND_EVENT } from "../../server/payments/ledger";
import type { EventHandler } from "../handlers/types";
import { paymentEventHandler } from "./event";
import { reconcileHandler, RECONCILE_EVENT } from "./reconcile";
import { refundProcessHandler } from "./refund";

export const PAYMENT_EVENT = "payment.event";

export interface PaymentDeps extends ProviderEnvironment {
  now?: () => Date;
}

/** The payment event types and their handlers (feature 23), for the worker's registry. */
export function paymentHandlers(deps: PaymentDeps = {}): [string, EventHandler][] {
  return [
    [PAYMENT_EVENT, paymentEventHandler(deps.now ?? (() => new Date()))],
    [REFUND_EVENT, refundProcessHandler(deps)],
    [RECONCILE_EVENT, reconcileHandler(deps)],
  ];
}
