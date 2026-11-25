import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { inboundTextCallback, signedWhatsAppRequest, TEST_WHATSAPP_APP_SECRET } from "../src/test/whatsapp-webhook";
import { chooseBookingSlot, expectAccessible, fillCustomerDetails, newCustomer, signIn, unique, type Customer } from "./support/journey";

/**
 * Feature 3: a booking for a customer who chose WhatsApp (and agreed to messages) is sent as a WhatsApp
 * template; the customer's signed reply lands in the Inbox with an unread badge; staff open it and answer;
 * a signed STOP ends WhatsApp for that customer, so their next booking message goes by email.
 *
 * The worker runs in local_capture mode against the capture server, so nothing reaches Meta.
 * Webhooks are signed with a test-only app secret.
 */
const captureUrl = process.env.KALENDR_CAPTURE_URL ?? "http://127.0.0.1:3199";
const appUrl = process.env.KALENDR_APP_URL ?? "http://localhost:3100";

interface CapturedWhatsApp {
  id: string;
  to: string;
  type: string;
  template: unknown;
  text: string | null;
}

interface CapturedEmail {
  subject: string;
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
      // The worker opens and seals inbox messages with the business's data key.
      KALENDR_KEY_PROVIDER: runtime.KALENDR_KEY_PROVIDER,
      KALENDR_LOCAL_MASTER_KEY: runtime.KALENDR_LOCAL_MASTER_KEY,
      BETTER_AUTH_SECRET: runtime.BETTER_AUTH_SECRET,
      BETTER_AUTH_URL: appUrl,
      EMAIL_FROM: "Kalendr Tests <tests@example.com>",
      RESEND_API_KEY: "e2e-capture-only",
      EMAIL_API_URL: `${captureUrl}/emails`,
      WHATSAPP_ACCESS_TOKEN: "e2e-capture-only",
      WHATSAPP_PHONE_NUMBER_ID: "e2e-phone-number",
      WHATSAPP_APP_SECRET: TEST_WHATSAPP_APP_SECRET,
      WHATSAPP_API_URL: `${captureUrl}/whatsapp`,
      LOG_LEVEL: "warn",
    },
  });
});

test.afterAll(() => {
  worker?.kill("SIGTERM");
});

const digits = (phone: string) => phone.replace(/\D/g, "");

async function whatsappTo(phone: string): Promise<CapturedWhatsApp[]> {
  const response = await fetch(`${captureUrl}/whatsapp/messages?to=${digits(phone)}`);
  return (await response.json()) as CapturedWhatsApp[];
}

async function emailsTo(address: string): Promise<CapturedEmail[]> {
  const response = await fetch(`${captureUrl}/messages?to=${encodeURIComponent(address)}`);
  return (await response.json()) as CapturedEmail[];
}

async function postWebhook(body: unknown): Promise<Response> {
  const request = signedWhatsAppRequest(TEST_WHATSAPP_APP_SECRET, body);
  return fetch(`${appUrl}/api/webhooks/whatsapp`, { method: "POST", headers: request.headers, body: request.body });
}

/** The public booking flow, choosing WhatsApp and ticking the messages box so the customer may be messaged there. */
async function bookOnWhatsApp(page: Page, customer: Customer, consent = true): Promise<void> {
  await chooseBookingSlot(page, { slug: "lotus-dental", service: "Dental consultation", practitioner: "Dr Kavya Rao" });
  await fillCustomerDetails(page, customer);
  await page.getByRole("button", { name: /Add more details/ }).click();
  await page.getByRole("combobox", { name: /contact you/ }).click();
  await page.getByRole("option", { name: "WhatsApp" }).click();
  if (consent) await page.getByRole("checkbox", { name: /Send reminders by text message or WhatsApp/ }).check();
  await page.getByRole("button", { name: "Confirm booking" }).click();
  await expect(page.getByRole("region", { name: "You’re booked" })).toBeVisible();
}

test("a customer's WhatsApp reply reaches the Inbox, staff answer it, and STOP moves them to email", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const customer = newCustomer("Wa");
  const fullName = `${customer.firstName} ${customer.lastName}`;

  await bookOnWhatsApp(page, customer);

  // The worker sends the booking as an approved WhatsApp template, not an email.
  await expect.poll(async () => (await whatsappTo(customer.phone)).length, { timeout: 45_000 }).toBeGreaterThanOrEqual(1);
  expect((await whatsappTo(customer.phone))[0]!.type).toBe("template");

  // Unsigned posts are refused; a signed reply is accepted.
  const unsigned = await fetch(`${appUrl}/api/webhooks/whatsapp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(inboundTextCallback(customer.phone, `wamid.bad.${unique()}`, "hi")) });
  expect(unsigned.status).toBe(401);
  const customerWords = `Can I come 30 minutes later? ${unique()}`;
  expect((await postWebhook(inboundTextCallback(customer.phone, `wamid.in.${unique()}`, customerWords))).status).toBe(200);

  await signIn(page, "kalendr.owner@example.com", undefined, "/messages?tab=inbox");
  await expect(page).toHaveURL(/tab=inbox/);
  await expect(page.getByRole("tab", { name: /Inbox/ })).toContainText(/\d/);
  const thread = page.getByRole("button", { name: new RegExp(fullName) });
  await expect(thread).toBeVisible({ timeout: 30_000 });
  await expect(thread.getByLabel(/\d+ unread/)).toBeVisible();
  await expectAccessible(page, testInfo, "inbox-list");

  // Opening it shows the customer's words and the booking, and clears the unread badge.
  await thread.click();
  const log = page.getByRole("log", { name: "Messages" });
  await expect(log.getByText(customerWords)).toBeVisible();
  await expect(page.getByText(/Dental consultation with Dr Kavya Rao/)).toBeVisible();
  await expectAccessible(page, testInfo, "inbox-conversation");

  // The window is open, so staff reply freely; the worker sends it to the capture server.
  const reply = `Yes, 30 minutes later is fine. ${unique()}`;
  await page.getByRole("textbox", { name: `Reply to ${fullName}` }).fill(reply);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(log.getByText(reply)).toBeVisible({ timeout: 20_000 });
  await expect.poll(async () => (await whatsappTo(customer.phone)).some((message) => message.type === "text" && message.text === reply), { timeout: 45_000 }).toBe(true);

  // STOP ends WhatsApp for this customer. Their next booking message goes by email.
  const beforeStop = (await whatsappTo(customer.phone)).length;
  expect((await postWebhook(inboundTextCallback(customer.phone, `wamid.stop.${unique()}`, "STOP"))).status).toBe(200);
  // One confirmation goes out, then nothing more. The customer books again without agreeing to messages.
  await expect.poll(async () => (await whatsappTo(customer.phone)).length, { timeout: 45_000 }).toBe(beforeStop + 1);
  const sentBefore = beforeStop + 1;
  await bookOnWhatsApp(page, customer, false);
  await expect.poll(async () => (await emailsTo(customer.email)).length, { timeout: 45_000 }).toBeGreaterThanOrEqual(1);
  expect((await whatsappTo(customer.phone)).length).toBe(sentBefore);
});
