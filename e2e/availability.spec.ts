import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { signIn, unique, withOwnerDatabase } from "./support/journey";

/**
 * Feature 37: a person gets two ranges a day and a closed date, the public openings follow, and
 * "Why no slot?" explains the gap on screen. Each run makes its own person so the shared sample
 * team keeps its hours, and switches them off at the end.
 */

const DAY = 86_400_000;
const ZONE = "Asia/Kolkata";
const localDate = (epoch: number): string => new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(epoch));

async function nextMonday(): Promise<string> {
  for (let ahead = 3; ahead < 12; ahead += 1) {
    const date = localDate(Date.now() + ahead * DAY);
    if (new Date(`${date}T12:00:00Z`).getUTCDay() === 1) return date;
  }
  throw new Error("No Monday in range");
}

async function openings(page: Page, ids: { locationId: string; serviceId: string; practitionerId: string }, date: string): Promise<string[]> {
  const response = await page.request.get("/api/public/availability?" + new URLSearchParams({
    clinicSlug: "lotus-dental", locationId: ids.locationId, serviceId: ids.serviceId, practitionerId: ids.practitionerId,
    from: new Date(`${date}T00:00:00+05:30`).toISOString(), to: new Date(`${date}T23:59:00+05:30`).toISOString(),
  }));
  expect(response.status()).toBe(200);
  const slots = (await response.json()).data.slots as Array<{ startsAt: string }>;
  return slots.map((slot) => new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(slot.startsAt)));
}

test("two ranges a day and a closed date shape the openings, and Why no slot explains the gap", async ({ page }) => {
  const name = `Journey Person ${unique()}`;
  await signIn(page, "kalendr.owner@example.com");
  const { locationId, serviceId } = await withOwnerDatabase(async (sql) => {
    const [row] = await sql<{ location_id: string; service_id: string }[]>`
      select l.id as location_id, s.id as service_id from locations l, services s, tenants t
      where t.slug = 'lotus-dental' and l.tenant_id = t.id and s.tenant_id = t.id and s.name = 'Dental consultation' limit 1`;
    if (!row) throw new Error("Seed the e2e database first.");
    return { location_id: row.location_id, service_id: row.service_id };
  }).then((row) => ({ locationId: row.location_id, serviceId: row.service_id }));

  const created = await page.request.post("/api/staff/team/practitioners", {
    data: {
      name, title: "Dentist", specialty: "Journeys", email: `journey.${unique()}@example.com`, locationIds: [locationId], serviceIds: [serviceId],
      hours: { days: [1, 2, 3, 4, 5, 6, 7], startsAtLocal: "09:00", endsAtLocal: "17:00" },
    },
  });
  expect(created.status()).toBe(201);
  const practitionerId = (await created.json()).data.practitionerId as string;
  const ids = { locationId, serviceId, practitionerId };
  try {
    const schedules = (await (await page.request.get(`/api/staff/availability/schedules?practitionerId=${practitionerId}`)).json()).data as Array<{ id: string; version: number; weekly: Record<string, Array<{ start: string; end: string }>> }>;
    const schedule = schedules[0]!;
    const monday = await nextMonday();
    const closed = localDate(Date.now() + 20 * DAY);

    // 9 to 1 and 3 to 7 on Mondays; one later date closed.
    const saved = await page.request.patch(`/api/staff/availability/schedules/${schedule.id}`, {
      data: { expectedVersion: schedule.version, weekly: { ...schedule.weekly, "1": [{ start: "09:00", end: "13:00" }, { start: "15:00", end: "19:00" }] }, overrides: [{ date: closed, ranges: null }] },
    });
    expect(saved.status()).toBe(200);
    // Saving with the old version again says someone else changed it.
    const stale = await page.request.patch(`/api/staff/availability/schedules/${schedule.id}`, { data: { expectedVersion: schedule.version, name: "Other name" } });
    expect(stale.status()).toBe(409);

    const mondaySlots = await openings(page, ids, monday);
    expect(mondaySlots).toContain("12:00");
    expect(mondaySlots).toContain("15:00");
    expect(mondaySlots.filter((time) => time >= "13:00" && time < "15:00")).toEqual([]);
    expect(await openings(page, ids, closed)).toEqual([]);
    expect((await openings(page, ids, localDate(new Date(`${closed}T12:00:00Z`).getTime() + DAY))).length).toBeGreaterThan(0);

    // The hours screen shows both ranges.
    await page.goto("/settings");
    await page.getByText("Hours", { exact: true }).first().click();
    await expect(page.getByText(name).first()).toBeVisible();

    // Why no slot? from the schedule page: pick the person and a service, and read the reasons.
    await page.goto("/schedule");
    await page.getByRole("button", { name: "More schedule actions" }).click();
    await page.getByRole("menuitem", { name: /Why no slot/ }).click();
    const sheet = page.getByRole("dialog", { name: /Why no slot/ });
    await expect(sheet).toBeVisible();
    await sheet.getByRole("combobox", { name: /Practitioner|Doctor|Provider|Person/ }).click();
    await page.getByRole("option", { name }).click();
    await sheet.getByRole("combobox", { name: /Appointment type|Service|Visit|Treatment/ }).click();
    await page.getByRole("option", { name: /Dental consultation/ }).click();
    await expect(sheet.getByRole("list", { name: /What happens on/ })).toBeVisible();
    await expect(sheet.getByText("Outside working hours").first()).toBeVisible();
    const scan = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(scan.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical").map((violation) => violation.id)).toEqual([]);
  } finally {
    await page.request.patch(`/api/staff/team/practitioners/${practitionerId}`, { data: { isActive: false } });
  }
});
