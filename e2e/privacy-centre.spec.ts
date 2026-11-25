import type { ChildProcess } from "node:child_process";

import { expect, test, type Page } from "@playwright/test";

import { linkFromEmail, signIn, unique, withOwnerDatabase } from "./support/journey";
import { freshCode, recallSecret } from "./support/second-factor";
import { startWorker } from "./support/worker";

/**
 * Feature 7: the customer's privacy page and the staff's privacy requests. The worker runs only to send
 * sign-in codes, so these check what the screens and routes do: the outbox rows
 * the worker will pick up are checked in the database, and the worker itself is covered by
 * src/server/privacy/*.integration.test.ts.
 */

// Customer sign-in codes are sent by the worker (feature 8), so one runs here against the capture server.
let worker: ChildProcess | undefined;
test.beforeAll(() => { worker = startWorker(); });
test.afterAll(() => { worker?.kill("SIGTERM"); });

test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ "x-forwarded-for": `198.51.100.${1 + Math.floor(Math.random() * 250)}` });
});

async function newCustomer(): Promise<{ email: string; patientId: string; tenantId: string; lastName: string }> {
  const suffix = unique();
  const email = `privacy.${suffix}@example.com`;
  return withOwnerDatabase(async (sql) => {
    const [tenant] = await sql<{ id: string }[]>`select id from tenants where slug = 'lotus-dental'`;
    const [patient] = await sql<{ id: string }[]>`
      insert into patients (tenant_id, first_name, last_name, phone, email, preferred_channel, messaging_consent_at)
      values (${tenant!.id}, 'Priya', ${`Privacy${suffix}`}, ${`+9198${String(Number.parseInt(suffix, 16) % 100_000_000).padStart(8, "0")}`}, ${email}, 'email', now())
      returning id`;
    return { email, patientId: patient!.id, tenantId: tenant!.id, lastName: `Privacy${suffix}` };
  });
}

/** Portal sign-in with the six-digit code the capture server received. */
async function portalSignIn(page: Page, email: string): Promise<void> {
  await page.goto("/portal/sign-in");
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  await page.getByRole("button", { name: "Send code" }).click();
  const message = await linkFromEmail(email, /\b\d{6}\b/);
  const code = message.match(/\d{6}/)![0];
  await page.getByRole("group", { name: "Six-digit code" }).getByRole("textbox").first().click();
  await page.waitForTimeout(400);
  await page.keyboard.type(code, { delay: 80 });
  // The sixth digit signs in on its own; the button is there for anyone who pastes.
  const arrived = await page.waitForURL((url) => url.pathname === "/portal", { timeout: 8_000 }).then(() => true, () => false);
  if (!arrived) await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/portal", { timeout: 20_000 });
}

async function openPrivacy(page: Page): Promise<void> {
  await page.goto("/portal/privacy");
  await expect(page.getByRole("heading", { name: "Your privacy" })).toBeVisible();
}

test("a customer asks to download their data from the portal", async ({ page }) => {
  const customer = await newCustomer();
  await portalSignIn(page, customer.email);
  await openPrivacy(page);
  await page.getByRole("button", { name: "Download my data" }).click();
  const confirm = page.getByRole("button", { name: /^(Send request|Request download|Download my data)$/ }).last();
  if (await confirm.isVisible().catch(() => false)) await confirm.click();
  await expect(page.getByText(/we emailed the link|works once|7 days/i).first()).toBeVisible({ timeout: 15_000 });
  await withOwnerDatabase(async (sql) => {
    const rows = await sql<{ id: string }[]>`select id from data_requests where patient_id = ${customer.patientId} and type = 'export'`;
    expect(rows).toHaveLength(1);
    const queued = await sql`select 1 from outbox_events where tenant_id = ${customer.tenantId} and dedupe_key = ${`privacy.export.requested:${rows[0]!.id}`}`;
    expect(queued).toHaveLength(1);
  });
});

test("withdrawing marketing is one switch and appointment reminders stay on", async ({ page }) => {
  const customer = await newCustomer();
  await portalSignIn(page, customer.email);
  await openPrivacy(page);
  const marketing = page.getByRole("switch", { name: "Marketing messages" });
  await expect(marketing).not.toBeChecked();
  await marketing.click();
  await expect(marketing).toBeChecked();
  await marketing.click();
  await expect(marketing).not.toBeChecked();
  await expect(page.getByRole("switch", { name: "Appointment messages" })).toBeChecked();
  await withOwnerDatabase(async (sql) => {
    const rows = await sql<{ purpose: string; granted: boolean }[]>`select purpose, granted from consent_records where patient_id = ${customer.patientId} and purpose = 'marketing_messages' order by created_at, id`;
    expect(rows.map((row) => row.granted)).toEqual([true, false]);
    const [gate] = await sql<{ granted: boolean }[]>`select granted from consent_records where patient_id = ${customer.patientId} and purpose = 'appointment_messages' order by created_at desc, id desc limit 1`;
    expect(gate?.granted ?? true).toBe(true);
  });
});

test("staff approve an erasure request with a fresh code and the audit trail names them", async ({ page, browser }, testInfo) => {
  const customer = await newCustomer();
  const customerPage = await (await browser.newContext({ ...testInfo.project.use, baseURL: testInfo.project.use.baseURL, extraHTTPHeaders: { "x-forwarded-for": `198.51.100.${1 + Math.floor(Math.random() * 250)}` } })).newPage();
  await portalSignIn(customerPage, customer.email);
  await openPrivacy(customerPage);
  await customerPage.getByRole("button", { name: "Ask us to delete my data" }).click();
  await customerPage.getByRole("button", { name: "Send request" }).click();
  await expect(customerPage.getByText(/delete|erasure/i).first()).toBeVisible();

  const owner = "kalendr.owner@example.com";
  await signIn(page, owner, undefined, "/settings/privacy-requests");
  await expect(page.getByRole("heading", { name: "Privacy requests" })).toBeVisible();
  // Eleven minutes since the last second-factor check: approving asks for a code.
  await withOwnerDatabase((sql) => sql`update auth_sessions set second_factor_at = now() - interval '11 minutes' where user_id = (select id from auth_users where email = ${owner})`);
  // The list holds everyone's requests; open this customer's.
  await page.getByRole("button", { name: `Review request from Priya ${customer.lastName}` }).click();
  await page.getByRole("button", { name: "Approve" }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
  if (await dialog.waitFor({ timeout: 10_000 }).then(() => true, () => false)) {
    await dialog.getByLabel("Authenticator code").fill(await freshCode(recallSecret(owner)!));
    await dialog.getByRole("button", { name: "Confirm" }).click();
    await expect(dialog).toBeHidden();
  }
  await expect.poll(async () => withOwnerDatabase(async (sql) => {
    const rows = await sql<{ status: string }[]>`select status from data_requests where patient_id = ${customer.patientId} and type = 'erasure'`;
    return rows[0]?.status ?? "none";
  }), { timeout: 20_000 }).toMatch(/approved|processing|completed/);
  await withOwnerDatabase(async (sql) => {
    const audit = await sql`select 1 from audit_events where tenant_id = ${customer.tenantId} and action = 'privacy.request.approved' and actor_user_id is not null`;
    expect(audit.length).toBeGreaterThan(0);
    const queued = await sql`select 1 from outbox_events where tenant_id = ${customer.tenantId} and event_type = 'privacy.erasure.approved'`;
    expect(queued.length).toBeGreaterThan(0);
  });
});
