/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendInviteEmail, sendVerificationEmail } from "./auth-email";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function configure() {
  vi.stubEnv("RESEND_API_KEY", "re_test_key");
  vi.stubEnv("EMAIL_FROM", "Kalendr <kalendr@example.com>");
  vi.stubEnv("EMAIL_API_URL", "http://127.0.0.1:3199/emails");
}

describe("account emails", () => {
  it("fail closed without delivery configuration", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("EMAIL_FROM", "");
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    await expect(sendVerificationEmail("owner@example.com", "https://example.com/verify")).rejects.toThrow("not configured");
    expect(request).not.toHaveBeenCalled();
  });

  it("send a branded verification email with a text version, keyed so a repeat sends once", async () => {
    configure();
    const request = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ id: "email-1" }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", request);
    await sendVerificationEmail("owner@example.com", "https://example.com/verify?token=example");
    await sendVerificationEmail("owner@example.com", "https://example.com/verify?token=example");
    expect(request).toHaveBeenCalledTimes(2);
    const [url, init] = request.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:3199/emails");
    const body = JSON.parse(String(init.body));
    expect(body.to).toEqual(["owner@example.com"]);
    expect(body.text).toContain("https://example.com/verify?token=example");
    expect(body.html).toContain("https://example.com/verify?token=example");
    const keyOf = (call: unknown[]) => new Headers((call[1] as RequestInit).headers).get("idempotency-key");
    expect(keyOf(request.mock.calls[0]!)).toMatch(/^account:email_verification:[0-9a-f]{64}$/);
    // The key is a hash: the token never reaches a header.
    expect(keyOf(request.mock.calls[0]!)).not.toContain("example");
    expect(keyOf(request.mock.calls[1]!)).toBe(keyOf(request.mock.calls[0]!));
  });

  it("report a provider failure with a short code, never the link", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ name: "rate_limit_exceeded", message: "slow down", statusCode: 429 }), { status: 429, headers: { "content-type": "application/json" } })));
    const failure = sendVerificationEmail("owner@example.com", "https://example.com/verify?token=secret-token");
    await expect(failure).rejects.toThrow(/unavailable/);
    await expect(failure).rejects.not.toThrow(/secret-token/);
  });

  it("send staff invites in the business's name", async () => {
    configure();
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "email-2" }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", request);
    expect(await sendInviteEmail({ email: "staff@example.com", name: "Asha", clinicName: "Lotus Dental Studio", inviterName: "Ravi", url: "https://example.com/invite/abc" })).toBe(true);
    const body = JSON.parse(String((request.mock.calls[0]![1] as RequestInit).body));
    expect(body.from).toBe('"Lotus Dental Studio" <kalendr@example.com>');
    expect(body.text).toContain("https://example.com/invite/abc");
  });
});
