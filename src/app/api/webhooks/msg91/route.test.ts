/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const intakeStatuses = vi.fn();
vi.mock("@/server/channels/webhook-intake", () => ({ intakeStatuses: (...args: unknown[]) => intakeStatuses(...args) }));

import { POST } from "./[token]/route";

const SECRET = "msg91-path-secret-0123456789";
const post = (token: string, body: string) => POST(
  new Request(`http://127.0.0.1:3202/api/webhooks/msg91/${token}`, { method: "POST", body }),
  { params: Promise.resolve({ token }) },
);

beforeEach(() => {
  vi.stubEnv("MSG91_WEBHOOK_TOKEN", SECRET);
  intakeStatuses.mockResolvedValue({ queued: 1, unknown: 0 });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("POST /api/webhooks/msg91/[token]", () => {
  it("queues the reports when the path token is right", async () => {
    const response = await post(SECRET, JSON.stringify([{ requestId: "r1", status: 1 }]));
    expect(response.status).toBe(200);
    expect(intakeStatuses).toHaveBeenCalledWith("sms", [{ eventId: "r1:delivered", providerMessageId: "r1", state: "delivered" }]);
  });

  it("refuses a wrong token, a token of another length, and everything when none is set", async () => {
    expect((await post("wrong", "[]")).status).toBe(401);
    expect((await post(`${SECRET}x`, "[]")).status).toBe(401);
    vi.stubEnv("MSG91_WEBHOOK_TOKEN", "");
    expect((await post(SECRET, "[]")).status).toBe(401);
    expect(intakeStatuses).not.toHaveBeenCalled();
  });

  it("answers 200 for an unreadable body so MSG91 stops retrying", async () => {
    expect((await post(SECRET, "garbage")).status).toBe(200);
    expect(intakeStatuses).not.toHaveBeenCalled();
  });

  it("refuses an oversized body", async () => {
    expect((await post(SECRET, "x".repeat(70 * 1024))).status).toBe(413);
  });
});
