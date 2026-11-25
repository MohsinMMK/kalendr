import { describe, expect, it } from "vitest";

import { createTwilioChannel, twilioSignature } from "./sms-twilio";
import { WebhookSignatureError, type ChannelMessage } from "./types";

const approvedText = "Hi {#var#}, a reminder of your booking with {#var#} on {#var#}. Manage: {#var#}";
const message: ChannelMessage = {
  tenantId: "t1",
  to: "+14155550100",
  idempotencyKey: "sms:k",
  content: {
    kind: "template",
    templateKey: "reminder",
    provider: { name: "reminder", approvedText },
    language: "en",
    variables: ["Sam", "Acme", "Mon 10:30", "https://k.test/m/aaaaaaaaaa"],
  },
};

function setup(respond: () => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    return respond();
  };
  const channel = createTwilioChannel({ accountSid: "AC123", authToken: "12345", from: "+15005550006", fetch: fakeFetch });
  return { channel, calls };
}

describe("Twilio send", () => {
  it("posts the filled-in approved text with basic auth", async () => {
    const { channel, calls } = setup(() => Response.json({ sid: "SM1", num_segments: "1" }, { status: 201 }));
    expect(await channel.send(message)).toEqual({ status: "sent", providerMessageId: "SM1", segments: 1 });
    expect(calls[0]!.url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe(`Basic ${Buffer.from("AC123:12345").toString("base64")}`);
    const form = new URLSearchParams(String(calls[0]!.init.body));
    expect(form.get("To")).toBe("+14155550100");
    expect(form.get("From")).toBe("+15005550006");
    expect(form.get("Body")).toBe("Hi Sam, a reminder of your booking with Acme on Mon 10:30. Manage: https://k.test/m/aaaaaaaaaa");
  });

  it("maps errors the same way as the other SMS channel", async () => {
    expect(await setup(() => new Response("{}", { status: 500 })).channel.send(message)).toEqual({ status: "retry", code: "http_500" });
    expect(await setup(() => Response.json({ code: 21211 }, { status: 400 })).channel.send(message)).toEqual({ status: "rejected", code: "twilio_21211" });
    expect(await setup(() => Response.json({})).channel.send({ ...message, content: { kind: "text", body: "x" } })).toEqual({ status: "rejected", code: "template_required" });
  });
});

// The worked example in Twilio's "Webhooks security" page.
const docUrl = "https://example.com/myapp.php?foo=1&bar=2";
const docFields: Array<[string, string]> = [
  ["From", "+14158675310"], ["To", "+18005551212"], ["CallSid", "CA1234567890ABCDE"], ["Caller", "+14158675310"], ["Digits", "1234"],
];
const docSignature = "L/OH5YylLD5NRKLltdqwSvS0BnU=";

describe("Twilio signature", () => {
  it("matches the known answer from Twilio's documentation", () => {
    expect(twilioSignature("12345", docUrl, docFields)).toBe(docSignature);
  });

  function callback(fields: Array<[string, string]>, signature: string | null, url = docUrl) {
    const { channel } = setup(() => Response.json({}));
    const headers = new Headers(signature ? { "x-twilio-signature": signature } : {});
    return () => channel.parseWebhook({ rawBody: new URLSearchParams(fields).toString(), headers, url });
  }

  it("accepts a signed status callback and maps it", () => {
    const fields: Array<[string, string]> = [["MessageSid", "SM1"], ["MessageStatus", "delivered"]];
    const signature = twilioSignature("12345", docUrl, fields);
    expect(callback(fields, signature)().statuses).toEqual([{ eventId: "SM1:delivered", providerMessageId: "SM1", state: "delivered", failureCode: undefined }]);
  });

  it("maps failures to a short code and ignores queued", () => {
    const failed: Array<[string, string]> = [["MessageSid", "SM2"], ["MessageStatus", "undelivered"], ["ErrorCode", "30003"]];
    expect(callback(failed, twilioSignature("12345", docUrl, failed))().statuses[0]).toMatchObject({ state: "failed", failureCode: "twilio_30003" });
    const queued: Array<[string, string]> = [["MessageSid", "SM3"], ["MessageStatus", "queued"]];
    expect(callback(queued, twilioSignature("12345", docUrl, queued))().statuses).toEqual([]);
  });

  it("refuses a missing, wrong or tampered signature, or a different URL", () => {
    const fields: Array<[string, string]> = [["MessageSid", "SM1"], ["MessageStatus", "delivered"]];
    const signature = twilioSignature("12345", docUrl, fields);
    expect(callback(fields, null)).toThrow(WebhookSignatureError);
    expect(callback(fields, "AAAA")).toThrow(WebhookSignatureError);
    expect(callback([["MessageSid", "SM1"], ["MessageStatus", "failed"]], signature)).toThrow(WebhookSignatureError);
    expect(callback(fields, signature, "https://evil.example/myapp.php?foo=1&bar=2")).toThrow(WebhookSignatureError);
    expect(callback(fields, twilioSignature("wrong-token", docUrl, fields))).toThrow(WebhookSignatureError);
  });
});
