/**
 * The customer's side of paying online (feature 23): the calls to the server and the opening of a provider's
 * checkout. The browser never decides that something is paid (only the server's `confirmed` does) and never
 * reads, stores or logs card or UPI details: those are typed into the provider's own window.
 */
import type { BookingPaymentRequired, CheckoutSession, PaymentStatus, StartPaymentInput } from "@/lib/payments";
import { loadRazorpayScript } from "@/lib/razorpay-script";

export class PaymentRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "PaymentRequestError";
  }
}

/** A booking that was saved and now waits for payment (the answer to POST /api/public/appointments). */
export interface PendingPaymentBooking {
  appointmentId: string;
  manageToken: string;
  startsAt: string;
  endsAt: string;
  practitionerId?: string;
  payment: BookingPaymentRequired;
}

export async function postPublicJson<T>(url: string, body: unknown, fallback: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
  } catch {
    throw new PaymentRequestError("We could not reach the server. Check your connection and try again.", 0, "network");
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = (payload as { error?: { code?: unknown; message?: unknown } } | undefined)?.error;
    throw new PaymentRequestError(
      typeof error?.message === "string" ? error.message : fallback,
      response.status,
      typeof error?.code === "string" ? error.code : undefined,
    );
  }
  const data = (payload as { data?: T } | undefined)?.data;
  if (!data) throw new PaymentRequestError(fallback, response.status);
  return data;
}

/** POST /api/public/bookings/pay */
export function startPayment(input: StartPaymentInput): Promise<CheckoutSession> {
  return postPublicJson<CheckoutSession>("/api/public/bookings/pay", input, "We could not start the payment. Try again.");
}

/** POST /api/public/bookings/pay-link */
export function startPayLinkPayment(token: string): Promise<CheckoutSession> {
  return postPublicJson<CheckoutSession>("/api/public/bookings/pay-link", { token }, "We could not start the payment. Try again.");
}

/** POST /api/public/bookings/pay/status */
export function fetchPaymentStatus(input: StartPaymentInput): Promise<PaymentStatus> {
  return postPublicJson<PaymentStatus>("/api/public/bookings/pay/status", input, "We could not check the payment. Try again.");
}

/** True when the failure means the held time is gone (the server says the hold or booking expired). */
export function isExpiredError(error: unknown): boolean {
  return error instanceof PaymentRequestError && (error.status === 410 || /expired/i.test(error.code ?? ""));
}

// ---- checkout ---------------------------------------------------------------------------------

interface RazorpayOptions {
  key: string;
  order_id: string;
  amount: number;
  currency: string;
  name: string;
  handler: () => void;
  modal: { ondismiss: () => void };
  theme?: { color?: string };
}

interface RazorpayInstance {
  open(): void;
  on(event: "payment.failed", callback: () => void): void;
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

/** Loads Checkout.js once. A failed load can be tried again. */
export const loadRazorpay = loadRazorpayScript;

export interface CheckoutHandlers {
  /** The provider's window says it went through. Not proof: the screen only starts waiting for the server. */
  onSubmitted: () => void;
  /** The customer closed the provider's window without paying. */
  onDismissed: () => void;
  /** The provider's window said the payment failed. The customer can try again. */
  onFailed: () => void;
}

/** Only our own test checkout (a path on this site) and https pages are followed. */
export function safeCheckoutUrl(url: string | null): string | null {
  if (!url) return null;
  if (url.startsWith("/") && !url.startsWith("//") && !url.includes("\\")) return url;
  try {
    return new URL(url).protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/**
 * Opens the provider's checkout. Razorpay opens in a window on this page; Stripe and the built-in test
 * checkout are pages the browser goes to, and they send it back to the manage page.
 */
export async function openCheckout(session: CheckoutSession, handlers: CheckoutHandlers): Promise<void> {
  if (session.provider === "razorpay") {
    if (!session.keyId) throw new Error("Checkout is not set up for this business.");
    await loadRazorpay();
    if (!window.Razorpay) throw new Error("Checkout did not load.");
    const checkout = new window.Razorpay({
      key: session.keyId,
      order_id: session.orderId,
      amount: session.amountMinor,
      currency: session.currency,
      name: session.businessName,
      handler: () => handlers.onSubmitted(),
      modal: { ondismiss: () => handlers.onDismissed() },
    });
    checkout.on("payment.failed", () => handlers.onFailed());
    checkout.open();
    return;
  }
  const url = safeCheckoutUrl(session.checkoutUrl);
  if (!url) throw new Error("Checkout is not available right now.");
  window.location.assign(url);
}
