/*
 * Kalendr service worker (hand-written; no build step, so it is served as is).
 *
 * What it does, and the rules it keeps:
 *  1. Keeps the app's own files (scripts, styles, icons) so the app opens at once. These hold no customer data.
 *  2. Keeps the last schedule the signed-in person loaded (the snapshot and the schedule and dashboard pages) so
 *     the schedule opens read-only with no network. That is customer data, so it lives in its own private cache,
 *     tied to the signed-in person, and is deleted on sign-out, on a "signed out" answer from the server, and when
 *     a different person signs in. Nothing else is ever stored: not the live stream, not sign-in, not the customer
 *     portal's data, and never a change (only GET is touched).
 *  3. Shows push alerts (short text, no names) and opens the right page when one is tapped.
 *
 * The logic is in `createWorker`, which takes its browser pieces as arguments so tests can drive it with fakes.
 */

const VERSION = "v1";
const SHELL_CACHE = `kalendr-shell-${VERSION}`;
const PRIVATE_CACHE = `kalendr-private-${VERSION}`;
const META_CACHE = `kalendr-meta-${VERSION}`;
const SCOPE_KEY = "/__scope";
const CACHED_AT_HEADER = "x-kalendr-cached-at";
/** Set on a response the worker served from its private cache, so the page can say "Offline: showing 9:42 am". */
const OFFLINE_HEADER = "x-kalendr-offline-at";

const SNAPSHOT_PATH = "/api/staff/snapshot";
/** Pages that open offline. Everything else needs the network. */
const OFFLINE_PAGES = ["/dashboard", "/schedule"];
const DEFAULT_LINK = "/dashboard";
const ICON = "/icons/icon-192.png";

const ALL_CACHES = [SHELL_CACHE, PRIVATE_CACHE, META_CACHE];

/** Which way a request is handled: "static", "snapshot", "page", or "pass" (the worker does not touch it). */
function classify(requestUrl, method, mode, origin) {
  if (method !== "GET") return "pass";
  const url = new URL(requestUrl);
  if (url.origin !== origin) return "pass";
  const path = url.pathname;
  if (path === SNAPSHOT_PATH) return "snapshot";
  // The live stream, sign-in, portal data and every other API call always go to the network.
  if (path.startsWith("/api/")) return "pass";
  if (path.startsWith("/_next/static/") || path.startsWith("/icons/") || path === "/kalendr-mark.svg" || path === "/kalendr-maskable.svg") {
    return "static";
  }
  if (mode === "navigate" && OFFLINE_PAGES.some((page) => path === page || path.startsWith(`${page}/`))) return "page";
  return "pass";
}

/** Only a path on this site may be opened from a notification. Anything else becomes the dashboard. */
function safeLink(link, origin) {
  if (typeof link !== "string" || link.length > 200) return DEFAULT_LINK;
  try {
    const url = new URL(link, origin);
    if (url.origin !== origin) return DEFAULT_LINK;
    return url.pathname + url.search + url.hash;
  } catch {
    return DEFAULT_LINK;
  }
}

/** Reads a push event's data defensively: a bad or empty one still shows something sensible. */
function readPush(data) {
  let parsed = null;
  try {
    parsed = data ? data.json() : null;
  } catch {
    parsed = null;
  }
  const title = parsed && typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.slice(0, 140) : "Kalendr";
  const body = parsed && typeof parsed.body === "string" ? parsed.body.slice(0, 140) : undefined;
  const link = parsed && typeof parsed.link === "string" ? parsed.link : DEFAULT_LINK;
  const kind = parsed && typeof parsed.kind === "string" ? parsed.kind.slice(0, 40) : "alert";
  return { title, body, link, kind };
}

