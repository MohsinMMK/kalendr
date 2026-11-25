import { randomUUID } from "node:crypto";

import { expect, test, type Browser, type Page } from "@playwright/test";
import { hashPassword } from "better-auth/crypto";

import { linkFromEmail, signIn, unique, withOwnerDatabase } from "./support/journey";
import { freshCode, recallSecret } from "./support/second-factor";

/**
 * Feature 6: ways to sign in, the second factor, passkeys, devices and step-up.
 * Google and Microsoft run against the built-in stand-in (KALENDR_DEV_OAUTH); the real
 * providers need the owner's OAuth apps and are not exercised here.
 */

/**
 * Better Auth allows three sign-in requests per ten seconds per address, and Kalendr limits
 * password sign-ins per address and email. Each test comes from its own documentation address
 * (TEST-NET-2) so the tests do not count against each other.
 */
function randomAddress(): string {
  return `198.51.100.${1 + Math.floor(Math.random() * 250)}`;
}

test.beforeEach(async ({ context }) => {
  await context.setExtraHTTPHeaders({ "x-forwarded-for": randomAddress() });
});

/** An invited teammate: a user and a membership, no password they know, the way an invite leaves them. */
async function invite(role: "receptionist" | "admin" = "receptionist"): Promise<string> {
  const id = randomUUID();
  const email = `invited.${unique()}.${id.slice(0, 4)}@example.com`;
  await withOwnerDatabase(async (sql) => {
    const [tenant] = await sql<{ id: string }[]>`select id from tenants where slug = 'lotus-dental'`;
    await sql`insert into auth_users (id, name, email, email_verified) values (${id}, 'Invited Person', ${email}, false)`;
    await sql`insert into auth_accounts (id, issuer, account_id, provider_id, user_id, password) values (${randomUUID()}, 'local:credential', ${id}, 'credential', ${id}, ${await hashPassword(randomUUID())})`;
    await sql`insert into memberships (tenant_id, user_id, role, invited_at) values (${tenant!.id}, ${id}, ${role}::membership_role, now())`;
  });
  return email;
}

async function userCount(): Promise<number> {
  return withOwnerDatabase(async (sql) => (await sql<{ count: number }[]>`select count(*)::int as count from auth_users`)[0]!.count);
}

/** Signs in through the stand-in provider page, the way Google's own page would be used. */
async function continueWith(page: Page, provider: "Google" | "Microsoft", email: string, verified = true): Promise<void> {
  await page.goto("/sign-in");
  await page.getByRole("button", { name: `Continue with ${provider}` }).click();
  await page.waitForURL(/\/api\/dev-oauth\/authorize/);
  await page.getByRole("textbox", { name: "Email" }).fill(email);
  if (!verified) await page.getByRole("checkbox").uncheck();
  await page.getByRole("button", { name: "Continue" }).click();
}

async function secondContext(browser: Browser, page: Page): Promise<Page> {
  const context = await browser.newContext({ baseURL: page.url().split("/").slice(0, 3).join("/"), extraHTTPHeaders: { "x-forwarded-for": randomAddress() } });
  return context.newPage();
}

test("an invited receptionist signs in with Google on first use", async ({ page }) => {
  const email = await invite();
  await continueWith(page, "Google", email);
  await expect(page).toHaveURL(/\/dashboard/);
  await withOwnerDatabase(async (sql) => {
    const accounts = await sql<{ provider_id: string }[]>`select a.provider_id from auth_accounts a join auth_users u on u.id = a.user_id where u.email = ${email}`;
    expect(accounts.map((row) => row.provider_id)).toEqual(["google"]);
    const [user] = await sql<{ email_verified: boolean }[]>`select email_verified from auth_users where email = ${email}`;
    expect(user!.email_verified).toBe(true);
  });
});

test("a receptionist who types the address of a page their role doesn't include lands on access-denied", async ({ page }) => {
  const email = await invite("receptionist");
  await continueWith(page, "Google", email);
  await expect(page).toHaveURL(/\/dashboard/);
  // Their role opens the front desk's pages and not the business's marketing, settings or activity log.
  await page.goto("/messages");
  await expect(page).toHaveURL(/\/messages/);
  for (const path of ["/campaigns", "/settings", "/activity", "/spam", "/records"]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/access-denied\?reason=permission/);
    await expect(page.getByRole("heading", { name: "You don't have access to this page" })).toBeVisible();
  }
  await page.getByRole("link", { name: "Back to the dashboard" }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  // The sidebar doesn't offer what they can't open.
  await expect(page.locator('[data-nav-id="campaigns"]')).toHaveCount(0);
  await expect(page.locator('[data-nav-id="settings"]')).toHaveCount(0);
});

test("a stranger with a Google or Microsoft account is refused and no user is created", async ({ page }) => {
  const before = await userCount();
  const stranger = `stranger.${unique()}@example.com`;
  await continueWith(page, "Google", stranger);
  await expect(page).toHaveURL(/\/sign-in/);
  await expect(page.getByText("Ask your manager to invite you.")).toBeVisible();
  await continueWith(page, "Microsoft", stranger);
  await expect(page.getByText("Ask your manager to invite you.")).toBeVisible();
  expect(await userCount()).toBe(before);
});

