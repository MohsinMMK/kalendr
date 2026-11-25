import type { ChildProcess } from "node:child_process";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { startWorker } from "./support/worker";
import { newCustomer, signIn, withOwnerDatabase } from "./support/journey";

// The one message for the whole series goes out through the worker to the capture server, never a real provider.
let worker: ChildProcess | undefined;
/** Gives back the times this journey took, so a run that stopped half way cannot make the next one clash with it. */
async function tidy(): Promise<void> {
  await withOwnerDatabase(async (sql) => {
    await sql`delete from schedule_blocks where reason = 'Series e2e closure'`;
    const open = sql`select id from appointments where status in ('booked', 'requested') and series_id is not null
      and patient_id in (select id from patients where first_name = 'Repeater')`;
    await sql`update resource_reservations set state = 'released', updated_at = now() where appointment_id in (${open})`;
    await sql`update appointments set status = 'cancelled', cancelled_at = now(), version = version + 1 where id in (${open})`;
  });
}
test.beforeAll(async () => {
  worker = startWorker();
  await tidy();
});
test.afterAll(async () => {
  worker?.kill("SIGTERM");
  await tidy();
});

const owner = "kalendr.owner@example.com";
const slug = "lotus-dental";
const captureUrl = process.env.KALENDR_CAPTURE_URL ?? "http://127.0.0.1:3199";

/**
 * The page's main content only: the clinic shell's own markup (its "Today" count badge, alerts bell and needs-attention button) is not this
 * feature's and has its own findings. Everything this feature draws is inside main or a dialog.
 */
