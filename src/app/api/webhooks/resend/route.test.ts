/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signedHeaders, TEST_WEBHOOK_SECRET } from "@/test/resend-webhook";

const applyResendEvent = vi.fn();
vi.mock("@/server/messaging/resend-webhook", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/messaging/resend-webhook")>()),
  applyResendEvent: (...args: unknown[]) => applyResendEvent(...args),
}));

import { POST } from "./route";

const body = JSON.stringify({ type: "email.delivered", created_at: "2026-11-12T10:00:00Z", data: { email_id: "4ef9a417-02e9-4d39-ad75-9611e0fcc33c", to: ["priya@example.com"] } });

function post(payload: string, headers: Headers) {
  return POST(new Request("http://127.0.0.1:3202/api/webhooks/resend", { method: "POST", body: payload, headers }));
}

beforeEach(() => {
  vi.stubEnv("RESEND_WEBHOOK_SECRET", TEST_WEBHOOK_SECRET);
  applyResendEvent.mockResolvedValue("applied");
});
afterEach(() => vi.unstubAllEnvs());

describe("POST /api/webhooks/resend", () => {
  it("applies a correctly signed event", async () => {
    const response = await post(body, signedHeaders(TEST_WEBHOOK_SECRET, "msg_route_1", body));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ data: { result: "applied" } });
    expect(applyResendEvent).toHaveBeenCalledWith("msg_route_1", expect.objectContaining({ type: "email.delivered" }));
  });

  it("refuses a bad signature, and refuses everything when no secret is set", async () => {
    const bad = signedHeaders(TEST_WEBHOOK_SECRET, "msg_route_2", body);
    bad.set("svix-signature", "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=");
    expect((await post(body, bad)).status).toBe(401);
    vi.stubEnv("RESEND_WEBHOOK_SECRET", "");
    expect((await post(body, signedHeaders(TEST_WEBHOOK_SECRET, "msg_route_3", body))).status).toBe(401);
    expect(applyResendEvent).not.toHaveBeenCalled();
  });

  it("refuses an oversized body before checking it", async () => {
    const huge = "x".repeat(70 * 1024);
    expect((await post(huge, signedHeaders(TEST_WEBHOOK_SECRET, "msg_route_4", huge))).status).toBe(413);
    expect(applyResendEvent).not.toHaveBeenCalled();
  });

  it("answers 200 for a duplicate so the provider stops retrying", async () => {
    applyResendEvent.mockResolvedValue("duplicate");
    const response = await post(body, signedHeaders(TEST_WEBHOOK_SECRET, "msg_route_5", body));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { result: "duplicate" } });
  });
});
