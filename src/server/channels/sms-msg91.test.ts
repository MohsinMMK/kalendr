import { describe, expect, it } from "vitest";

import { createMsg91Channel, parseMsg91Reports } from "./sms-msg91";
import { WebhookSignatureError, type ChannelMessage } from "./types";

const approvedText = "Hi {#var#}, your booking with {#var#} is confirmed for {#var#}. Manage: {#var#}";

function message(overrides: Partial<ChannelMessage["content"]> = {}): ChannelMessage {
  return {
    tenantId: "t1",
    to: "+919876543210",
    idempotencyKey: "sms:k",
    content: {
      kind: "template",
      templateKey: "booking_confirmed",
      provider: { name: "booking_confirmed", templateId: "flow123", approvedText },
      language: "en",
      variables: ["Asha", "Lotus Dental", "Mon 16 Nov, 10:30 am", "https://k.in/m/abcdefghij"],
      ...overrides,
    } as ChannelMessage["content"],
  };
}

function setup(respond: () => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return respond();
  };
  const channel = createMsg91Channel({ authKey: "key-1", senderId: "KALNDR", fetch: fakeFetch });
  return { channel, calls };
}

describe("MSG91 send", () => {
  it("posts the template id and variables only, with the authkey header", async () => {
    const { channel, calls } = setup(() => Response.json({ type: "success", message: "req-abc" }));
    const result = await channel.send(message());
    expect(result).toEqual({ status: "sent", providerMessageId: "req-abc", segments: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.msg91.com/api/v5/flow/");
    expect(calls[0]!.init.method).toBe("POST");
    expect(new Headers(calls[0]!.init.headers).get("authkey")).toBe("key-1");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      template_id: "flow123",
      short_url: "0",
      recipients: [{
        mobiles: "919876543210",
        VAR1: "Asha", VAR2: "Lotus Dental", VAR3: "Mon 16 Nov, 10:30 am", VAR4: "https://k.in/m/abcdefghij",
      }],
    });
    // No free text reaches the provider.
    expect(String(calls[0]!.init.body)).not.toContain("your booking with");
  });

  it("counts Hindi wording as Unicode segments", async () => {
    const { channel } = setup(() => Response.json({ type: "success", message: "req-hi" }));
    const hindi = "नमस्ते {#var#}, {#var#} के साथ आपकी बुकिंग {#var#} के लिए पक्की है। प्रबंधित करें: {#var#}";
    const result = await channel.send(message({ provider: { name: "x", templateId: "f", approvedText: hindi } }));
    expect(result).toMatchObject({ status: "sent", segments: 2 });
  });

  it("refuses free text, other content and a missing template id without calling out", async () => {
    const { channel, calls } = setup(() => Response.json({}));
    expect(await channel.send({ ...message(), content: { kind: "text", body: "hello" } })).toEqual({ status: "rejected", code: "template_required" });
    expect(await channel.send(message({ provider: { name: "x", approvedText } }))).toEqual({ status: "rejected", code: "no_dlt_template_id" });
    expect(calls).toHaveLength(0);
  });

  it("retries on 429, 5xx and network errors; rejects other 4xx", async () => {
    expect(await setup(() => new Response("{}", { status: 429 })).channel.send(message())).toEqual({ status: "retry", code: "http_429" });
    expect(await setup(() => new Response("{}", { status: 503 })).channel.send(message())).toEqual({ status: "retry", code: "http_503" });
    expect(await setup(() => new Response("{}", { status: 401 })).channel.send(message())).toEqual({ status: "rejected", code: "http_401" });
    expect(await setup(() => { throw new TypeError("offline"); }).channel.send(message())).toEqual({ status: "retry", code: "network_error" });
  });

  it("rejects an error answer and retries an unreadable one", async () => {
    expect(await setup(() => Response.json({ type: "error", message: "Template not found" })).channel.send(message())).toEqual({ status: "rejected", code: "msg91_refused" });
    expect(await setup(() => new Response("<html>")).channel.send(message())).toEqual({ status: "retry", code: "bad_response" });
  });
});

describe("MSG91 delivery reports", () => {
  it("reads delivered, failed and sent reports with stable event ids", () => {
    const events = parseMsg91Reports(JSON.stringify([
      { requestId: "r1", telNum: "919876543210", status: 1 },
      { requestId: "r2", status: "2", failureReason: "Number blocked" },
      { requestId: "r3", status: 9 },
      { requestId: "r4", status: 0 },
    ]));
    expect(events).toEqual([
      { eventId: "r1:delivered", providerMessageId: "r1", state: "delivered" },
      { eventId: "r2:failed", providerMessageId: "r2", state: "failed", failureCode: "undelivered" },
      { eventId: "r3:failed", providerMessageId: "r3", state: "failed", failureCode: "ndnc" },
      { eventId: "r4:sent", providerMessageId: "r4", state: "sent" },
    ]);
  });

  it("reads the older nested format and a single object, and ignores unknown statuses", () => {
    expect(parseMsg91Reports(JSON.stringify({ request_id: "r9", report: [{ status: "1", desc: "DELIVERED" }] })))
      .toEqual([{ eventId: "r9:delivered", providerMessageId: "r9", state: "delivered" }]);
    expect(parseMsg91Reports(JSON.stringify({ requestId: "r8", status: 7 }))).toEqual([]);
  });

  it("throws on a body that is not a report", () => {
    expect(() => parseMsg91Reports("not json")).toThrow(WebhookSignatureError);
    expect(() => parseMsg91Reports('"text"')).toThrow(WebhookSignatureError);
  });
});