function createWorker(env) {
  const { caches, clients, registration, origin, now, isDevHost } = env;
  const doFetch = env.fetch;

  async function deleteOldCaches() {
    for (const name of await caches.keys()) {
      if (name.startsWith("kalendr-") && !ALL_CACHES.includes(name)) await caches.delete(name);
    }
  }

  /** Everything that holds customer data. */
  async function clearPrivate() {
    await caches.delete(PRIVATE_CACHE);
    await caches.delete(META_CACHE);
  }

  async function withCachedAt(response) {
    const headers = new Headers(response.headers);
    headers.set(CACHED_AT_HEADER, new Date(now()).toISOString());
    return new Response(await response.blob(), { status: response.status, statusText: response.statusText, headers });
  }

  function asOffline(cached) {
    const headers = new Headers(cached.headers);
    headers.set(OFFLINE_HEADER, headers.get(CACHED_AT_HEADER) || new Date(now()).toISOString());
    return new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers });
  }

  function offlinePage() {
    return new Response(
      "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>Offline</title>" +
        "<body style='font:16px system-ui;margin:2rem'><h1>You are offline</h1><p>Open the schedule once while online and it will be here next time.</p>",
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
    );
  }

  /** Network first. A good answer is kept for next time; a failed network falls back to what was kept. */
  async function privateNetworkFirst(request) {
    const cache = await caches.open(PRIVATE_CACHE);
    try {
      const response = await doFetch(request);
      if (response.status === 401 || response.status === 403) {
        // Signed out (or not allowed any more): nothing kept for this person may be shown again.
        await clearPrivate();
        return response;
      }
      if (response.ok && !response.redirected) await cache.put(request, await withCachedAt(response.clone()));
      return response;
    } catch {
      const cached = await cache.match(request);
      if (cached) return asOffline(cached);
      return null;
    }
  }

  async function staticFiles(request) {
    // While developing, scripts change on every save: never serve an old one.
    if (isDevHost) return doFetch(request);
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(request);
    const refresh = doFetch(request).then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    });
    if (cached) {
      refresh.catch(() => undefined);
      return cached;
    }
    return refresh;
  }

  async function handleRequest(request) {
    const kind = classify(request.url, request.method, request.mode, origin);
    if (kind === "static") return staticFiles(request);
    if (kind === "snapshot") {
      const response = await privateNetworkFirst(request);
      return response || new Response(JSON.stringify({ error: { code: "offline", message: "You are offline." } }), { status: 503, headers: { "Content-Type": "application/json" } });
    }
    if (kind === "page") return (await privateNetworkFirst(request)) || offlinePage();
    return doFetch(request);
  }

  /** The page tells the worker who is signed in. A different person than last time means the old schedule goes. */
  async function setScope(scope) {
    if (typeof scope !== "string" || !scope) return;
    const meta = await caches.open(META_CACHE);
    const stored = await meta.match(SCOPE_KEY);
    const previous = stored ? await stored.text() : null;
    if (previous !== null && previous !== scope) await clearPrivate();
    const fresh = await caches.open(META_CACHE);
    await fresh.put(SCOPE_KEY, new Response(scope));
  }

  async function onMessage(data) {
    if (!data || typeof data !== "object") return;
    if (data.type === "clear") await clearPrivate();
    else if (data.type === "scope") await setScope(data.scope);
  }

  async function onPush(data) {
    const message = readPush(data);
    await registration.showNotification(message.title, {
      body: message.body,
      icon: ICON,
      badge: ICON,
      // The same kind of alert replaces the last one instead of piling up on the lock screen.
      tag: message.kind,
      data: { link: safeLink(message.link, origin) },
    });
  }

  async function onNotificationClick(notification) {
    notification.close();
    const target = safeLink(notification.data && notification.data.link, origin);
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin === origin) {
        await client.focus();
        if (typeof client.navigate === "function") await client.navigate(target);
        return target;
      }
    }
    await clients.openWindow(target);
    return target;
  }

  return { classify: (request) => classify(request.url, request.method, request.mode, origin), handleRequest, onMessage, onPush, onNotificationClick, deleteOldCaches, clearPrivate };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { createWorker, classify, safeLink, readPush, SHELL_CACHE, PRIVATE_CACHE, META_CACHE, OFFLINE_HEADER, CACHED_AT_HEADER };
} else if (typeof self !== "undefined" && typeof self.addEventListener === "function") {
  const worker = createWorker({
    caches: self.caches,
    clients: self.clients,
    registration: self.registration,
    fetch: (request) => self.fetch(request),
    origin: self.location.origin,
    now: () => Date.now(),
    isDevHost: ["localhost", "127.0.0.1", "[::1]"].includes(self.location.hostname),
  });
  self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
  self.addEventListener("activate", (event) => event.waitUntil(worker.deleteOldCaches().then(() => self.clients.claim())));
  self.addEventListener("fetch", (event) => {
    if (worker.classify(event.request) === "pass") return;
    event.respondWith(worker.handleRequest(event.request));
  });
  self.addEventListener("message", (event) => event.waitUntil(worker.onMessage(event.data)));
  self.addEventListener("push", (event) => event.waitUntil(worker.onPush(event.data)));
  self.addEventListener("notificationclick", (event) => event.waitUntil(worker.onNotificationClick(event.notification)));
}
