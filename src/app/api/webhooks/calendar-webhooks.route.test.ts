/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { POST as google } from "./google-calendar/route";
import { POST as microsoft } from "./microsoft-graph/route";

const TOKEN = "k".repeat(40);
const googleUrl = "https://app.example.test/api/webhooks/google-calendar";
const microsoftUrl = "https://app.example.test/api/webhooks/microsoft-graph";

const saved = { ...process.env };
beforeEach(() => {
  process.env.CALENDAR_WEBHOOK_TOKEN = TOKEN;
  process.env.CALENDAR_PROVIDER_MODE = "live";
  delete process.env.DATABASE_URL;
});
afterEach(() => {
  process.env = { ...saved };
});

const post = (url: string, init: RequestInit = {}) => new Request(url, { method: "POST", ...init });

describe("Google Calendar webhook", () => {
  it("refuses a missing or wrong token with a 401 and no detail", async () => {
    for (const headers of [{}, { "x-goog-channel-token": "wrong" }, { "x-goog-channel-token": TOKEN.slice(1) }] as Record<string, string>[]) {
      const response = await google(post(googleUrl, { headers: { "x-goog-channel-id": "c1", "x-goog-message-number": "1", ...headers } }));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: { code: "unauthorized" } });
    }
  });

  it("refuses every request when no secret is configured, even an empty token", async () => {
    delete process.env.CALENDAR_WEBHOOK_TOKEN;
    const response = await google(post(googleUrl, { headers: { "x-goog-channel-token": "", "x-goog-channel-id": "c1", "x-goog-message-number": "1" } }));
    expect(response.status).toBe(401);
  });

  it("acknowledges a request without a channel or message number without touching the database", async () => {
    const response = await google(post(googleUrl, { headers: { "x-goog-channel-token": TOKEN } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { result: "ignored" } });
  });

  it("refuses a body that is too large before checking anything else", async () => {
    const response = await google(post(googleUrl, { headers: { "content-length": "999999", "x-goog-channel-token": TOKEN } }));
    expect(response.status).toBe(413);
  });
});

describe("Microsoft Graph webhook", () => {
  it("echoes the validation token as plain text, before any other check", async () => {
    delete process.env.CALENDAR_WEBHOOK_TOKEN;
    const response = await microsoft(post(`${microsoftUrl}?validationToken=Validation%3A+abc%2Fxyz`));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await response.text()).toBe("Validation: abc/xyz");
  });

  it("refuses the whole request when any item carries a wrong clientState", async () => {
    const body = JSON.stringify({ value: [{ subscriptionId: "s1", clientState: TOKEN }, { subscriptionId: "s2", clientState: "forged" }] });
    const response = await microsoft(post(microsoftUrl, { headers: { "content-type": "application/json" }, body }));
    expect(response.status).toBe(401);
  });

  it("refuses an item with no clientState, and a body that is not a notification", async () => {
    const missing = await microsoft(post(microsoftUrl, { body: JSON.stringify({ value: [{ subscriptionId: "s1" }] }) }));
    expect(missing.status).toBe(401);
    expect((await microsoft(post(microsoftUrl, { body: "not json" }))).status).toBe(400);
    expect((await microsoft(post(microsoftUrl, { body: JSON.stringify({ nope: true }) }))).status).toBe(400);
  });
});
