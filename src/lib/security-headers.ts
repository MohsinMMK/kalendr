/**
 * The site's Content Security Policy, shared by next.config.ts (for responses the
 * proxy doesn't touch) and src/proxy.ts (for pages, which get a per-request nonce).
 */

import { isLoopbackDeployment } from "./embed/query";
import { trackingConnectHosts, trackingImageHosts, trackingScriptHosts } from "./embed/tracking";

const isDevelopment = process.env.NODE_ENV !== "production";

/**
 * HSTS and upgrade-insecure-requests only make sense on a site served over HTTPS.
 * On http://localhost they'd make the browser ask for assets that can't load.
 */
export function enforcesHttps(): boolean {
  if (isDevelopment) return false;
  return !/^http:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(process.env.NEXT_PUBLIC_APP_URL ?? "");
}

/** Cloudflare Turnstile's script and challenge frame, allowed only when the bot check is configured. */
export const turnstileOrigin = "https://challenges.cloudflare.com";

function botCheckOrigins(): string[] {
  return process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY ? [turnstileOrigin] : [];
}

/**
 * What a video call page (`/visit`) needs beyond the rest of the site: Daily's call frame and its media and signalling
 * servers. Nothing else gets these, so a script injected into another page can't open a call connection.
 */
const dailyFrameOrigins = ["https://*.daily.co"];
const dailyConnectOrigins = ["https://*.daily.co", "https://*.wss.daily.co", "wss://*.wss.daily.co", "https://*.pluot.blue", "wss://*.pluot.blue"];

/** Whether a path is a video call page. Camera and microphone are allowed on these and nowhere else. */
export function isVisitPath(pathname: string): boolean {
  return pathname === "/visit" || pathname.startsWith("/visit/");
}

/**
 * Permissions-Policy for the video call pages: the page itself may use the camera and microphone, and so may the
 * call frame on the business's own Daily address (a Permissions-Policy origin can't be a wildcard).
 */
export function visitPermissionsPolicy(dailyDomain: string | undefined = process.env.DAILY_DOMAIN): string {
  const domain = dailyDomain?.trim();
  const frame = domain && /^[a-z0-9-]+$/i.test(domain) ? ` "https://${domain}.daily.co"` : "";
  return `camera=(self${frame}), microphone=(self${frame}), geolocation=(), browsing-topics=()`;
}

/**
 * What Razorpay's Checkout.js needs (their published list): the script, the checkout frames, and the
 * calls the checkout makes. Only the pages where a customer pays get these (`isPaymentPath`).
 */
const razorpayScriptOrigins = ["https://checkout.razorpay.com"];
const razorpayFrameOrigins = ["https://api.razorpay.com", "https://checkout.razorpay.com"];
const razorpayConnectOrigins = ["https://api.razorpay.com", "https://lumberjack.razorpay.com"];
const razorpayImageOrigins = ["https://cdn.razorpay.com"];

/** Whether a path is a page where a customer can pay: the booking pages, the manage page and pay links. */
export function isPaymentPath(pathname: string): boolean {
  // Special links (/l/…) and combined links (/b/…/with/…) run the same booking flow, so they pay the same way; a visit opened from
  // the patient portal shows the same "pay now" step as /manage.
  return ["/book", "/manage", "/pay", "/l", "/portal/visits"].some((root) => pathname === root || pathname.startsWith(`${root}/`)) || /^\/b\/[^/]+\/with\//.test(pathname);
}

/** Settings, where an owner pays Kalendr for a plan: Razorpay's checkout opens there (feature 14). */
export function isBillingPath(pathname: string): boolean {
  return pathname === "/settings" || pathname.startsWith("/settings/");
}

/**
 * Whether a path is a public booking page, the only place a business's own tracking snippets run (feature 52). Staff, portal,
 * manage and pay pages never get the tracking hosts below.
 */
export function isBookingPath(pathname: string): boolean {
  return pathname === "/book" || pathname.startsWith("/book/");
}

export function contentSecurityPolicy({
  nonce,
  frameAncestors = "'none'",
  video = false,
  payments = false,
  tracking = false,
}: { nonce?: string; frameAncestors?: string; video?: boolean; payments?: boolean; tracking?: boolean } = {}): string {
  const scriptSources = [
    "'self'",
    ...(nonce ? [`'nonce-${nonce}'`, "'strict-dynamic'"] : []),
    // Browsers that understand 'strict-dynamic' ignore host sources and trust the widget
    // loader because a nonced script adds it; older ones need the host listed.
    ...botCheckOrigins(),
    ...(payments ? razorpayScriptOrigins : []),
    ...(tracking ? Object.values(trackingScriptHosts) : []),
    ...(isDevelopment ? ["'unsafe-eval'"] : []),
  ];
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
    `frame-src ${["'self'", ...botCheckOrigins(), ...(video ? dailyFrameOrigins : []), ...(payments ? razorpayFrameOrigins : [])].join(" ")}`,
    `frame-ancestors ${frameAncestors}`,
    `script-src ${scriptSources.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src ${["'self'", "data:", "blob:", ...(payments ? razorpayImageOrigins : []), ...(tracking ? trackingImageHosts : [])].join(" ")}`,
    "font-src 'self' data:",
    // The service worker (public/sw.js) and the app manifest are our own files only.
    "worker-src 'self'",
    "manifest-src 'self'",
    `connect-src ${["'self'", ...errorReportingOrigins(), ...(video ? dailyConnectOrigins : []), ...(payments ? razorpayConnectOrigins : []), ...(tracking ? trackingConnectHosts : [])].join(" ")}`,
    ...(video ? ["media-src 'self' blob: mediastream:"] : []),
    ...(enforcesHttps() ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

/** Where the browser may send error reports: the origin of NEXT_PUBLIC_SENTRY_DSN, if set. */
function errorReportingOrigins(): string[] {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  if (!dsn) return [];
  try {
    const origin = new URL(dsn).origin;
    return origin.startsWith("https://") || isDevelopment || /^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin) ? [origin] : [];
  } catch {
    return [];
  }
}

/**
 * Who may frame public booking: this site, the operator's own list (KALENDR_BOOKING_FRAME_ANCESTORS, for Kalendr's
 * demo pages), and the sites this business saved in Settings (`tenant_embed_origins`, feature 13), which the proxy
 * passes in as `businessOrigins`. Anything else is refused by the browser. Saved origins are checked again here, so a
 * bad row can never put anything but an https origin into the header.
 */
export function bookingFrameAncestors(businessOrigins: readonly string[] = []): string {
  const configuredOrigins = [...(process.env.KALENDR_BOOKING_FRAME_ANCESTORS?.split(",") ?? []), ...businessOrigins];
  const safeOrigins = configuredOrigins.flatMap((candidate) => {
    try {
      const origin = new URL(candidate.trim()).origin;
      if (origin.startsWith("https://")) return [origin];
      if (
        (isDevelopment || isLoopbackDeployment()) &&
        (origin.startsWith("http://localhost:") || origin.startsWith("http://127.0.0.1:"))
      ) {
        return [origin];
      }
    } catch {
      return [];
    }
    return [];
  });
  return ["'self'", ...new Set(safeOrigins)].join(" ");
}
