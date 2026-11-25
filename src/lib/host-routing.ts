/**
 * Which host a request came to, and what a business's own address may show (feature 13). Pure, so the proxy and the
 * tests share it. The proxy resolves a host that is not Kalendr's own to a business and rewrites the request to that
 * business's public pages. Everything else on that host, staff sign-in and staff screens above all, is a plain 404:
 * staff sign in on Kalendr's own address only.
 */

/** Hosts that are always Kalendr's own. */
const loopbackHosts = ["localhost", "127.0.0.1", "[::1]"];

/** The host without its port, in lower case. */
export function hostOf(headerValue: string | null | undefined): string {
  const value = (headerValue ?? "").trim().toLowerCase();
  if (value.startsWith("[")) return value.slice(0, value.indexOf("]") + 1);
  return value.split(":")[0] ?? "";
}

export interface HostEnvironment {
  appUrl?: string | undefined;
  ownHosts?: string | undefined;
  cnameTarget?: string | undefined;
}

/** Kalendr's own hosts: loopback, the app address, the CNAME target, and any listed in KALENDR_OWN_HOSTS. */
export function ownHostSet(environment: HostEnvironment): Set<string> {
  const hosts = new Set<string>(loopbackHosts);
  for (const candidate of [environment.appUrl, environment.cnameTarget]) {
    if (!candidate) continue;
    try {
      hosts.add(new URL(/^[a-z]+:\/\//i.test(candidate) ? candidate : `https://${candidate}`).hostname.toLowerCase());
    } catch {
      // A malformed setting adds nothing; the env check reports it at startup.
    }
  }
  for (const entry of (environment.ownHosts ?? "").split(",")) {
    const host = hostOf(entry.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
    if (host) hosts.add(host);
  }
  return hosts;
}

/** Top-level paths a business's own address serves. These are all pages a customer meets, never a staff screen. */
const servedRoots = ["b", "book", "manage", "pay", "portal", "offer", "q", "check-in", "visit", "m", "class", "r", "f"];
/** API paths those pages call. Staff, sign-in, admin, webhook and internal APIs are not reachable on a business's address. */
const servedApiPrefixes = ["/api/public/", "/api/portal/"];

export type HostDecision =
  | { kind: "serve"; pathname: string }
  | { kind: "not_found" };

/**
 * What a business's own address does with a path. `/` becomes the business page and `/book/...` the booking flow; the
 * canonical `/b/<slug>` and `/book/<slug>/...` forms also work (the app's own links use them). A path that names a
 * different business is refused, so one address never shows another business.
 */
export function decideCustomHostPath(pathname: string, slug: string): HostDecision {
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return servedApiPrefixes.some((prefix) => pathname.startsWith(prefix)) ? { kind: "serve", pathname } : { kind: "not_found" };
  }
  const segments = pathname.split("/").filter(Boolean);
  const [root, second, ...rest] = segments;
  if (!root) return { kind: "serve", pathname: `/b/${slug}` };
  if (!servedRoots.includes(root)) return { kind: "not_found" };
  if (root === "b") {
    if (!second) return { kind: "serve", pathname: `/b/${slug}` };
    return second === slug ? { kind: "serve", pathname } : { kind: "not_found" };
  }
  if (root === "book") {
    if (!second) return { kind: "serve", pathname: `/book/${slug}` };
    if (second === slug) return { kind: "serve", pathname };
    return { kind: "serve", pathname: `/book/${slug}/${[second, ...rest].join("/")}` };
  }
  if (root === "f") {
    // A routing form (feature 46): `/f/<form>` on the business's own address is `/f/<slug>/<form>` underneath.
    if (!second) return { kind: "not_found" };
    if (second === slug) return { kind: "serve", pathname };
    return { kind: "serve", pathname: `/f/${slug}/${[second, ...rest].join("/")}` };
  }
  return { kind: "serve", pathname };
}

/** The business slug a booking path names, for the frame-ancestors lookup on Kalendr's own address. */
export function bookingSlugFromPath(pathname: string): string | null {
  const [root, second] = pathname.split("/").filter(Boolean);
  return root === "book" && second ? second.toLowerCase() : null;
}
