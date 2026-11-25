/** @vitest-environment node */

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { isolatedDatabaseReady } from "@/test/isolated-database";

vi.mock("server-only", () => ({}));

import { createTenant, type TenantFixture } from "@/test/privacy-fixture";
import { OidcRefusal, oidcLoginUrl, readOidcReply, type OidcConnectionFacts } from "./oidc";
import { prepareRecordKeys, sealText } from "@/server/record-crypto";

const describeLocal = isolatedDatabaseReady(process.env.DATABASE_URL, process.env.KALENDR_TEST_OWNER_URL) ? describe : describe.skip;

const issuer = "https://idp.oidc-test.example";
const origin = "https://kalendr.test";

/** A stand-in provider: its address book, and a token endpoint that refuses every code. The success path (a signed ID token) is not covered here. */
function stubProvider(tokenStatus = 400) {
  const requests: string[] = [];
  const fetcher = async (input: string | URL | Request): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push(url);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return Response.json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, response_types_supported: ["code"], subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"] });
    }
    if (url.endsWith("/token")) return Response.json({ error: "invalid_grant" }, { status: tokenStatus });
    return new Response("not found", { status: 404 });
  };
  return { fetcher, requests };
}

describeLocal("OIDC company sign-in (state and PKCE; the signed ID token path is not covered)", () => {
  let owner: postgres.Sql;
  let tenant: TenantFixture;
  let connection: OidcConnectionFacts;

  beforeAll(async () => {
    owner = postgres(process.env.KALENDR_TEST_OWNER_URL!, { max: 2, prepare: false });
    tenant = await createTenant(owner, "oidc");
    await prepareRecordKeys(tenant.tenantId, { forWrite: true });
    connection = { id: "oidc-connection-1", tenantId: tenant.tenantId, oidcIssuer: issuer, oidcClientId: "kalendr-test", oidcClientSecretEnc: sealText(tenant.tenantId, "super-secret-value") };
  });

  afterAll(async () => {
    await owner`delete from tenants where id = ${tenant.tenantId}`.catch(() => undefined);
    await owner.end();
  });

  it("sends the person to the provider with PKCE, a state and a nonce, and our own reply address", async () => {
    const { fetcher } = stubProvider();
    const url = new URL(await oidcLoginUrl(connection, origin, fetcher));
    expect(url.origin + url.pathname).toBe(`${issuer}/authorize`);
    expect(url.searchParams.get("client_id")).toBe("kalendr-test");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(url.searchParams.get("nonce")).toBeTruthy();
    expect(url.searchParams.get("redirect_uri")).toBe(`${origin}/api/sso/oidc/${connection.id}/callback`);
    expect(url.toString()).not.toContain("super-secret-value");
  });

  it("refuses a reply with no state, an unknown state or a state used before, and a code the provider rejects", async () => {
    const { fetcher } = stubProvider();
    const reply = (state: string | null) => new URL(`${origin}/api/sso/oidc/${connection.id}/callback?code=abc${state ? `&state=${state}` : ""}`);
    await expect(readOidcReply(connection, reply(null), origin, fetcher)).rejects.toMatchObject({ reason: "invalid_response" });
    await expect(readOidcReply(connection, reply("never-issued"), origin, fetcher)).rejects.toBeInstanceOf(OidcRefusal);
    const started = new URL(await oidcLoginUrl(connection, origin, fetcher));
    const state = started.searchParams.get("state")!;
    // The provider turns the code down: refused, and the state is spent either way.
    await expect(readOidcReply(connection, reply(state), origin, fetcher)).rejects.toMatchObject({ reason: "invalid_response" });
    await expect(readOidcReply(connection, reply(state), origin, fetcher)).rejects.toMatchObject({ reason: "invalid_response" });
  });

  it("will not use a state that was made for another connection", async () => {
    const { fetcher } = stubProvider();
    const started = new URL(await oidcLoginUrl(connection, origin, fetcher));
    const other: OidcConnectionFacts = { ...connection, id: "oidc-connection-2" };
    await expect(readOidcReply(other, new URL(`${origin}/api/sso/oidc/${other.id}/callback?code=abc&state=${started.searchParams.get("state")}`), origin, fetcher)).rejects.toMatchObject({ reason: "invalid_response" });
  });

  it("says the provider could not be reached, not that the person is unknown", async () => {
    const down = async () => new Response("unavailable", { status: 503 });
    await expect(oidcLoginUrl(connection, origin, down)).rejects.toMatchObject({ reason: "provider_error" });
  });
});
