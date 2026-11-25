import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import { expectAccessible, signIn, unique } from "./support/journey";

/**
 * Feature 12: the import wizard, end to end. A small customer file with a messy phone number, a
 * repeated person and a bad row goes through upload, matching, the dry run, the import and undo.
 * The worker runs the check and the import, so this spec starts it like the other worker journeys.
 */
const owner = "kalendr.owner@example.com";
const captureUrl = process.env.KALENDR_CAPTURE_URL ?? "http://127.0.0.1:3199";
const appUrl = process.env.KALENDR_APP_URL ?? "http://localhost:3100";

function runtimeEnv(): Record<string, string> {
  return Object.fromEntries(
    readFileSync(resolve(process.cwd(), process.env.KALENDR_E2E_STATE_DIR ?? ".e2e", "runtime.env"), "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

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
      KALENDR_FILE_STORE_DIR: resolve(process.cwd(), process.env.KALENDR_E2E_STATE_DIR ?? ".e2e", "files"),
      BETTER_AUTH_SECRET: runtime.BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: appUrl,
      EMAIL_FROM: "Kalendr Tests <tests@example.com>",
      RESEND_API_KEY: "e2e-capture-only",
      EMAIL_API_URL: `${captureUrl}/emails`,
      LOG_LEVEL: "warn",
    },
  });
});

test.afterAll(() => {
  worker?.kill("SIGTERM");
});

/** The fixture with fresh phone numbers and names, so a rerun or the phone project never finds earlier rows. */
function customerFile(): { name: string; mimeType: string; buffer: Buffer; tag: string } {
  const tag = unique();
  const base = String(Number.parseInt(tag, 16) % 1_000_000).padStart(6, "0");
  const text = readFileSync(resolve(process.cwd(), "e2e/fixtures/import-customers.csv"), "utf8").replaceAll("{{tag}}", tag).replaceAll("{{base}}", base);
  return { name: "customers.csv", mimeType: "text/csv", buffer: Buffer.from(text), tag };
}

async function tileCount(page: Page, label: string): Promise<number> {
  const tile: Locator = page.getByRole("list", { name: "Totals" }).getByRole("button", { name: new RegExp(label) });
  const text = (await tile.innerText()).split("\n")[0].replaceAll(",", "");
  return Number.parseInt(text, 10);
}

test("an owner imports customers from a file, fixes nothing, and undoes it", async ({ page }, testInfo) => {
  const file = customerFile();
  await signIn(page, owner, undefined, "/settings/import");
  await expect(page.getByRole("heading", { level: 1, name: "Import data" })).toBeVisible();
  await expectAccessible(page, testInfo, "import upload");

  // Step 1: the sample file is offered, and the upload leads to matching.
  await expect(page.getByRole("link", { name: /Download a sample file for/ })).toHaveAttribute("href", "/api/staff/imports/samples/customers");
  await page.getByLabel(/Drag a file here/).setInputFiles({ name: file.name, mimeType: file.mimeType, buffer: file.buffer });
  await page.getByRole("button", { name: "Upload and continue" }).click();

  // Step 2: the guessed columns are in place, and the preview shows the messy number cleaned up.
  await expect(page.getByRole("heading", { name: /Step 2 of 4/ })).toBeVisible();
  await expect(page.getByRole("table", { name: /as they will be saved/ })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("table", { name: /as they will be saved/ }).getByText(/^\+91/).first()).toBeVisible();
  await expectAccessible(page, testInfo, "import match columns");
  // The job id is in the address, so a reload keeps the place.
  expect(new URL(page.url()).searchParams.get("job")).toBeTruthy();
  await page.getByRole("button", { name: /Check the file/ }).click();

  // Step 3: the dry run. Two rows are good; the repeat and the bad row are held back.
  await expect(page.getByRole("heading", { name: /Step 3 of 4/ })).toBeVisible();
  await expect(page.getByRole("list", { name: "Totals" })).toBeVisible({ timeout: 60_000 });
  expect(await tileCount(page, "Ready")).toBe(2);
  expect((await tileCount(page, "Will skip")) + (await tileCount(page, "Has errors"))).toBe(2);
  expect(await tileCount(page, "Has errors")).toBeGreaterThanOrEqual(1);
  await expect(page.getByText(/phone number is not valid|email address is not valid/).first()).toBeVisible();
  await expectAccessible(page, testInfo, "import check");

  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: /Download the rows with errors/ }).click();
  const errorFile = readFileSync(await (await download).path(), "utf8");
  expect(errorFile).toContain(`Row${file.tag}`);

  // Step 4: confirm, import, and read the result.
  await page.getByRole("button", { name: /Continue to import/ }).click();
  await expect(page.getByRole("heading", { name: /Step 4 of 4/ })).toBeVisible();
  await page.getByRole("button", { name: /Start the import/ }).click();
  await expect(page.getByText("Import finished")).toBeVisible({ timeout: 90_000 });
  const result = page.getByRole("list", { name: "Result" });
  await expect(result.getByText("Created").locator("xpath=preceding-sibling::span")).toHaveText("2");
  await expect(page.getByText(/You can undo this import until/)).toBeVisible();

  // Undo: the dialog says what goes and what stays, and the result shows it done.
  await page.getByRole("button", { name: /Undo this import/ }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog.getByText("What this removes")).toBeVisible();
  await expect(dialog.getByText("What this keeps")).toBeVisible();
  await dialog.getByRole("button", { name: "Undo the import" }).click();
  await expect(page.getByText("Import undone")).toBeVisible({ timeout: 60_000 });
});
