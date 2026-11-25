/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { PublicBookingInput } from "@/lib/contracts";
import { createAppointment, type BookingLinkContext } from "@/server/appointment-repository";
import { listCombinedAvailability } from "@/server/combined-availability";
import { createCombinedLink, createSpecialLink, listSpecialLinks, resolvePublicCombinedLink, resolvePublicSpecialLink, revokeSpecialLink } from "@/server/special-links";
import { describeScratch } from "@/server/testing/scratch-database";
import { createSchedulingFixture, plusMinutes, startIn, type SchedulingFixture } from "@/server/testing/scheduling-fixture";

const ownerUrl = process.env.KALENDR_TEST_OWNER_URL ?? "";
const book = (input: PublicBookingInput, link: BookingLinkContext = {}, key: string = randomUUID()) => createAppointment(input, key, key.replaceAll("-", ""), link);

async function tidy(fixture: SchedulingFixture, extraPractitioners: string[] = []): Promise<void> {
  await fixture.owner`update appointments set special_link_id = null where tenant_id = ${fixture.tenantId} and service_id = ${fixture.serviceId}`;
  await fixture.owner`delete from special_links where tenant_id = ${fixture.tenantId} and service_id = ${fixture.serviceId}`;
  await fixture.owner`delete from combined_links where tenant_id = ${fixture.tenantId} and service_id = ${fixture.serviceId}`;
  await fixture.cleanup();
  if (extraPractitioners.length > 0) {
    const sql = postgres(ownerUrl, { max: 1, prepare: false });
    for (const id of extraPractitioners) await sql`delete from practitioners where id = ${id}`;
    await sql.end();
  }
}

const slotAt = (fixture: SchedulingFixture, days: number, hour: number, email: string, extra: Partial<PublicBookingInput> = {}) => {
  const start = startIn(days, hour);
  return fixture.bookingInput(start, plusMinutes(start, 30), email, extra);
};

