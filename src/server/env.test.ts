import { describe, expect, it } from "vitest";

import { assertStartupEnvironment, env, EnvironmentError, startupProblems } from "./env";

const key = Buffer.alloc(32, 7).toString("base64");
const production = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://app:pw@db.internal:5432/kalendr",
  BETTER_AUTH_SECRET: "x".repeat(48),
  BETTER_AUTH_URL: "https://book.example.com",
  KALENDR_RECORDS_KEY: key,
  KALENDR_KEY_PROVIDER: "local",
  KALENDR_LOCAL_MASTER_KEY: Buffer.alloc(32, 9).toString("base64"),
  TRUSTED_PROXY_HOPS: "1",
};

describe("environment", () => {
  it("accepts a complete production environment", () => {
    expect(startupProblems(production)).toEqual([]);
    expect(assertStartupEnvironment(production).DATABASE_POOL_MAX).toBe(5);
  });

  it("needs both Daily settings when video runs on Daily, and refuses test video in production", () => {
    expect(startupProblems({ ...production, VIDEO_PROVIDER: "daily" })).toEqual(["DAILY_API_KEY and DAILY_DOMAIN are required when VIDEO_PROVIDER is daily"]);
    expect(startupProblems({ ...production, VIDEO_PROVIDER: "daily", DAILY_API_KEY: "k", DAILY_DOMAIN: "d" })).toEqual([]);
    expect(startupProblems({ ...production, VIDEO_PROVIDER: "none" })).toEqual([]);
    expect(startupProblems({ ...production, VIDEO_PROVIDER: "test" })).toEqual(["VIDEO_PROVIDER must be daily or none in production: test mode shows fake calls"]);
    expect(startupProblems({ ...production, VIDEO_PROVIDER: "test", KALENDR_ALLOW_TEST_VIDEO: "true" })).toEqual([]);
  });

  it("names a missing secret and stops startup", () => {
    const missing = { ...production, BETTER_AUTH_SECRET: "" };
    expect(startupProblems(missing)).toEqual(["BETTER_AUTH_SECRET is required in production"]);
    expect(() => assertStartupEnvironment(missing)).toThrow(/BETTER_AUTH_SECRET is required/);
  });

  it("refuses the example secret, preview mode and a missing records key in production", () => {
    const problems = startupProblems({
      ...production,
      BETTER_AUTH_SECRET: "replace-with-a-long-random-secret",
      KALENDR_PREVIEW_MODE: "true",
      KALENDR_RECORDS_KEY: undefined,
    });
    expect(problems).toEqual([
      "BETTER_AUTH_SECRET is still the example placeholder",
      "KALENDR_PREVIEW_MODE must not be true in production",
      "KALENDR_RECORDS_KEY is required in production",
    ]);
  });

  it("keeps the Google and Microsoft stand-in off public addresses and asks for each provider's id and secret together", () => {
    expect(startupProblems({ ...production, KALENDR_DEV_OAUTH: "true" })).toEqual(["KALENDR_DEV_OAUTH must not be true on a public address"]);
    // The browser tests run a production build on this machine; that is the one allowed place.
    expect(startupProblems({ ...production, BETTER_AUTH_URL: "http://localhost:3100", KALENDR_DEV_OAUTH: "true" })).toEqual([]);
    expect(startupProblems({ ...production, GOOGLE_CLIENT_ID: "id" })).toEqual(["GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together"]);
    expect(startupProblems({ ...production, MICROSOFT_CLIENT_SECRET: "secret" })).toEqual(["MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET must be set together"]);
    expect(startupProblems({ ...production, GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" })).toEqual([]);
  });

  it("names malformed values without echoing them", () => {
    try {
      env({ DATABASE_URL: "mysql://secret-password@host/db", DATABASE_POOL_MAX: "500", LOG_LEVEL: "loud" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EnvironmentError);
      const message = (error as Error).message;
      expect(message).toContain("DATABASE_URL must be a postgres:// or postgresql:// URL");
      expect(message).toContain("DATABASE_POOL_MAX");
      expect(message).toContain("LOG_LEVEL");
      expect(message).not.toContain("secret-password");
    }
  });

  it("lets development run without a database or secret", () => {
    expect(startupProblems({ NODE_ENV: "development" })).toEqual([]);
    expect(env({}).NODE_ENV).toBe("development");
  });

  it("needs the proxy hop count in production, never 0", () => {
    expect(startupProblems({ ...production, TRUSTED_PROXY_HOPS: "" })).toEqual([
      "TRUSTED_PROXY_HOPS is required in production (the number of proxies that append to X-Forwarded-For)",
    ]);
    expect(startupProblems({ ...production, TRUSTED_PROXY_HOPS: "0" })).toEqual([
      "TRUSTED_PROXY_HOPS must be at least 1 in production: without a proxy, client addresses can be forged",
    ]);
    expect(startupProblems({ ...production, TRUSTED_PROXY_HOPS: "9" })[0]).toMatch(/^TRUSTED_PROXY_HOPS/);
    expect(env({ TRUSTED_PROXY_HOPS: "2" }).TRUSTED_PROXY_HOPS).toBe(2);
  });

  it("needs both Turnstile keys or neither", () => {
    expect(startupProblems({ ...production, TURNSTILE_SITE_KEY: "1x00000000000000000000AA" })).toEqual([
      "TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY must be set together",
    ]);
    expect(startupProblems({
      ...production,
      TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
      TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
    })).toEqual([]);
  });

  it("only allows a plain-http email endpoint on loopback", () => {
    expect(startupProblems({ ...production, EMAIL_API_URL: "http://127.0.0.1:4010/emails" })).toEqual([]);
    expect(startupProblems({ ...production, EMAIL_API_URL: "http://mail.example.com/emails" })).toEqual([
      "EMAIL_API_URL must use https, or http on a loopback address",
    ]);
  });

  it("needs a key provider in production, with the settings that provider uses", () => {
    expect(startupProblems({ ...production, KALENDR_KEY_PROVIDER: "" })).toEqual([
      "KALENDR_KEY_PROVIDER (local or kms) is required in production",
    ]);
    expect(startupProblems({ ...production, KALENDR_LOCAL_MASTER_KEY: "" })).toEqual([
      "KALENDR_LOCAL_MASTER_KEY is required when KALENDR_KEY_PROVIDER is local",
    ]);
    expect(startupProblems({ ...production, KALENDR_KEY_PROVIDER: "kms", KMS_REGION: "ap-south-1" })).toEqual([
      "KMS_KEY_ID and KMS_REGION are required when KALENDR_KEY_PROVIDER is kms",
    ]);
    expect(startupProblems({ ...production, KALENDR_KEY_PROVIDER: "kms", KMS_KEY_ID: "alias/kalendr", KMS_REGION: "ap-south-1" })).toEqual([]);
    expect(startupProblems({ ...production, KALENDR_KEY_PROVIDER: "vault" })).not.toEqual([]);
  });

  it("needs a bucket when files go to S3", () => {
    expect(startupProblems({ ...production, KALENDR_FILE_STORE: "s3" })).toEqual(["S3_BUCKET is required when KALENDR_FILE_STORE is s3"]);
    expect(startupProblems({ ...production, KALENDR_FILE_STORE: "s3", S3_BUCKET: "kalendr-files" })).toEqual([]);
  });

  it("takes the push keys all together or not at all", () => {
    const keys = { VAPID_PUBLIC_KEY: "P".repeat(87), VAPID_PRIVATE_KEY: "K".repeat(43), VAPID_SUBJECT: "mailto:ops@example.com" };
    expect(startupProblems({ ...production, ...keys })).toEqual([]);
    expect(startupProblems(production)).toEqual([]);
    expect(startupProblems({ ...production, VAPID_PUBLIC_KEY: keys.VAPID_PUBLIC_KEY })).toEqual([
      "VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT must be set together",
    ]);
    expect(() => env({ ...keys, VAPID_SUBJECT: "ops@example.com" })).toThrow(/VAPID_SUBJECT/);
  });

  it("takes each calendar provider's keys as a pair, and a webhook secret when one is on", () => {
    const google = { GOOGLE_CALENDAR_CLIENT_ID: "id", GOOGLE_CALENDAR_CLIENT_SECRET: "secret" };
    expect(startupProblems({ ...production, GOOGLE_CALENDAR_CLIENT_ID: "id" })).toContain("GOOGLE_CALENDAR_CLIENT_ID and GOOGLE_CALENDAR_CLIENT_SECRET must be set together");
    expect(startupProblems({ ...production, ...google })).toEqual(["CALENDAR_WEBHOOK_TOKEN is required when Google or Microsoft calendar keys are set"]);
    expect(startupProblems({ ...production, ...google, CALENDAR_WEBHOOK_TOKEN: "w".repeat(32) })).toEqual([]);
    expect(startupProblems(production)).toEqual([]);
  });

  it("refuses fake calendars unless the app's own address is on this machine", () => {
    expect(startupProblems({ ...production, CALENDAR_PROVIDER_MODE: "fake" })).toEqual([
      "CALENDAR_PROVIDER_MODE=fake is only allowed when the app's own address (BETTER_AUTH_URL) is on this machine",
    ]);
    expect(startupProblems({ ...production, BETTER_AUTH_URL: "http://localhost:3100", CALENDAR_PROVIDER_MODE: "fake" })).toEqual([]);
  });

  it("refuses the built-in test model for the booking assistant unless the app's own address is on this machine", () => {
    expect(startupProblems({ ...production, ASSISTANT_PROVIDER_MODE: "fake" })).toEqual([
      "ASSISTANT_PROVIDER_MODE=fake is only allowed when the app's own address (BETTER_AUTH_URL) is on this machine",
    ]);
    expect(startupProblems({ ...production, BETTER_AUTH_URL: "http://localhost:3100", ASSISTANT_PROVIDER_MODE: "fake" })).toEqual([]);
    // Without a key and without the test model the assistant is simply off, which is a valid production setup.
    expect(startupProblems(production)).toEqual([]);
  });
});
