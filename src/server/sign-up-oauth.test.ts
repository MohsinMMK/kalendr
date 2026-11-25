import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { openSignUpProof, proofFromRequest, proofSetCookie, sealSignUpProof } from "./sign-up-check";
import { beginSignUpOAuth, finishSignUpOAuth, providerConfig } from "./sign-up-oauth";

const app = "http://localhost:3100";

beforeEach(() => {
  vi.stubEnv("BETTER_AUTH_SECRET", "s".repeat(40));
  vi.stubEnv("BETTER_AUTH_URL", app);
  vi.stubEnv("KALENDR_DEV_OAUTH", "");
  vi.stubEnv("GOOGLE_CLIENT_ID", "google-id");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "google-secret");
  vi.stubEnv("MICROSOFT_CLIENT_ID", "");
  vi.stubEnv("MICROSOFT_CLIENT_SECRET", "");
});
afterEach(() => vi.unstubAllEnvs());

/** The provider's answer coming back to this browser: the redirect with its query, plus the cookie set on the way out. */
function callback(cookie: string, query: Record<string, string>) {
  const url = new URL(`${app}/api/public/sign-up/callback/google`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return new Request(url, { headers: { cookie: cookie.split(";")[0]! } });
}

function provider(person: Record<string, unknown>, token: { ok: boolean } = { ok: true }) {
  return vi.fn(async (url: string | URL | Request) =>
    String(url).includes("token")
      ? ({ ok: token.ok, json: async () => ({ access_token: "access" }) } as Response)
      : ({ ok: true, json: async () => person } as Response),
  );
}

describe("sign-up with Google or Microsoft", () => {
  it("is offered only for a provider that is set up", () => {
    expect(providerConfig("google")?.authorizeUrl).toContain("accounts.google.com");
    expect(providerConfig("microsoft")).toBeNull();
  });

  it("sends the owner to the provider with a state and PKCE, and ties the answer to this browser", () => {
    const config = providerConfig("google")!;
    const { location, cookie } = beginSignUpOAuth("google", config);
    const url = new URL(location);
    expect(url.searchParams.get("redirect_uri")).toBe(`${app}/api/public/sign-up/callback/google`);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Path=\/api\/public\/sign-up/);
  });

  it("accepts a verified email from the provider, with the name it gave", async () => {
    const config = providerConfig("google")!;
    const { location, cookie } = beginSignUpOAuth("google", config);
    const state = new URL(location).searchParams.get("state")!;
    const fetchImpl = provider({ email: "asha@example.com", email_verified: true, name: "Asha Rao" });
    const result = await finishSignUpOAuth(callback(cookie, { state, code: "c" }), "google", config, fetchImpl as typeof fetch);
    expect(result).toEqual({ ok: true, email: "asha@example.com", name: "Asha Rao" });
    // PKCE: the token request carries the verifier only this browser's cookie held.
    expect(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)).toMatch(/code_verifier=/);
  });

  it("refuses an email the provider has not verified", async () => {
    const config = providerConfig("google")!;
    const { location, cookie } = beginSignUpOAuth("google", config);
    const state = new URL(location).searchParams.get("state")!;
    const result = await finishSignUpOAuth(callback(cookie, { state, code: "c" }), "google", config, provider({ email: "asha@example.com" }) as typeof fetch);
    expect(result).toEqual({ ok: false, reason: "unverified" });
  });

  it("refuses an answer without this browser's cookie, with another state, or for another provider", async () => {
    const config = providerConfig("google")!;
    const { location, cookie } = beginSignUpOAuth("google", config);
    const state = new URL(location).searchParams.get("state")!;
    const person = provider({ email: "asha@example.com", email_verified: true }) as typeof fetch;
    expect(await finishSignUpOAuth(callback("other=1", { state, code: "c" }), "google", config, person)).toEqual({ ok: false, reason: "state" });
    expect(await finishSignUpOAuth(callback(cookie, { state: `${state}x`, code: "c" }), "google", config, person)).toEqual({ ok: false, reason: "state" });
    const [name, value] = cookie.split(";")[0]!.split("=");
    const [body, mac] = value!.split(".");
    expect(await finishSignUpOAuth(callback(`${name}=${body}.${mac}x`, { state, code: "c" }), "google", config, person)).toEqual({ ok: false, reason: "state" });
    expect(await finishSignUpOAuth(callback(cookie, { state, code: "c" }), "microsoft", config, person)).toEqual({ ok: false, reason: "state" });
  });

  it("reports a failed code exchange", async () => {
    const config = providerConfig("google")!;
    const { location, cookie } = beginSignUpOAuth("google", config);
    const state = new URL(location).searchParams.get("state")!;
    const failing = provider({ email: "asha@example.com", email_verified: true }, { ok: false }) as typeof fetch;
    expect(await finishSignUpOAuth(callback(cookie, { state, code: "c" }), "google", config, failing)).toEqual({ ok: false, reason: "exchange" });
  });
});

describe("sign-up proof", () => {
  const proof = { email: "asha@example.com", method: "google" as const, expiresAt: Date.now() + 60_000 };

  it("reads back the proof it sealed, from the cookie it set", () => {
    const header = proofSetCookie(proof);
    expect(header).toMatch(/HttpOnly/);
    const request = new Request(app, { headers: { cookie: header.split(";")[0]! } });
    expect(proofFromRequest(request)).toEqual(proof);
  });

  it("refuses a changed, foreign or expired proof", () => {
    const sealed = sealSignUpProof(proof);
    const [, mac] = sealed.split(".");
    const forged = Buffer.from(JSON.stringify({ ...proof, email: "someone@example.com" })).toString("base64url");
    expect(openSignUpProof(`${forged}.${mac}`)).toBeNull();
    expect(openSignUpProof("nonsense")).toBeNull();
    expect(openSignUpProof(sealSignUpProof({ ...proof, expiresAt: Date.now() - 1 }))).toBeNull();
    vi.stubEnv("BETTER_AUTH_SECRET", "t".repeat(40));
    expect(openSignUpProof(sealed)).toBeNull();
  });
});
