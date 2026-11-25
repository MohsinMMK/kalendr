import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

import AxeBuilder from "@axe-core/playwright";
import { expect, type Browser, type Page, type TestInfo } from "@playwright/test";
import postgres from "postgres";

import { minimumBookingFillMs } from "../../src/lib/bot-check";
import { freshCode, recallSecret, rememberSecret } from "./second-factor";

/**
 * Shared steps for the browser journeys. Every value here is a test value: the seeded
 * sample businesses, fresh names per run, and the capture server in place of email.
 */
const captureUrl = process.env.KALENDR_CAPTURE_URL ?? "http://127.0.0.1:3199";

/** A short random suffix so a rerun, or the phone project, never collides with earlier data. */
export function unique(): string {
  return randomBytes(3).toString("hex");
}

function staffPassword(email: string): string {
  const file = process.env.KALENDR_STAFF_CREDENTIALS;
  if (!file) throw new Error("KALENDR_STAFF_CREDENTIALS is not set; run scripts/e2e.sh.");
  const credentials = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
  const password = credentials[email];
  if (!password) throw new Error(`No seeded password for ${email}.`);
  return password;
}

/**
 * Findings that come from the vendored coss components, not from Kalendr's own screens. They are
 * still attached to the report and listed under "Known limits" in the feature 35 doc; they do not
 * fail the journey, so a regression in Kalendr's own markup stays visible. Keep this list short.
 */
