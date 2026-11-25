/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import type { WeeklyHours } from "@/lib/availability-setup";
import { resolvePermissions } from "@/lib/permissions";
import type { StaffContext } from "@/server/staff-context";

vi.mock("server-only", () => ({}));

import { copyScheduleToPerson, createSchedule, deleteSchedule, listSchedules, updateSchedule } from "@/server/availability-admin";
import { createTimeOff, createTravel, deleteTimeOff, deleteTravel, listTimeOff, listTravel, updateTimeOff } from "@/server/availability-extras";
import { updateStaffPractitioner } from "@/server/staff-team";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const localDatabase = (url: string | undefined): boolean => {
  if (!url) return false;
  const parsed = new URL(url);
  return parsed.hostname === "127.0.0.1" && ["5544", "5545"].includes(parsed.port) && ["/kalendr_local", "/nira_local"].includes(parsed.pathname);
};
const describeLocal = localDatabase(runtimeUrl) && localDatabase(ownerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

function contextFor(tenantId: string, slug: string, role: "owner" | "receptionist" = "owner"): StaffContext {
  return { tenantId, clinicSlug: slug, clinicName: slug, role, permissions: resolvePermissions(role, []), membershipId: null, userId: null, userName: "Test", userEmail: "test@example.com", preview: false };
}

const empty = (): WeeklyHours => ({ "1": [], "2": [], "3": [], "4": [], "5": [], "6": [], "7": [] });

describeLocal("availability schedules", () => {
  it("saves several ranges a day, keeps other schedules when the old hours form saves, and stays inside its business", async () => {
    const owner = postgres(ownerUrl!, { max: 1, prepare: false });
    const personId = randomUUID();
    const coverId = randomUUID();
    const otherPersonId = randomUUID();
    try {
      const [dental] = await owner<{ id: string }[]>`select id from tenants where slug = 'lotus-dental' limit 1`;
      const [other] = await owner<{ id: string; slug: string }[]>`select id, slug from tenants where slug <> 'lotus-dental' limit 1`;
      const [location] = await owner<{ id: string }[]>`select id from locations where tenant_id = ${dental?.id ?? ""} limit 1`;
      if (!dental || !other || !location) throw new Error("Seed the isolated local database before this test");
      for (const id of [personId, coverId, otherPersonId]) {
        await owner`insert into practitioners (id, tenant_id, name, title, initials, specialty) values (${id}, ${dental.id}, 'Schedule Test', 'Dentist', 'ST', 'Testing')`;
        await owner`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${dental.id}, ${id}, ${location.id})`;
      }
      const context = contextFor(dental.id, "lotus-dental");
      const outsider = contextFor(other.id, other.slug);

      // The first schedule a person gets is their main one. Monday 9-1 and 3-7 reads back as saved.
      const main = await createSchedule(context, { practitionerId: personId, name: "Working hours", timezone: "Asia/Kolkata" });
      expect(main.isDefault).toBe(true);
      const monday = { ...empty(), "1": [{ start: "09:00", end: "13:00" }, { start: "15:00", end: "19:00" }], "2": [{ start: "09:00", end: "17:00" }] };
      const saved = (await updateSchedule(context, main.id, { expectedVersion: main.version, weekly: monday })).schedule;
      expect(saved.weekly["1"]).toEqual([{ start: "09:00", end: "13:00" }, { start: "15:00", end: "19:00" }]);
      expect(saved.version).toBe(main.version + 1);
      const [{ count }] = await owner<{ count: string }[]>`select count(*) from availability_rules where schedule_id = ${main.id}`;
      expect(Number(count)).toBe(3);

      // Overlapping ranges are refused, and a stale save is told to reload.
      await expect(updateSchedule(context, main.id, { expectedVersion: saved.version, weekly: { ...empty(), "3": [{ start: "09:00", end: "12:00" }, { start: "11:00", end: "14:00" }] } }))
        .rejects.toMatchObject({ status: 400, code: "hours_overlap" });
      await expect(updateSchedule(context, main.id, { expectedVersion: main.version, name: "Late edit" }))
        .rejects.toMatchObject({ status: 409, code: "version_conflict" });
      await expect(updateSchedule(context, main.id, { expectedVersion: saved.version, weekly: empty() }))
        .rejects.toMatchObject({ status: 400, code: "hours_required" });

      // The main schedule can't be deleted; another schedule can, unless a service uses it.
      await expect(deleteSchedule(context, main.id)).rejects.toMatchObject({ status: 409, code: "default_schedule" });
      const summer = await createSchedule(context, { practitionerId: personId, name: "Summer", copyFromScheduleId: main.id });
      expect(summer.isDefault).toBe(false);
      expect(summer.weekly["1"]).toHaveLength(2);
      await expect(createSchedule(context, { practitionerId: personId, name: "Summer" })).rejects.toMatchObject({ status: 409, code: "name_taken" });
      const [service] = await owner<{ id: string }[]>`select id from services where tenant_id = ${dental.id} limit 1`;
      await owner`update services set schedule_id = ${summer.id} where id = ${service!.id}`;
      await expect(deleteSchedule(context, summer.id)).rejects.toMatchObject({ status: 409, code: "schedule_in_use" });
      await owner`update services set schedule_id = null where id = ${service!.id}`;

      // Date overrides: closed day, different ranges, then removal.
      const withOverrides = (await updateSchedule(context, summer.id, {
        expectedVersion: summer.version,
        overrides: [{ date: "2026-12-25", ranges: null }, { date: "2026-12-26", ranges: [{ start: "10:00", end: "12:00" }] }],
      })).schedule;
      expect(withOverrides.overrides).toEqual([{ date: "2026-12-25", ranges: null }, { date: "2026-12-26", ranges: [{ start: "10:00", end: "12:00" }] }]);
      const removed = (await updateSchedule(context, summer.id, { expectedVersion: withOverrides.version, removeOverrideDates: ["2026-12-25"] })).schedule;
      expect(removed.overrides.map((override) => override.date)).toEqual(["2026-12-26"]);

      // The older doctor-hours form replaces only the main schedule's ranges.
      await updateStaffPractitioner(context, personId, { hours: { days: [4, 5], startsAtLocal: "08:00", endsAtLocal: "12:00" } });
      const afterOldSave = await listSchedules(context, personId);
      expect(afterOldSave.find((schedule) => schedule.isDefault)?.weekly).toMatchObject({ "4": [{ start: "08:00", end: "12:00" }], "1": [] });
      expect(afterOldSave.find((schedule) => schedule.name === "Summer")?.weekly["1"]).toHaveLength(2);

      // Copy to a teammate, then delete the copy.
      const copied = await copyScheduleToPerson(context, summer.id, { toPractitionerId: otherPersonId, name: "Borrowed" });
      expect(copied.practitionerId).toBe(otherPersonId);
      expect(copied.isDefault).toBe(true);
      await expect(deleteSchedule(context, summer.id)).resolves.toEqual({ scheduleId: summer.id });

      // Travel: a second trip over the same days is refused.
      const trip = await createTravel(context, { practitionerId: personId, startsOn: "2026-12-01", endsOn: "2026-12-07", timezone: "Asia/Dubai" });
      await expect(createTravel(context, { practitionerId: personId, startsOn: "2026-12-05", endsOn: "2026-12-09", timezone: "Asia/Dubai" }))
        .rejects.toMatchObject({ status: 409, code: "travel_overlap" });
      expect(await listTravel(context, personId)).toHaveLength(1);
      await deleteTravel(context, trip.id);

      // Out of office, with a cover person, as whole days.
      const away = await createTimeOff(context, { practitionerId: personId, startsOn: "2026-12-10", throughDate: "2026-12-12", reason: "leave", publicNote: "Back on 13 December", coverPractitionerId: coverId });
      expect(away).toMatchObject({ startsOn: "2026-12-10", throughDate: "2026-12-12", coverPractitionerId: coverId, publicNote: "Back on 13 December" });
      const [stored] = await owner<{ starts_at: Date; ends_at: Date }[]>`select starts_at, ends_at from time_off where id = ${away.id}`;
      expect(stored!.starts_at.toISOString()).toBe("2026-12-09T18:30:00.000Z");
      expect(stored!.ends_at.toISOString()).toBe("2026-12-12T18:30:00.000Z");
      await expect(createTimeOff(context, { practitionerId: personId, startsOn: "2026-12-10", throughDate: "2026-12-12", reason: "leave", publicNote: null, coverPractitionerId: personId }))
        .rejects.toMatchObject({ status: 400 });
      const moved = await updateTimeOff(context, away.id, { expectedVersion: away.version, throughDate: "2026-12-14", coverPractitionerId: null });
      expect(moved).toMatchObject({ throughDate: "2026-12-14", coverPractitionerId: null, version: away.version + 1 });
      await expect(updateTimeOff(context, away.id, { expectedVersion: away.version, reason: "sick" })).rejects.toMatchObject({ code: "version_conflict" });
      expect((await listTimeOff(context, personId)).map((entry) => entry.id)).toContain(away.id);
      await deleteTimeOff(context, away.id);

      // The audit trail names ids and groups, never the note.
      const audits = await owner<{ metadata: unknown }[]>`select metadata from audit_events where tenant_id = ${dental.id} and action like 'availability.%' and occurred_at > now() - interval '5 minutes'`;
      expect(audits.length).toBeGreaterThan(5);
      expect(JSON.stringify(audits)).not.toContain("Back on 13 December");

      // Staff without hours.edit are refused; another business sees nothing.
      await expect(updateSchedule(contextFor(dental.id, "lotus-dental", "receptionist"), main.id, { expectedVersion: saved.version, name: "Nope" }))
        .rejects.toMatchObject({ status: 403 });
      await expect(listSchedules(outsider, personId)).rejects.toMatchObject({ status: 404 });
      await expect(updateSchedule(outsider, main.id, { expectedVersion: saved.version, name: "Hijacked" })).rejects.toMatchObject({ status: 404 });
      await expect(deleteSchedule(outsider, main.id)).rejects.toMatchObject({ status: 404 });
      await expect(createTimeOff(outsider, { practitionerId: personId, startsOn: "2026-12-10", throughDate: "2026-12-11", reason: "leave", publicNote: null, coverPractitionerId: null }))
        .rejects.toMatchObject({ status: 404 });
    } finally {
      for (const id of [personId, coverId, otherPersonId]) await owner`delete from practitioners where id = ${id}`;
      await owner.end();
    }
  }, 30_000);
});
