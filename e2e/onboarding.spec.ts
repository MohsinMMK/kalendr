import type { ChildProcess } from "node:child_process";

import { expect, test, type Page } from "@playwright/test";

import { chooseCard, expectAccessible, landAfterSignUp, linkFromEmail, signIn, signUpWithEmail, unique, withOwnerDatabase } from "./support/journey";
import { startWorker } from "./support/worker";

/**
 * Feature 11, the journey in "Done when": a new owner goes from the registration form to seeing their own test booking on
 * the schedule with a confirmation on its way to their phone, without reading any help; leaving halfway and coming back
 * resumes at the same step. The worker runs against the capture server, so nothing reaches a real provider.
 *
 * Not covered here: a confirmation on a real phone (needs a WhatsApp or text account); the ten-minute clock is shown by the
 * time this journey takes from /start to the booking on the schedule, which is logged at the end.
 */
// One owner, two journeys that build on each other: they run in order.
test.describe.configure({ mode: "serial" });

let worker: ChildProcess;
test.beforeAll(() => { worker = startWorker(); });
test.afterAll(() => { worker.kill(); });

const suffix = unique();
const business = `Onboard Studio ${suffix}`;
const email = `onboard.${suffix}@example.com`;
const password = `journey-pass-${suffix}-${unique()}`;
// A number of its own per run: the booking page limits how often one number can book.
const phone = `98450 ${String(Number.parseInt(suffix, 16) % 100_000).padStart(5, "0")}`;

async function register(page: Page): Promise<void> {
  await signUpWithEmail(page, null, email, password);
  await chooseCard(page, "Salon");
  await page.getByRole("textbox", { name: "Salon name" }).fill(business);
  await page.getByRole("textbox", { name: "Your full name" }).fill("Neha Journey");
  await page.getByRole("button", { name: "Create salon" }).click();
  // The welcome email reaches the owner at once, whatever else they do.
  await linkFromEmail(email, /Your booking page is ready/);
  // The email was confirmed by its code, so the owner is signed in at once.
  await landAfterSignUp(page, email, password);
}

/** A menu item. On a phone the menu is a sheet that slides up, so wait for it to settle before pressing. */
async function pickMenuItem(page: Page, name: string | RegExp): Promise<void> {
  const item = page.getByRole("menuitem", { name });
  await expect(item).toBeInViewport();
  await page.waitForTimeout(400);
  await item.click();
}

async function openAllSteps(page: Page): Promise<void> {
  await page.getByRole("button", { name: "More about getting started" }).click();
  await pickMenuItem(page, "See all steps");
  await expect(page.getByRole("dialog", { name: "Getting started" })).toBeVisible();
}

