import { expect, test } from "@playwright/test";

import { chooseBookingSlot, fillCustomerDetails, newCustomer, newPage, openTimeStep, unique, withOwnerDatabase } from "./support/journey";

// The guarantee CI protects above all: two people choosing the same time never both get it.
// A picked time is held for five minutes, so the second customer is told at once; and when two requests
// reach the database together without a hold, exactly one wins.
test("two customers racing for one time: only the first is booked", async ({ browser, request }, testInfo) => {
  const first = await newPage(browser, testInfo);
  const second = await newPage(browser, testInfo);
  const slot = { slug: "lotus-dental", service: "Dental cleaning", practitioner: "Dr Kavya Rao" };

  // Both customers are looking at the same openings when the first one picks a time.
  const secondTimes = await openTimeStep(second, slot);
  await expect(secondTimes.first()).toBeVisible();
  const time = (await secondTimes.first().innerText()).split("\n")[0]!.trim();
  await chooseBookingSlot(first, { ...slot, time });
  await fillCustomerDetails(first, newCustomer("Kiran"));

  // The second customer taps the same time a moment too late: the time is held, and they are told so.
  await secondTimes.filter({ hasText: time }).first().click();
  await expect(second.getByText("Someone just took that time")).toBeVisible();

  await first.getByRole("button", { name: "Confirm booking" }).click();
  await expect(first.getByRole("region", { name: "You’re booked" })).toBeVisible();
  await expect(second.getByRole("region", { name: "You’re booked" })).toHaveCount(0);

  // With no hold in the way, two requests for one time reach the database together: one booking, one refusal.
  const ids = await withOwnerDatabase((sql) => sql<{ location_id: string; service_id: string }[]>`
    select l.id as location_id, s.id as service_id from locations l, services s, tenants t
    where t.slug = 'lotus-dental' and l.tenant_id = t.id and s.tenant_id = t.id and s.name = 'Dental cleaning' limit 1`);
  const from = new Date(Date.now() + 6 * 86_400_000);
  const listing = await request.get("/api/public/availability?" + new URLSearchParams({
    clinicSlug: "lotus-dental", locationId: ids[0]!.location_id, serviceId: ids[0]!.service_id, practitionerId: "first_available",
    from: from.toISOString(), to: new Date(from.getTime() + 86_400_000).toISOString(),
  }));
  const target = (await listing.json()).data.slots[0] as { id: string; startsAt: string; endsAt: string; practitionerId: string };
  const race = await Promise.all([1, 2].map((index) => request.post("/api/public/appointments", {
    headers: { "Idempotency-Key": crypto.randomUUID(), "x-forwarded-for": `192.0.2.${testInfo.project.name === "phone" ? 150 + index : 50 + index}` },
    data: {
      clinicSlug: "lotus-dental", patientType: "new", bookingFor: "self", locationId: ids[0]!.location_id, serviceId: ids[0]!.service_id, practitionerId: target.practitionerId,
      slotId: target.id, startsAt: target.startsAt, endsAt: target.endsAt, firstName: "Race", lastName: `Runner${unique()}`, phone: `+91 98450 ${String(10_000 + index * 7_001 + Math.floor(Math.random() * 900))}`,
      email: `race.${index}.${unique()}@example.com`, preferredChannel: "email", acceptedPrivacyNotice: true, messagingConsent: false, origin: { channel: "hosted" },
    },
  })));
  expect(race.map((response) => response.status()).sort()).toEqual([201, 409]);

  // And in the database: no practitioner holds two live appointments that overlap. A declined or expired request, and a booking
  // waiting for a new time, hold no time (their reservation is released), so other journeys' leftovers do not count.
  const overlaps = await withOwnerDatabase((sql) => sql`
    SELECT a.id
    FROM appointments a
    JOIN appointments b
      ON b.tenant_id = a.tenant_id
     AND b.practitioner_id = a.practitioner_id
     AND b.id > a.id
     AND tstzrange(b.starts_at, b.ends_at) && tstzrange(a.starts_at, a.ends_at)
    WHERE a.status NOT IN ('cancelled', 'no_show', 'entered_in_error', 'declined', 'expired', 'reschedule_requested')
      AND b.status NOT IN ('cancelled', 'no_show', 'entered_in_error', 'declined', 'expired', 'reschedule_requested')
  `);
  expect(overlaps).toHaveLength(0);

  await first.context().close();
  await second.context().close();
});
