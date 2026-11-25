import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { defineConfig, devices } from "@playwright/test";

/**
 * Browser journeys against the production build (`next start`) and a throwaway
 * database. Run `scripts/e2e.sh` locally; CI prepares the database the same way.
 * Outside services are replaced by e2e/support/capture-server.mjs: no test reaches a
 * real email provider or Sentry.
 */
// Playwright loads this file as CommonJS, so paths resolve from the project root it runs in.
const projectRoot = process.cwd();
// Overridable (with KALENDR_E2E_NAME in scripts/e2e-database.mjs) so sessions sharing a scratch server keep separate state.
const stateDirName = process.env.KALENDR_E2E_STATE_DIR ?? ".e2e";
// Overridable so two checkouts can run browser tests on one machine.
const appPort = Number(process.env.KALENDR_E2E_APP_PORT ?? 3100);
const capturePort = Number(process.env.KALENDR_E2E_CAPTURE_PORT ?? 3199);
const appUrl = `http://localhost:${appPort}`;
const captureUrl = `http://127.0.0.1:${capturePort}`;

function readRuntimeEnv(): Record<string, string> {
  const file = resolve(projectRoot, stateDirName, "runtime.env");
  if (!existsSync(file)) {
    throw new Error("Run scripts/e2e.sh (or node scripts/e2e-database.mjs) first to prepare the test database.");
  }
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

const runtime = readRuntimeEnv();
// The tests read these too (sign-in passwords, owner access for isolation checks).
process.env.KALENDR_STAFF_CREDENTIALS = runtime.KALENDR_STAFF_CREDENTIALS;
process.env.KALENDR_E2E_OWNER_URL = runtime.KALENDR_E2E_OWNER_URL;
process.env.KALENDR_CAPTURE_URL = captureUrl;
process.env.KALENDR_APP_URL = appUrl;

export default defineConfig({
  testDir: "./e2e",
  // Journeys share one database and book real slots, so they run one at a time.
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: appUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
  },
  projects: [
    // Each project books and signs in from its own documentation address (TEST-NET-1), so the two
    // runs don't share one request-limit count. The app trusts one proxy hop, like production.
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 900 }, extraHTTPHeaders: { "x-forwarded-for": "192.0.2.10" } },
    },
    { name: "phone", use: { ...devices["Pixel 7"], extraHTTPHeaders: { "x-forwarded-for": "192.0.2.20" } } },
  ],
  webServer: [
    {
      command: "node e2e/support/capture-server.mjs",
      url: `${captureUrl}/health`,
      reuseExistingServer: false,
      env: { KALENDR_CAPTURE_PORT: String(capturePort) },
    },
    {
      command: `pnpm exec next start --port ${appPort}`,
      url: `${appUrl}/api/ready`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: "pipe",
      env: {
        NODE_ENV: "production",
        DATABASE_URL: runtime.DATABASE_URL,
        BETTER_AUTH_SECRET: runtime.BETTER_AUTH_SECRET,
        BETTER_AUTH_URL: appUrl,
        BETTER_AUTH_TRUSTED_ORIGINS: appUrl,
        NEXT_PUBLIC_APP_URL: appUrl,
        BETTER_AUTH_ALLOW_SIGNUP: "false",
        BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION: "true",
        KALENDR_ALLOW_CLINIC_REGISTRATION: "true",
        // The built-in Google and Microsoft stand-in (feature 6). Allowed only because the app is on localhost.
        KALENDR_DEV_OAUTH: "true",
        KALENDR_PREVIEW_MODE: "false",
        KALENDR_RECORDS_KEY: runtime.KALENDR_RECORDS_KEY,
        KALENDR_KEY_PROVIDER: runtime.KALENDR_KEY_PROVIDER,
        KALENDR_LOCAL_MASTER_KEY: runtime.KALENDR_LOCAL_MASTER_KEY,
        KALENDR_FILE_STORE_DIR: resolve(projectRoot, stateDirName, "files"),
        // The made-up website the embed journey (e2e/embeds.spec.ts) pastes the snippet into: another address on this machine, served by the test itself.
        KALENDR_BOOKING_FRAME_ANCESTORS: `${appUrl},http://127.0.0.1:${appPort}`,
        // Own web addresses (feature 13). Any other host is looked up as a business's own address, e.g. http://book-e2e.localhost:3100.
        KALENDR_CNAME_TARGET: "edge.e2e.test",
        TRUSTED_PROXY_HOPS: "1",
        EMAIL_FROM: "Kalendr Tests <tests@example.com>",
        RESEND_API_KEY: "e2e-capture-only",
        EMAIL_API_URL: `${captureUrl}/emails`,
        // A test-only svix secret; e2e/booking-email.spec.ts signs its webhooks with it.
        RESEND_WEBHOOK_SECRET: `whsec_${Buffer.from("kalendr-test-webhook-secret-0001").toString("base64")}`,
        // Test-only WhatsApp and SMS settings: the app verifies webhooks with these, and the worker (started by the
        // specs) sends to the capture server. e2e/whatsapp-inbox.spec.ts signs with the same secret.
        WHATSAPP_APP_SECRET: "kalendr-test-whatsapp-app-secret-0001",
        WHATSAPP_VERIFY_TOKEN: "kalendr-test-whatsapp-verify-token-0001",
        SENTRY_DSN: `http://e2epublickey@127.0.0.1:${capturePort}/1`,
        SENTRY_ENVIRONMENT: "e2e",
        // Calendar sync runs on in-memory test calendars; no provider is contacted. Refused unless the address above is localhost.
        CALENDAR_PROVIDER_MODE: "fake",
        // Video visits run in local test mode: the browser tests never reach a real video provider.
        VIDEO_PROVIDER: "test",
        KALENDR_ALLOW_TEST_VIDEO: "true",
        // The built-in test checkout page (/pay/test/...), for the online payment journey. It is on only because the app is on localhost.
        KALENDR_E2E_TEST_CHECKOUT: "true",
        // The booking assistant (feature 30) runs on its built-in test model: no key, no network. Refused unless the address above is localhost.
        ASSISTANT_PROVIDER_MODE: "fake",
        // Search and discovery (feature 29): nothing kept, so a journey that lists a business sees the sitemap change at once.
        KALENDR_DISCOVERY_CACHE_SECONDS: "0",
        LOG_LEVEL: "warn",
        DEPLOYMENT_VERSION: "e2e",
      },
    },
  ],
});
