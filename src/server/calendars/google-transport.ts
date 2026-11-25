/**
 * The real network layer for Google, built on `googleapis`' OAuth2 client. It refreshes
 * the access token when it is missing or about to expire and reports every new token
 * through `onTokens`, so the consumer can store it.
 *
 * `googleapis` is imported lazily: it is large, and tests never need it.
 */
import { z } from "zod";

import type { OAuthAppConfig } from "./config";
import { CalendarProviderError } from "./errors";
import type { HttpRequest, HttpResponse } from "./http";
import type { OAuthCredentials, RefreshedTokens } from "./provider";

export interface GoogleTransport {
  /** Returns Google's raw token response; the adapter validates it. */
  exchangeCode(input: { code: string; redirectUri: string }): Promise<unknown>;
  request(credentials: OAuthCredentials, onTokens: (tokens: RefreshedTokens) => void, request: HttpRequest): Promise<HttpResponse>;
}

const tokenEventSchema = z.object({
  access_token: z.string().nullish(),
  refresh_token: z.string().nullish(),
  expiry_date: z.number().nullish(),
});

export function createGoogleTransport(app: OAuthAppConfig): GoogleTransport {
  async function newClient(redirectUri?: string) {
    const { google } = await import("googleapis");
    return new google.auth.OAuth2(app.clientId, app.clientSecret, redirectUri);
  }

  return {
    async exchangeCode({ code, redirectUri }) {
      const client = await newClient(redirectUri);
      const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });
      return tokens;
    },

    async request(credentials, onTokens, request) {
      const client = await newClient();
      client.setCredentials({
        refresh_token: credentials.refreshToken,
        access_token: credentials.accessToken ?? undefined,
        expiry_date: credentials.expiresAt ? Date.parse(credentials.expiresAt) : undefined,
      });
      client.on("tokens", (raw) => {
        const parsed = tokenEventSchema.safeParse(raw);
        if (!parsed.success || !parsed.data.access_token) return;
        onTokens({
          refreshToken: parsed.data.refresh_token ?? credentials.refreshToken,
          accessToken: parsed.data.access_token,
          expiresAt: new Date(parsed.data.expiry_date ?? Date.now() + 3_000_000).toISOString(),
        });
      });
      const response = await client.request<unknown>({
        url: request.url,
        method: request.method,
        headers: request.headers,
        data: request.json,
        // Status handling lives in the adapter, one place for every provider.
        validateStatus: () => true,
      });
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      return { status: response.status, headers, body: response.data === "" ? undefined : response.data };
    },
  };
}

/** Used when Google calendars are not configured: every call fails the same plain way. */
export function missingGoogleTransport(): GoogleTransport {
  const fail = (): never => {
    throw new CalendarProviderError("not_configured", "Google Calendar is not configured");
  };
  return { exchangeCode: fail, request: fail };
}
