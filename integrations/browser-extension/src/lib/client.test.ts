import { beforeEach, describe, expect, it } from "vitest";

import { ApiFailure, createClient, SignedOutError } from "./client";
import { memoryStore } from "./store";

const ORIGIN = "https://kalendr.test";
const KEY = `kal_live_${"A".repeat(43)}`;

interface Call { url: string; method: string; headers: Record<string, string>; body: string }
type Answer = Response | ((call: Call) => Response | Promise<Response>);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function setup() {
  const store = memoryStore();
  const calls: Call[] = [];
  const routes: { match: (call: Call) => boolean; answer: Answer }[] = [];
  let clock = 1_000_000;
  const fetchFake = (async (input: string, init?: RequestInit) => {
    const call: Call = { url: String(input), method: init?.method ?? "GET", headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)), body: String(init?.body ?? "") };
    calls.push(call);
    const route = routes.find((candidate) => candidate.match(call));
    if (!route) return json({ error: { code: "not_mocked", message: "no route" } }, 500);
    return typeof route.answer === "function" ? route.answer(call) : route.answer.clone();
  }) as typeof fetch;
  const client = createClient({ origin: ORIGIN, store, fetch: fetchFake, now: () => clock });
  return {
    client, store, calls,
    on: (method: string, path: string, answer: Answer) => routes.unshift({ match: (call) => call.method === method && call.url === `${ORIGIN}${path}`, answer }),
    advance: (ms: number) => { clock += ms; },
    now: () => clock,
  };
}

const token = (n: number) => ({ access_token: `kat_${n}`, refresh_token: `krt_${n}`, expires_in: 3600, token_type: "Bearer", scope: "services:read" });
const services = { data: [{ id: "s1", name: "Cleaning", url: "https://kalendr.test/book/x/cleaning", hidden: false, durationMinutes: 30 }] };

describe("connecting with a code", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => { t = setup(); });

  it("asks for a code, shows it, waits, and keeps the tokens once approved", async () => {
    t.on("POST", "/api/oauth/device", json({ device_code: "kdc_x", user_code: "BCDF-GHJK", verification_uri: `${ORIGIN}/oauth/device`, verification_uri_complete: `${ORIGIN}/oauth/device?code=BCDF-GHJK`, expires_in: 600, interval: 5 }));
    const started = await t.client.startConnect();
    expect(started).toMatchObject({ userCode: "BCDF-GHJK", interval: 5 });
    expect(started.verificationUri).toContain("code=BCDF-GHJK");
    expect(await t.client.pending()).toMatchObject({ userCode: "BCDF-GHJK" });
    // Only the extension's own public client id goes out. No password, no secret.
    expect(t.calls[0]!.body).toBe("client_id=kalendr-extension");

    t.on("POST", "/api/oauth/token", json({ error: "authorization_pending", error_description: "wait" }, 400));
    expect(await t.client.pollConnect()).toEqual({ state: "waiting" });
    t.on("POST", "/api/oauth/token", json({ error: "slow_down", error_description: "slow" }, 400));
    expect(await t.client.pollConnect()).toEqual({ state: "waiting" });
    t.on("POST", "/api/oauth/token", json(token(1)));
    expect(await t.client.pollConnect()).toEqual({ state: "connected" });
    expect(await t.client.connected()).toBe(true);
    expect(await t.client.pending()).toBeNull();
    const sent = new URLSearchParams(t.calls.at(-1)!.body);
    expect(sent.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(sent.get("device_code")).toBe("kdc_x");
  });

  it("reports a no, and a code that ran out, and forgets the code either way", async () => {
    t.on("POST", "/api/oauth/device", json({ device_code: "kdc_x", user_code: "BCDF-GHJK", verification_uri: `${ORIGIN}/oauth/device`, verification_uri_complete: `${ORIGIN}/oauth/device?code=BCDF-GHJK`, expires_in: 600, interval: 5 }));
    await t.client.startConnect();
    t.on("POST", "/api/oauth/token", json({ error: "access_denied", error_description: "no" }, 400));
    expect(await t.client.pollConnect()).toEqual({ state: "denied" });
    expect(await t.client.pending()).toBeNull();
    await t.client.startConnect();
    t.advance(11 * 60_000);
    expect(await t.client.pending()).toBeNull();
    expect(await t.client.pollConnect()).toEqual({ state: "expired" });
  });

  it("says plainly when Kalendr cannot be reached", async () => {
    const offline = createClient({ origin: ORIGIN, store: memoryStore(), fetch: (async () => { throw new TypeError("network"); }) as typeof fetch, now: () => 0 });
    await expect(offline.startConnect()).rejects.toMatchObject({ code: "network" });
  });
});

