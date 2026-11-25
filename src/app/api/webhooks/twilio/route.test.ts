/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const intakeStatuses = vi.fn();
vi.mock("@/server/channels/webhook-intake", () => ({ intakeStatuses: (...args: unknown[]) => intakeStatuses(...args) }));

import { twilioSignature } from "@/server/channels/sms-twilio";

import { POST } from "./route";

const TOKEN = "twilio-test-token";
const PUBLIC_URL = "https://app.example.test/api/webhooks/twilio";
const fields: Array<[string, string]> = [["MessageSid", "SM1"], ["MessageStatus", "delivered"]];

// request.url is the internal address behind a proxy; the signature covers the public one.
const post = (signature: string | null, body = new URLSearchParams(fields).toString()) => POST(new Request("http://127.0.0.1:3202/api/webhooks/twilio", {
  method: "POST",
  body,
  headers: signature ? { "x-twilio-signature": signature, "content-type": "application/x-www-form-urlencoded" } : {},
}));

beforeEach(() => {
  vi.stubEnv("TWILIO_AUTH_TOKEN", TOKEN);
  vi.stubEnv("BETTER_AUTH_URL", "https://app.example.test");
  intakeStatuses.mockResolvedValue({ queued: 1, unknown: 0 });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("POST /api/webhooks/twilio", () => {
  it("queues a status signed over the public url", async () => {
    const response = await post(twilioSignature(TOKEN, PUBLIC_URL, fields));
    expect(response.status).toBe(200);
    expect(intakeStatuses).toHaveBeenCalledWith("sms", [expect.objectContaining({ eventId: "SM1:delivered", state: "delivered" })]);
  });

  it("refuses a missing or wrong signature, a signature over the internal url, and no token set", async () => {
    expect((await post(null)).status).toBe(401);
    expect((await post("bad")).status).toBe(401);
    expect((await post(twilioSignature(TOKEN, "http://127.0.0.1:3202/api/webhooks/twilio", fields))).status).toBe(401);
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    expect((await post(twilioSignature(TOKEN, PUBLIC_URL, fields))).status).toBe(401);
    expect(intakeStatuses).not.toHaveBeenCalled();
  });

  it("refuses an oversized body", async () => {
    expect((await post("x", "a=".concat("x".repeat(70 * 1024)))).status).toBe(413);
  });
});
