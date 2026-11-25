/** @vitest-environment node */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { intakeStatuses, intakeInbound, applyTemplateStatuses } = vi.hoisted(() => ({
  intakeStatuses: vi.fn(async () => ({ queued: 1, unknown: 0 })),
  intakeInbound: vi.fn(async () => ({ stored: 0, unknown: 0 })),
  applyTemplateStatuses: vi.fn(async () => undefined),
}));
vi.mock("@/server/channels/webhook-intake", () => ({ intakeStatuses }));
vi.mock("@/server/channels/whatsapp-intake", () => ({ intakeInbound, applyTemplateStatuses }));

import { signedWhatsAppRequest, statusCallback, TEST_WHATSAPP_APP_SECRET, TEST_WHATSAPP_VERIFY_TOKEN } from "@/test/whatsapp-webhook";

import { GET, POST } from "./route";

const post = (headers: Record<string, string>, body: string) => POST(new Request("http://localhost/api/webhooks/whatsapp", { method: "POST", headers, body }));

describe("/api/webhooks/whatsapp", () => {
  beforeEach(() => {
    vi.stubEnv("WHATSAPP_APP_SECRET", TEST_WHATSAPP_APP_SECRET);
    vi.stubEnv("WHATSAPP_VERIFY_TOKEN", TEST_WHATSAPP_VERIFY_TOKEN);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("queues a signed callback and answers 200", async () => {
    const request = signedWhatsAppRequest(TEST_WHATSAPP_APP_SECRET, statusCallback("wamid.1", "delivered"));
    const response = await post(request.headers, request.body);
    expect(response.status).toBe(200);
    expect(intakeStatuses).toHaveBeenCalledWith("whatsapp", [expect.objectContaining({ providerMessageId: "wamid.1", state: "delivered" })]);
  });

  it("refuses a bad signature with no detail and queues nothing", async () => {
    const request = signedWhatsAppRequest("not-the-secret", statusCallback("wamid.1", "delivered"));
    const response = await post(request.headers, request.body);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "unauthorized" } });
    expect(intakeStatuses).not.toHaveBeenCalled();
  });

  it("refuses everything when no app secret is configured", async () => {
    vi.stubEnv("WHATSAPP_APP_SECRET", "");
    const request = signedWhatsAppRequest(TEST_WHATSAPP_APP_SECRET, statusCallback("wamid.1", "delivered"));
    expect((await post(request.headers, request.body)).status).toBe(401);
  });

  it("answers the address check only with the right verify token", async () => {
    const url = (token: string) => `http://localhost/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=42`;
    const ok = await GET(new Request(url(TEST_WHATSAPP_VERIFY_TOKEN)));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("42");
    expect((await GET(new Request(url("wrong")))).status).toBe(403);
  });
});
