import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

import { signedHeaders, TEST_WEBHOOK_SECRET } from "../src/test/resend-webhook";
import { chooseBookingSlot, fillCustomerDetails, newCustomer, signIn, unique } from "./support/journey";

/**
 * Feature 2: a website booking becomes a branded email with a calendar file and the private
 * manage link; a signed delivery webhook marks it delivered; a hard bounce suppresses the
 * address, and the next email to it is skipped with a reason staff can read.
 *
 * The worker runs in local_capture mode against the capture server, so nothing reaches a real
 * email provider. The webhook is signed with a test-only secret.
 */
const captureUrl = process.env.KALENDR_CAPTURE_URL ?? "http://127.0.0.1:3199";
const appUrl = process.env.KALENDR_APP_URL ?? "http://localhost:3100";

interface CapturedEmail {
  id: string;
  from: string;
  replyTo: string | null;
  subject: string;
  text: string;
  idempotencyKey: string | null;
  attachments: Array<{ filename: string; content: string }>;
}

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

async function emailsTo(address: string): Promise<CapturedEmail[]> {
  const response = await fetch(`${captureUrl}/messages?to=${encodeURIComponent(address)}`);
  return (await response.json()) as CapturedEmail[];
}

async function sendWebhook(event: Record<string, unknown>): Promise<Response> {
  const body = JSON.stringify(event);
  const headers = signedHeaders(TEST_WEBHOOK_SECRET, `msg_e2e_${unique()}`, body);
  headers.set("content-type", "application/json");
  return fetch(`${appUrl}/api/webhooks/resend`, { method: "POST", headers, body });
}

test("a booking is emailed with a calendar file and manage link, delivery and bounces come back", async ({ page }) => {
  test.setTimeout(150_000);
  const customer = newCustomer("Inbox");

  await chooseBookingSlot(page, { slug: "lotus-dental", service: "Dental consultation", practitioner: "Dr Kavya Rao" });
  await fillCustomerDetails(page, customer);
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByRole("region", { name: "You’re booked" })).toBeVisible();
  const managePath = await page.getByRole("link", { name: "Manage appointment" }).getAttribute("href");

  // The worker picks the booking up from the outbox and sends one email through the adapter.
  await expect.poll(async () => (await emailsTo(customer.email)).length, { timeout: 45_000 }).toBe(1);
  const [email] = await emailsTo(customer.email);
  expect(email!.from).toBe('"Lotus Dental Studio" <tests@example.com>');
  expect(email!.replyTo).toBe("lotus-dental@example.com");
  expect(email!.subject).toMatch(/booked/i);
  expect(email!.idempotencyKey).toBeTruthy();
  expect(email!.text).toContain(`${appUrl}${managePath}`);
  const calendar = email!.attachments.find((file) => file.filename === "appointment.ics");
  expect(calendar?.content).toContain("BEGIN:VCALENDAR");
  expect(calendar?.content).toContain("Dental consultation");

  // The manage link in the email opens this booking.
  await page.goto(`${appUrl}${managePath}`);
  await expect(page.getByText("Dental consultation").first()).toBeVisible();

  // A signed delivery event marks it delivered; an unsigned one is refused.
  const unsigned = await fetch(`${appUrl}/api/webhooks/resend`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "email.delivered", data: { email_id: email!.id } }),
  });
  expect(unsigned.status).toBe(401);
  const delivered = await sendWebhook({ type: "email.delivered", created_at: new Date().toISOString(), data: { email_id: email!.id, to: [customer.email] } });
  expect(delivered.status).toBe(200);
  expect(await delivered.json()).toEqual({ data: { result: "applied" } });

  await signIn(page, "kalendr.owner@example.com", undefined, "/messages");
  const row = page.getByRole("row").filter({ hasText: customer.lastName });
  await expect(row.getByText("Delivered")).toBeVisible();

  // A hard bounce suppresses the address. The next email to it is skipped, with a reason.
  const bounced = await sendWebhook({
    type: "email.bounced",
    created_at: new Date().toISOString(),
    data: { email_id: email!.id, to: [customer.email], bounce: { type: "Permanent" } },
  });
  expect(await bounced.json()).toEqual({ data: { result: "applied" } });

  await chooseBookingSlot(page, { slug: "lotus-dental", service: "Dental consultation", practitioner: "Dr Kavya Rao" });
  await fillCustomerDetails(page, { ...customer, phone: newCustomer("Inbox").phone });
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByRole("region", { name: "You’re booked" })).toBeVisible();

  await expect
    .poll(async () => {
      await page.goto("/messages");
      await expect(page.getByRole("row").filter({ hasText: customer.lastName }).first()).toBeVisible();
      return page.getByText("Not sent: this address bounced before.").count();
    }, { timeout: 45_000 })
    .toBeGreaterThan(0);
  expect(await emailsTo(customer.email)).toHaveLength(1);
});