describeScratch("special links (feature 45)", () => {
  it("a single-use link books once, then shows as used; two at once give one booking", async () => {
    const fixture = await createSchedulingFixture(ownerUrl, { name: "Links" });
    try {
      const { token, id } = await createSpecialLink(fixture.context, fixture.serviceId, { label: "For Priya", kind: "single_use" });
      // The token is stored only as a hash.
      const [stored] = await fixture.owner<{ token_hash: string }[]>`select token_hash from special_links where id = ${id}`;
      expect(stored!.token_hash).not.toContain(token);
      expect(stored!.token_hash).toHaveLength(64);
      expect((await resolvePublicSpecialLink(token)).state).toBe("ok");

      const results = await Promise.allSettled([
        book(slotAt(fixture, 14, 10, "one@acme-corp.in"), { specialLinkToken: token }),
        book(slotAt(fixture, 14, 11, "two@acme-corp.in"), { specialLinkToken: token }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const refused = results.find((result) => result.status === "rejected");
      expect(refused).toMatchObject({ reason: { code: "special_link_unavailable", status: 410 } });
      const [row] = await fixture.owner<{ used_count: number }[]>`select used_count from special_links where id = ${id}`;
      expect(row!.used_count).toBe(1);

      // Opening it again shows the "already used" page state.
      expect((await resolvePublicSpecialLink(token)).state).toBe("unavailable");
      await expect(book(slotAt(fixture, 14, 12, "three@acme-corp.in"), { specialLinkToken: token })).rejects.toMatchObject({ code: "special_link_unavailable" });

      const listed = await listSpecialLinks(fixture.context, fixture.serviceId);
      expect(listed[0]).toMatchObject({ status: "used_up", usedCount: 1 });
      expect(listed[0]!.bookings).toHaveLength(1);
      // A link for another service, or one that is made up, books nothing.
      await expect(book(slotAt(fixture, 14, 13, "x@acme-corp.in"), { specialLinkToken: "a".repeat(43) })).rejects.toMatchObject({ code: "special_link_unavailable" });
    } finally {
      await tidy(fixture);
    }
  });

  it("limited and expiring links count in the transaction, and a failed booking gives the use back", async () => {
    const fixture = await createSchedulingFixture(ownerUrl, { name: "LinksLimit" });
    try {
      const limited = await createSpecialLink(fixture.context, fixture.serviceId, { label: "Two", kind: "limited", maxUses: 2 });
      const first = slotAt(fixture, 15, 10, "a@acme-corp.in");
      const key = randomUUID();
      const made = await book(first, { specialLinkToken: limited.token }, key);
      // The same request again (a retry) replays and does not spend a second use.
      const replay = await book(first, { specialLinkToken: limited.token }, key);
      expect(replay.appointmentId).toBe(made.appointmentId);
      expect((await fixture.owner<{ used_count: number }[]>`select used_count from special_links where id = ${limited.id}`)[0]!.used_count).toBe(1);
      // A booking that cannot be made (the time is taken) refuses and keeps the use.
      await expect(book(slotAt(fixture, 15, 10, "b@acme-corp.in"), { specialLinkToken: limited.token })).rejects.toMatchObject({ code: "slot_unavailable" });
      expect((await fixture.owner<{ used_count: number }[]>`select used_count from special_links where id = ${limited.id}`)[0]!.used_count).toBe(1);
      await book(slotAt(fixture, 15, 11, "b@acme-corp.in"), { specialLinkToken: limited.token });
      await expect(book(slotAt(fixture, 15, 12, "c@acme-corp.in"), { specialLinkToken: limited.token })).rejects.toMatchObject({ code: "special_link_unavailable" });

      // Expiring: the database's clock decides. One minute past the end it refuses.
      const expiring = await createSpecialLink(fixture.context, fixture.serviceId, { label: "Until midnight", kind: "expiring", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
      await book(slotAt(fixture, 16, 10, "d@acme-corp.in"), { specialLinkToken: expiring.token });
      await fixture.owner`update special_links set expires_at = now() - interval '1 minute' where id = ${expiring.id}`;
      await expect(book(slotAt(fixture, 16, 11, "e@acme-corp.in"), { specialLinkToken: expiring.token })).rejects.toMatchObject({ code: "special_link_unavailable" });
      expect((await resolvePublicSpecialLink(expiring.token)).state).toBe("unavailable");

      // Revoked.
      const revoked = await createSpecialLink(fixture.context, fixture.serviceId, { label: "Gone", kind: "single_use" });
      await revokeSpecialLink(fixture.context, revoked.id);
      await expect(book(slotAt(fixture, 16, 12, "f@acme-corp.in"), { specialLinkToken: revoked.token })).rejects.toMatchObject({ code: "special_link_unavailable" });
      await expect(revokeSpecialLink(fixture.context, revoked.id)).rejects.toMatchObject({ code: "special_link_not_found" });
      // Another business cannot see or revoke these links.
      expect(await listSpecialLinks(fixture.outsider, fixture.serviceId)).toEqual([]);
      await expect(revokeSpecialLink(fixture.outsider, limited.id)).rejects.toMatchObject({ code: "special_link_not_found" });
    } finally {
      await tidy(fixture);
    }
  });

  it("a combined link offers only times everyone is free and books two linked appointments", async () => {
    const fixture = await createSchedulingFixture(ownerUrl, { name: "Combo" });
    const other = randomUUID();
    try {
      await fixture.owner`insert into practitioners (id, tenant_id, name, title, initials, specialty) values (${other}, ${fixture.tenantId}, 'Combo Second', 'Therapist', 'CS', 'Testing')`;
      await fixture.owner`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${fixture.tenantId}, ${other}, ${fixture.locationId})`;
      await fixture.owner`insert into practitioner_services (tenant_id, practitioner_id, service_id) values (${fixture.tenantId}, ${other}, ${fixture.serviceId})`;
      const [location] = await fixture.owner<{ timezone: string }[]>`select timezone from locations where id = ${fixture.locationId}`;
      for (let day = 1; day <= 7; day += 1) {
        await fixture.owner`insert into availability_rules (id, tenant_id, location_id, practitioner_id, day_of_week, starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes)
          values (${randomUUID()}, ${fixture.tenantId}, ${fixture.locationId}, ${other}, ${day}, '00:00', '23:59', ${location!.timezone}, '2025-01-01', 30)`;
      }
      await expect(createCombinedLink(fixture.context, fixture.serviceId, { label: "Solo", slug: "solo", practitionerIds: [fixture.practitionerId, fixture.practitionerId] })).rejects.toMatchObject({ code: "validation_error" });
      await createCombinedLink(fixture.context, fixture.serviceId, { label: "Together", slug: "together", practitionerIds: [fixture.practitionerId, other] });
      await expect(createCombinedLink(fixture.context, fixture.serviceId, { label: "Again", slug: "together", practitionerIds: [fixture.practitionerId, other] })).rejects.toMatchObject({ code: "slug_taken" });
      expect(await resolvePublicCombinedLink("lotus-dental", "together")).toMatchObject({ practitionerIds: [fixture.practitionerId, other] });

      // The second person is busy at 10:00 on day 17 (a normal booking); the first is free.
      const busy = slotAt(fixture, 17, 10, "busy@acme-corp.in", { practitionerId: other, slotId: `${other}:x` });
      await book(busy);
      const from = new Date(Date.now() + 16 * 86_400_000).toISOString();
      const to = new Date(Date.now() + 19 * 86_400_000).toISOString();
      const listing = await listCombinedAvailability({ clinicSlug: "lotus-dental", locationId: fixture.locationId, serviceId: fixture.serviceId, practitionerId: "first_available", from, to, combo: "together" });
      const starts = listing.slots.map((slot) => slot.startsAt);
      expect(starts).not.toContain(busy.startsAt);
      expect(starts).toContain(startIn(17, 11));
      expect(starts.length).toBeGreaterThan(10);

      const target = slotAt(fixture, 17, 11, "pair@acme-corp.in", { firstName: "Pair", lastName: "Booker" });
      const made = await book(target, { combinedSlug: "together" });
      const rows = await fixture.owner<{ practitioner_id: string; group_ref: string | null; patient_id: string; starts_at: Date }[]>`
        select practitioner_id, group_ref, patient_id, starts_at from appointments where tenant_id = ${fixture.tenantId} and id in (select id from appointments where group_ref is not null and tenant_id = ${fixture.tenantId} and service_id = ${fixture.serviceId})`;
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.practitioner_id))).toEqual(new Set([fixture.practitionerId, other]));
      expect(new Set(rows.map((row) => row.group_ref)).size).toBe(1);
      expect(rows[0]!.group_ref).not.toBeNull();
      expect(new Set(rows.map((row) => row.patient_id)).size).toBe(1);
      expect(made.appointmentId).toBeTruthy();

      // All or nothing: booking the time the second person is busy books neither.
      const before = (await fixture.owner<{ n: number }[]>`select count(*)::int as n from appointments where tenant_id = ${fixture.tenantId} and service_id = ${fixture.serviceId}`)[0]!.n;
      await expect(book(slotAt(fixture, 17, 10, "late@acme-corp.in"), { combinedSlug: "together" })).rejects.toMatchObject({ code: "slot_unavailable" });
      expect((await fixture.owner<{ n: number }[]>`select count(*)::int as n from appointments where tenant_id = ${fixture.tenantId} and service_id = ${fixture.serviceId}`)[0]!.n).toBe(before);
    } finally {
      await tidy(fixture, [other]);
    }
  });
});