test("a new owner registers, takes the tour, makes a test booking, sees it on the schedule, and can leave and come back", async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": `192.0.2.${testInfo.project.name === "phone" ? 175 : 75}` });
  const started = Date.now();
  await register(page);
  if (!page.url().includes("/dashboard")) await page.goto("/dashboard");

  // The tour: five stops on the real screens, closable at any point.
  await expect(page.getByText("Stop 1 of 5")).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/schedule/);
  for (const stop of [1, 2, 3, 4, 5]) {
    await expect(page.getByText(`Stop ${stop} of 5`)).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: stop === 5 ? "Finish" : "Next", exact: true }).click();
  }
  await expect(page.getByText(/Stop \d of 5/)).toHaveCount(0);
  await withOwnerDatabase(async (sql) => {
    const [mark] = await sql<{ done_at: Date | null }[]>`select progress.done_at from onboarding_progress as progress join tenants on tenants.id = progress.tenant_id where tenants.name = ${business} and progress.step_key = 'tour'`;
    expect(mark?.done_at).not.toBeNull();
  });

  await page.goto("/dashboard");
  const card = page.getByLabel("Getting started", { exact: true });
  await expect(card).toContainText("1 of 8 done");
  await expectAccessible(page, testInfo, "dashboard with the checklist");

  // Step 4 is the important one: a test booking on the owner's own page, in a side panel.
  await openAllSteps(page);
  await page.getByRole("button", { name: "Make a test booking" }).first().click();
  const panel = page.getByRole("dialog", { name: "Make a test booking" });
  await expect(panel).toBeVisible();
  await panel.getByLabel("Your mobile number").fill(phone);
  await panel.getByRole("button", { name: "Start the test booking" }).click();

  const frame = page.frameLocator('iframe[title="Your booking page"]');
  await frame.locator("label").filter({ hasText: "Haircut" }).first().click();
  // Choosing moves on by itself. One person takes bookings (the owner), so the person step may be skipped; choose them if asked.
  const next = frame.getByRole("heading", { level: 1, name: /Who would you like to see\?|When works for you\?/ });
  await expect(next).toBeVisible();
  if ((await next.innerText()) === "Who would you like to see?") {
    await frame.locator("label").filter({ hasText: "Neha Journey" }).first().click();
  }
  await expect(frame.getByRole("heading", { level: 1, name: "When works for you?" })).toBeVisible();
  await frame.getByRole("radiogroup").last().getByRole("radio").first().click();
  // The template's one question comes first (it is optional); then the form, already filled in with the owner's own details.
  await expect(frame.getByText("Anything we should know about your hair?")).toBeVisible();
  await frame.getByRole("button", { name: "Continue" }).click();
  await expect(frame.getByRole("textbox", { name: "Email address" })).toHaveValue(email);
  await expect(frame.getByRole("textbox", { name: "Full name" })).toHaveValue("Neha Journey");
  await frame.getByRole("checkbox", { name: /I understand and agree/ }).check();
  await page.waitForTimeout(4_000);
  await frame.getByRole("button", { name: "Confirm booking" }).click();

  // The booking lands: the panel says so, and says how the confirmation is going.
  await expect(panel.getByText(/It is on your schedule: Haircut/)).toBeVisible({ timeout: 30_000 });
  await expect(panel.getByText(/Your confirmation (is on its way|was sent|reached you) as (a|an) /)).toBeVisible({ timeout: 45_000 });
  await withOwnerDatabase(async (sql) => {
    const [row] = await sql<{ is_test: boolean; sent: number }[]>`
      select appointment.is_test, (select count(*)::int from notifications where tenant_id = appointment.tenant_id and appointment_id = appointment.id and status in ('sending', 'delivered')) as sent
      from appointments as appointment join tenants on tenants.id = appointment.tenant_id where tenants.name = ${business} limit 1`;
    expect(row).toEqual({ is_test: true, sent: 1 });
    const [step] = await sql<{ done_at: Date | null }[]>`select progress.done_at from onboarding_progress as progress join tenants on tenants.id = progress.tenant_id where tenants.name = ${business} and progress.step_key = 'test_booking'`;
    expect(step?.done_at).not.toBeNull();
  });

  await panel.getByRole("link", { name: "See it on the schedule" }).click();
  await expect(page).toHaveURL(/\/schedule\?date=\d{4}-\d{2}-\d{2}/);
  await expect(page.getByText("Neha Journey").first()).toBeVisible({ timeout: 20_000 });
  console.log(`From /start to the test booking on the schedule: ${Math.round((Date.now() - started) / 1000)} seconds (limit: 600).`);
  expect(Date.now() - started).toBeLessThan(600_000);

  // Leaving halfway and coming back: the same step is next, because progress is kept on the server.
  await page.goto("/dashboard");
  await expect(page.getByLabel("Getting started", { exact: true })).toContainText("2 of 8 done");
  await openAllSteps(page);
  const list = page.getByRole("dialog", { name: "Getting started" }).getByRole("list");
  await list.getByRole("button", { name: "More for Confirm your" }).click();
  await pickMenuItem(page, "Mark as done");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Getting started" })).toBeHidden();
  await expect(page.getByLabel("Getting started", { exact: true })).toContainText("3 of 8 done");
  await page.reload();
  await expect(page.getByLabel("Getting started", { exact: true })).toContainText("3 of 8 done");
  await expect(page.getByLabel("Getting started", { exact: true }).getByRole("button", { name: /Set your hours|Set hours/ }).first()).toBeVisible();

  // Remove the test booking in one step; the schedule is clean again.
  await page.getByRole("button", { name: "More about getting started" }).click();
  await pickMenuItem(page, "Remove test data");
  await page.getByRole("alertdialog", { name: "Remove test and sample data?" }).getByRole("button", { name: "Remove them" }).click();
  await expect(page.getByText("Test data removed")).toBeVisible();
  await withOwnerDatabase(async (sql) => {
    const [count] = await sql<{ n: number }[]>`select count(*)::int as n from appointments join tenants on tenants.id = appointments.tenant_id where tenants.name = ${business}`;
    expect(count?.n).toBe(0);
  });
});

