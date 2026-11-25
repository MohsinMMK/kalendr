import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

import {
  bookingFrameAncestors,
  contentSecurityPolicy,
  enforcesHttps,
  visitPermissionsPolicy,
} from "./src/lib/security-headers";

const baseContentSecurityPolicy = contentSecurityPolicy();

const bookingContentSecurityPolicy = contentSecurityPolicy({
  frameAncestors: bookingFrameAncestors(),
});

const visitContentSecurityPolicy = contentSecurityPolicy({ video: true });

const commonSecurityHeaders = [
  { key: "Content-Security-Policy", value: baseContentSecurityPolicy },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
  ...(enforcesHttps()
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]
    : []),
];

const nextConfig: NextConfig = {
  distDir: process.env.KALENDR_NEXT_DIST_DIR ?? ".next",
  output: "standalone",
  poweredByHeader: false,
  experimental: {
    // Root imports of these packages pull in every component unless Next rewrites them to the files used.
    optimizePackageImports: ["@base-ui/react", "react-email"],
  },
  deploymentId: process.env.DEPLOYMENT_VERSION,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: commonSecurityHeaders,
      },
      {
        source: "/book/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value: bookingContentSecurityPolicy,
          },
        ],
      },
      {
        // Defence in depth for pages that are never for search engines (feature 29): manage links, queue and payment links,
        // the portal, check-in and the like also say so in their own metadata, so a page that forgets still carries it.
        source: "/:area(manage|portal|check-in|q|s|m|l|class|pay|visit|r|offer|unsubscribed|print)/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
      {
        // The service worker must never be cached, or a fix to it would not reach phones that already have the app.
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        // Video call pages: the call frame, and the camera and microphone for these pages only.
        source: "/visit/:path*",
        headers: [
          { key: "Content-Security-Policy", value: visitContentSecurityPolicy },
          { key: "Permissions-Policy", value: visitPermissionsPolicy() },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
      {
        source: "/kalendr-widget.js",
        headers: [
          { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
          { key: "Cache-Control", value: "public, max-age=300, must-revalidate" },
        ],
      },
      ...["/dashboard/:path*", "/patients/:path*", "/follow-ups/:path*", "/settings/:path*"]
        .map((source) => ({
          source,
          headers: [{ key: "X-Frame-Options", value: "DENY" }],
        })),
      {
        // Picture addresses never change, so their route sets a long cache itself. So does the public API
        // description (v1/openapi.json), which holds nothing private and is cached for a few minutes.
        source: "/api/:path((?!public/media/|v1/openapi\\.json$).*)",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
    ];
  },
};

/*
 * Sentry's build step only uploads source maps when SENTRY_AUTH_TOKEN is set (a release
 * build in CI). Local and test builds send nothing: no upload and no build telemetry.
 * Error reporting at runtime is a separate switch, SENTRY_DSN.
 */
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN;

export default withSentryConfig(nextConfig, {
  silent: true,
  telemetry: false,
  authToken: sentryAuthToken,
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  release: { name: process.env.DEPLOYMENT_VERSION, create: Boolean(sentryAuthToken) },
  sourcemaps: { disable: !sentryAuthToken, deleteSourcemapsAfterUpload: true },
  // Reporting has one path: routeErrorResponse for API routes and onRequestError for pages.
  // Sentry's wrappers would also report expected 4xx errors, so they stay off.
  webpack: {
    autoInstrumentServerFunctions: false,
    autoInstrumentMiddleware: false,
    autoInstrumentAppDirectory: false,
  },
});
