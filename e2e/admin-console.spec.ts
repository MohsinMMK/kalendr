import { randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";
import { hashPassword } from "better-auth/crypto";

import { enrolAuthenticator, expectAccessible, signIn, unique, withOwnerDatabase } from "./support/journey";

/**
 * Feature 15: the platform admin console. A staff member who guesses /admin sees the ordinary 404; an operator
 * finds a business, starts "View as this business", sees the banner on the business's own screens, is refused when
 * trying to change anything, and ends the session.
 */
const owner = "kalendr.owner@example.com";

/** Sign-ins are limited per address; each test comes from its own documentation address (TEST-NET-2), like the sign-in journeys. */
test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ "x-forwarded-for": `198.51.100.${1 + Math.floor(Math.random() * 250)}` });
});

/** A user who is an operator and nothing else: verified, with a password, listed in platform_admins. The second factor is enrolled on first sign-in. */
async function operator(role: "support" | "super" = "support"): Promise<{ email: string; password: string }> {
  const id = randomUUID();
  const email = `operator.${unique()}@example.com`;
  const password = `Op-${randomUUID()}`;
  await withOwnerDatabase(async (sql) => {
    await sql`insert into auth_users (id, name, email, email_verified, password_set_at) values (${id}, 'Test Operator', ${email}, true, now())`;
    await sql`insert into auth_accounts (id, issuer, account_id, provider_id, user_id, password) values (${randomUUID()}, 'local:credential', ${id}, 'credential', ${id}, ${await hashPassword(password)})`;
    await sql`insert into platform_admins (user_id, role) values (${id}, ${role})`;
  });
  return { email, password };
}

/**
 * Signs the operator in and opens a console page. An operator has no business, so the ordinary sign-in lands on the
 * access-denied page; the console itself sends someone without a second factor to enrol one, which is done once here.
 */
async function openConsole(page: Page, who: { email: string; password: string }, path: string): Promise<void> {
  await signIn(page, who.email, who.password);
  await page.goto(path);
  if (page.url().includes("/security/second-factor")) {
    await enrolAuthenticator(page, who.email, who.password);
    await page.goto(path);
  }
  await page.waitForURL((url) => url.pathname === path);
}

/** Runs a business action by name: in the row when it fits, otherwise from the ⋯ menu (always on a phone). */
async function runBusinessAction(page: Page, name: RegExp): Promise<void> {
  const inline = page.getByRole("button", { name });
  if (await inline.count()) {
    await inline.first().click();
    return;
  }
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name }).click();
}

test("a staff member who guesses /admin gets the normal 404", async ({ page }) => {
  await signIn(page, owner);
  const response = await page.goto("/admin");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "This appointment page is unavailable." })).toBeVisible();
  const api = await page.request.get("/api/admin/tenants");
  expect(api.status()).toBe(404);
});

test("an operator finds a business, views it read-only with the banner, is refused a change, and ends the session", async ({ page }, testInfo) => {
  await openConsole(page, await operator(), "/admin");
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { level: 1, name: "Businesses" })).toBeVisible();
  await expectAccessible(page, testInfo, "admin businesses");

  await page.getByRole("searchbox", { name: "Search businesses" }).fill("Lotus");
  await page.getByRole("link", { name: "Lotus Dental Studio" }).filter({ visible: true }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "Lotus Dental Studio" })).toBeVisible();
  await expectAccessible(page, testInfo, "admin one business");

  await runBusinessAction(page, /View as this business/);
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText(/30 minutes/)).toBeVisible();
  await expect(dialog.getByRole("switch", { name: "Allow changes" })).toHaveCount(0);
  await dialog.getByLabel("Why do you need to look?").fill("too short");
  await dialog.getByRole("button", { name: "Start viewing" }).click();
  await expect(dialog.getByText(/at least 10 characters/)).toBeVisible();
  await dialog.getByLabel("Why do you need to look?").fill("Owner says reminders stopped on Monday");
  await dialog.getByRole("button", { name: "Start viewing" }).click();

  const banner = page.getByTestId("impersonation-banner");
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(banner).toContainText("Viewing Lotus Dental Studio as Kalendr support. Read-only.");
  await expect(banner).toContainText(/Ends in (2[789]|30):\d\d/);
  await expectAccessible(page, testInfo, "business home with the support banner");

  // The banner follows to every staff screen.
  await page.goto("/schedule");
  await expect(page.getByTestId("impersonation-banner")).toBeVisible();

  // Nothing can be changed: the server refuses it with a plain sentence.
  const refused = await page.request.post("/api/staff/waitlist", { data: {} });
  expect(refused.status()).toBe(403);
  expect((await refused.json()).error.code).toBe("read_only_support_session");

  // The session is in the business's own Activity log.
  await withOwnerDatabase(async (sql) => {
    const rows = await sql<{ action: string }[]>`select action from audit_events where action like 'support.session.%' order by occurred_at desc limit 5`;
    expect(rows.map((row) => row.action)).toContain("support.session.started");
  });

  await page.getByRole("button", { name: "End session" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { level: 1, name: "Businesses" })).toBeVisible();

  // After the end, the same cookie shows no business: the operator is not staff anywhere.
  await page.goto("/dashboard");
  await expect(page.getByTestId("impersonation-banner")).toHaveCount(0);
  await withOwnerDatabase(async (sql) => {
    const rows = await sql<{ action: string }[]>`select action from audit_events where action = 'support.session.ended' limit 1`;
    expect(rows).toHaveLength(1);
  });
});

test("a support operator finds why a reminder was not delivered, without a customer name", async ({ page }) => {
  const who = await operator();
  // A failed reminder with a placeholder destination: the console must never need, or show, a real one.
  const notificationId = await withOwnerDatabase(async (sql) => {
    const [tenant] = await sql<{ id: string }[]>`select id from tenants where slug = 'lotus-dental'`;
    const [row] = await sql<{ id: string }[]>`
      insert into notifications (tenant_id, channel, template_key, destination_ciphertext, semantic_key, status, scheduled_at, failed_at, failure_code, attempt_count)
      values (${tenant!.id}, 'email', 'appointment_reminder', 'not-a-real-destination', ${`e2e-${unique()}`}, 'failed', now(), now(), 'bounced', 2)
      returning id`;
    return row!.id;
  });
  await openConsole(page, who, "/admin/messages");
  await expect(page.getByRole("heading", { level: 1, name: "Messages" })).toBeVisible();
  await page.getByRole("textbox", { name: "Message id or appointment id" }).fill(notificationId);
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByText("Why", { exact: true })).toBeVisible();
  await expect(page.getByText(/the address bounced earlier/)).toBeVisible();
  await expect(page.getByText("2 attempts")).toBeVisible();
  await expect(page.getByText("not-a-real-destination")).toHaveCount(0);
  await page.getByRole("textbox", { name: "Message id or appointment id" }).fill("no-such-message-id");
  await page.getByRole("button", { name: "Find" }).click();
  await expect(page.getByText("No message found")).toBeVisible();
});

test("an operator without the super role cannot open the Operators screen", async ({ page }) => {
  await openConsole(page, await operator("support"), "/admin");
  await expect(page.getByRole("link", { name: "Operators" })).toHaveCount(0);
  const response = await page.goto("/admin/operators");
  expect(response?.status()).toBe(404);
});