test("sample data is labelled and removable, and the go-live check names what would embarrass the owner", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": `192.0.2.${testInfo.project.name === "phone" ? 176 : 76}` });
  await signIn(page, email, password, "/dashboard");
  // Sample data: a week of labelled sample customers, removable in one click.
  await page.getByRole("button", { name: "More about getting started" }).click();
  await pickMenuItem(page, /Add sample data/);
  await expect(page.getByText("Sample data added")).toBeVisible({ timeout: 20_000 });
  await page.goto("/patients");
  await expect(page.getByText(/\(sample\)/).first()).toBeVisible();
  await page.goto("/dashboard");

  // The go-live check names what would embarrass the owner: no phone or address yet, and sample data still in.
  await openAllSteps(page);
  await page.getByRole("button", { name: "Share the link" }).click();
  const share = page.getByRole("dialog", { name: "Share your booking link" });
  await expect(share.getByText(/phone number or address is missing/)).toBeVisible();
  await expect(share.getByText(/Test or sample bookings and customers are still in/)).toBeVisible();
  await expectAccessible(page, testInfo, "go-live check");

  // The owner can fix what it names through the screens: Fix opens the page settings, where the phone and address go in.
  await share.getByRole("listitem").filter({ hasText: "phone number or address is missing" }).getByRole("button", { name: "Fix" }).click();
  // Settings is a page of its own; Fix lands on the section that holds the phone and address.
  await expect(page).toHaveURL(/\/settings\?section=/);
  const settings = page.locator("#clinic-main");
  await expect(settings).toBeVisible();
  await settings.getByRole("tab", { name: "Edit" }).click();
  await settings.getByLabel("Phone").fill("+91 98450 77001");
  await settings.getByLabel("Address").fill("4 Test Street, Indiranagar");
  await settings.getByLabel("City").fill("Bengaluru");
  await settings.getByRole("button", { name: /^Save .* details$/ }).click();
  await expect.poll(() => withOwnerDatabase(async (sql) => {
    const [row] = await sql<{ phone: string; city: string }[]>`select tenants.phone, locations.city from tenants join locations on locations.tenant_id = tenants.id where tenants.name = ${business}`;
    return row;
  }), { message: "the phone and city are saved", timeout: 15_000 }).toEqual({ phone: "+91 98450 77001", city: "Bengaluru" });
  // On a phone the way back is in the settings sidebar, which opens from the header.
  if (testInfo.project.name === "phone") await page.getByRole("button", { name: "Toggle Sidebar" }).first().click();
  await page.getByRole("link", { name: /Back to / }).click();
  await openAllSteps(page);
  await page.getByRole("button", { name: "Share the link" }).click();
  await expect(page.getByRole("dialog", { name: "Share your booking link" }).getByText("Your phone number and address are on the page.")).toBeVisible();
  await page.getByRole("dialog", { name: "Share your booking link" }).getByRole("button", { name: "Not yet" }).click();

  await page.getByRole("button", { name: "More about getting started" }).click();
  await pickMenuItem(page, "Remove sample data");
  await page.getByRole("alertdialog").getByRole("button", { name: "Remove them" }).click();
  await expect(page.getByText("Test data removed")).toBeVisible();
});
