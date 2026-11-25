import type { CheckoutResult } from "@/lib/billing-contracts";
import { loadRazorpayScript } from "@/lib/razorpay-script";

interface RazorpayOptions {
  key: string;
  subscription_id: string;
  name: string;
  description: string;
  handler: () => void;
  modal: { ondismiss: () => void };
  theme: { color: string };
}
type RazorpayConstructor = new (options: RazorpayOptions) => { open: () => void };

/** The booking pages also type `window.Razorpay`, so read it as unknown here instead of declaring it a second time. */
function isConstructor(value: unknown): value is RazorpayConstructor {
  return typeof value === "function";
}
function installed(): RazorpayConstructor | null {
  const value: unknown = typeof window === "undefined" ? undefined : Reflect.get(window, "Razorpay");
  return isConstructor(value) ? value : null;
}

export async function loadRazorpay(): Promise<RazorpayConstructor> {
  await loadRazorpayScript();
  const started = installed();
  if (!started) throw new Error("Razorpay did not start.");
  return started;
}

export interface CheckoutDeps {
  loadRazorpay: typeof loadRazorpay;
  navigate: (url: string) => void;
}

export const browserCheckoutDeps: CheckoutDeps = { loadRazorpay, navigate: (url) => window.location.assign(url) };

/**
 * What happened after the server prepared checkout: the page left for Stripe, the Razorpay sheet took a payment, the
 * person closed it, or there was nothing to pay (a downgrade scheduled).
 */
export type CheckoutOutcome = "redirected" | "paid" | "dismissed" | "done";

export async function runCheckout(result: CheckoutResult, deps: CheckoutDeps = browserCheckoutDeps): Promise<CheckoutOutcome> {
  if (result.kind === "done") return "done";
  if (result.kind === "redirect") {
    deps.navigate(result.url);
    return "redirected";
  }
  const Razorpay = await deps.loadRazorpay();
  return new Promise<CheckoutOutcome>((resolve) => {
    const sheet = new Razorpay({
      key: result.keyId,
      subscription_id: result.subscriptionId,
      name: "Kalendr",
      description: "Kalendr plan",
      handler: () => resolve("paid"),
      modal: { ondismiss: () => resolve("dismissed") },
      theme: { color: "#315CCE" },
    });
    sheet.open();
  });
}