describe("using the API", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(async () => {
    t = setup();
    await t.store.write("session", { kind: "oauth", accessToken: "kat_0", accessExpiresAt: t.now() + 3_600_000, refreshToken: "krt_0" });
  });

  it("sends the token, never cookies, and parses the reply", async () => {
    t.on("GET", "/api/ext/services", json(services));
    expect(await t.client.services()).toEqual(services.data);
    expect(t.calls[0]!.headers.Authorization).toBe("Bearer kat_0");
  });

  it("refuses an answer in a shape it does not know", async () => {
    t.on("GET", "/api/ext/services", json({ data: [{ id: 1 }] }));
    await expect(t.client.services()).rejects.toMatchObject({ code: "unexpected_reply" });
  });

  it("renews an old token before using it, once, even for two requests at the same time", async () => {
    t.advance(3_600_000);
    t.on("POST", "/api/oauth/token", async () => { await Promise.resolve(); return json(token(1)); });
    t.on("GET", "/api/ext/services", json(services));
    t.on("GET", "/api/ext/me", json({ data: { businessName: "Lotus", businessSlug: "lotus", scopes: [] } }));
    await Promise.all([t.client.services(), t.client.me()]);
    expect(t.calls.filter((call) => call.url.endsWith("/api/oauth/token"))).toHaveLength(1);
    expect(t.calls.filter((call) => call.url.includes("/api/ext/")).every((call) => call.headers.Authorization === "Bearer kat_1")).toBe(true);
    expect(t.store.dump().session).toMatchObject({ refreshToken: "krt_1" });
  });

  it("renews and retries when Kalendr says the token is no good", async () => {
    let first = true;
    t.on("GET", "/api/ext/services", (call) => (first && call.headers.Authorization === "Bearer kat_0" ? ((first = false), json({ error: { code: "invalid_api_key", message: "no" } }, 401)) : json(services)));
    t.on("POST", "/api/oauth/token", json(token(1)));
    expect(await t.client.services()).toEqual(services.data);
  });

  it("signs out, and forgets everything, when Kalendr has ended the connection", async () => {
    t.on("GET", "/api/ext/services", json({ error: { code: "invalid_api_key", message: "no" } }, 401));
    t.on("POST", "/api/oauth/token", json({ error: "invalid_grant", error_description: "gone" }, 400));
    await expect(t.client.services()).rejects.toBeInstanceOf(SignedOutError);
    expect(await t.client.connected()).toBe(false);
    expect(t.store.dump()).toEqual({});
    await expect(t.client.today()).rejects.toMatchObject({ reason: "never" });
  });

  it("keeps the connection when a renewal fails only because Kalendr is busy", async () => {
    t.advance(3_600_000);
    t.on("POST", "/api/oauth/token", json({ error: "server_error" }, 503));
    await expect(t.client.services()).rejects.toBeInstanceOf(ApiFailure);
    expect(await t.client.connected()).toBe(true);
  });

  it("creates a single-use link and reads email times", async () => {
    t.on("POST", "/api/ext/single-use-links", json({ data: { id: "l1", url: "https://kalendr.test/l/abc" } }, 201));
    expect(await t.client.createLink("s1", "For Sam")).toEqual({ id: "l1", url: "https://kalendr.test/l/abc" });
    expect(JSON.parse(t.calls.at(-1)!.body)).toEqual({ serviceId: "s1", label: "For Sam" });
    t.on("GET", "/api/ext/email-times?serviceId=s1", json({ data: { times: [{ startsAt: "2026-12-01T04:00:00.000Z", label: "Tue 1 Dec, 9:30 am", href: "https://kalendr.test/book/x?time=1" }], html: "<ul></ul>" } }));
    expect((await t.client.emailTimes("s1")).times).toHaveLength(1);
  });

  it("disconnects here first, then tells Kalendr so the token stops working", async () => {
    t.on("POST", "/api/oauth/revoke", new Response(null, { status: 200 }));
    await t.client.disconnect();
    expect(await t.client.connected()).toBe(false);
    expect(t.calls.at(-1)).toMatchObject({ url: `${ORIGIN}/api/oauth/revoke` });
    expect(t.calls.at(-1)!.body).toBe("token=krt_0");
  });

  it("still disconnects when Kalendr cannot be reached", async () => {
    const down = createClient({ origin: ORIGIN, store: t.store, fetch: (async () => { throw new TypeError("offline"); }) as typeof fetch, now: () => 0 });
    await down.disconnect();
    expect(await down.connected()).toBe(false);
  });
});

describe("connecting with an API key", () => {
  it("checks the key before keeping it, and explains each refusal", async () => {
    const t = setup();
    await expect(t.client.connectWithKey("not a key")).rejects.toMatchObject({ code: "bad_key" });
    t.on("GET", "/api/ext/me", json({ error: { code: "invalid_api_key", message: "x" } }, 401));
    await expect(t.client.connectWithKey(KEY)).rejects.toMatchObject({ status: 401 });
    t.on("GET", "/api/ext/me", json({ error: { code: "insufficient_scope", message: "x" } }, 403));
    await expect(t.client.connectWithKey(KEY)).rejects.toMatchObject({ code: "insufficient_scope" });
    expect(await t.client.connected()).toBe(false);
    t.on("GET", "/api/ext/me", json({ data: { businessName: "Lotus", businessSlug: "lotus", scopes: ["services:read"] } }));
    await t.client.connectWithKey(` ${KEY}\n`);
    expect(await t.client.connected()).toBe(true);
  });

  it("uses the key as is, and signs out when the key is revoked", async () => {
    const t = setup();
    await t.store.write("session", { kind: "key", apiKey: KEY });
    t.on("GET", "/api/ext/services", json({ error: { code: "invalid_api_key", message: "x" } }, 401));
    await expect(t.client.services()).rejects.toBeInstanceOf(SignedOutError);
    expect(t.calls.some((call) => call.url.endsWith("/api/oauth/token"))).toBe(false);
    expect(await t.client.connected()).toBe(false);
  });
});
