import { z } from "zod";

import { apiScopeLabels, apiScopes, apiWriteScopes, type ApiScope } from "@/lib/api-scopes";

/**
 * OAuth 2 for apps that act on a business's behalf (feature 55). Browser-safe: the consent screen, the Apps page and
 * the server share these shapes. Apps may only ask for the API scopes that already exist, so a grant can never do more
 * than an API key with the same scopes could.
 */

export const ACCESS_TOKEN_PREFIX = "kat_";
export const REFRESH_TOKEN_PREFIX = "krt_";
export const CLIENT_SECRET_PREFIX = "kcs_";
export const CODE_PREFIX = "kac_";

export const ACCESS_TOKEN_SECONDS = 60 * 60;
export const REFRESH_TOKEN_SECONDS = 60 * 86_400;
export const CODE_SECONDS = 10 * 60;

/** Our own clients. They have no row and no secret: they are public clients that must use PKCE. */
export interface BuiltinClient {
  id: string;
  name: string;
  description: string;
  scopes: readonly ApiScope[];
  /** A redirect address is allowed when it matches one of these. Chrome and Edge give each extension its own address. */
  redirectPattern: RegExp;
}

export const extensionClient: BuiltinClient = {
  id: "kalendr-extension",
  name: "Kalendr browser extension",
  description: "Lists your booking links and today's bookings from the toolbar.",
  scopes: ["services:read", "bookings:today", "links:write"],
  redirectPattern: /^https:\/\/[a-p]{32}\.chromiumapp\.org\/[A-Za-z0-9_\-./]*$/,
};

/** The device sign-in (RFC 8628) for clients that cannot catch a redirect. */
export const DEVICE_CODE_SECONDS = 10 * 60;
export const DEVICE_POLL_SECONDS = 5;
export const DEVICE_CODE_PREFIX = "kdc_";
/** No vowels, so a code never spells a word; no look-alikes. Twenty letters, eight places: about 34 bits, short-lived and rate limited. */
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";

export const deviceStartRequest = z.object({ client_id: z.string().min(1).max(64), scope: z.string().max(400).optional() });
export const devicePollRequest = z.object({
  grant_type: z.literal("urn:ietf:params:oauth:grant-type:device_code"),
  device_code: z.string().min(10).max(200),
  client_id: z.string().min(1).max(64),
});

/** What a person types, in any case, with or without the dash. */
export function normalizeUserCode(value: string): string | null {
  const letters = value.toUpperCase().replace(/[^A-Z]/g, "");
  if (letters.length !== 8 || [...letters].some((letter) => !USER_CODE_ALPHABET.includes(letter))) return null;
  return letters;
}

export function formatUserCode(letters: string): string {
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

export const builtinClients: readonly BuiltinClient[] = [extensionClient];

export function builtinClientById(id: string): BuiltinClient | null {
  return builtinClients.find((client) => client.id === id) ?? null;
}

const scopeSchema = z.enum(apiScopes);

/** The query a client sends to the authorize page. */
export const authorizeQuery = z.object({
  response_type: z.literal("code"),
  client_id: z.string().min(1).max(64),
  redirect_uri: z.string().url().max(600),
  scope: z.string().max(400).optional(),
  state: z.string().max(200).optional(),
  code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "code_challenge must be a base64url SHA-256."),
  code_challenge_method: z.literal("S256"),
});
export type AuthorizeQuery = z.infer<typeof authorizeQuery>;

export function parseScopeList(value: string | undefined): ApiScope[] | null {
  const words = (value ?? "").split(/\s+/).filter(Boolean);
  const scopes: ApiScope[] = [];
  for (const word of words) {
    const parsed = scopeSchema.safeParse(word);
    if (!parsed.success) return null;
    if (!scopes.includes(parsed.data)) scopes.push(parsed.data);
  }
  return scopes;
}

/** The body of POST /api/oauth/token. */
export const tokenRequest = z.discriminatedUnion("grant_type", [
  z.object({
    grant_type: z.literal("authorization_code"),
    code: z.string().min(10).max(200),
    redirect_uri: z.string().max(600),
    client_id: z.string().min(1).max(64),
    client_secret: z.string().max(200).optional(),
    code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
  }),
  z.object({
    grant_type: z.literal("refresh_token"),
    refresh_token: z.string().min(10).max(200),
    client_id: z.string().min(1).max(64),
    client_secret: z.string().max(200).optional(),
  }),
]);
export type TokenRequest = z.infer<typeof tokenRequest>;

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export const createClientInput = z.object({
  name: z.string().trim().min(1, "Give the app a name.").max(60, "Use 60 characters or fewer."),
  redirectUris: z.array(z.string().trim().url("Enter a full web address.").max(600)).min(1, "Add at least one redirect address.").max(5, "At most 5 redirect addresses."),
  scopes: z.array(scopeSchema).min(1, "Choose at least one thing the app may ask for."),
}).strict().superRefine((value, context) => {
  value.redirectUris.forEach((uri, index) => {
    if (!isAllowedRedirect(uri)) context.addIssue({ code: "custom", path: ["redirectUris", index], message: "Use an https address, or http://localhost while you build." });
  });
});
export type CreateClientInput = z.infer<typeof createClientInput>;

/** https anywhere, plain http only for this machine. No fragments: they would let a code leak into a page's script. */
export function isAllowedRedirect(uri: string): boolean {
  let parsed: URL;
  try { parsed = new URL(uri); } catch { return false; }
  if (parsed.hash) return false;
  if (parsed.username || parsed.password) return false;
  if (parsed.protocol === "https:") return true;
  return parsed.protocol === "http:" && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
}

export interface OAuthClientView {
  id: string;
  name: string;
  redirectUris: string[];
  scopes: ApiScope[];
  secretPrefix: string;
  createdAt: string;
  revokedAt: string | null;
}

export interface OAuthGrantView {
  id: string;
  clientName: string;
  clientKind: "builtin" | "custom";
  userId: string;
  scopes: ApiScope[];
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** What the consent screen shows. */
export interface ConsentView {
  clientName: string;
  clientDescription: string | null;
  scopes: { scope: ApiScope; label: string; description: string; writes: boolean }[];
  /** Where the browser goes afterwards, so the person can see the address they are sending a code to. */
  redirectHost: string;
}

export function describeScopes(scopes: readonly ApiScope[]): ConsentView["scopes"] {
  return scopes.map((scope) => ({ scope, ...apiScopeLabels[scope], writes: apiWriteScopes.includes(scope) }));
}

/**
 * Where sign-in may send a person afterwards when they were stopped at an approval page (feature 55/57). Only those two
 * pages, with a plain query string: nothing a link could use to land someone elsewhere.
 */
export function approvalReturnPath(value: string | null): string | null {
  if (value === null || value.length > 1_000) return null;
  return /^\/oauth\/(authorize|device)(\?[A-Za-z0-9=&%._~:/+*-]*)?$/.test(value) ? value : null;
}
