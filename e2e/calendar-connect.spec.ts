import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

import { expectAccessible, signIn } from "./support/journey";

const appUrl = process.env.KALENDR_APP_URL ?? "http://localhost:3100";

function runtimeEnv(): Record<string, string> {
  return Object.fromEntries(
    readFileSync(resolve(process.cwd(), process.env.KALENDR_E2E_STATE_DIR ?? ".e2e", "runtime.env"), "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

// The worker checks a new connection and lists its calendars. Its imports include "server-only" code, which the
// worker tsconfig empties, as e2e/support/worker.ts does. It runs on the same in-memory test
// calendars as the app (CALENDAR_PROVIDER_MODE=fake), so no real provider is contacted.
let worker: ChildProcess | undefined;

test.beforeAll(() => {
  const runtime = runtimeEnv();
  worker = spawn(resolve(process.cwd(), "node_modules/.bin/tsx"), ["--tsconfig", "e2e/support/tsconfig.worker.json", "src/worker/run.ts"], {
    cwd: process.cwd(),
    stdio: "ignore",
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "development",
      KALENDR_WORKER_MODE: "local_capture",
      KALENDR_PREVIEW_MODE: "false",
      DATABASE_URL: runtime.DATABASE_URL,
      WORKER_DATABASE_URL: runtime.WORKER_DATABASE_URL,
      KALENDR_RECORDS_KEY: runtime.KALENDR_RECORDS_KEY,
      KALENDR_KEY_PROVIDER: runtime.KALENDR_KEY_PROVIDER,
      KALENDR_LOCAL_MASTER_KEY: runtime.KALENDR_LOCAL_MASTER_KEY,
      BETTER_AUTH_SECRET: runtime.BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: appUrl,
      CALENDAR_PROVIDER_MODE: "fake",
      LOG_LEVEL: "warn",
    },
  });
});

test.afterAll(() => {
  worker?.kill("SIGTERM");
});

const owner = "kalendr.owner@example.com";

/**
 * The server runs with CALENDAR_PROVIDER_MODE=fake in these tests, so "Connect" for Google goes
 * straight back to the profile page with a made-up account. No real calendar is contacted.
 */
test("a staff member connects a test Google calendar and chooses to block their availability", async ({ page }, testInfo) => {
  await signIn(page, owner, undefined, "/profile");
  await expect(page.getByRole("heading", { level: 2, name: "My calendars" })).toBeVisible();
  await expect(page.getByText("Test accounts", { exact: true })).toBeVisible();

  await page.getByRole("listitem").filter({ hasText: "Google Calendar" }).getByRole("link", { name: "Connect" }).click();
  await page.waitForURL(/\/profile/);

  const accounts = page.getByRole("list", { name: "Connected calendars" });
  await expect(accounts).toBeVisible();
  // The worker checks a new connection; the screen refreshes itself while it waits.
  await expect(accounts.getByText("Connected", { exact: true }).first()).toBeVisible({ timeout: 30_000 });

  // The primary calendar blocks availability from the start; the person ticks a second one.
  const work = accounts.getByRole("switch").nth(1);
  await expect(accounts.getByRole("switch").first()).toBeChecked();
  if (!(await work.isChecked())) await work.click();
  await expect(work).toBeChecked();
  await page.reload();
  await expect(page.getByRole("list", { name: "Connected calendars" }).getByRole("switch").nth(1)).toBeChecked();
  await expectAccessible(page, testInfo, "my calendars");
});

test("my calendars fits a 375px phone without sideways scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await signIn(page, owner, undefined, "/profile");
  await expect(page.getByRole("heading", { level: 2, name: "My calendars" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const buttons = page.getByRole("listitem").filter({ hasText: "Apple Calendar" }).getByRole("button", { name: "Connect" });
  const box = await buttons.boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
});
