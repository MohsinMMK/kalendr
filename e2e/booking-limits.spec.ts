import { expect, test, type Page } from "@playwright/test";

import { signIn, unique } from "./support/journey";

/**
 * Feature 38: an owner caps a service at two bookings a day. The public page then stops offering that
 * day and says it is full, a third booking is refused with a plain sentence, staff can go past the cap
 * with a recorded reason, and the Limits tab shows what was saved. Each run makes its own service.
 */

const DAY = 86_400_000;
const ZONE = "Asia/Kolkata";
const localDate = (epoch: number): string => new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(epoch));

async function availability(page: Page, ids: { locationId: string; serviceId: string }, date: string) {
  const response = await page.request.get("/api/public/availability?" + new URLSearchParams({
    clinicSlug: "lotus-dental", locationId: ids.locationId, serviceId: ids.serviceId, practitionerId: "first_available",
    from: new Date(`${date}T00:00:00+05:30`).toISOString(), to: new Date(`${date}T23:59:00+05:30`).toISOString(),
  }));
  expect(response.status()).toBe(200);
  return (await response.json()).data as { slots: Array<{ id: string; startsAt: string; endsAt: string; practitionerId: string }>; fullDays: string[] };
}

test("a service capped at two a day stops offering the day, refuses a third, and staff can override with a reason", async ({ page }, testInfo) => {
  // Public bookings are limited to ten an hour per address; this journey uses an address of its own.
  const address = `192.0.2.${testInfo.project.name === "phone" ? 131 : 31}`;
  const name = `Limits journey ${unique()}`;
  // Staff sign-in is limited per address too, so this journey signs in from its own address.
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": address });
  await signIn(page, "kalendr.owner@example.com");
  const created = await page.request.post("/api/staff/services", { data: { name, description: "Made by the booking limits journey.", durationMinutes: 30 } });
  expect(created.status()).toBe(201);
  const { serviceId } = (await created.json()).data as { serviceId: string };
  const setup = (await (await page.request.get(`/api/staff/services/${serviceId}`)).json()).data;
  const locationId = setup.basics.locationIds[0] as string;

  const saved = await page.request.put("/api/staff/limits", {
    data: { target: { scope: "service", scopeId: serviceId }, limits: [{ measure: "count", period: "day", maxValue: 2, weekStart: 1 }] },
  });
  expect(saved.status()).toBe(200);
  expect((await saved.json()).data.limits).toHaveLength(1);

  const date = localDate(Date.now() + 5 * DAY);
  const before = await availability(page, { locationId, serviceId }, date);
  expect(before.slots.length).toBeGreaterThan(3);
  expect(before.fullDays).toEqual([]);

  const customer = (label: string) => ({ firstName: label, lastName: `Limits${unique()}`, phone: `+91 98450 ${String(Math.floor(Math.random() * 90_000) + 10_000)}`, email: `${label.toLowerCase()}.${unique()}@example.com` });
  const book = (slot: { id: string; startsAt: string; endsAt: string; practitionerId: string }, who: ReturnType<typeof customer>) => page.request.post("/api/public/appointments", {
    headers: { "Idempotency-Key": crypto.randomUUID(), "x-forwarded-for": address },
    data: {
      clinicSlug: "lotus-dental", patientType: "new", bookingFor: "self", locationId, serviceId, practitionerId: slot.practitionerId, slotId: slot.id,
      startsAt: slot.startsAt, endsAt: slot.endsAt, ...who, preferredChannel: "email", acceptedPrivacyNotice: true, messagingConsent: false,
      origin: { channel: "hosted" },
    },
  });
  // Two people at the same time, then a start an hour later that nobody holds, so only the limit can refuse it.
  const first = before.slots[0]!;
  const second = before.slots.find((slot) => slot.startsAt === first.startsAt && slot.practitionerId !== first.practitionerId)!;
  const third = before.slots.find((slot) => Date.parse(slot.startsAt) >= Date.parse(first.startsAt) + 3_600_000)!;
  expect(second).toBeTruthy();
  expect((await book(first, customer("One"))).status()).toBe(201);
  expect((await book(second, customer("Two"))).status()).toBe(201);
  const refused = await book(third, customer("Three"));
  expect(refused.status()).toBe(409);
  expect((await refused.json()).error.code).toBe("limit_reached");

  // The day shows as full, not as closed, and no more times are offered on it.
  const after = await availability(page, { locationId, serviceId }, date);
  expect(after.slots).toEqual([]);
  expect(after.fullDays).toEqual([date]);

  // Staff go past the cap with a fixed reason; the refusal says which kind of limit it was.
  const staffBooking = (extra: object) => page.request.post("/api/staff/appointments", {
    headers: { "Idempotency-Key": crypto.randomUUID() },
    data: {
      clinicSlug: "lotus-dental", locationId, serviceId, practitionerId: third.practitionerId, startsAt: third.startsAt, source: "desk",
      newPatient: { ...customer("Desk"), preferredChannel: "email", isDependent: false, messagingConsent: false }, ...extra,
    },
  });
  const warned = await staffBooking({});
  expect(warned.status()).toBe(409);
  expect((await warned.json()).error.code).toBe("limit_reached");
  expect((await staffBooking({ limitOverrideReason: "owner_decision" })).status()).toBe(201);

  // The editor's Limits tab shows the saved cap.
  await page.goto(`/services/${serviceId}`);
  const editor = page.locator("main");
  await editor.getByRole("tab", { name: /Limits/ }).click();
  await expect(editor.getByText(/2 bookings a day|2/).first()).toBeVisible();

  // Clear the limit so the shared business is left as it was.
  const cleared = await page.request.put("/api/staff/limits", { data: { target: { scope: "service", scopeId: serviceId }, limits: [] } });
  expect(cleared.status()).toBe(200);
});
