import "server-only";

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { devOAuthEnabled } from "./dev-oauth";
import { env, publicAppUrl } from "./env";

/**
 * Google or Microsoft as the first step of sign-up (/start). This is its own small OAuth leg, separate from Better
 * Auth's: it only reads the provider's verified email and turns it into the same sign-up proof the email code gives
 * (`sign-up-check.ts`). It never makes a user or a session, so Better Auth's rule that only invited people sign in
 * with a provider stays as it is. After the business is created, the owner signs in through Better Auth's normal
 * Google or Microsoft sign-in, which links the provider to the account that now exists.
 *
 * The real providers need this redirect URI registered next to Better Auth's:
 *   <app>/api/public/sign-up/callback/google   and   <app>/api/public/sign-up/callback/microsoft
 */

export type SignUpProvider = "google" | "microsoft";
export const SIGN_UP_OAUTH_COOKIE = "kalendr_sign_up_oauth";
const STATE_MINUTES = 10;

interface ProviderConfig {
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  clientId: string;
  clientSecret: string;
  pkce: boolean;
}

function appBase(): string {
  return (env().BETTER_AUTH_URL ?? publicAppUrl()).replace(/\/$/, "");
}

export function callbackUrl(provider: SignUpProvider): string {
  return `${appBase()}/api/public/sign-up/callback/${provider}`;
}

export function providerConfig(provider: SignUpProvider): ProviderConfig | null {
  const settings = env();
  if (devOAuthEnabled()) {
    const base = appBase();
    return { authorizeUrl: `${base}/api/dev-oauth/authorize`, tokenUrl: `${base}/api/dev-oauth/token`, userInfoUrl: `${base}/api/dev-oauth/userinfo`, clientId: "dev-stand-in", clientSecret: "dev-stand-in", pkce: false };
  }
  if (provider === "google" && settings.GOOGLE_CLIENT_ID && settings.GOOGLE_CLIENT_SECRET) {
    return {
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      userInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
      clientId: settings.GOOGLE_CLIENT_ID,
      clientSecret: settings.GOOGLE_CLIENT_SECRET,
      pkce: true,
    };
  }
  if (provider === "microsoft" && settings.MICROSOFT_CLIENT_ID && settings.MICROSOFT_CLIENT_SECRET) {
    const tenant = settings.MICROSOFT_TENANT_ID ?? "common";
    return {
      authorizeUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
      tokenUrl: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      userInfoUrl: "https://graph.microsoft.com/oidc/userinfo",
      clientId: settings.MICROSOFT_CLIENT_ID,
      clientSecret: settings.MICROSOFT_CLIENT_SECRET,
      pkce: true,
    };
  }
  return null;
}

function key(): string {
  const secret = env().BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is not set");
  return secret;
}
const mac = (body: string) => createHmac("sha256", key()).update(`sign-up-oauth:${body}`).digest("base64url");

interface OAuthState {
  state: string;
  verifier: string;
  provider: SignUpProvider;
  exp: number;
}

/** The provider's authorize URL, and the cookie that ties its answer to this browser. */
export function beginSignUpOAuth(provider: SignUpProvider, config: ProviderConfig): { location: string; cookie: string } {
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const url = new URL(config.authorizeUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", callbackUrl(provider));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "select_account");
  if (config.pkce) {
    url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    url.searchParams.set("code_challenge_method", "S256");
  }
  const body = Buffer.from(JSON.stringify({ state, verifier, provider, exp: Date.now() + STATE_MINUTES * 60_000 } satisfies OAuthState)).toString("base64url");
  const secure = env().NODE_ENV === "production" ? "; Secure" : "";
  return {
    location: url.toString(),
    cookie: `${SIGN_UP_OAUTH_COOKIE}=${body}.${mac(body)}; Path=/api/public/sign-up; Max-Age=${STATE_MINUTES * 60}; HttpOnly; SameSite=Lax${secure}`,
  };
}

export const clearOAuthCookie = `${SIGN_UP_OAUTH_COOKIE}=; Path=/api/public/sign-up; Max-Age=0; HttpOnly; SameSite=Lax`;

function readState(request: Request): OAuthState | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, value] = part.trim().split("=");
    if (name !== SIGN_UP_OAUTH_COOKIE || !value) continue;
    const [body, signature] = value.split(".");
    if (!body || !signature) return null;
    const expected = Buffer.from(mac(body));
    const given = Buffer.from(signature);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    try {
      const state = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as OAuthState;
      return state.exp > Date.now() ? state : null;
    } catch {
      return null;
    }
  }
  return null;
}

export type SignUpOAuthResult =
  | { ok: true; email: string; name?: string }
  | { ok: false; reason: "state" | "exchange" | "unverified" };

/** Checks the provider's answer against this browser's cookie, then reads the verified email. */
export async function finishSignUpOAuth(request: Request, provider: SignUpProvider, config: ProviderConfig, fetchImpl: typeof fetch = fetch): Promise<SignUpOAuthResult> {
  const query = new URL(request.url).searchParams;
  const saved = readState(request);
  const state = query.get("state") ?? "";
  const code = query.get("code");
  if (!saved || saved.provider !== provider || !code || saved.state.length !== state.length || !timingSafeEqual(Buffer.from(saved.state), Buffer.from(state))) {
    return { ok: false, reason: "state" };
  }
  try {
    const token = await fetchImpl(config.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: callbackUrl(provider),
        client_id: config.clientId,
        client_secret: config.clientSecret,
        ...(config.pkce ? { code_verifier: saved.verifier } : {}),
      }),
    });
    if (!token.ok) return { ok: false, reason: "exchange" };
    const { access_token: accessToken } = (await token.json()) as { access_token?: string };
    if (!accessToken) return { ok: false, reason: "exchange" };
    const info = await fetchImpl(config.userInfoUrl, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } });
    if (!info.ok) return { ok: false, reason: "exchange" };
    const person = (await info.json()) as { email?: string; email_verified?: boolean | string; name?: string };
    // Only an email the provider itself has verified counts. Microsoft often leaves this out; those owners use the code.
    const verified = person.email_verified === true || person.email_verified === "true";
    if (!person.email || !verified) return { ok: false, reason: "unverified" };
    return { ok: true, email: person.email, ...(person.name ? { name: person.name } : {}) };
  } catch {
    return { ok: false, reason: "exchange" };
  }
}
