import { describe, expect, it, vi } from "vitest";

import { signedWhatsAppRequest } from "@/test/whatsapp-webhook";
import { buttonTapCallback, inboundTextCallback, statusCallback, TEST_WHATSAPP_APP_SECRET } from "@/test/whatsapp-webhook";

import { toE164 } from "./phone";
import { isStopMessage } from "./stop-words";
import { WebhookSignatureError, type ChannelMessage } from "./types";
import { answerVerification, buildSendBody, createWhatsAppChannel, parseCallback, verifySignature } from "./whatsapp-cloud";

const reminder: ChannelMessage = {
  tenantId: "t1",
  to: "+919876543210",
  idempotencyKey: "k1",
  content: {
    kind: "template",
    templateKey: "reminder",
    language: "en",
    variables: ["Asha", "Lotus", "Check-up", "Mon 10 am", "https://x/manage/abc"],
    buttons: [{ label: "Confirm", payload: "confirm:appt1" }, { label: "Reschedule", payload: "reschedule:appt1" }],
    provider: { name: "kalendr_reminder" },
  },
};

const channel = (fetchImpl: typeof fetch) => createWhatsAppChannel({ accessToken: "tok", phoneNumberId: "123", appSecret: TEST_WHATSAPP_APP_SECRET, fetchImpl });

describe("WhatsApp send", () => {
  it("builds a template with ordered variables and two quick-reply buttons, no plus sign on the number", () => {
    const body = buildSendBody(reminder) as { to: string; template: { name: string; components: Array<{ type: string; sub_type?: string; index?: string; parameters: unknown[] }> } };
    expect(body.to).toBe("919876543210");
    expect(body.template.name).toBe("kalendr_reminder");
    expect(body.template.components[0]!.parameters).toHaveLength(5);
    const buttons = body.template.components.filter((component) => component.type === "button");
    expect(buttons.map((button) => [button.sub_type, button.index])).toEqual([["quick_reply", "0"], ["quick_reply", "1"]]);
  });

  it("builds an authentication template with the code in the body and again in a url-type copy-code button at index 0", () => {
    const body = buildSendBody({
      tenantId: "platform",
      to: "+919876543210",
      idempotencyKey: "code-delivery:1:whatsapp",
      content: { kind: "template", templateKey: "sign_in_code", language: "en", variables: ["482913"], copyCode: "482913", provider: { name: "kalendr_sign_in_code" } },
    }) as { template: { components: unknown[] } };
    expect(body.template.components).toEqual([
      { type: "body", parameters: [{ type: "text", text: "482913" }] },
      { type: "button", sub_type: "url", index: "0", parameters: [{ type: "text", text: "482913" }] },
    ]);
  });

  it("sends with the bearer token and returns Meta's message id", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => Response.json({ messages: [{ id: "wamid.1" }] }));
    const result = await channel(fetchImpl).send(reminder);
    expect(result).toEqual({ status: "sent", providerMessageId: "wamid.1" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://graph.facebook.com/v23.0/123/messages");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("retries rate limits, outages and network errors, and refuses a number that is not on WhatsApp", async () => {
    expect(await channel(async () => Response.json({ error: { code: 130429 } }, { status: 400 })).send(reminder)).toMatchObject({ status: "retry" });
    expect(await channel(async () => Response.json({}, { status: 503 })).send(reminder)).toMatchObject({ status: "retry" });
    expect(await channel(async () => { throw new Error("offline"); }).send(reminder)).toEqual({ status: "retry", code: "whatsapp_network_error" });
    expect(await channel(async () => Response.json({ error: { code: 131026 } }, { status: 400 })).send(reminder)).toEqual({ status: "rejected", code: "whatsapp_131026" });
  });

  it("refuses email content", async () => {
    const result = await channel(async () => Response.json({})).send({ ...reminder, content: { kind: "email", subject: "s", html: "h", text: "t" } });
    expect(result.status).toBe("rejected");
  });
});

