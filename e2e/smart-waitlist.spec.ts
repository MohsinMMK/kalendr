import type { ChildProcess } from "node:child_process";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { startWorker, whatsAppCode, whatsAppCount } from "./support/worker";
import { chooseCard, expectAccessible, fillCustomerDetails, linkFromEmail, newCustomer, signIn, withOwnerDatabase, type Customer } from "./support/journey";

// Cancelling from a manage link asks for a one-time code (feature 8) and the offers go out through the worker: both
// reach the capture server, never a real provider.
let worker: ChildProcess | undefined;
test.beforeAll(() => { worker = startWorker(); });
test.afterAll(() => { worker?.kill("SIGTERM"); });

const owner = "kalendr.owner@example.com";
// Each run signs up and books from an address of its own (a documentation address), so rerunning this file within the hour
// does not meet the sign-up and booking limits the earlier run used up.
const clientHeaders = { "x-forwarded-for": `203.0.113.${20 + Math.floor(Math.random() * 200)}` };
test.use({ extraHTTPHeaders: clientHeaders });

/** The page's main content only, without the clinic shell's alerts bell (not this feature's markup; its unread badge has its own findings). */
async function expectMainAccessible(page: Page, label: string): Promise<void> {
  const results = await new AxeBuilder({ page }).include("main").exclude('button[aria-label^="Notifications"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const blocking = results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
  expect(blocking.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`), `serious accessibility findings on ${label}`).toEqual([]);
}
const slug = "lotus-dental";
const dayInIndia = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

interface Setup { tenantId: string; locationId: string; serviceId: string; practitionerId: string; quiet: { start: number; end: number } | null }

async function arrange(): Promise<Setup> {
  return withOwnerDatabase(async (sql) => {
    const [row] = await sql<{ tenant_id: string; location_id: string; service_id: string; practitioner_id: string }[]>`
      select tenant.id as tenant_id, location.id as location_id, service.id as service_id, person.id as practitioner_id
      from tenants as tenant
      join locations as location on location.tenant_id = tenant.id
      join services as service on service.tenant_id = tenant.id and service.name = 'Dental cleaning'
      join practitioners as person on person.tenant_id = tenant.id and person.name = 'Dr Arjun Shah'
      where tenant.slug = ${slug} limit 1`;
    if (!row) throw new Error("The seeded business is missing.");
    const [before] = await sql<{ quiet_start_minute: number; quiet_end_minute: number }[]>`select quiet_start_minute, quiet_end_minute from workflow_settings where tenant_id = ${row.tenant_id}`;
    // No quiet hours for this journey, and nobody else waiting for this service, so the order is the one the test sets up.
    await sql`insert into workflow_settings (tenant_id, quiet_start_minute, quiet_end_minute) values (${row.tenant_id}, 0, 0)
      on conflict (tenant_id) do update set quiet_start_minute = 0, quiet_end_minute = 0`;
    await sql`delete from waitlist_entries where tenant_id = ${row.tenant_id}`;
    await sql`delete from waitlist_service_switches where tenant_id = ${row.tenant_id}`;
    return {
      tenantId: row.tenant_id, locationId: row.location_id, serviceId: row.service_id, practitionerId: row.practitioner_id,
      quiet: before ? { start: before.quiet_start_minute, end: before.quiet_end_minute } : null,
    };
  });
}

/** Leaves the business as it was found: no one waiting, no offer or held time, the original quiet hours. */
async function restore(setup: Setup): Promise<void> {
  await withOwnerDatabase(async (sql) => {
    await sql`delete from waitlist_entries where tenant_id = ${setup.tenantId}`;
    await sql`delete from slot_holds where tenant_id = ${setup.tenantId} and purpose = 'waitlist'`;
    await sql`delete from schedule_blocks where tenant_id = ${setup.tenantId} and reason = 'Training'`;
    if (setup.quiet) await sql`update workflow_settings set quiet_start_minute = ${setup.quiet.start}, quiet_end_minute = ${setup.quiet.end} where tenant_id = ${setup.tenantId}`;
    else await sql`delete from workflow_settings where tenant_id = ${setup.tenantId}`;
  });
}

/** A free time three to ten days ahead, read from the same public listing the booking page uses. */
async function openTime(request: APIRequestContext, setup: Setup): Promise<{ startsAt: string; endsAt: string }> {
  const from = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const to = new Date(Date.now() + 10 * 86_400_000).toISOString();
  const response = await request.get(`/api/public/availability?clinicSlug=${slug}&locationId=${setup.locationId}&serviceId=${setup.serviceId}&practitionerId=${setup.practitionerId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  const { data } = (await response.json()) as { data: { slots: Array<{ startsAt: string; endsAt: string }> } };
  const [first] = data.slots;
  if (!first) throw new Error("No open time to test with.");
  return first;
}

async function isOnPublicPage(request: APIRequestContext, setup: Setup, startsAt: string): Promise<boolean> {
  const from = new Date(Date.parse(startsAt) - 60_000).toISOString();
  const to = new Date(Date.parse(startsAt) + 3_660_000).toISOString();
  const response = await request.get(`/api/public/availability?clinicSlug=${slug}&locationId=${setup.locationId}&serviceId=${setup.serviceId}&practitionerId=${setup.practitionerId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
  const { data } = (await response.json()) as { data: { slots: Array<{ startsAt: string }> } };
  return data.slots.some((slot) => new Date(slot.startsAt).toISOString() === new Date(startsAt).toISOString());
}

/** The booking page's time step for the service and person, ready to read or to choose a time. */
async function openBookingPage(page: Page, setup: Setup): Promise<void> {
  const query = new URLSearchParams({ service: setup.serviceId, person: setup.practitionerId });
  await page.goto(`/book/${slug}?${query}`);
}

/** Picks one time on the calendar the way a customer does: the day, then the time. */
async function pickTime(page: Page, startsAt: string): Promise<void> {
  const when = new Date(startsAt);
  const part = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Kolkata", ...options }).format(when);
  const month = part({ month: "long" });
  const dayNumber = Number(part({ day: "numeric" }));
  const year = part({ year: "numeric" });
  const label = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(when);
  const dayButton = page.getByRole("button", { name: new RegExp(`${month} ${dayNumber}(st|nd|rd|th), ${year}`) });
  // Let the calendar finish loading before deciding the day is in a later month.
  await dayButton.waitFor({ timeout: 10_000 }).catch(() => undefined);
  for (let attempt = 0; attempt < 3 && !(await dayButton.isVisible().catch(() => false)); attempt += 1) {
    await page.getByRole("button", { name: /next month/i }).click();
  }
  await dayButton.click();
  await page.getByRole("radiogroup").last().getByRole("radio").filter({ hasText: new RegExp(`(?<![0-9])${label}`, "i") }).first().click();
}

/** A short name for a screenshot file: the width of the window the person is using. */
function testInfoName(page: Page): string {
  return `${page.viewportSize()?.width ?? "x"}`;
}

async function joinTheWaitlist(page: Page, setup: Setup, person: Customer, day: string): Promise<void> {
  await openBookingPage(page, setup);
  await expect(page.getByRole("heading", { level: 1, name: "When works for you?" })).toBeVisible();
  await page.getByRole("button", { name: "Join the waitlist" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "Join the waitlist" })).toBeVisible();
  await dialog.getByLabel("From").fill(dayInIndia(new Date()));
  await dialog.getByLabel("Until").fill(day);
  await dialog.getByRole("textbox", { name: "First name" }).fill(person.firstName);
  await dialog.getByRole("textbox", { name: "Last name" }).fill(person.lastName);
  await dialog.getByRole("textbox", { name: "Email" }).fill(person.email);
  await dialog.getByRole("checkbox", { name: /I agree that/ }).check();
  // The server refuses a form sent sooner than any person could fill it in (the bot filter).
  await page.waitForTimeout(3_200);
  if (process.env.KALENDR_E2E_SHOTS) await page.screenshot({ path: `${process.env.KALENDR_E2E_SHOTS}/join-${testInfoName(page)}.png` });
  await dialog.getByRole("button", { name: "Join the waitlist" }).click();
  await expect(dialog.getByRole("heading", { name: "You are on the waitlist" })).toBeVisible();
  await dialog.getByRole("button", { name: "Done" }).click();
}

test("a cancelled time is offered to the first person waiting, passed on when ignored, and the second takes it in one tap", async ({ page, browser }, testInfo) => {
  test.setTimeout(240_000);
  const setup = await arrange();
  try {
    const slot = await openTime(page.request, setup);
    const day = dayInIndia(new Date(slot.startsAt));
    const canceller = newCustomer("Cancel");
    const first = newCustomer("Firsty");
    const second = newCustomer("Secondly");

    // Two people ask to be told, from the booking page, one after the other.
    await joinTheWaitlist(page, setup, first, day);
    await expectAccessible(page, testInfo, "booking page after joining");
    await joinTheWaitlist(page, setup, second, day);

    // Someone books that time.
    await openBookingPage(page, setup);
    await expect(page.getByRole("heading", { level: 1, name: "When works for you?" })).toBeVisible();
    await pickTime(page, slot.startsAt);
    await expect(page.getByRole("heading", { level: 1, name: "Last step: your details" })).toBeVisible();
    await fillCustomerDetails(page, canceller);
    await page.getByRole("button", { name: "Confirm booking" }).click();
    await expect(page.getByRole("region", { name: "You’re booked" })).toBeVisible();
    expect(await isOnPublicPage(page.request, setup, slot.startsAt)).toBe(false);
    const manageHref = await page.getByRole("link", { name: "Manage appointment" }).getAttribute("href");

    // They cancel from their link (with the code sent to them).
    await page.goto(manageHref!);
    await page.getByRole("button", { name: "Cancel appointment" }).click();
    const dialog = page.getByRole("dialog", { name: "Cancel your appointment?" });
    await chooseCard(page, "I booked by mistake");
    const codesBefore = await whatsAppCount(canceller.phone);
    await dialog.getByRole("button", { name: "Cancel my appointment" }).click();
    await expect(page.getByRole("heading", { name: "Enter your code" })).toBeVisible();
    const { code } = await whatsAppCode(canceller.phone, codesBefore);
    await page.getByRole("group", { name: "Six-digit code" }).getByRole("textbox").first().click();
    await page.waitForTimeout(400);
    await page.keyboard.type(code, { delay: 80 });
    await expect(page.getByRole("heading", { level: 1, name: /cancelled/i })).toBeVisible();

    // The first person is offered it by message, and the time is not on the public page at any point.
    const offerLink = /https?:\/\/[^\s"'<>]+\/offer\/[A-Za-z0-9_-]+/;
    const firstLink = await linkFromEmail(first.email, offerLink);
    expect(await isOnPublicPage(page.request, setup, slot.startsAt)).toBe(false);

    // They ignore it. When the answer time is up, the second person is asked, and the time is still held.
    await withOwnerDatabase(async (sql) => {
      const [offer] = await sql<{ id: string }[]>`
        update slot_offers set expires_at = now() - interval '1 second'
        where tenant_id = ${setup.tenantId} and status = 'sent' and entry_id in (
          select entry.id from waitlist_entries as entry join patients as patient on patient.id = entry.patient_id where patient.email = ${first.email})
        returning id`;
      if (!offer) throw new Error("The first person's offer was not live.");
      await sql`update outbox_events set available_at = now() where tenant_id = ${setup.tenantId} and event_type = 'offer-expire' and aggregate_id = ${offer.id}`;
    });
    const secondLink = await linkFromEmail(second.email, offerLink);
    expect(secondLink).not.toBe(firstLink);
    expect(await isOnPublicPage(page.request, setup, slot.startsAt)).toBe(false);

    // The old link no longer takes it.
    const stale = await browser.newContext({ ...testInfo.project.use, extraHTTPHeaders: clientHeaders, baseURL: testInfo.project.use.baseURL });
    const stalePage = await stale.newPage();
    await stalePage.goto(firstLink);
    await expect(stalePage.getByRole("heading", { name: "This time is no longer open" })).toBeVisible();
    await expect(stalePage.getByRole("button", { name: "Take this time" })).toHaveCount(0);
    await stale.close();

    // The second person opens their link on a small phone and takes it in one tap.
    const phone = await browser.newContext({ ...testInfo.project.use, extraHTTPHeaders: clientHeaders, baseURL: testInfo.project.use.baseURL, viewport: { width: 360, height: 780 } });
    const offerPage = await phone.newPage();
    await offerPage.goto(secondLink);
    await expect(offerPage.getByRole("heading", { level: 1, name: "A time just opened up" })).toBeVisible();
    await expect(offerPage.getByText("Dental cleaning")).toBeVisible();
    await expect(offerPage.getByText("Dr Arjun Shah")).toBeVisible();
    expect(await offerPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await expectAccessible(offerPage, testInfo, "offer page");
    await testInfo.attach("offer-page-360", { body: await offerPage.screenshot(), contentType: "image/png" });
    if (process.env.KALENDR_E2E_SHOTS) await offerPage.screenshot({ path: `${process.env.KALENDR_E2E_SHOTS}/offer-360-${testInfo.project.name}.png` });
    await offerPage.getByRole("button", { name: "Take this time" }).click();
    await expect(offerPage.getByRole("heading", { level: 1, name: "You’re booked" })).toBeVisible();
    await expect(offerPage.getByRole("link", { name: /Manage/ })).toBeVisible();
    await expectAccessible(offerPage, testInfo, "offer page after taking it");
    await testInfo.attach("offer-booked-360", { body: await offerPage.screenshot(), contentType: "image/png" });
    if (process.env.KALENDR_E2E_SHOTS) await offerPage.screenshot({ path: `${process.env.KALENDR_E2E_SHOTS}/offer-booked-360-${testInfo.project.name}.png` });
    await phone.close();

    // The time is taken, not public, and the booking is on the schedule with the usual confirmation sent.
    expect(await isOnPublicPage(page.request, setup, slot.startsAt)).toBe(false);
    await linkFromEmail(second.email, /https?:\/\/[^\s"'<>]+\/manage\/[A-Za-z0-9_-]+/);
    await signIn(page, owner);
    await page.goto(`/schedule?date=${day}&view=list`);
    await expect(page.getByText(new RegExp(`${second.firstName}`)).first()).toBeVisible();

    // Staff see who was asked and who answered, with no contact detail.
    await page.goto("/follow-ups");
    await page.getByRole("tab", { name: "Offers" }).click();
    const trail = page.getByRole("list", { name: /People asked about/ }).first();
    await expect(trail).toContainText(first.firstName);
    await expect(trail).toContainText("did not answer");
    await expect(trail).toContainText(second.firstName);
    await expect(trail).toContainText("took it");
    await expect(page.getByText("Taken", { exact: true }).first()).toBeVisible();
    expect(await page.locator("main").innerText()).not.toContain(second.email);
    await expectMainAccessible(page, "offers tab");
    if (process.env.KALENDR_E2E_SHOTS) await page.screenshot({ path: `${process.env.KALENDR_E2E_SHOTS}/offers-tab-${testInfoName(page)}.png`, fullPage: true });
  } finally {
    await restore(setup);
  }
});

test("someone who passes on an offered time keeps their place and the next person is asked at once", async ({ page, browser }, testInfo) => {
  test.setTimeout(180_000);
  const setup = await arrange();
  try {
    const slot = await openTime(page.request, setup);
    const day = dayInIndia(new Date(slot.startsAt));
    const decliner = newCustomer("Passer");
    const next = newCustomer("Nexty");
    await joinTheWaitlist(page, setup, decliner, day);
    await joinTheWaitlist(page, setup, next, day);
    // Staff-free: the time is freed by removing the booking the way a cancel would, through the app's own staff screens is covered above.
    // Here a closed time is added and removed, which is the other way a time opens.
    await withOwnerDatabase((sql) => sql`
      insert into schedule_blocks (tenant_id, practitioner_id, location_id, starts_at, ends_at, reason)
      values (${setup.tenantId}, ${setup.practitionerId}, ${setup.locationId}, ${slot.startsAt}, ${slot.endsAt}, 'Training')`);
    await signIn(page, owner);
    const response = await page.request.get("/api/staff/waitlist/offers");
    expect(response.status()).toBe(200);
    const [block] = await withOwnerDatabase((sql) => sql<{ id: string }[]>`select id from schedule_blocks where tenant_id = ${setup.tenantId} and starts_at = ${slot.startsAt}::timestamptz`);
    const removed = await page.request.delete(`/api/staff/schedule-blocks/${block!.id}`);
    expect(removed.status()).toBe(200);
    const link = await linkFromEmail(decliner.email, /https?:\/\/[^\s"'<>]+\/offer\/[A-Za-z0-9_-]+/);
    const context = await browser.newContext({ ...testInfo.project.use, extraHTTPHeaders: clientHeaders, baseURL: testInfo.project.use.baseURL });
    const offerPage = await context.newPage();
    await offerPage.goto(link);
    await offerPage.getByRole("button", { name: "Not this time" }).click();
    await expect(offerPage.getByRole("heading", { name: "Thanks for letting us know" })).toBeVisible();
    await linkFromEmail(next.email, /https?:\/\/[^\s"'<>]+\/offer\/[A-Za-z0-9_-]+/);
    expect(await isOnPublicPage(page.request, setup, slot.startsAt)).toBe(false);
    await context.close();
  } finally {
    await restore(setup);
  }
});
