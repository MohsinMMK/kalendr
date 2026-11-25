import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { newCustomer, signIn, withOwnerDatabase } from "./support/journey";

const owner = "kalendr.owner@example.com";
const slug = "lotus-dental";

/** The Bookings list only: the clinic shell's own markup (alerts bell, needs-attention button) is not this tab's. */
async function expectAccessible(page: Page, testInfo: TestInfo, label: string): Promise<void> {
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"), undefined, { timeout: 5_000 }).catch(() => {});
  const dialogOpen = (await page.locator('[data-slot="dialog-popup"][data-open]').count()) > 0;
  const results = await new AxeBuilder({ page }).include(dialogOpen ? '[data-slot="dialog-popup"][data-open]' : "main").exclude('button[aria-label^="Notifications"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  const blocking = results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
  if (results.violations.length > 0) await testInfo.attach(`axe-${label}`, { body: JSON.stringify(results.violations, null, 2), contentType: "application/json" });
  expect(blocking.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`), `serious accessibility findings on ${label}`).toEqual([]);
}

/** Gives back every time this journey's customers hold, so a run that stopped half way cannot make the next one clash. */
async function tidy(): Promise<void> {
  await withOwnerDatabase(async (sql) => {
    const open = sql`select id from appointments where status in ('booked', 'requested') and series_id is not null
      and patient_id in (select id from patients where first_name = 'Listed')`;
    await sql`update resource_reservations set state = 'released', updated_at = now() where appointment_id in (${open})`;
    await sql`update appointments set status = 'cancelled', cancelled_at = now(), version = version + 1 where id in (${open})`;
    await sql`update appointment_series set status = 'cancelled', version = version + 1 where status = 'active' and patient_id in (select id from patients where first_name = 'Listed')`;
  });
}
test.beforeAll(tidy);
test.afterAll(tidy);

interface Ids { locationId: string; serviceId: string; practitionerId: string }

/** Books a four-week series through the staff route (the same one the New appointment screen uses), at the first time the engine says is free. */
async function bookSeries(page: Page, customer: ReturnType<typeof newCustomer>, ids: Ids): Promise<string> {
  return page.evaluate(async ({ customer: person, ids: place, slug: clinicSlug }) => {
    const rule = { frequency: "weekly", interval: 1, weekdays: [], end: { kind: "count", count: 4 } };
    const post = async (path: string, body: unknown) => {
      const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify(body) });
      return { ok: response.ok, json: (await response.json()) as { data?: Record<string, unknown> } };
    };
    const day = (offset: number) => {
      const date = new Date(Date.now() + offset * 86_400_000 + 5.5 * 3_600_000);
      return date.toISOString().slice(0, 10);
    };
    for (let offset = 21; offset < 120; offset += 1) {
      for (const hour of ["09", "10", "11", "14", "15", "16"]) {
        const booking = {
          clinicSlug, ...place, startsAt: `${day(offset)}T${hour}:00:00+05:30`, source: "phone",
          newPatient: { firstName: person.firstName, lastName: person.lastName, phone: person.phone, email: person.email, preferredChannel: "email", isDependent: false, messagingConsent: false },
        };
        const preview = await post("/api/staff/series/preview", { booking, rule });
        if (!preview.ok || preview.json.data?.clashCount !== 0) continue;
        const saved = await post("/api/staff/series", { booking, rule, resolutions: [] });
        if (saved.ok && saved.json.data?.saved === true) return String(saved.json.data.seriesId);
      }
    }
    throw new Error("No free time for a four-week series");
  }, { customer, ids, slug });
}

test("staff finds a repeating series on the Bookings list, opens it, and cancels what is left", async ({ page }, testInfo) => {
  const phone = testInfo.project.name === "phone";
  const customer = { ...newCustomer("Listed") };
  const ids = await withOwnerDatabase(async (sql) => {
    const [row] = await sql<{ location_id: string; service_id: string; practitioner_id: string }[]>`
      select location.id as location_id, service.id as service_id, person.id as practitioner_id
      from tenants as tenant
      join locations as location on location.tenant_id = tenant.id
      join services as service on service.tenant_id = tenant.id and service.name = 'Dental consultation'
      join practitioners as person on person.tenant_id = tenant.id and person.name = 'Dr Arjun Shah'
      where tenant.slug = ${slug} order by location.created_at limit 1`;
    return { locationId: row!.location_id, serviceId: row!.service_id, practitionerId: row!.practitioner_id } satisfies Ids;
  });

  await signIn(page, owner, undefined, "/bookings");
  const seriesId = await bookSeries(page, customer, ids);

  // The fifth tab, with its count, and the series in it.
  await page.goto("/bookings");
  const tab = page.getByRole("tab", { name: /^Repeating/ });
  await expect(tab).toBeVisible();
  await tab.click();
  await expect(page).toHaveURL(/tab=repeating/);
  await page.getByRole("button", { name: /^Filter/ }).click();
  await page.getByPlaceholder("Name or phone").fill(customer.lastName);
  await expect(page).toHaveURL(/q=/); // the search is sent once typing pauses
  await page.keyboard.press("Escape");
  const row = page.getByRole(phone ? "listitem" : "row").filter({ hasText: customer.lastName });
  await expect(row).toHaveCount(1);
  await expect(row.getByText(/Every .* for 4 weeks/)).toBeVisible();
  await expect(row.getByText(/0 of 4/)).toBeVisible();
  await expect(row.getByText("Running")).toBeVisible();
  await expect(page.getByRole("tab", { name: /^Repeating\s*\d+/ })).toBeVisible();
  await expectAccessible(page, testInfo, `repeating tab ${phone ? "phone" : "desktop"}`);

  if (phone) {
    // At 360 px the cards fit without sideways scrolling, and a screenshot is attached for the report.
    await page.setViewportSize({ width: 360, height: 780 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await testInfo.attach("repeating-tab-360", { body: await page.screenshot(), contentType: "image/png" });
  }

  // The link in the row is the way into the series screen, and its back link returns to this tab.
  await row.getByRole("link", { name: new RegExp(customer.firstName) }).click();
  await expect(page).toHaveURL(new RegExp(`/appointments/series/${seriesId}`));
  await expect(page.getByRole("list", { name: /Every .*/ }).getByRole("listitem")).toHaveCount(4);
  await page.getByRole("link", { name: /Back to Bookings/ }).click();
  await expect(page).toHaveURL(/tab=repeating/);
  await page.getByRole("button", { name: /^Filter/ }).click();
  await page.getByPlaceholder("Name or phone").fill(customer.lastName);
  await expect(page).toHaveURL(/q=/); // the search is sent once typing pauses
  await page.keyboard.press("Escape");
  await expect(row).toHaveCount(1);

  // Cancelling goes through the same which-visits question, then the row leaves the running list.
  await row.getByRole("button", { name: /^Actions for/ }).click();
  await page.getByRole("menuitem", { name: "Cancel…" }).click();
  const dialog = page.locator('[data-slot="dialog-popup"][data-open]');
  await dialog.getByRole("radio", { name: /All that are still ahead/ }).click();
  await expectAccessible(page, testInfo, "series scope dialog from the list");
  await dialog.getByRole("button", { name: /Continue/ }).click();
  await dialog.getByRole("button", { name: /^Cancel 4 appointments$/ }).click();
  await expect(dialog).toBeHidden();
  await expect(row).toHaveCount(0);
  const left = await withOwnerDatabase((sql) => sql<{ booked: number; cancelled: number }[]>`
    select count(*) filter (where status = 'booked')::int as booked, count(*) filter (where status = 'cancelled')::int as cancelled
    from appointments where series_id = ${seriesId}`);
  expect(left[0]).toEqual({ booked: 0, cancelled: 4 });

  // Asking for cancelled series shows it, with its status and nothing ahead.
  await page.getByRole("button", { name: /^Filter/ }).click();
  await page.getByRole("combobox", { name: "Status" }).click();
  await page.getByRole("option", { name: "Cancelled" }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(row).toHaveCount(1);
  await expect(row.getByText("Cancelled")).toBeVisible();
  await expectAccessible(page, testInfo, `repeating tab, cancelled ${phone ? "phone" : "desktop"}`);
});