describe("WhatsApp webhook", () => {
  it("accepts a body signed with the app secret and refuses a wrong or missing signature", () => {
    const request = signedWhatsAppRequest(TEST_WHATSAPP_APP_SECRET, statusCallback("wamid.1", "delivered"));
    const wa = channel(async () => Response.json({}));
    expect(wa.parseWebhook({ rawBody: request.body, headers: new Headers(request.headers), url: "http://x" }).statuses).toHaveLength(1);
    const forged = signedWhatsAppRequest("another-secret", statusCallback("wamid.1", "delivered"));
    expect(() => wa.parseWebhook({ rawBody: forged.body, headers: new Headers(forged.headers), url: "http://x" })).toThrow(WebhookSignatureError);
    expect(() => wa.parseWebhook({ rawBody: request.body, headers: new Headers(), url: "http://x" })).toThrow(WebhookSignatureError);
    expect(() => wa.parseWebhook({ rawBody: `${request.body} `, headers: new Headers(request.headers), url: "http://x" })).toThrow(WebhookSignatureError);
  });

  it("refuses everything when no app secret is set", () => {
    const wa = createWhatsAppChannel({ accessToken: "t", phoneNumberId: "1" });
    const request = signedWhatsAppRequest(TEST_WHATSAPP_APP_SECRET, statusCallback("wamid.1", "sent"));
    expect(() => wa.parseWebhook({ rawBody: request.body, headers: new Headers(request.headers), url: "http://x" })).toThrow(WebhookSignatureError);
  });

  it("compares signatures without throwing on a different length", () => {
    expect(() => verifySignature("s", "{}", "sha256=short")).toThrow(WebhookSignatureError);
  });

  it("reads statuses with their pricing category and failure code, one event per status", () => {
    const parsed = parseCallback(JSON.stringify(statusCallback("wamid.9", "failed", "marketing")));
    expect(parsed.statuses).toEqual([{ eventId: "wamid.9:failed", providerMessageId: "wamid.9", state: "failed", failureCode: "whatsapp_131026", costCategory: "marketing" }]);
  });

  it("reads one callback that carries several statuses and messages", () => {
    const body = {
      entry: [{ changes: [{ field: "messages", value: {
        statuses: [{ id: "a", status: "sent" }, { id: "b", status: "read" }, { id: "c", status: "deleted" }],
        messages: [
          { id: "m1", from: "919876543210", type: "text", text: { body: "hello" } },
          { id: "m2", from: "919876543210", type: "image" },
        ],
      } }] }],
    };
    const parsed = parseCallback(JSON.stringify(body));
    expect(parsed.statuses.map((status) => status.eventId)).toEqual(["a:sent", "b:read"]);
    expect(parsed.inbound.map((message) => message.content.kind)).toEqual(["text", "other"]);
    expect(parsed.inbound[0]!.from).toBe("+919876543210");
  });

  it("reads a quick-reply tap with the message it answers", () => {
    const parsed = parseCallback(JSON.stringify(buttonTapCallback("+919876543210", "m3", "confirm:appt1", "Confirm", "wamid.reminder")));
    expect(parsed.inbound[0]).toMatchObject({ contextMessageId: "wamid.reminder", content: { kind: "button", payload: "confirm:appt1", label: "Confirm" } });
  });

  it("reads template approval changes", () => {
    const body = { entry: [{ changes: [{ field: "message_template_status_update", value: { event: "REJECTED", message_template_name: "kalendr_reminder", message_template_language: "en", reason: "INCORRECT_CATEGORY" } }] }] };
    expect(parseCallback(JSON.stringify(body)).templates).toEqual([
      { eventId: "tpl:kalendr_reminder:en:REJECTED", providerTemplateName: "kalendr_reminder", language: "en", status: "rejected", reason: "INCORRECT_CATEGORY" },
    ]);
  });

  it("treats a body that is not JSON as unauthenticated rather than crashing", () => {
    expect(() => parseCallback("not json")).toThrow(WebhookSignatureError);
  });

  it("answers Meta's address check only for the right token", () => {
    const ask = (token: string) => new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": token, "hub.challenge": "1158201444" });
    expect(answerVerification(ask("good-token"), "good-token")).toBe("1158201444");
    expect(answerVerification(ask("bad-token"), "good-token")).toBeNull();
    expect(answerVerification(ask("good-token"), undefined)).toBeNull();
  });
});

describe("phone numbers and STOP", () => {
  it("normalises to E.164 with the business's country and refuses what does not parse", () => {
    expect(toE164("98765 43210")).toBe("+919876543210");
    expect(toE164("+1 415 555 2671", "IN")).toBe("+14155552671");
    expect(toE164("12345")).toBeNull();
    expect(toE164("")).toBeNull();
  });

  it("recognises STOP words as a whole message only", () => {
    for (const text of ["STOP", " stop. ", "Unsubscribe", "बंद"]) expect(isStopMessage(text)).toBe(true);
    for (const text of ["please don't stop the reminders", "stop by tomorrow?", ""]) expect(isStopMessage(text)).toBe(false);
  });
});

describe("inbound text", () => {
  it("carries the sender as E.164", () => {
    expect(parseCallback(JSON.stringify(inboundTextCallback("+919876543210", "m1", "hi"))).inbound[0]!.from).toBe("+919876543210");
  });
});