const knownFindings: Array<{ rule: string; html: RegExp; detail?: RegExp; why: string }> = [
  { rule: "color-contrast", html: /^<th [^>]*text-muted-foreground\/72/, why: "coss calendar weekday header at 72% muted" },
  { rule: "color-contrast", html: /data-slot="segmented-control-it/, why: "coss segmented control, unselected item" },
  // axe cuts attribute values at 20 characters ("Wednesday, November ..."), so match the weekday only.
  { rule: "label-content-name-mismatch", html: /^<button [^>]*aria-label="(Today, )?(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day, /, why: "react-day-picker day buttons read the full date" },
  // White on the red-500 destructive token is 3.8:1. Fixing it means changing the theme token.
  { rule: "color-contrast", html: /^<button [^>]*data-slot="button"/, detail: /foreground color: #ffffff, background color: #fb2c36/, why: "coss destructive button on the light theme's red-500 token" },
];

function isKnownFinding(rule: string, node: { html: string; failureSummary?: string }): boolean {
  return knownFindings.some(
    (known) => known.rule === rule && known.html.test(node.html) && (!known.detail || known.detail.test(node.failureSummary ?? "")),
  );
}

/**
 * Accessibility scan of the current page. Serious and critical findings fail the journey;
 * minor and moderate ones are attached to the report for review.
 */
/** `scope` limits the scan to one part of the page (a dialog), for a screen shown over a page whose own findings belong to another feature. */
export async function expectAccessible(page: Page, testInfo: TestInfo, label: string, scope?: string): Promise<void> {
  // A screen fading in has partial opacity, which reads as low contrast. Scan the settled screen.
  // A popup that has just mounted sits at its starting style before its fade begins, so wait for that to clear too.
  await page.waitForFunction(
    () => !document.querySelector("[data-starting-style], [data-ending-style]") && document.getAnimations().every((animation) => animation.playState !== "running"),
    undefined, { timeout: 5_000 },
  ).catch(() => {});
  // A section change in the address re-runs the page's async metadata, so the tab title streams back a moment later.
  // Scan once it is there; a page that never gets one still fails the scan below.
  await page.waitForFunction(() => document.title.trim().length > 0, undefined, { timeout: 5_000 }).catch(() => {});
  const builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
  const results = await (scope ? builder.include(scope) : builder).analyze();
  const blocking = results.violations
    .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
    .map((violation) => ({ ...violation, nodes: violation.nodes.filter((node) => !isKnownFinding(violation.id, node)) }))
    .filter((violation) => violation.nodes.length > 0);
  if (results.violations.length > 0) {
    await testInfo.attach(`axe-${label}`, {
      body: JSON.stringify(results.violations, null, 2),
      contentType: "application/json",
    });
  }
  expect(
    blocking.map((violation) => `${violation.id} (${violation.impact}): ${violation.help} — ${violation.nodes.map((node) => node.target.join(" ")).slice(0, 3).join(", ")}`),
    `serious accessibility findings on ${label}`,
  ).toEqual([]);
}

/**
 * Base UI radio cards: the visible label receives the click, not the hidden input.
 * Choosing moves the booking on by itself, so there is no Continue to press; callers wait for the next screen.
 */
export async function chooseCard(page: Page, text: string | RegExp): Promise<void> {
  await page.locator("label").filter({ hasText: text }).first().click();
}

/**
 * Owners and admins must have a second factor (feature 6). The first sign-in as someone without
 * one lands on the enrolment screen: this enrols an authenticator app through the real screens and
 * remembers the secret, so later sign-ins as the same person answer the code step.
 */
export async function enrolAuthenticator(page: Page, email: string, password?: string): Promise<void> {
  await expect(page.getByRole("heading", { name: "Set up a second factor" })).toBeVisible();
  await page.getByRole("button", { name: "Authenticator app" }).click();
  // Someone who chose a password is asked for it before the key is made.
  const current = page.getByLabel("Current password");
  if (await current.isVisible({ timeout: 3_000 }).catch(() => false)) {
    await current.fill(password ?? staffPassword(email));
    await page.getByRole("button", { name: "Continue" }).click();
  }
  const secret = (await page.getByTestId("totp-secret").first().innerText()).replace(/\s+/g, "");
  rememberSecret(email, secret);
  await page.getByLabel("Authenticator code").fill(await freshCode(secret));
  await page.getByRole("button", { name: "Verify" }).click();
  await page.getByRole("checkbox", { name: "I saved these codes" }).check();
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/security") && !url.pathname.startsWith("/sign-in"), { timeout: 20_000 });
}

/** The code step after a password: the same page asks for it without navigating. */
export async function answerCodeStep(page: Page, email: string): Promise<void> {
  const secret = recallSecret(email);
  if (!secret) throw new Error(`No authenticator secret was enrolled for ${email} in this run.`);
  await page.getByLabel("Authenticator code").fill(await freshCode(secret));
  await page.getByRole("button", { name: "Verify" }).click();
}

/**
 * The app allows ten staff sign-ins per address and per email in fifteen minutes. Most journeys sign in as the same
 * seeded owner from the same runner, so a CI shard of forty journeys would run out partway. Each sign-in here starts
 * from empty counts in the disposable test database. No journey tests the limits; `src/server/rate-limit*.test.ts` do.
 */
async function clearRateLimits(): Promise<void> {
  await withOwnerDatabase((sql) => sql`delete from rate_limit_buckets`);
}

/**
 * Staff sign-in. better-auth allows three sign-in attempts per ten seconds per address,
 * so a refused attempt waits out the window once before failing. An owner or admin is taken
 * through the second factor as well (enrolling it the first time).
 */
export async function signIn(page: Page, email: string, password = staffPassword(email), next?: string): Promise<void> {
  await clearRateLimits();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.goto(next ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in");
    await page.getByLabel("Work email").fill(email);
    await page.getByRole("textbox", { name: "Password" }).fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    let outcome = await Promise.race([
      page.waitForURL((url) => !url.pathname.startsWith("/sign-in") && !url.pathname.startsWith("/security"), { timeout: 20_000 }).then(() => "signed-in" as const),
      page.waitForURL((url) => url.pathname.startsWith("/security/second-factor"), { timeout: 20_000 }).then(() => "enrol" as const),
      page.getByLabel("Authenticator code").waitFor({ timeout: 20_000 }).then(() => "code" as const),
      page.getByRole("alert").filter({ hasText: /Could not sign in|Too many/i }).waitFor({ timeout: 20_000 }).then(() => "refused" as const),
    ]);
    if (outcome === "enrol") {
      await enrolAuthenticator(page, email, password);
      outcome = "signed-in";
    } else if (outcome === "code") {
      await answerCodeStep(page, email);
      await page.waitForURL((url) => !url.pathname.startsWith("/sign-in"), { timeout: 20_000 });
      outcome = "signed-in";
    }
    if (outcome === "signed-in") {
      // The dashboard can redirect an owner on to enrolment a moment after the address changed.
      await page.waitForLoadState("networkidle").catch(() => {});
      if (page.url().includes("/security/second-factor")) await enrolAuthenticator(page, email, password);
      // Sign-in lands on the dashboard; go on to the page the journey needs.
      if (next && !page.url().includes(next)) await page.goto(next);
      return;
    }
    await page.waitForTimeout(11_000);
  }
  throw new Error(`Could not sign in as ${email}.`);
}

export interface Customer {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
}

export function newCustomer(label: string): Customer {
  const suffix = unique();
  const digits = String(Number.parseInt(suffix, 16) % 100_000).padStart(5, "0");
  return {
    firstName: label,
    lastName: `Journey${suffix}`,
    phone: `+91 98450 ${digits}`,
    email: `${label.toLowerCase()}.${suffix}@example.com`,
  };
}

/** Public booking flow up to the time step: first visit, a service, a person. Returns the openings on screen. */
export async function openTimeStep(
  page: Page,
  options: { slug: string; service: string; practitioner: string },
) {
  await page.goto(`/book/${options.slug}`);
  await chooseCard(page, options.service);
  await expect(page.getByRole("heading", { level: 1, name: "Who would you like to see?" })).toBeVisible();
  await chooseCard(page, options.practitioner);
  await expect(page.getByRole("heading", { level: 1, name: "When works for you?" })).toBeVisible();
  return page.getByRole("radiogroup").last().getByRole("radio");
}

/** Public booking flow up to the details step: first visit, a service, a person, then a time. */
export async function chooseBookingSlot(
  page: Page,
  options: { slug: string; service: string; practitioner: string; time?: string },
): Promise<string> {
  const times = await openTimeStep(page, options);
  const slot = options.time ? times.filter({ hasText: options.time }).first() : times.first();
  await expect(slot).toBeVisible();
  // What the customer reads on the button: the time, without the person's name underneath.
  const label = (await slot.innerText()).split("\n")[0]!;
  await slot.click();
  await expect(page.getByRole("heading", { level: 1, name: "Last step: your details" })).toBeVisible();
  return label.trim();
}

export async function fillCustomerDetails(page: Page, customer: Customer): Promise<void> {
  await page.getByRole("textbox", { name: "Full name" }).fill(`${customer.firstName} ${customer.lastName}`);
  await page.getByRole("textbox", { name: "Mobile number" }).fill(customer.phone);
  await page.getByRole("textbox", { name: "Email address" }).fill(customer.email);
  await page.getByRole("checkbox", { name: /I understand and agree/ }).check();
  // The server refuses a booking sent sooner than any person could fill it in (the bot filter),
  // and a script is that fast, so give the flow a person's pace before it is confirmed.
  await page.waitForTimeout(minimumBookingFillMs);
}

/** Emails the app sent through the capture server (never a real provider). */
async function capturedEmails(to: string): Promise<Array<{ subject: string; text: string; html: string }>> {
  const response = await fetch(`${captureUrl}/messages?to=${encodeURIComponent(to)}`);
  return (await response.json()) as Array<{ subject: string; text: string; html: string }>;
}

export async function linkFromEmail(to: string, pattern: RegExp): Promise<string> {
  let link: string | undefined;
  await expect
    .poll(async () => {
      for (const message of (await capturedEmails(to)).reverse()) {
        const match = `${message.text}\n${message.html}`.match(pattern);
        if (match) {
          link = match[0];
          return true;
        }
      }
      return false;
    }, { message: `an email to ${to} with a link matching ${pattern}`, timeout: 20_000 })
    .toBe(true);
  return link!;
}

/** The 6-digit code /start emails a new owner. */
async function signUpCode(to: string): Promise<string> {
  let code: string | undefined;
  await expect
    .poll(async () => {
      for (const message of (await capturedEmails(to)).reverse()) {
        const match = message.subject.match(/^(\d{6}) is your Kalendr code/);
        if (match) {
          code = match[1];
          return true;
        }
      }
      return false;
    }, { message: `a sign-up code email to ${to}`, timeout: 20_000 })
    .toBe(true);
  return code!;
}

/**
 * The account half of /start: the email, the code from the email, then a password. Leaves the owner on
 * "What kind of business?".
 */
export async function signUpWithEmail(page: Page, testInfo: TestInfo | null, email: string, password: string): Promise<void> {
  await page.goto("/start");
  if (testInfo) await expectAccessible(page, testInfo, "start");
  await page.getByRole("textbox", { name: "Work email" }).fill(email);
  await page.getByRole("button", { name: "Continue with email" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  const code = await signUpCode(email);
  await page.getByRole("textbox", { name: "Six-digit code" }).click();
  await page.keyboard.type(code);
  await expect(page.getByRole("heading", { name: "Choose a password" })).toBeVisible();
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(password);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "What kind of business?" })).toBeVisible();
}

/** After "Create": the owner is signed in at once, and an owner sets up a second factor first. */
export async function landAfterSignUp(page: Page, email: string, password: string): Promise<void> {
  await page.waitForURL(/\/(dashboard|security\/second-factor)/, { timeout: 30_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  if (page.url().includes("/security/second-factor")) await enrolAuthenticator(page, email, password);
}

/**
 * Owner-role database access, for arranging state the UI cannot reach (an appointment that
 * already started) and for checking what the database holds. Never used to skip the UI step
 * a journey is testing.
 */
export async function withOwnerDatabase<T>(work: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const url = process.env.KALENDR_E2E_OWNER_URL;
  if (!url) throw new Error("KALENDR_E2E_OWNER_URL is not set; run scripts/e2e.sh.");
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    return await work(sql);
  } finally {
    await sql.end();
  }
}

export async function newPage(browser: Browser, testInfo: TestInfo): Promise<Page> {
  const context = await browser.newContext({ ...testInfo.project.use, baseURL: testInfo.project.use.baseURL });
  return context.newPage();
}
