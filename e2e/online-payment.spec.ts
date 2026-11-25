import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

import { chooseBookingSlot, expectAccessible, fillCustomerDetails, newCustomer, newPage, signIn } from "./support/journey";
import { arrangeDepositService, connectTestAccount, paidBusiness, restoreService } from "./support/online-payment";

type Arranged = Awaited<ReturnType<typeof arrangeDepositService>>;
let arranged: Arranged;
let worker: ChildProcess | undefined;

function runtimeEnv(): Record<string, string> {
  return Object.fromEntries(
    readFileSync(resolve(process.cwd(), process.env.KALENDR_E2E_STATE_DIR ?? ".e2e", "runtime.env"), "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

// The webhook is only stored by the app: the worker is what confirms the booking, so the journey needs it running.
test.beforeAll(async ({ browser }, testInfo) => {
  arranged = await arrangeDepositService();
  const owner = await newPage(browser, testInfo);
  await signIn(owner, "kalendr.owner@example.com");
  await connectTestAccount(owner);
  await owner.close();
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
      BETTER_AUTH_URL: process.env.KALENDR_APP_URL,
      LOG_LEVEL: "warn",
    },
  });
});
test.afterAll(async () => {
  worker?.kill("SIGTERM");
  if (arranged) await restoreService(arranged);
});

test("a customer pays a deposit on the test checkout and the booking is confirmed", async ({ page }, testInfo) => {
  const customer = newCustomer("Payer");
  await chooseBookingSlot(page, { slug: paidBusiness.slug, service: paidBusiness.service, practitioner: paidBusiness.practitioner });

  // Review: what is paid now, the exact policy, and a required agreement.
  await expect(page.getByRole("heading", { level: 2, name: `Pay ${paidBusiness.payNow} now, ${paidBusiness.payLater} at the appointment` })).toBeVisible();
  const policy = page.locator("#payment-policy-text");
  await expect(policy).toContainText(`You pay ${paidBusiness.payNow} now as a deposit.`);
  await fillCustomerDetails(page, customer);
  const confirm = page.getByRole("button", { name: "Confirm booking" });
  await expect(confirm).toBeDisabled();
  await page.getByRole("checkbox", { name: "I agree to this policy" }).check();
  await expect(confirm).toBeEnabled();
  await expectAccessible(page, testInfo, "review with payment policy");
  await confirm.click();

  // Pay step: the amount, a visible countdown, and the Pay button.
  await expect(page.getByRole("heading", { level: 1, name: new RegExp(`Pay ${paidBusiness.payNow} to keep your`) })).toBeVisible();
  await expect(page.getByText(/Time left to pay/)).toBeVisible();
  await expectAccessible(page, testInfo, "pay step");
  await page.getByRole("button", { name: `Pay ${paidBusiness.payNow}` }).click();

  // The built-in test checkout is plainly marked.
  await expect(page).toHaveURL(/\/pay\/test\//);
  await expect(page.getByText("TEST — no real money")).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: paidBusiness.name })).toBeVisible();
  await expectAccessible(page, testInfo, "test checkout");
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Pay with UPI (test)" }).click();

  // Back on the manage page: Confirming…, then the booking shows as booked once the server's webhook is processed.
  await expect(page).toHaveURL(/\/manage\/[A-Za-z0-9_-]{20,}\?paid=1/);
  await expect(page.getByRole("heading", { level: 1, name: /Confirming your payment|Your appointment/ })).toBeVisible();
  await expect(page.getByText("Booked", { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(paidBusiness.service).first()).toBeVisible();
  await expectAccessible(page, testInfo, "manage page after payment");
});

test("a failed test payment leaves the booking waiting, with Pay now still on offer", async ({ page }) => {
  const customer = newCustomer("Failer");
  await chooseBookingSlot(page, { slug: paidBusiness.slug, service: paidBusiness.service, practitioner: paidBusiness.practitioner });
  await fillCustomerDetails(page, customer);
  await page.getByRole("checkbox", { name: "I agree to this policy" }).check();
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await page.getByRole("button", { name: `Pay ${paidBusiness.payNow}` }).click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Payment fails (test)" }).click();

  await expect(page).toHaveURL(/\/manage\//);
  await expect(page).not.toHaveURL(/paid=1/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(/Pay .* to keep your appointment/);
  await expect(page.getByRole("button", { name: `Pay ${paidBusiness.payNow}` })).toBeVisible();
});

test("the test checkout refuses a return address outside the manage pages", async ({ page }) => {
  const refused = await page.goto("/pay/test/order_x?returnTo=https%3A%2F%2Fevil.example%2Fmanage%2Fx");
  expect(refused?.status()).toBe(404);
});
