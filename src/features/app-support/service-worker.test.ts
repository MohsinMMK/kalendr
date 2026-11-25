/** @vitest-environment node */

import { createRequire } from "node:module";

import { beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const sw = require("../../../public/sw.js") as {
  createWorker: (env: unknown) => TestWorker;
  safeLink: (link: unknown, origin: string) => string;
  PRIVATE_CACHE: string;
  META_CACHE: string;
  SHELL_CACHE: string;
  OFFLINE_HEADER: string;
};

interface TestWorker {
  classify: (request: Request) => string;
  handleRequest: (request: Request) => Promise<Response>;
  onMessage: (data: unknown) => Promise<void>;
  onPush: (data: unknown) => Promise<void>;
  onNotificationClick: (notification: { close: () => void; data?: { link?: unknown } }) => Promise<string>;
}

const ORIGIN = "https://app.example.com";

/** A cache that remembers by URL, like Cache Storage does for GET requests. */
class FakeCache {
  entries = new Map<string, Response>();
  async match(request: Request | string) { return this.entries.get(typeof request === "string" ? request : new URL(request.url).pathname + new URL(request.url).search)?.clone(); }
  async put(request: Request | string, response: Response) { this.entries.set(typeof request === "string" ? request : new URL(request.url).pathname + new URL(request.url).search, response); }
}
class FakeCaches {
  stores = new Map<string, FakeCache>();
  async open(name: string) { if (!this.stores.has(name)) this.stores.set(name, new FakeCache()); return this.stores.get(name)!; }
  async delete(name: string) { return this.stores.delete(name); }
  async keys() { return [...this.stores.keys()]; }
}

function makeWorker(options: { online?: boolean; status?: number; host?: string } = {}) {
  const caches = new FakeCaches();
  const state = { online: options.online ?? true, status: options.status ?? 200, body: "{\"data\":{\"patients\":[\"Asha\"]}}" };
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const navigated: string[] = [];
  const windows: { url: string; focus: () => Promise<void>; navigate?: (url: string) => Promise<void> }[] = [];
  const fetchSpy = vi.fn(async () => {
    if (!state.online) throw new TypeError("offline");
    return new Response(state.body, { status: state.status, headers: { "Content-Type": "application/json" } });
  });
  const worker = sw.createWorker({
    caches,
    clients: {
      matchAll: async () => windows,
      openWindow: async (url: string) => { opened.push(url); },
    },
    registration: { showNotification: async (title: string, notificationOptions: Record<string, unknown>) => { shown.push({ title, options: notificationOptions }); } },
    fetch: fetchSpy,
    origin: ORIGIN,
    now: () => Date.parse("2026-11-19T04:12:00Z"),
    isDevHost: false,
  });
  return { worker, caches, state, shown, opened, navigated, windows, fetchSpy };
}

const request = (path: string, init: { method?: string; mode?: RequestMode } = {}) => {
  const value = new Request(`${ORIGIN}${path}`, { method: init.method ?? "GET" });
  return Object.defineProperty(value, "mode", { value: init.mode ?? "cors" }) as Request;
};

describe("service worker: what it touches", () => {
  const { worker } = makeWorker();
  it("handles the app's files, the schedule data and the schedule pages, and nothing else", () => {
    expect(worker.classify(request("/_next/static/chunks/app.js"))).toBe("static");
    expect(worker.classify(request("/icons/icon-192.png"))).toBe("static");
    expect(worker.classify(request("/api/staff/snapshot"))).toBe("snapshot");
    expect(worker.classify(request("/schedule", { mode: "navigate" }))).toBe("page");
    expect(worker.classify(request("/dashboard", { mode: "navigate" }))).toBe("page");
    // Live stream, sign-in, portal data and writes are never intercepted.
    expect(worker.classify(request("/api/staff/events"))).toBe("pass");
    expect(worker.classify(request("/api/auth/get-session"))).toBe("pass");
    expect(worker.classify(request("/api/portal/me"))).toBe("pass");
    expect(worker.classify(request("/api/staff/snapshot", { method: "POST" }))).toBe("pass");
    expect(worker.classify(request("/portal", { mode: "navigate" }))).toBe("pass");
    expect(worker.classify(request("/patients", { mode: "navigate" }))).toBe("pass");
    expect(worker.classify(new Request("https://other.example.com/api/staff/snapshot"))).toBe("pass");
  });
});

describe("service worker: offline schedule, read-only", () => {
  let ctx: ReturnType<typeof makeWorker>;
  beforeEach(() => { ctx = makeWorker(); });

  it("keeps the last schedule and serves it with the time it was saved when the network is gone", async () => {
    const live = await ctx.worker.handleRequest(request("/api/staff/snapshot"));
    expect(live.headers.get(sw.OFFLINE_HEADER)).toBeNull();
    ctx.state.online = false;
    const offline = await ctx.worker.handleRequest(request("/api/staff/snapshot"));
    expect(offline.status).toBe(200);
    expect(offline.headers.get(sw.OFFLINE_HEADER)).toBe("2026-11-19T04:12:00.000Z");
    expect(await offline.text()).toContain("Asha");
  });

  it("opens the schedule page offline, and says so plainly when it was never opened before", async () => {
    ctx.state.online = false;
    const never = await ctx.worker.handleRequest(request("/schedule", { mode: "navigate" }));
    expect(never.status).toBe(503);
    expect(await never.text()).toContain("You are offline");
    ctx.state.online = true;
    ctx.state.body = "<html>schedule</html>";
    await ctx.worker.handleRequest(request("/schedule", { mode: "navigate" }));
    ctx.state.online = false;
    const cached = await ctx.worker.handleRequest(request("/schedule", { mode: "navigate" }));
    expect(await cached.text()).toContain("schedule");
  });

  it("reports an offline snapshot as unavailable (not as data) when nothing was saved", async () => {
    ctx.state.online = false;
    const response = await ctx.worker.handleRequest(request("/api/staff/snapshot"));
    expect(response.status).toBe(503);
  });

  it("never stores a redirect to sign-in or a failed answer", async () => {
    ctx.state.status = 500;
    await ctx.worker.handleRequest(request("/api/staff/snapshot"));
    ctx.state.online = false;
    expect((await ctx.worker.handleRequest(request("/api/staff/snapshot"))).status).toBe(503);
  });
});

describe("service worker: customer data does not outlive the sign-in", () => {
  it("clears everything private on sign-out, but keeps the app's own files", async () => {
    const ctx = makeWorker();
    await ctx.worker.handleRequest(request("/api/staff/snapshot"));
    await ctx.worker.handleRequest(request("/_next/static/chunks/app.js"));
    await ctx.worker.onMessage({ type: "scope", scope: "clinic:user-1" });
    expect(await ctx.caches.keys()).toEqual(expect.arrayContaining([sw.PRIVATE_CACHE, sw.META_CACHE, sw.SHELL_CACHE]));

    await ctx.worker.onMessage({ type: "clear" });
    const left = await ctx.caches.keys();
    expect(left).not.toContain(sw.PRIVATE_CACHE);
    expect(left).not.toContain(sw.META_CACHE);
    expect(left).toContain(sw.SHELL_CACHE);

    ctx.state.online = false;
    expect((await ctx.worker.handleRequest(request("/api/staff/snapshot"))).status).toBe(503);
  });

  it("drops the saved schedule the moment the server says the person is signed out", async () => {
    const ctx = makeWorker();
    await ctx.worker.handleRequest(request("/api/staff/snapshot"));
    ctx.state.status = 401;
    expect((await ctx.worker.handleRequest(request("/api/staff/snapshot"))).status).toBe(401);
    ctx.state.status = 200;
    ctx.state.online = false;
    expect((await ctx.worker.handleRequest(request("/api/staff/snapshot"))).status).toBe(503);
  });

  it("never shows one person's saved schedule to the next person who signs in on this device", async () => {
    const ctx = makeWorker();
    await ctx.worker.onMessage({ type: "scope", scope: "clinic:user-1" });
    await ctx.worker.handleRequest(request("/api/staff/snapshot"));
    await ctx.worker.onMessage({ type: "scope", scope: "clinic:user-1" });
    ctx.state.online = false;
    expect((await ctx.worker.handleRequest(request("/api/staff/snapshot"))).status).toBe(200);
    await ctx.worker.onMessage({ type: "scope", scope: "clinic:user-2" });
    expect((await ctx.worker.handleRequest(request("/api/staff/snapshot"))).status).toBe(503);
  });

  it("ignores messages it does not understand", async () => {
    const ctx = makeWorker();
    await ctx.worker.handleRequest(request("/api/staff/snapshot"));
    for (const junk of [null, "clear", { type: "nope" }, { type: "scope", scope: 5 }]) await ctx.worker.onMessage(junk);
    ctx.state.online = false;
    expect((await ctx.worker.handleRequest(request("/api/staff/snapshot"))).status).toBe(200);
  });
});

describe("service worker: push alerts", () => {
  const dataOf = (value: unknown) => ({ json: () => value });

  it("shows the short alert and remembers where it leads", async () => {
    const ctx = makeWorker();
    await ctx.worker.onPush(dataOf({ title: "New booking at 4:30 pm", link: "/schedule?open=abc", kind: "new_booking" }));
    expect(ctx.shown).toHaveLength(1);
    expect(ctx.shown[0]!.title).toBe("New booking at 4:30 pm");
    expect(ctx.shown[0]!.options).toMatchObject({ tag: "new_booking", data: { link: "/schedule?open=abc" }, icon: "/icons/icon-192.png" });
  });

  it("still shows something sensible for a push with no or broken data", async () => {
    const ctx = makeWorker();
    await ctx.worker.onPush(null);
    await ctx.worker.onPush({ json: () => { throw new SyntaxError("bad"); } });
    expect(ctx.shown.map((entry) => entry.title)).toEqual(["Kalendr", "Kalendr"]);
    expect(ctx.shown[0]!.options.data).toEqual({ link: "/dashboard" });
  });

  it("opens the right appointment when the alert is tapped, in a window already open or a new one", async () => {
    const ctx = makeWorker();
    const closed = vi.fn();
    const target = await ctx.worker.onNotificationClick({ close: closed, data: { link: "/schedule?open=abc" } });
    expect(closed).toHaveBeenCalled();
    expect(target).toBe("/schedule?open=abc");
    expect(ctx.opened).toEqual(["/schedule?open=abc"]);

    const focus = vi.fn(async () => undefined);
    const navigate = vi.fn(async () => undefined);
    ctx.windows.push({ url: `${ORIGIN}/dashboard`, focus, navigate });
    await ctx.worker.onNotificationClick({ close: closed, data: { link: "/schedule?open=xyz" } });
    expect(focus).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/schedule?open=xyz");
    expect(ctx.opened).toHaveLength(1);
  });

  it("never opens another site, whatever the push says", async () => {
    const ctx = makeWorker();
    for (const link of ["https://evil.example/phish", "//evil.example", "javascript:alert(1)", 42, undefined, "/" + "a".repeat(300)]) {
      expect(sw.safeLink(link, ORIGIN)).toBe("/dashboard");
    }
    await ctx.worker.onNotificationClick({ close: () => undefined, data: { link: "https://evil.example/phish" } });
    expect(ctx.opened).toEqual(["/dashboard"]);
  });
});
