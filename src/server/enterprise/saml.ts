import "server-only";

import { SAML, ValidateInResponseTo } from "@node-saml/node-saml";

import { serviceProviderUrls } from "@/lib/sso-urls";
import { appOrigin } from "@/server/env";

import { samlRequestCache } from "./sso-state";

export interface SamlConnectionFacts {
  id: string;
  idpEntityId: string;
  idpSsoUrl: string;
  idpCertificate: string;
}

/**
 * The SAML client for one connection. It accepts a login only when: the response answers a request we made (and then forgets
 * it, so a copy replayed later is refused), the assertion is signed by the provider's certificate, it names our entity as its
 * audience, it came from the provider's issuer, and its clock window is current.
 */
export function samlClient(connection: SamlConnectionFacts, origin = appOrigin()): SAML {
  const urls = serviceProviderUrls(origin, connection.id);
  return new SAML({
    callbackUrl: urls.acsUrl,
    entryPoint: connection.idpSsoUrl,
    issuer: urls.entityId,
    audience: urls.entityId,
    idpCert: connection.idpCertificate,
    idpIssuer: connection.idpEntityId,
    wantAssertionsSigned: true,
    // Providers differ on signing the response, the assertion or both; the assertion is the part that carries the identity.
    wantAuthnResponseSigned: false,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: 10 * 60_000,
    cacheProvider: samlRequestCache(connection.id),
    acceptedClockSkewMs: 60_000,
    maxAssertionAgeMs: 10 * 60_000,
    identifierFormat: "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress",
    disableRequestedAuthnContext: true,
    signatureAlgorithm: "sha256",
    digestAlgorithm: "sha256",
  });
}

/** Where to send the person's browser to sign in at the company's identity provider. `relayState` comes back unchanged. */
export async function samlLoginUrl(connection: SamlConnectionFacts, relayState: string): Promise<string> {
  return samlClient(connection).getAuthorizeUrlAsync(relayState, undefined, {});
}

export function samlMetadata(connection: Pick<SamlConnectionFacts, "id">, origin = appOrigin()): string {
  const client = samlClient({ id: connection.id, idpEntityId: "unused", idpSsoUrl: "https://unused.invalid/", idpCertificate: "unused" }, origin);
  return client.generateServiceProviderMetadata(null, null);
}

const emailClaims = [
  "email",
  "mail",
  "urn:oid:0.9.2342.19200300.100.1.3",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn",
];
const nameClaims = ["displayName", "name", "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name"];

function firstString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) return firstString(value[0]);
  return null;
}

export interface SamlIdentity {
  email: string;
  name: string | null;
}

export class SamlRefusal extends Error {
  constructor(readonly reason: "invalid_response" | "no_email") {
    super(reason);
    this.name = "SamlRefusal";
  }
}

/** Checks a posted response and returns who it says signed in. Anything that fails a check is one `invalid_response`, with no detail for an attacker. */
export async function readSamlResponse(connection: SamlConnectionFacts, body: { SAMLResponse: string; RelayState?: string }): Promise<SamlIdentity> {
  let profile;
  try {
    ({ profile } = await samlClient(connection).validatePostResponseAsync({ SAMLResponse: body.SAMLResponse, ...(body.RelayState ? { RelayState: body.RelayState } : {}) }));
  } catch {
    throw new SamlRefusal("invalid_response");
  }
  if (!profile) throw new SamlRefusal("invalid_response");
  const candidates = [...emailClaims.map((claim) => firstString(profile[claim])), /@/.test(profile.nameID) ? profile.nameID : null];
  const email = candidates.find((value): value is string => Boolean(value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)));
  if (!email) throw new SamlRefusal("no_email");
  return { email: email.toLowerCase(), name: nameClaims.map((claim) => firstString(profile[claim])).find(Boolean) ?? null };
}
