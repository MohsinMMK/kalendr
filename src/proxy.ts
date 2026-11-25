import { type NextRequest, NextResponse } from "next/server";

import { bookingSlugFromPath, decideCustomHostPath, hostOf, ownHostSet } from "@/lib/host-routing";
import { bookingFrameAncestors, contentSecurityPolicy, isBillingPath, isBookingPath, isPaymentPath, isVisitPath, visitPermissionsPolicy } from "@/lib/security-headers";
import { lookupEmbedOrigins, lookupHostBusiness } from "@/server/host-lookup";

function ownHosts(): Set<string> {
  return ownHostSet({
    appUrl: process.env.NEXT_PUBLIC_APP_URL,
    ownHosts: [process.env.KALENDR_OWN_HOSTS, process.env.BETTER_AUTH_URL].filter(Boolean).join(","),
    cnameTarget: process.env.KALENDR_CNAME_TARGET,
  });
}

/** What an unknown, lapsed or staff-only address gets: nothing about Kalendr, and nothing to cache. */
function plainResponse(status: 404 | 503): NextResponse {
  return new NextResponse(status === 404 ? "Not found" : "Temporarily unavailable", {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'" },
  });
}

/**
 * Two jobs. On a host that is not Kalendr's own it finds the business that owns the address and rewrites the request
 * to that business's public pages, or answers 404 (feature 13). On every page it gives the response a fresh script
 * nonce; Next.js reads it from the request's CSP and applies it to its own scripts.
 */
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const host = hostOf(request.headers.get("host"));
  // Own web addresses are off until the deployment names a CNAME target: without one every host is Kalendr's own, as before.
  // The two probes are answered on any host, because a load balancer asks by IP address or service name.
  const probe = request.nextUrl.pathname === "/api/health" || request.nextUrl.pathname === "/api/ready";
  const ownHost = !process.env.KALENDR_CNAME_TARGET?.trim() || probe || ownHosts().has(host);
  const isApi = request.nextUrl.pathname === "/api" || request.nextUrl.pathname.startsWith("/api/");
  const isPrefetch = request.headers.has("next-router-prefetch") || request.headers.get("purpose") === "prefetch";
  // Prefetches keep the static policy from next.config.ts, as before.
  if (ownHost && isPrefetch) return NextResponse.next();

  let pathname = request.nextUrl.pathname;
  let customSlug: string | null = null;
  let rewriteTo: URL | null = null;
  if (!ownHost) {
    // The API only comes through the proxy to be refused on a business's address; Kalendr's own API keeps its static policy.
    let business;
    try {
      business = await lookupHostBusiness(host);
    } catch {
      return plainResponse(503);
    }
    if (!business) return plainResponse(404);
    const decision = decideCustomHostPath(pathname, business.slug);
    if (decision.kind === "not_found") return plainResponse(404);
    customSlug = business.slug;
    pathname = decision.pathname;
    if (pathname !== request.nextUrl.pathname) {
      rewriteTo = request.nextUrl.clone();
      rewriteTo.pathname = pathname;
    }
  }
  if (isApi || isPrefetch) return rewriteTo ? NextResponse.rewrite(rewriteTo) : NextResponse.next();

  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isBooking = pathname === "/book" || pathname.startsWith("/book/");
  // The CSP follows the page that will render, not the address the visitor typed.
  const bookingSlug = isBooking ? (customSlug ?? bookingSlugFromPath(pathname)) : null;
  const policy = contentSecurityPolicy({
    nonce,
    ...(isBooking ? { frameAncestors: bookingFrameAncestors(bookingSlug ? await lookupEmbedOrigins(bookingSlug) : []) } : {}),
    // Video call pages also get Daily's call frame and servers, and the camera and microphone.
    video: isVisitPath(pathname),
    // Booking, manage and pay-link pages also get Razorpay's checkout script and frames.
    payments: isPaymentPath(pathname) || isBillingPath(pathname),
    // The business's own analytics hosts, on its public booking pages only (feature 52).
    tracking: isBookingPath(pathname),
  });

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  // The page being opened, for the support-session view log. Documents only: API requests skip this proxy, so a client could send its own x-pathname there (it only labels the operator's own audit rows).
  requestHeaders.set("x-pathname", pathname);
  requestHeaders.set("Content-Security-Policy", policy);

  const response = rewriteTo
    ? NextResponse.rewrite(rewriteTo, { request: { headers: requestHeaders } })
    : NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  if (isVisitPath(pathname)) response.headers.set("Permissions-Policy", visitPermissionsPolicy());
  return response;
}

export const config = {
  matcher: [
    {
      // Documents only. Assets keep the static policy from next.config.ts. Prefetches come through too, so a business's
      // own address can rewrite and refuse them like any other request; on Kalendr's own address they pass straight through.
      source: "/((?!api|_next/static|_next/image|favicon\\.ico|.*\\.[a-zA-Z0-9]+$).*)",
    },
    // API routes, so a business's own address can be refused them. Own-host API requests pass straight through.
    { source: "/api/:path*" },
  ],
};
