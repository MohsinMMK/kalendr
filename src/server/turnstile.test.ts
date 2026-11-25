/** @vitest-environment node */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getPatientAccount = vi.fn();
const getSession = vi.fn();
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ authIsConfigured: true, auth: { api: { getSession: (...args: unknown[]) => getSession(...args) } } }));
vi.mock("@/server/patient-auth", () => ({ getPatientAccount: (...args: unknown[]) => getPatientAccount(...args) }));
vi.mock("@/db/client", () => ({ getDatabase: () => null }));
vi.mock("@/server/logger", () => ({ logger: () => ({ warn: vi.fn() }) }));

import { ApiError } from "@/server/api-error";
import { requireHumanWhenRisky, turnstileSiteKey, verifyTurnstileToken } from "@/server/turnstile";

// Cloudflare's published test keys: these always pass.
const siteKey = "1x00000000000000000000AA";
const secret = "1x0000000000000000000000000000000AA";

function siteverify(result: { success: boolean; "error-codes"?: string[] }, status = 200) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(result), { status }));
}

function request(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/public/appointments", { method: "POST", headers });
}

async function refusal(promise: Promise<unknown>): Promise<ApiError> {
  const error = await promise.then(() => null, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(ApiError);
  return error as ApiError;
}

describe("verifyTurnstileToken", () => {
  it("posts the secret, the token and the client address to siteverify", async () => {
    const fetchImpl = siteverify({ success: true });
    expect(await verifyTurnstileToken("token-1", { secret, remoteIp: "203.0.113.5", fetchImpl })).toEqual({ success: true, errorCodes: [] });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    const body = init?.body as URLSearchParams;
    expect(body.get("secret")).toBe(secret);
    expect(body.get("response")).toBe("token-1");
    expect(body.get("remoteip")).toBe("203.0.113.5");
  });

  it("leaves out addresses it cannot vouch for", async () => {
    const fetchImpl = siteverify({ success: true });
    await verifyTurnstileToken("token-1", { secret, remoteIp: "2001:db8:0:1::/64", fetchImpl });
    await verifyTurnstileToken("token-1", { secret, remoteIp: "unknown", fetchImpl });
    for (const [, init] of fetchImpl.mock.calls) expect((init?.body as URLSearchParams).has("remoteip")).toBe(false);
  });

  it("treats a refused token, an error status, a network failure and an empty token as a failed check", async () => {
    expect(await verifyTurnstileToken("used", { secret, fetchImpl: siteverify({ success: false, "error-codes": ["timeout-or-duplicate"] }) }))
      .toEqual({ success: false, errorCodes: ["timeout-or-duplicate"] });
    expect(await verifyTurnstileToken("t", { secret, fetchImpl: siteverify({ success: true }, 500) })).toMatchObject({ success: false });
    const offline = vi.fn(async () => { throw new TypeError("fetch failed"); });
    expect(await verifyTurnstileToken("t", { secret, fetchImpl: offline })).toEqual({ success: false, errorCodes: ["internal-error"] });
    const never = vi.fn();
    expect(await verifyTurnstileToken("", { secret, fetchImpl: never })).toMatchObject({ success: false });
    expect(never).not.toHaveBeenCalled();
  });
});

describe("requireHumanWhenRisky", () => {
  beforeEach(() => {
    vi.stubEnv("TURNSTILE_SITE_KEY", siteKey);
    vi.stubEnv("TURNSTILE_SECRET_KEY", secret);
    getPatientAccount.mockResolvedValue(null);
    getSession.mockResolvedValue(null);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("is off when the keys are not set", async () => {
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    const fetchImpl = siteverify({ success: false });
    await expect(requireHumanWhenRisky(request(), { count: 9 }, "203.0.113.5", fetchImpl)).resolves.toBeUndefined();
    expect(turnstileSiteKey()).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("never asks on the first attempt", async () => {
    const fetchImpl = siteverify({ success: false });
    await expect(requireHumanWhenRisky(request(), { count: 1 }, "203.0.113.5", fetchImpl)).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(turnstileSiteKey()).toBe(siteKey);
  });

  it("asks on a repeat attempt with no token, as a field error", async () => {
    const error = await refusal(requireHumanWhenRisky(request(), { count: 2 }, "203.0.113.5", siteverify({ success: true })));
    expect(error).toMatchObject({ status: 400, code: "challenge_required", fieldErrors: { turnstileToken: ["Complete the check to continue."] } });
  });

  it("lets a passing token through and refuses a failing one", async () => {
    await expect(requireHumanWhenRisky(request({ "x-turnstile-token": "ok" }), { count: 3 }, "203.0.113.5", siteverify({ success: true }))).resolves.toBeUndefined();
    const error = await refusal(requireHumanWhenRisky(request({ "x-turnstile-token": "bad" }), { count: 3 }, "203.0.113.5", siteverify({ success: false, "error-codes": ["invalid-input-response"] })));
    expect(error).toMatchObject({ status: 400, code: "challenge_failed", fieldErrors: { turnstileToken: ["The check did not pass. Try it again."] } });
  });

  it("does not ask someone already signed in, as a customer or as staff", async () => {
    getPatientAccount.mockResolvedValueOnce({ id: "patient-account" });
    await expect(requireHumanWhenRisky(request({ cookie: "kalendr_patient=abc" }), { count: 5 }, "203.0.113.5")).resolves.toBeUndefined();
    getSession.mockResolvedValueOnce({ user: { id: "u" } });
    await expect(requireHumanWhenRisky(request({ cookie: "kalendr.session_token=abc" }), { count: 5 }, "203.0.113.5")).resolves.toBeUndefined();
    // A cookie that names no live session still gets the check.
    const error = await refusal(requireHumanWhenRisky(request({ cookie: "kalendr_patient=expired" }), { count: 5 }, "203.0.113.5"));
    expect(error.code).toBe("challenge_required");
  });
});