async function expectAccessible(page: Page, testInfo: TestInfo, label: string): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"), undefined, { timeout: 5_000 }).catch(() => {});
  const dialogOpen = (await page.locator('[data-slot="dialog-popup"][data-open]').count()) > 0;
  const results = await new AxeBuilder({ page }).include(dialogOpen ? '[data-slot="dialog-popup"][data-open]' : "main").exclude('button[aria-label^="Notifications"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const blocking = results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
  if (results.violations.length > 0) await testInfo.attach(`axe-${label}`, { body: JSON.stringify(results.violations, null, 2), contentType: "application/json" });
  expect(blocking.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`), `serious accessibility findings on ${label}`).toEqual([]);
}

async function emailsTo(address: string): Promise<Array<{ subject: string; text: string }>> {
  const response = await fetch(`${captureUrl}/messages?to=${encodeURIComponent(address)}`);
  return (await response.json()) as Array<{ subject: string; text: string }>;
}

/** The instant a row of the checklist reads, such as "Tue, 8 Dec 2026, 10:00 am", in India time. */
function instantOf(text: string): Date {
  const match = /(\d{1,2}) (\w{3}),? (\d{4}),? (\d{1,2}):(\d{2}) (am|pm)/i.exec(text);
  if (!match) throw new Error(`Cannot read the time in "${text}"`);
  const [, day, month, year, hour, minute, meridiem] = match;
  const hours = (Number(hour) % 12) + (meridiem!.toLowerCase() === "pm" ? 12 : 0);
  return new Date(`${day} ${month} ${year} ${String(hours).padStart(2, "0")}:${minute} +05:30`);
}

async function chooseFirstOpening(page: Page): Promise<void> {
  await page.getByRole("heading", { level: 1, name: "Choose an opening" }).waitFor();
  await page.getByRole("combobox", { name: "Service" }).click();
  await page.getByRole("option", { name: "Dental consultation · 30 min" }).click();
  await page.getByRole("combobox", { name: /^(Practitioner|Doctor|Dentist|Provider|Person)$/ }).click();
  await page.getByRole("option", { name: "Dr Arjun Shah" }).click();
  await page.getByRole("group", { name: "Show openings as" }).getByText("List").click();
  const openings = page.getByRole("region", { name: "Matching openings" }).getByRole("button", { name: /\bDr / });
  for (let day = 0; day < 10 && (await openings.count()) === 0; day += 1) {
    await page.getByRole("button", { name: "Next opening date" }).click();
    await page.getByText("Loading compatible openings…").waitFor({ state: "detached" });
  }
  await openings.first().click();
}

test("staff books a repeating series, settles a clash, moves this and following, then cancels the rest", async ({ page }, testInfo) => {
  const customer = newCustomer("Repeater");
  await signIn(page, owner, undefined, "/appointments/new");
  await page.getByRole("group", { name: "Patient type" }).getByText("New patient").click();
  await page.getByRole("textbox", { name: "First name" }).fill(customer.firstName);
  await page.getByRole("textbox", { name: "Last name" }).fill(customer.lastName);
  await page.getByRole("textbox", { name: "Phone" }).fill(customer.phone);
  await page.getByRole("textbox", { name: "Email" }).fill(customer.email);
  await page.getByRole("button", { name: "Choose service and time" }).click();
  await chooseFirstOpening(page);

  // The Repeat control: a rich dropdown and a sentence saying what will be booked.
  await expect(page.getByRole("heading", { name: "Repeat", exact: true })).toBeVisible();
  await page.getByRole("combobox", { name: /Repeat this/ }).click();
  await page.getByRole("option", { name: "Every week, on chosen days" }).click();
  await page.getByRole("spinbutton", { name: "How many times" }).fill("4");
  await expect(page.getByRole("status").filter({ hasText: /^Every .* at .* for 4 weeks$/ })).toBeVisible();
  await expectAccessible(page, testInfo, "repeat control");
  await page.getByRole("button", { name: /^Check appointments$/ }).click();

  // Every date is checked and shown before anything is saved.
  const list = page.getByRole("list", { name: /Every .* in the series/ });
  await expect(list.getByRole("listitem")).toHaveCount(4);
  await expect(page.getByText("Every date is free.")).toBeVisible();
  await expectAccessible(page, testInfo, "series check");

  // Meanwhile someone closes the time of the third visit. Nothing is saved, and the list comes back with the clash.
  const thirdText = (await list.getByRole("listitem").nth(2).locator("p").first().innerText()).replace(/^\d+\s*/, "");
  const thirdStart = instantOf(thirdText);
  const blockId = await withOwnerDatabase(async (sql) => {
    const [row] = await sql<{ id: string }[]>`
      insert into schedule_blocks (tenant_id, practitioner_id, starts_at, ends_at, reason)
      select tenant.id, person.id, ${thirdStart}, ${new Date(thirdStart.getTime() + 30 * 60_000)}, 'Series e2e closure'
      from tenants as tenant join practitioners as person on person.tenant_id = tenant.id and person.name = 'Dr Arjun Shah'
      where tenant.slug = ${slug} returning id`;
    return row!.id;
  });
  await page.getByRole("button", { name: "Book 4 appointments" }).click();
  await expect(page.getByText(/nothing was booked/)).toBeVisible();
  const before = await withOwnerDatabase((sql) => sql<{ count: number }[]>`
    select count(*)::int as count from appointments join patients on patients.id = appointments.patient_id and patients.tenant_id = appointments.tenant_id
    where patients.email = ${customer.email}`);
  expect(before[0]!.count).toBe(0);
  const choice = page.getByRole("combobox", { name: /What to do about/ });
  await expect(choice).toHaveCount(1);
  await choice.click();
  const alternatives = page.getByRole("option", { name: /^Move to / });
  if (await alternatives.count()) await alternatives.first().click(); else await page.getByRole("option", { name: "Skip this one" }).click();
  await page.getByRole("button", { name: /^Book \d+ appointments?$/ }).click();
  await expect(page.getByRole("heading", { name: /\d+ appointments? booked/ })).toBeVisible();
  await withOwnerDatabase((sql) => sql`delete from schedule_blocks where id = ${blockId}`);

  const [series] = await withOwnerDatabase((sql) => sql<{ id: string; visits: number }[]>`
    select series.id, (select count(*)::int from appointments where series_id = series.id) as visits
    from appointment_series as series join patients on patients.id = series.patient_id and patients.tenant_id = series.tenant_id
    where patients.email = ${customer.email}`);
  expect(series!.visits).toBeGreaterThanOrEqual(3);
  const total = series!.visits;

  // One confirmation for the whole series, listing the dates; not one per visit.
  await expect.poll(async () => (await emailsTo(customer.email)).length, { timeout: 30_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(4_000);
  const emails = await emailsTo(customer.email);
  const confirmations = emails.filter((email) => new RegExp(`${total} .* booked`).test(email.subject));
  expect(confirmations).toHaveLength(1);
  expect((confirmations[0]!.text.match(/\b20\d\d\b/g) ?? []).length).toBeGreaterThanOrEqual(total);
  // No booking confirmation for any single visit. A reminder for a visit that is close is a normal per-visit message.
  expect(emails.filter((email) => /is booked$/.test(email.subject))).toEqual([]);

  // The series screen lists every visit with its status.
  await page.getByRole("link", { name: /See every/ }).click();
  const visits = page.getByRole("list", { name: /Every .*/ }).getByRole("listitem");
  await expect(visits).toHaveCount(total);
  await expect(page.getByText("Booked", { exact: true }).first()).toBeVisible();
  await expectAccessible(page, testInfo, "series screen");

  // A small repeat mark shows on the schedule for the visits of a series.
  const seriesUrl = page.url();
  const [firstVisit] = await withOwnerDatabase((sql) => sql<{ starts_at: Date }[]>`
    select starts_at from appointments where series_id = ${series!.id} order by series_index limit 1`);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(firstVisit!.starts_at);
  await page.goto(`/schedule?date=${day}&view=list`);
  await expect(page.getByRole("img", { name: "Repeating" }).first()).toBeVisible();
  await page.goto(seriesUrl);
  await expect(visits).toHaveCount(total);

  // Move this and following: open the second visit, choose the scope, change the time.
  await visits.nth(1).getByRole("link").click();
  await expect(page.getByRole("heading", { name: /^Repeating / })).toBeVisible();
  await page.getByRole("button", { name: "Reschedule" }).click();
  const dialog = page.locator('[data-slot="dialog-popup"][data-open]');
  await dialog.getByRole("radio", { name: /This and the ones after it/ }).click();
  await expectAccessible(page, testInfo, "scope dialog");
  await dialog.getByRole("button", { name: /Continue/ }).click();
  await dialog.getByLabel("Time").fill("15:00");
  await dialog.getByRole("button", { name: "Check the dates" }).click();
  await expect(dialog.getByRole("list", { name: /Every .* in the series/ })).toBeVisible();
  for (let guard = 0; guard < 6 && (await dialog.getByRole("combobox", { name: /What to do about/ }).count()) > 0; guard += 1) {
    await dialog.getByRole("combobox", { name: /What to do about/ }).first().click();
    await page.getByRole("option", { name: "Skip this one" }).click();
  }
  await dialog.getByRole("button", { name: /^Move \d+ appointments?$/ }).click();
  await expect(dialog).toBeHidden();

  const after = await withOwnerDatabase((sql) => sql<{ status: string; series_id: string; series_index: number }[]>`
    select status, series_id, series_index from appointments where series_id = ${series!.id} order by series_index`);
  expect(after[0]!.status).toBe("booked"); // the first visit was left alone
  expect(after.slice(1).every((row) => row.status === "cancelled")).toBe(true);
  const [continued] = await withOwnerDatabase((sql) => sql<{ id: string; visits: number }[]>`
    select id, (select count(*)::int from appointments where series_id = appointment_series.id and status = 'booked') as visits
    from appointment_series where continued_from_id = ${series!.id}`);
  expect(continued!.visits).toBeGreaterThan(0);

  // Cancel all that are still ahead from the new part.
  await page.goto(`/appointments/series/${continued!.id}`);
  const open = page.getByRole("list", { name: /Every .*/ }).getByRole("listitem").first();
  await open.getByRole("link").click();
  await page.getByRole("button", { name: /^Cancel appointment$/ }).click();
  const cancelDialog = page.locator('[data-slot="dialog-popup"][data-open]');
  await cancelDialog.getByRole("radio", { name: /All that are still ahead/ }).click();
  await cancelDialog.getByRole("button", { name: /Continue/ }).click();
  await cancelDialog.getByRole("button", { name: /^Cancel \d+ appointments?$/ }).click();
  await expect(cancelDialog).toBeHidden();
  const left = await withOwnerDatabase((sql) => sql<{ count: number }[]>`select count(*)::int as count from appointments where series_id = ${continued!.id} and status = 'booked'`);
  expect(left[0]!.count).toBe(0);
  const mine = await withOwnerDatabase((sql) => sql<{ status: string }[]>`select status from appointment_series where id = ${continued!.id}`);
  expect(mine[0]!.status).toBe("cancelled");
  await expectAccessible(page, testInfo, "after cancelling the series");
});
