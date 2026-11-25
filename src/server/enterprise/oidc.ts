import "server-only";

import * as client from "openid-client";

import { serviceProviderUrls } from "@/lib/sso-urls";
import { appOrigin } from "@/server/env";
import { openText, prepareRecordKeys } from "@/server/record-crypto";

import { saveOidcPending, takeOidcPending } from "./sso-state";

/**
 * OIDC company sign-in (feature 53), by authorization code with PKCE. Unlike SAML it needs the provider's address book (discovery) and
 * a token exchange, both while the person waits; those are the only outside calls a sign-in makes, and nothing is stored from them
 * but the verified identity.
 */

export interface OidcConnectionFacts {
  id: string;
  tenantId: string;
  oidcIssuer: string;
  oidcClientId: string;
  oidcClientSecretEnc: string;
}

export class OidcRefusal extends Error {
  constructor(readonly reason: "invalid_response" | "no_email" | "provider_error") {
    super(reason);
    this.name = "OidcRefusal";
  }
}

type Fetcher = client.CustomFetch;

async function configuration(connection: OidcConnectionFacts, fetcher?: Fetcher): Promise<client.Configuration> {
  await prepareRecordKeys(connection.tenantId);
  const secret = openText(connection.tenantId, connection.oidcClientSecretEnc);
  // The stand-in (tests) must also answer discovery, so it goes in with the first request, not only after.
  const options: client.DiscoveryRequestOptions = { timeout: 5, ...(fetcher ? { [client.customFetch]: fetcher } : {}) };
  const config = await client.discovery(new URL(connection.oidcIssuer), connection.oidcClientId, undefined, client.ClientSecretPost(secret), options);
  if (fetcher) config[client.customFetch] = fetcher;
  return config;
}

/** The provider's sign-in address for this connection, with PKCE, a state and a nonce remembered for the reply. */
export async function oidcLoginUrl(connection: OidcConnectionFacts, origin = appOrigin(), fetcher?: Fetcher, binding = ""): Promise<string> {
  let config;
  try {
    config = await configuration(connection, fetcher);
  } catch {
    throw new OidcRefusal("provider_error");
  }
  const codeVerifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const nonce = client.randomNonce();
  await saveOidcPending({ connectionId: connection.id, binding, state, nonce, codeVerifier });
  return client.buildAuthorizationUrl(config, {
    redirect_uri: serviceProviderUrls(origin, connection.id).redirectUri,
    scope: "openid email profile",
    code_challenge: await client.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: "S256",
    state,
    nonce,
  }).href;
}

export interface OidcIdentity {
  email: string;
  name: string | null;
}

/** Checks the provider's reply (state, code, PKCE, nonce, signature, audience) and returns who it says signed in. */
export async function readOidcReply(connection: OidcConnectionFacts, currentUrl: URL, origin = appOrigin(), fetcher?: Fetcher): Promise<OidcIdentity & { binding: string }> {
  const state = currentUrl.searchParams.get("state");
  const pending = state ? await takeOidcPending(state) : null;
  if (!state || !pending || pending.connectionId !== connection.id) throw new OidcRefusal("invalid_response");
  let claims;
  try {
    const config = await configuration(connection, fetcher);
    // The address the provider redirected to is rebuilt from our own origin, never from the request's Host header.
    const callback = new URL(serviceProviderUrls(origin, connection.id).redirectUri);
    callback.search = currentUrl.search;
    const tokens = await client.authorizationCodeGrant(config, callback, { pkceCodeVerifier: pending.codeVerifier, expectedState: pending.state, expectedNonce: pending.nonce });
    claims = tokens.claims();
  } catch {
    throw new OidcRefusal("invalid_response");
  }
  const email = typeof claims?.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new OidcRefusal("no_email");
  // A provider that says the address is not verified has not proved the person owns it.
  if (claims?.email_verified === false) throw new OidcRefusal("invalid_response");
  return { email, name: typeof claims?.name === "string" ? claims.name : null, binding: pending.binding ?? "" };
}
