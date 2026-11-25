import { describe, expect, it } from "vitest";

import { createFake, FAKE_SIGNATURE_HEADER, signFakeWebhook } from "./fake";
import { createRazorpay, razorpayMethod } from "./razorpay";
import { hmacHex } from "./signature";
import { createStripe, stripeEventAccount, verifyStripeSignature } from "./stripe";
import { ProviderError, WebhookSignatureError, type ProviderCredentials } from "./types";

const credentials: ProviderCredentials = { keyId: "rzp_test_abc123", keySecret: "key-secret", webhookSecret: "webhook-secret" };

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

describe("Razorpay", () => {
  const captured = JSON.stringify({
    event: "payment.captured",
    payload: { payment: { entity: { id: "pay_1", order_id: "order_1", amount: 20000, currency: "INR", method: "upi", email: "private@example.com", contact: "+919999999999" } } },
  });
  const signed = (body: string, secret = credentials.webhookSecret) => new Headers({ "x-razorpay-signature": hmacHex(secret, body), "x-razorpay-event-id": "evt_1" });

  it("accepts a correctly signed capture and keeps only ids, amount and method", () => {
    const event = createRazorpay().parseWebhook(credentials, captured, signed(captured));
    expect(event).toEqual({ kind: "payment.captured", eventId: "evt_1", providerOrderId: "order_1", providerPaymentId: "pay_1", amountMinor: 20000, currency: "INR", method: "upi" });
    expect(JSON.stringify(event)).not.toContain("private@example.com");
  });

  it("refuses a forged, missing, wrong-secret or tampered signature", () => {
    const provider = createRazorpay();
    expect(() => provider.parseWebhook(credentials, captured, new Headers({ "x-razorpay-signature": "0".repeat(64), "x-razorpay-event-id": "evt_1" }))).toThrow(WebhookSignatureError);
    expect(() => provider.parseWebhook(credentials, captured, new Headers({ "x-razorpay-event-id": "evt_1" }))).toThrow(WebhookSignatureError);
    expect(() => provider.parseWebhook(credentials, captured, signed(captured, "another-secret"))).toThrow(WebhookSignatureError);
    expect(() => provider.parseWebhook(credentials, captured.replace("20000", "100"), signed(captured))).toThrow(WebhookSignatureError);
    expect(() => provider.parseWebhook(credentials, captured, new Headers({ "x-razorpay-signature": hmacHex(credentials.webhookSecret, captured) }))).toThrow(WebhookSignatureError);
  });

  it("reads refunds and failures, and ignores what it does not know", () => {
    const provider = createRazorpay();
    const refund = JSON.stringify({ event: "refund.processed", payload: { refund: { entity: { id: "rfnd_1", payment_id: "pay_1", amount: 500, currency: "INR" } } } });
    expect(provider.parseWebhook(credentials, refund, signed(refund))).toMatchObject({ kind: "refund.processed", providerRefundId: "rfnd_1", providerPaymentId: "pay_1", amountMinor: 500 });
    const failed = JSON.stringify({ event: "payment.failed", payload: { payment: { entity: { id: "pay_2", order_id: "order_2" } } } });
    expect(provider.parseWebhook(credentials, failed, signed(failed))).toMatchObject({ kind: "payment.failed", providerOrderId: "order_2" });
    const other = JSON.stringify({ event: "order.paid", payload: {} });
    expect(provider.parseWebhook(credentials, other, signed(other))).toMatchObject({ kind: "ignored" });
    expect(createRazorpay().parseWebhook(credentials, "not json", signed("not json"))).toMatchObject({ kind: "ignored" });
  });

  it("maps methods onto the ledger's four", () => {
    expect([razorpayMethod("upi"), razorpayMethod("card"), razorpayMethod("netbanking"), razorpayMethod("wallet"), razorpayMethod(undefined)]).toEqual(["upi", "card", "bank", "other", "other"]);
  });

  it("creates an order in paise with its own keys and sends a refund with an idempotency key", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const provider = createRazorpay((url, init) => {
      calls.push({ url, init });
      return url.endsWith("/orders") ? json({ id: "order_9" }) : json({ id: "rfnd_9", status: "processed" });
    });
    const order = await provider.createOrder(credentials, { amountMinor: 20000, currency: "INR", reference: "ord-1", businessName: "Lotus", returnUrl: "https://x/manage/t", description: "Cleaning", expiresAt: new Date() });
    expect(order).toEqual({ providerOrderId: "order_9", checkoutUrl: null });
    expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ amount: 20000, currency: "INR", receipt: "ord-1" });
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("rzp_test_abc123:key-secret").toString("base64")}`);
    const refund = await provider.refund(credentials, { providerPaymentId: "pay_1", amountMinor: 20000, currency: "INR", idempotencyKey: "req-1" });
    expect(refund).toEqual({ providerRefundId: "rfnd_9", status: "processed" });
    expect((calls[1]?.init.headers as Record<string, string>)["X-Refund-Idempotency"]).toBe("req-1");
  });

  it("says whether a failure is worth retrying", async () => {
    await expect(createRazorpay(() => json({}, 401)).verifyAccount(credentials)).rejects.toMatchObject({ code: "provider_rejected_keys", retryable: false });
    await expect(createRazorpay(() => json({}, 503)).verifyAccount(credentials)).rejects.toMatchObject({ retryable: true });
    await expect(createRazorpay(() => Promise.reject(new Error("offline"))).verifyAccount(credentials)).rejects.toBeInstanceOf(ProviderError);
    await expect(createRazorpay(() => json({ nothing: true })).createOrder(credentials, { amountMinor: 1, currency: "INR", reference: "r", businessName: "b", returnUrl: "u", description: "d", expiresAt: new Date() })).rejects.toMatchObject({ code: "provider_unexpected_response" });
  });
});

describe("Stripe", () => {
  const secret = "whsec_test_secret";
  const now = new Date("2026-11-19T12:00:00.000Z");
  const stamp = Math.floor(now.getTime() / 1000);
  const body = JSON.stringify({
    id: "evt_s1", type: "checkout.session.completed", account: "acct_123",
    data: { object: { id: "cs_1", payment_status: "paid", payment_intent: "pi_1", amount_total: 20000, currency: "inr" } },
  });
  const header = (payload: string, at = stamp, key = secret) => `t=${at},v1=${hmacHex(key, `${at}.${payload}`)}`;
  const stripe = createStripe({ secretKey: "sk_test_x" }, undefined, () => now);
  const stripeCredentials = { keyId: "acct_123", keySecret: "", webhookSecret: secret };

  it("verifies the signature over the raw body and refuses old, forged or tampered ones", () => {
    expect(() => verifyStripeSignature(secret, body, header(body), now)).not.toThrow();
    expect(() => verifyStripeSignature(secret, body, header(body, stamp, "other"), now)).toThrow(WebhookSignatureError);
    expect(() => verifyStripeSignature(secret, body.replace("20000", "1"), header(body), now)).toThrow(WebhookSignatureError);
    expect(() => verifyStripeSignature(secret, body, header(body, stamp - 3600), now)).toThrow(WebhookSignatureError);
    expect(() => verifyStripeSignature(secret, body, null, now)).toThrow(WebhookSignatureError);
    expect(() => verifyStripeSignature(secret, body, "garbage", now)).toThrow(WebhookSignatureError);
  });

  it("turns a paid checkout session into a capture on the payment intent", () => {
    expect(stripe.parseWebhook(stripeCredentials, body, new Headers({ "stripe-signature": header(body) }))).toEqual({
      kind: "payment.captured", eventId: "evt_s1", providerOrderId: "cs_1", providerPaymentId: "pi_1", amountMinor: 20000, currency: "INR", method: "other",
    });
    expect(stripeEventAccount(body)).toBe("acct_123");
    expect(stripeEventAccount("nope")).toBeNull();
  });

  it("ignores an unpaid session and reads a succeeded refund", () => {
    const unpaid = body.replace('"paid"', '"unpaid"');
    expect(stripe.parseWebhook(stripeCredentials, unpaid, new Headers({ "stripe-signature": header(unpaid) }))).toMatchObject({ kind: "ignored" });
    const refund = JSON.stringify({ id: "evt_s2", type: "refund.updated", account: "acct_123", data: { object: { id: "re_1", payment_intent: "pi_1", amount: 500, currency: "inr", status: "succeeded" } } });
    expect(stripe.parseWebhook(stripeCredentials, refund, new Headers({ "stripe-signature": header(refund) }))).toMatchObject({ kind: "refund.processed", providerRefundId: "re_1", providerPaymentId: "pi_1" });
  });

  it("makes a checkout session on the connected account with an idempotency key", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const provider = createStripe({ secretKey: "sk_test_x" }, (url, init) => { seen.push({ url, init }); return json({ id: "cs_9", url: "https://checkout.stripe.com/c/pay/cs_9" }); }, () => now);
    const order = await provider.createOrder(stripeCredentials, { amountMinor: 20000, currency: "INR", reference: "ord-1", businessName: "Lotus", returnUrl: "https://x/manage/t?paid=1", description: "Cleaning", expiresAt: new Date(now.getTime() + 600_000) });
    expect(order).toEqual({ providerOrderId: "cs_9", checkoutUrl: "https://checkout.stripe.com/c/pay/cs_9" });
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers["Stripe-Account"]).toBe("acct_123");
    expect(headers["Idempotency-Key"]).toBe("order-ord-1");
    const form = new URLSearchParams(String(seen[0]?.init.body));
    expect(form.get("line_items[0][price_data][unit_amount]")).toBe("20000");
    expect(form.get("line_items[0][price_data][currency]")).toBe("inr");
    // Stripe will not take a session shorter than 30 minutes, whatever the hold is.
    expect(Number(form.get("expires_at")) - stamp).toBeGreaterThanOrEqual(30 * 60);
  });
});

describe("the built-in test provider", () => {
  const secret = "fake-secret";
  const provider = createFake();

  it("accepts only a body signed with the account's secret", () => {
    const signed = signFakeWebhook(secret, { id: "evt_f1", type: "payment.captured", orderId: "fake_x_y", paymentId: "pay_f1", amountMinor: 100, currency: "INR" });
    const event = provider.parseWebhook({ keyId: "k", keySecret: "", webhookSecret: secret }, signed.rawBody, new Headers({ [FAKE_SIGNATURE_HEADER]: signed.signature }));
    expect(event).toMatchObject({ kind: "payment.captured", amountMinor: 100, method: "upi" });
    expect(() => provider.parseWebhook({ keyId: "k", keySecret: "", webhookSecret: "wrong" }, signed.rawBody, new Headers({ [FAKE_SIGNATURE_HEADER]: signed.signature }))).toThrow(WebhookSignatureError);
    expect(() => provider.parseWebhook({ keyId: "k", keySecret: "", webhookSecret: secret }, signed.rawBody, new Headers())).toThrow(WebhookSignatureError);
  });

  it("gives the same refund back for the same idempotency key", async () => {
    const input = { providerPaymentId: "p", amountMinor: 1, currency: "INR", idempotencyKey: "same" };
    const a = await provider.refund({ keyId: "k", keySecret: "", webhookSecret: "" }, input);
    const b = await provider.refund({ keyId: "k", keySecret: "", webhookSecret: "" }, input);
    expect(a).toEqual(b);
  });
});