test("an invited person is not linked when the provider does not vouch for the email", async ({ page }) => {
  const email = await invite();
  await continueWith(page, "Google", email, false);
  await expect(page).toHaveURL(/\/sign-in/);
  await expect(page.getByText(/Ask your manager|Could not sign in/)).toBeVisible();
  await withOwnerDatabase(async (sql) => {
    const rows = await sql`select 1 from auth_accounts a join auth_users u on u.id = a.user_id where u.email = ${email} and a.provider_id = 'google'`;
    expect(rows).toHaveLength(0);
  });
});

test("an email link signs in once, on another device, and then stops working", async ({ page, browser }) => {
  const email = await invite();
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByText(/we've sent a link/i)).toBeVisible();
  const link = await linkFromEmail(email, /https?:\/\/[^\s"'<>]*magic-link\/verify[^\s"'<>]*/);

  const other = await secondContext(browser, page);
  await other.goto(link.replaceAll("&amp;", "&"));
  await expect(other).toHaveURL(/\/dashboard/);
  const again = await secondContext(browser, page);
  await again.goto(link.replaceAll("&amp;", "&"));
  await expect(again).not.toHaveURL(/\/dashboard/);
});

test("an unknown address asking for a link gets the same answer and no user", async ({ page }) => {
  const before = await userCount();
  await page.goto("/sign-in");
  await page.getByLabel("Work email").fill(`nobody.${unique()}@example.com`);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByText(/we've sent a link/i)).toBeVisible();
  expect(await userCount()).toBe(before);
});

test("an owner without a second factor is taken to enrolment before seeing any data", async ({ page }) => {
  const email = `owner.${unique()}@example.com`;
  const password = `Pw-${randomUUID()}`;
  await withOwnerDatabase(async (sql) => {
    const id = randomUUID();
    const slug = `sf-${unique()}`;
    const [tenant] = await sql<{ id: string }[]>`insert into tenants (slug, name, legal_name, phone, email, timezone) values (${slug}, 'Second Factor Salon', 'Second Factor Salon', '+919000000777', ${`${slug}@example.com`}, 'Asia/Kolkata') returning id`;
    await sql`insert into auth_users (id, name, email, email_verified, password_set_at) values (${id}, 'New Owner', ${email}, true, now())`;
    await sql`insert into auth_accounts (id, issuer, account_id, provider_id, user_id, password) values (${randomUUID()}, 'local:credential', ${id}, 'credential', ${id}, ${await hashPassword(password)})`;
    await sql`insert into memberships (tenant_id, user_id, role) values (${tenant!.id}, ${id}, 'owner')`;
  });
  await signIn(page, email, password);
  // signIn enrolled through the real screens; the workspace is open now.
  await expect(page).not.toHaveURL(/\/security|\/sign-in/);
  expect(recallSecret(email)).toBeTruthy();
  // Signing in again asks for a code on the same screen.
  await page.context().clearCookies();
  await signIn(page, email, password);
  await expect(page).toHaveURL(/\/dashboard|\/setup/);
});

test("removing a device ends its session at once", async ({ page, browser }) => {
  const email = await invite();
  await continueWith(page, "Google", email);
  await expect(page).toHaveURL(/\/dashboard/);
  const other = await secondContext(browser, page);
  await continueWith(other, "Google", email);
  await expect(other).toHaveURL(/\/dashboard/);

  await page.goto("/profile");
  const devices = page.getByRole("region", { name: /signed-in devices/i }).or(page.getByText("Signed-in devices").locator("xpath=ancestor::section[1]"));
  await expect(devices.getByRole("button", { name: /^Sign out / }).first()).toBeVisible();
  await devices.getByRole("button", { name: /^Sign out / }).first().click();
  await other.reload();
  await expect(other).toHaveURL(/\/sign-in/);
});

test("a passkey signs in without a password and counts as two factors", async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name === "phone", "The virtual authenticator is driven once, on desktop Chromium.");
  const client = await context.newCDPSession(page);
  await client.send("WebAuthn.enable");
  await client.send("WebAuthn.addVirtualAuthenticator", {
    options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  const email = await invite("admin");
  await continueWith(page, "Google", email);
  // An admin must have a second factor: enrol a passkey from the enrolment screen.
  await expect(page).toHaveURL(/\/security\/second-factor/);
  await page.getByRole("button", { name: "Add a passkey" }).click();
  await expect(page).not.toHaveURL(/\/security\/second-factor/, { timeout: 20_000 });

  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByRole("button", { name: "Sign in with a passkey" }).click();
  await expect(page).toHaveURL(/\/dashboard|\/setup/, { timeout: 20_000 });
});

test("the security policy asks for a fresh code after ten minutes", async ({ page }) => {
  const email = "kalendr.owner@example.com";
  await signIn(page, email, undefined, "/profile");
  const toggle = page.getByRole("switch", { name: "Ask everyone on the team for a second factor" });
  await expect(toggle).toBeVisible();
  // Eleven minutes after the last check.
  await withOwnerDatabase((sql) => sql`update auth_sessions set second_factor_at = now() - interval '11 minutes' where user_id = (select id from auth_users where email = ${email})`);
  await toggle.click();
  const dialog = page.getByRole("dialog", { name: "Confirm it's you" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Authenticator code").fill(await freshCode(recallSecret(email)!));
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect(dialog).toBeHidden();
  await expect(toggle).toBeChecked();
  // Put it back so later journeys are unaffected.
  await toggle.click();
  await expect(toggle).not.toBeChecked();
});
