// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { createGoogleTransport } from "./google-transport";
import type { OAuthCredentials, RefreshedTokens } from "./provider";

const credentials: OAuthCredentials = { kind: "oauth", provider: "google", refreshToken: "refresh-1", accessToken: null, expiresAt: null };

afterEach(() => vi.unstubAllGlobals());

describe("google transport on the real OAuth client (network stubbed)", () => {
  it("refreshes a missing access token, reports it, then calls the API with it", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        calls.push({ url, auth: new Headers(init?.headers).get("authorization") });
        if (url.includes("oauth2.googleapis.com/token")) {
          return new Response(JSON.stringify({ access_token: "fresh-access", expires_in: 3600, token_type: "Bearer" }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const tokens: RefreshedTokens[] = [];
    const transport = createGoogleTransport({ clientId: "id", clientSecret: "secret" });
    const response = await transport.request(credentials, (value) => tokens.push(value), { method: "GET", url: "https://www.googleapis.com/calendar/v3/users/me/calendarList" });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [] });
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ refreshToken: "refresh-1", accessToken: "fresh-access" });
    expect(calls.at(-1)?.auth).toBe("Bearer fresh-access");
  });
});
