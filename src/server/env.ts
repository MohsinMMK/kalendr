/**
 * Every environment variable Kalendr reads, in one schema.
 *
 * `env()` parses the current process environment and fails with a message that
 * names each bad variable. `startupProblems()` adds the rules a production process
 * must meet before it serves anyone; `src/instrumentation.ts` and the worker call
 * `assertStartupEnvironment()` so a misconfigured process stops instead of starting.
 *
 * This file has no "server-only" import so the worker (run with tsx or a bundle) can
 * use it. Nothing here is sent to the browser: only NEXT_PUBLIC_* values are inlined
 * by Next.js, and those are read directly where a client component needs them.
 */
import { z } from "zod";

import { ipVersion } from "../lib/ip-address";

/** Placeholders that must never sign real sessions. */
const PLACEHOLDER_SECRETS = new Set([
  "replace-with-a-long-random-secret",
  "kalendr-preview-auth-disabled-000000000000000000000000",
]);

/** An empty value in a .env file means "not set". */
function blankAsUnset<T extends z.ZodType>(schema: T) {
  return z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? undefined : value), schema);
}

const optionalText = blankAsUnset(z.string().trim().optional());
const flag = blankAsUnset(z.enum(["true", "false"], { error: "must be true or false" }).optional());
const httpUrl = blankAsUnset(
  z
    .string()
    .trim()
    .refine((value) => /^https?:\/\//.test(value) && URL.canParse(value), "must be an http(s) URL")
    .optional(),
);

const schema = z.object({
  NODE_ENV: blankAsUnset(z.enum(["development", "test", "production"]).default("development")),

  DATABASE_URL: blankAsUnset(
    z
      .string()
      .trim()
      .refine(
        (value) => URL.canParse(value) && ["postgres:", "postgresql:"].includes(new URL(value).protocol),
        "must be a postgres:// or postgresql:// URL",
      )
      .optional(),
  ),
  DATABASE_POOL_MAX: blankAsUnset(z.coerce.number().int().min(1).max(50).default(5)),

  BETTER_AUTH_SECRET: optionalText,
  BETTER_AUTH_URL: httpUrl,
  BETTER_AUTH_TRUSTED_ORIGINS: optionalText,
  BETTER_AUTH_ALLOW_SIGNUP: flag,
  BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION: flag,
  KALENDR_ALLOW_CLINIC_REGISTRATION: flag,
  // Sign in with Google and Microsoft (feature 6). Each provider turns on only when both its id and secret are set.
  GOOGLE_CLIENT_ID: optionalText,
  GOOGLE_CLIENT_SECRET: optionalText,
  MICROSOFT_CLIENT_ID: optionalText,
  MICROSOFT_CLIENT_SECRET: optionalText,
  /** "common" lets any work or school account in; a directory id limits sign-in to one organisation. */
  MICROSOFT_TENANT_ID: optionalText,
  /** Development only: a built-in stand-in for Google and Microsoft that needs no keys. Refused in production. */
  KALENDR_DEV_OAUTH: flag,

  NEXT_PUBLIC_APP_URL: httpUrl,
  DEPLOYMENT_VERSION: optionalText,

  EMAIL_FROM: optionalText,
  RESEND_API_KEY: optionalText,
  EMAIL_API_URL: httpUrl,
  /** Fallback Reply-To when a business has no email of its own. */
  EMAIL_REPLY_TO: blankAsUnset(z.email({ error: "must be an email address" }).optional()),
  /** Resend's webhook signing secret (whsec_…). The webhook refuses every request without it. */
  RESEND_WEBHOOK_SECRET: blankAsUnset(
    z.string().trim().regex(/^whsec_[A-Za-z0-9+/=]{16,}$/, "must be the whsec_ signing secret from Resend").optional(),
  ),
  /**
   * Online payments with Stripe Connect (feature 23). All three or none; without them the Stripe option is hidden.
   * Razorpay needs nothing here: each business pastes its own keys, stored sealed in the database.
   */
  STRIPE_CONNECT_CLIENT_ID: optionalText,
  STRIPE_CONNECT_SECRET_KEY: optionalText,
  STRIPE_CONNECT_WEBHOOK_SECRET: optionalText,
  /** Web push (feature 32). All three or none; without them push alerts stay off and the bell still works. */
  VAPID_PUBLIC_KEY: blankAsUnset(z.string().trim().regex(/^[A-Za-z0-9_-]{80,100}$/, "must be the URL-safe base64 public key").optional()),
  VAPID_PRIVATE_KEY: blankAsUnset(z.string().trim().regex(/^[A-Za-z0-9_-]{40,50}$/, "must be the URL-safe base64 private key").optional()),
  VAPID_SUBJECT: blankAsUnset(
    z.string().trim().refine((value) => /^(mailto:[^@\s]+@[^@\s]+|https:\/\/\S+)$/.test(value), "must be a mailto: or https: address").optional(),
  ),
  /**
   * Calendar sync (feature 16). Each provider switches on when both of its keys are set; empty means off.
   * CALENDAR_WEBHOOK_TOKEN is the shared secret Google and Microsoft echo back on every notification.
   */
  GOOGLE_CALENDAR_CLIENT_ID: optionalText,
  GOOGLE_CALENDAR_CLIENT_SECRET: optionalText,
  MICROSOFT_CALENDAR_CLIENT_ID: optionalText,
  MICROSOFT_CALENDAR_CLIENT_SECRET: optionalText,
  CALENDAR_WEBHOOK_TOKEN: blankAsUnset(z.string().trim().min(24, "must be at least 24 characters").optional()),
  /** "fake" uses in-memory test calendars and contacts no provider. Refused unless the app's own address is on this machine. */
  CALENDAR_PROVIDER_MODE: blankAsUnset(z.enum(["live", "fake"]).default("live")),
  SMS_PROVIDER: blankAsUnset(z.enum(["msg91", "twilio"], { error: "must be msg91 or twilio" }).optional()),
  SMS_API_KEY: optionalText,

  // Video visits (feature 19). `daily` needs both of the other two; `none` turns video off; `test` is local test mode. Unset is test mode in development and off in production.
  VIDEO_PROVIDER: blankAsUnset(z.enum(["daily", "none", "test"]).optional()),
  /** Lets a production-mode process run video in local test mode. Browser tests only: it shows fake calls. */
  KALENDR_ALLOW_TEST_VIDEO: flag,
  DAILY_API_KEY: optionalText,
  DAILY_DOMAIN: optionalText,

  /** WhatsApp Cloud API (Meta). The token is a permanent system-user token. */
  WHATSAPP_ACCESS_TOKEN: optionalText,
  WHATSAPP_PHONE_NUMBER_ID: optionalText,
  WHATSAPP_BUSINESS_ACCOUNT_ID: optionalText,
  /** Signs every webhook POST (X-Hub-Signature-256). The webhook refuses all requests without it. */
  WHATSAPP_APP_SECRET: optionalText,
  /** Answers Meta's one-time hub.challenge address check. */
  WHATSAPP_VERIFY_TOKEN: optionalText,
  /** Graph API base. Browser tests and local runs point it at a loopback capture server. */
  WHATSAPP_API_URL: httpUrl,

  /** The AI assistant (feature 30). With no key the assistant is off in production; "fake" runs a scripted, rule-based model on this machine only. */
  ANTHROPIC_API_KEY: optionalText,
  ASSISTANT_PROVIDER_MODE: blankAsUnset(z.enum(["live", "fake"]).default("live")),
  /** The customer chat model. Staff copilot work uses ASSISTANT_STAFF_MODEL. */
  ASSISTANT_MODEL: blankAsUnset(z.string().trim().min(3).max(60).default("claude-haiku-5-5")),
  ASSISTANT_STAFF_MODEL: blankAsUnset(z.string().trim().min(3).max(60).default("claude-sonnet-5-5")),
  /** Input plus output tokens one business may use each month (the plan's cap, feature 14, can only lower it). */
  ASSISTANT_MONTHLY_TOKEN_CAP: blankAsUnset(z.coerce.number().int().min(10_000).max(1_000_000_000).default(3_000_000)),

  /** MSG91 (SMS in India). The sender id is the DLT-approved header. */
  MSG91_AUTH_KEY: optionalText,
  MSG91_SENDER_ID: optionalText,
  /** A long random string in the delivery-report URL, because MSG91 reports are not signed. */
  MSG91_WEBHOOK_TOKEN: optionalText,
  MSG91_API_URL: httpUrl,
  /** Twilio (SMS outside India). */
  TWILIO_ACCOUNT_SID: optionalText,
  TWILIO_AUTH_TOKEN: optionalText,
  TWILIO_FROM: optionalText,
  TWILIO_API_URL: httpUrl,

  KALENDR_RECORDS_KEY: blankAsUnset(
    z
      .string()
      .trim()
      .refine((value) => Buffer.from(value, "base64").length === 32, "must be 32 random bytes in base64")
      .optional(),
  ),
  KALENDR_FILE_STORE_DIR: optionalText,
  // Protected storage (feature 10): per-business data keys wrapped by a master key.
  KALENDR_KEY_PROVIDER: blankAsUnset(z.enum(["local", "kms"]).optional()),
  KALENDR_LOCAL_MASTER_KEY: blankAsUnset(
    z
      .string()
      .trim()
      .refine((value) => Buffer.from(value, "base64").length === 32, "must be 32 random bytes in base64")
      .optional(),
  ),
  KMS_KEY_ID: optionalText,
  KMS_REGION: optionalText,
  KALENDR_FILE_STORE: blankAsUnset(z.enum(["disk", "s3"]).default("disk")),
  S3_ENDPOINT: httpUrl,
  S3_REGION: optionalText,
  S3_BUCKET: optionalText,
  S3_ACCESS_KEY_ID: optionalText,
  S3_SECRET_ACCESS_KEY: optionalText,
  S3_FORCE_PATH_STYLE: flag,
  CLAMAV_HOST: optionalText,
  CLAMAV_PORT: blankAsUnset(z.coerce.number().int().min(1).max(65535).default(3310)),
  KALENDR_BOOKING_FRAME_ANCESTORS: optionalText,
  /** Own web address (feature 13): the host owners point their CNAME at, extra hosts that are Kalendr's own, and a secret the certificate host sends to /api/internal/domain-check. */
  KALENDR_CNAME_TARGET: optionalText,
  KALENDR_OWN_HOSTS: optionalText,
  KALENDR_DOMAIN_CHECK_TOKEN: optionalText,
  /** How many proxies in front of the app append to X-Forwarded-For. Required in production. */
  TRUSTED_PROXY_HOPS: blankAsUnset(z.coerce.number().int().min(0).max(5).optional()),
  /** How long the sitemap files and the directory filters are kept in each web process (feature 29). Empty means 600; 0 turns the keeping off. */
  KALENDR_DISCOVERY_CACHE_SECONDS: blankAsUnset(z.coerce.number().int().min(0).max(86_400).optional()),
  TURNSTILE_SITE_KEY: optionalText,
  TURNSTILE_SECRET_KEY: optionalText,
  KALENDR_PREVIEW_MODE: flag,
  /** Subscription billing (feature 14). Razorpay for businesses in India, Stripe elsewhere. All optional: with no keys, checkout is simply unavailable. */
  RAZORPAY_KEY_ID: optionalText,
  RAZORPAY_KEY_SECRET: optionalText,
  RAZORPAY_WEBHOOK_SECRET: optionalText,
  RAZORPAY_PLAN_ID_STARTER: optionalText,
  RAZORPAY_PLAN_ID_GROWTH: optionalText,
  RAZORPAY_PLAN_ID_SCALE: optionalText,
  STRIPE_SECRET_KEY: optionalText,
  STRIPE_WEBHOOK_SECRET: optionalText,
  STRIPE_PRICE_ID_STARTER: optionalText,
  STRIPE_PRICE_ID_GROWTH: optionalText,
  STRIPE_PRICE_ID_SCALE: optionalText,
  /** Kalendr's own GSTIN, printed on its invoices to businesses. Optional until the company is registered. */
  KALENDR_GSTIN: blankAsUnset(z.string().trim().toUpperCase().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "must be a 15-character GSTIN").optional()),
  /** Platform admin console (feature 15). When set, /admin and /api/admin answer 404 on any other Host. Host only, no scheme. */
  KALENDR_ADMIN_HOST: blankAsUnset(
    z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+(:\d{1,5})?$/, "must be a host name such as admin.example.com, with no scheme or path").optional(),
  ),
  /** Comma-separated IP addresses allowed to reach the console. When set, every other address gets a 404. */
  KALENDR_ADMIN_IP_ALLOWLIST: blankAsUnset(
    z.string().trim().refine(
      (value) => value.split(",").map((part) => part.trim()).filter(Boolean).every((part) => ipVersion(part) !== 0),
      "must be a comma-separated list of IP addresses",
    ).optional(),
  ),

  LOG_LEVEL: blankAsUnset(
    z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  ),
  SENTRY_DSN: httpUrl,
  NEXT_PUBLIC_SENTRY_DSN: httpUrl,
  SENTRY_ENVIRONMENT: optionalText,
  OTEL_EXPORTER_OTLP_ENDPOINT: httpUrl,
  OTEL_SERVICE_NAME: optionalText,

  KALENDR_WORKER_MODE: blankAsUnset(z.enum(["local_capture", "production"]).default("local_capture")),
  WORKER_DATABASE_URL: blankAsUnset(
    z
      .string()
      .trim()
      .refine(
        (value) => URL.canParse(value) && ["postgres:", "postgresql:"].includes(new URL(value).protocol),
        "must be a postgres:// or postgresql:// URL",
      )
      .optional(),
  ),
  WORKER_CONCURRENCY: blankAsUnset(z.coerce.number().int().min(1).max(32).default(4)),
});

