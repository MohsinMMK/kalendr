/** @vitest-environment node */
import { describe, expect, it } from "vitest";

import { signedHeaders, TEST_WEBHOOK_SECRET } from "@/test/resend-webhook";

import { deliveryChange, verifyResendWebhook, WebhookSignatureError, type ResendEvent } from "./resend-webhook";

const event = (type: string, extra: Partial<ResendEvent["data"]> = {}): ResendEvent => ({
  type,
  data: { email_id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c", to: ["priya@example.com"], ...extra },
});

describe("verifyResendWebhook", () => {
  const body = JSON.stringify({ type: "email.delivered", created_at: "2026-11-12T10:00:00Z", data: event("email.delivered").data });

  it("accepts a correctly signed event", () => {
    const verified = verifyResendWebhook(TEST_WEBHOOK_SECRET, body, signedHeaders(TEST_WEBHOOK_SECRET, "msg_1", body));
    expect(verified.eventId).toBe("msg_1");
    expect(verified.event.type).toBe("email.delivered");
  });

  it("refuses a wrong secret, a changed body, an old timestamp, a missing or odd id", () => {
    const other = `whsec_${Buffer.from("another-secret-another-secret-00").toString("base64")}`;
    const headers = signedHeaders(TEST_WEBHOOK_SECRET, "msg_1", body);
    expect(() => verifyResendWebhook(other, body, headers)).toThrow(WebhookSignatureError);
    expect(() => verifyResendWebhook(TEST_WEBHOOK_SECRET, body.replace("delivered", "bounced"), headers)).toThrow(WebhookSignatureError);
    const old = signedHeaders(TEST_WEBHOOK_SECRET, "msg_1", body, new Date(Date.now() - 10 * 60_000));
    expect(() => verifyResendWebhook(TEST_WEBHOOK_SECRET, body, old)).toThrow(WebhookSignatureError);
    expect(() => verifyResendWebhook(TEST_WEBHOOK_SECRET, body, new Headers())).toThrow(WebhookSignatureError);
    const odd = signedHeaders(TEST_WEBHOOK_SECRET, "msg 1;drop", body);
    expect(() => verifyResendWebhook(TEST_WEBHOOK_SECRET, body, odd)).toThrow(WebhookSignatureError);
  });

  it("refuses a signed body that isn't a Resend event", () => {
    const junk = JSON.stringify({ hello: "world" });
    expect(() => verifyResendWebhook(TEST_WEBHOOK_SECRET, junk, signedHeaders(TEST_WEBHOOK_SECRET, "msg_2", junk))).toThrow(WebhookSignatureError);
  });
});

describe("deliveryChange", () => {
  it("maps each event to a status and, for hard bounces and complaints, a suppression", () => {
    expect(deliveryChange(event("email.delivered"))).toEqual({ status: "delivered", failureCode: null, suppress: null });
    expect(deliveryChange(event("email.bounced", { bounce: { type: "Permanent" } }))).toEqual({ status: "failed", failureCode: "bounced", suppress: "bounced" });
    expect(deliveryChange(event("email.bounced", { bounce: { type: "Transient" } }))).toEqual({ status: "failed", failureCode: "bounced_soft", suppress: null });
    expect(deliveryChange(event("email.complained"))).toEqual({ status: null, failureCode: null, suppress: "complained" });
    expect(deliveryChange(event("email.failed"))).toEqual({ status: "failed", failureCode: "provider_failed", suppress: null });
    expect(deliveryChange(event("email.opened"))).toEqual({ status: null, failureCode: null, suppress: null });
  });
});
