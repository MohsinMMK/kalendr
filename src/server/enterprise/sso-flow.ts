import "server-only";

import { z } from "zod";

import { emailDomainOf } from "@/lib/email-domain-rules";
import { appOrigin } from "@/server/env";

import { OidcRefusal, oidcLoginUrl, readOidcReply, type OidcConnectionFacts } from "./oidc";
import { readSamlResponse, samlLoginUrl, SamlRefusal, type SamlConnectionFacts } from "./saml";
import { loadConnection, refuseSso, resolveSsoConnection, resolveSsoDomain, signInThroughCompany, SsoSignInError, type ConnectionRecord, type SsoRefusal } from "./sso-login";

/** The steps of company sign-in that the public routes call. Each returns where to send the browser next. */

export const ssoLookupSchema = z.object({ email: z.string().trim().toLowerCase().email().max(254) }).strict();

export interface SsoLookupResult {
  sso: boolean;
  startUrl?: string;
  required?: boolean;
}

/** Whether an address's company has company sign-in, and where to start it. Says nothing about whether the person exists. */
export async function lookupCompanySignIn(email: string): Promise<SsoLookupResult> {
  const domain = emailDomainOf(email);
  const found = domain ? await resolveSsoDomain(domain) : null;
  if (!found) return { sso: false };
  return { sso: true, startUrl: `/api/sso/${found.kind}/${found.connectionId}/start`, required: found.requireSso };
}

export function ssoErrorPath(reason: SsoRefusal): string {
  return `/sign-in?error=sso_${reason}`;
}

export function absolute(path: string): URL {
  return new URL(path, `${appOrigin()}/`);
}

async function active(connectionId: string, kind: "saml" | "oidc"): Promise<{ tenantId: string; connection: ConnectionRecord } | null> {
  const resolved = await resolveSsoConnection(connectionId);
  if (!resolved) return null;
  const connection = await loadConnection(resolved.tenantId, connectionId);
  return connection && connection.kind === kind ? { tenantId: resolved.tenantId, connection } : null;
}

function samlFacts(connection: ConnectionRecord): SamlConnectionFacts | null {
  return connection.idpEntityId && connection.idpSsoUrl && connection.idpCertificate
    ? { id: connection.id, idpEntityId: connection.idpEntityId, idpSsoUrl: connection.idpSsoUrl, idpCertificate: connection.idpCertificate }
    : null;
}

function oidcFacts(tenantId: string, connection: ConnectionRecord): OidcConnectionFacts | null {
  return connection.oidcIssuer && connection.oidcClientId && connection.oidcClientSecretEnc
    ? { id: connection.id, tenantId, oidcIssuer: connection.oidcIssuer, oidcClientId: connection.oidcClientId, oidcClientSecretEnc: connection.oidcClientSecretEnc }
    : null;
}

/** Where to send the browser to sign in at the provider. `binding` is the hash of the cookie just given to this browser. */
export async function startCompanySignIn(kind: "saml" | "oidc", connectionId: string, binding: string): Promise<string> {
  const found = await active(connectionId, kind);
  if (!found) return ssoErrorPath("connection_off");
  try {
    if (kind === "saml") {
      const facts = samlFacts(found.connection);
      return facts ? await samlLoginUrl(facts, binding) : ssoErrorPath("connection_off");
    }
    const facts = oidcFacts(found.tenantId, found.connection);
    return facts ? await oidcLoginUrl(facts, appOrigin(), undefined, binding) : ssoErrorPath("connection_off");
  } catch {
    return ssoErrorPath("provider_error");
  }
}

/** Options for the cookie that ties a sign-in to the browser that started it: unreadable by scripts, ten minutes, sent on top-level returns. */
export function browserCookieOptions() {
  return { httpOnly: true, secure: appOrigin().startsWith("https:"), sameSite: "lax" as const, path: "/api", maxAge: 10 * 60 };
}

function ticketPath(ticket: string): string {
  return `/api/auth/sso/complete?ticket=${encodeURIComponent(ticket)}`;
}

/** Checks the provider's posted reply and returns the path to open: the ticket redemption on success, the sign-in page with a reason otherwise. */
export async function finishSamlSignIn(connectionId: string, form: { SAMLResponse: string; RelayState?: string }): Promise<string> {
  const found = await active(connectionId, "saml");
  const facts = found ? samlFacts(found.connection) : null;
  if (!found || !facts) return ssoErrorPath("connection_off");
  try {
    const identity = await readSamlResponse(facts, form);
    // RelayState carries the starting browser's binding back; a reply without one (provider-started) is bound to no browser
    // and its ticket will not redeem.
    return ticketPath(await signInThroughCompany(found.connection, found.tenantId, identity, form.RelayState ?? ""));
  } catch (error: unknown) {
    return refusalPath(error, found.tenantId, connectionId);
  }
}

export async function finishOidcSignIn(connectionId: string, currentUrl: URL): Promise<string> {
  const found = await active(connectionId, "oidc");
  const facts = found ? oidcFacts(found.tenantId, found.connection) : null;
  if (!found || !facts) return ssoErrorPath("connection_off");
  if (currentUrl.searchParams.has("error")) return ssoErrorPath((await refuseSso(found.tenantId, connectionId, "provider_error")).reason);
  try {
    const { binding, ...identity } = await readOidcReply(facts, currentUrl);
    return ticketPath(await signInThroughCompany(found.connection, found.tenantId, identity, binding));
  } catch (error: unknown) {
    return refusalPath(error, found.tenantId, connectionId);
  }
}

async function refusalPath(error: unknown, tenantId: string, connectionId: string): Promise<string> {
  if (error instanceof SsoSignInError) return ssoErrorPath(error.reason);
  const reason: SsoRefusal = error instanceof SamlRefusal || error instanceof OidcRefusal ? error.reason : "provider_error";
  return ssoErrorPath((await refuseSso(tenantId, connectionId, reason)).reason);
}