export type Environment = z.infer<typeof schema>;
export type EnvironmentSource = Record<string, string | undefined>;

export class EnvironmentError extends Error {
  constructor(readonly problems: string[]) {
    super(`Kalendr cannot start. Fix these environment variables:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "EnvironmentError";
  }
}

function parse(source: EnvironmentSource): { value?: Environment; problems: string[] } {
  const result = schema.safeParse(source);
  if (result.success) return { value: result.data, problems: [] };
  // Name the variable and the rule. Never echo the value: it may be a secret.
  const problems = result.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`);
  return { problems };
}

/** The parsed environment. Throws EnvironmentError naming every malformed variable. */
export function env(source: EnvironmentSource = process.env): Environment {
  const { value, problems } = parse(source);
  if (!value) throw new EnvironmentError(problems);
  return value;
}

/** Every reason this environment can't serve requests. Empty means it may start. */
export function startupProblems(source: EnvironmentSource = process.env): string[] {
  const { value, problems } = parse(source);
  if (!value) return problems;
  if (value.NODE_ENV !== "production") return [];

  const found: string[] = [];
  if (!value.DATABASE_URL) found.push("DATABASE_URL is required in production");
  const secret = value.BETTER_AUTH_SECRET;
  if (!secret) found.push("BETTER_AUTH_SECRET is required in production");
  else if (PLACEHOLDER_SECRETS.has(secret)) found.push("BETTER_AUTH_SECRET is still the example placeholder");
  else if (secret.length < 32) found.push("BETTER_AUTH_SECRET must be at least 32 characters");
  if (!value.BETTER_AUTH_URL && !value.NEXT_PUBLIC_APP_URL) {
    found.push("BETTER_AUTH_URL or NEXT_PUBLIC_APP_URL is required in production");
  }
  if (value.KALENDR_DEV_OAUTH === "true" && !isLoopbackAddress(value.BETTER_AUTH_URL ?? value.NEXT_PUBLIC_APP_URL ?? "")) {
    found.push("KALENDR_DEV_OAUTH must not be true on a public address");
  }
  const stripeSet = [value.STRIPE_CONNECT_CLIENT_ID, value.STRIPE_CONNECT_SECRET_KEY, value.STRIPE_CONNECT_WEBHOOK_SECRET].filter(Boolean).length;
  if (stripeSet !== 0 && stripeSet !== 3) found.push("STRIPE_CONNECT_CLIENT_ID, STRIPE_CONNECT_SECRET_KEY and STRIPE_CONNECT_WEBHOOK_SECRET must be set together");
  if (Boolean(value.GOOGLE_CLIENT_ID) !== Boolean(value.GOOGLE_CLIENT_SECRET)) found.push("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together");
  if (Boolean(value.MICROSOFT_CLIENT_ID) !== Boolean(value.MICROSOFT_CLIENT_SECRET)) found.push("MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET must be set together");
  if (value.KALENDR_PREVIEW_MODE === "true") found.push("KALENDR_PREVIEW_MODE must not be true in production");
  if (!value.KALENDR_RECORDS_KEY) found.push("KALENDR_RECORDS_KEY is required in production");
  if (!value.KALENDR_KEY_PROVIDER) found.push("KALENDR_KEY_PROVIDER (local or kms) is required in production");
  if (value.KALENDR_KEY_PROVIDER === "local" && !value.KALENDR_LOCAL_MASTER_KEY) {
    found.push("KALENDR_LOCAL_MASTER_KEY is required when KALENDR_KEY_PROVIDER is local");
  }
  if (value.KALENDR_KEY_PROVIDER === "kms" && (!value.KMS_KEY_ID || !value.KMS_REGION)) {
    found.push("KMS_KEY_ID and KMS_REGION are required when KALENDR_KEY_PROVIDER is kms");
  }
  if (value.VIDEO_PROVIDER === "daily" && (!value.DAILY_API_KEY || !value.DAILY_DOMAIN)) {
    found.push("DAILY_API_KEY and DAILY_DOMAIN are required when VIDEO_PROVIDER is daily");
  }
  if (value.VIDEO_PROVIDER === "test" && value.KALENDR_ALLOW_TEST_VIDEO !== "true") {
    found.push("VIDEO_PROVIDER must be daily or none in production: test mode shows fake calls");
  }
  if (value.KALENDR_FILE_STORE === "s3" && !value.S3_BUCKET) found.push("S3_BUCKET is required when KALENDR_FILE_STORE is s3");
  if (value.TRUSTED_PROXY_HOPS === undefined) {
    found.push("TRUSTED_PROXY_HOPS is required in production (the number of proxies that append to X-Forwarded-For)");
  } else if (value.TRUSTED_PROXY_HOPS === 0) {
    found.push("TRUSTED_PROXY_HOPS must be at least 1 in production: without a proxy, client addresses can be forged");
  }
  if (Boolean(value.TURNSTILE_SITE_KEY) !== Boolean(value.TURNSTILE_SECRET_KEY)) {
    found.push("TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY must be set together");
  }
  const vapid = [value.VAPID_PUBLIC_KEY, value.VAPID_PRIVATE_KEY, value.VAPID_SUBJECT].filter(Boolean).length;
  if (Boolean(value.RAZORPAY_KEY_ID) !== Boolean(value.RAZORPAY_KEY_SECRET)) {
    found.push("RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set together");
  }
  if (value.NODE_ENV === "production") {
    // Keys with no webhook secret would let checkout run while nothing could ever activate the plan.
    if (value.RAZORPAY_KEY_ID && !value.RAZORPAY_WEBHOOK_SECRET) found.push("RAZORPAY_WEBHOOK_SECRET is required when Razorpay keys are set");
    if (value.STRIPE_SECRET_KEY && !value.STRIPE_WEBHOOK_SECRET) found.push("STRIPE_WEBHOOK_SECRET is required when STRIPE_SECRET_KEY is set");
  }
  if (vapid !== 0 && vapid !== 3) found.push("VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT must be set together");
  const calendarKeys = (id: string | undefined, secret: string | undefined) => Boolean(id) !== Boolean(secret);
  if (calendarKeys(value.GOOGLE_CALENDAR_CLIENT_ID, value.GOOGLE_CALENDAR_CLIENT_SECRET)) {
    found.push("GOOGLE_CALENDAR_CLIENT_ID and GOOGLE_CALENDAR_CLIENT_SECRET must be set together");
  }
  if (calendarKeys(value.MICROSOFT_CALENDAR_CLIENT_ID, value.MICROSOFT_CALENDAR_CLIENT_SECRET)) {
    found.push("MICROSOFT_CALENDAR_CLIENT_ID and MICROSOFT_CALENDAR_CLIENT_SECRET must be set together");
  }
  const anyCalendarProvider = value.GOOGLE_CALENDAR_CLIENT_ID || value.MICROSOFT_CALENDAR_CLIENT_ID;
  if (anyCalendarProvider && !value.CALENDAR_WEBHOOK_TOKEN) {
    found.push("CALENDAR_WEBHOOK_TOKEN is required when Google or Microsoft calendar keys are set");
  }
  if (value.ASSISTANT_PROVIDER_MODE === "fake" && !isLoopbackAddress(appOrigin(source))) {
    found.push("ASSISTANT_PROVIDER_MODE=fake is only allowed when the app's own address (BETTER_AUTH_URL) is on this machine");
  }
  if (value.CALENDAR_PROVIDER_MODE === "fake" && !isLoopbackAddress(appOrigin(source))) {
    found.push("CALENDAR_PROVIDER_MODE=fake is only allowed when the app's own address (BETTER_AUTH_URL) is on this machine");
  }
  if (value.EMAIL_API_URL && !isLoopbackHttpOrHttps(value.EMAIL_API_URL)) {
    found.push("EMAIL_API_URL must use https, or http on a loopback address");
  }
  for (const name of ["WHATSAPP_API_URL", "MSG91_API_URL", "TWILIO_API_URL"] as const) {
    const url = value[name];
    if (url && !isLoopbackHttpOrHttps(url)) found.push(`${name} must use https, or http on a loopback address`);
  }
  if (value.WHATSAPP_ACCESS_TOKEN && !value.WHATSAPP_APP_SECRET) {
    found.push("WHATSAPP_APP_SECRET is required when WhatsApp is set up: it verifies Meta's webhooks");
  }
  if (value.SMS_PROVIDER === "msg91" && value.MSG91_AUTH_KEY && !value.MSG91_WEBHOOK_TOKEN) {
    found.push("MSG91_WEBHOOK_TOKEN is required when MSG91 is set up: it protects the delivery-report address");
  }
  return found;
}

/** Stops startup with a message naming each problem. */
export function assertStartupEnvironment(source: EnvironmentSource = process.env): Environment {
  const problems = startupProblems(source);
  if (problems.length > 0) throw new EnvironmentError(problems);
  return env(source);
}

/** The public origin used in links, with no trailing slash. */
export function appOrigin(source: EnvironmentSource = process.env): string {
  const value = env(source);
  return (value.BETTER_AUTH_URL ?? value.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
}

/** The public site URL for metadata, robots and the sitemap. */
export function publicAppUrl(source: EnvironmentSource = process.env): string {
  return env(source).NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

export function emailIsConfigured(source: EnvironmentSource = process.env): boolean {
  const value = env(source);
  return Boolean(value.RESEND_API_KEY && value.EMAIL_FROM);
}

/** True when EMAIL_API_URL points at this machine (the capture server), so nothing leaves it. */
export function emailApiIsLoopback(source: EnvironmentSource = process.env): boolean {
  const value = env(source).EMAIL_API_URL;
  if (!value) return false;
  return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname);
}

/** Resend's send endpoint, or a local capture server in browser tests. */
export function emailApiUrl(source: EnvironmentSource = process.env): string {
  return env(source).EMAIL_API_URL ?? "https://api.resend.com/emails";
}

/** True only for http(s) addresses on this machine. The browser tests run a production build on one. */
export function isLoopbackAddress(value: string): boolean {
  if (!URL.canParse(value)) return false;
  return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname);
}

function isLoopbackHttpOrHttps(value: string): boolean {
  const url = new URL(value);
  if (url.protocol === "https:") return true;
  return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

/** True when an API base URL points at this machine (a capture server), so nothing leaves it. */
export function isLoopbackUrl(value: string | undefined): boolean {
  if (!value) return false;
  return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname);
}
