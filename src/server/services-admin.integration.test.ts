/** @vitest-environment node */

import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import { resolvePermissions } from "@/lib/permissions";
import type { StaffContext } from "@/server/staff-context";

vi.mock("server-only", () => ({}));

import { getPublicClinicCatalog } from "@/server/public-catalog";
import { applyServiceSetupPatch, deleteService, duplicateService, getServiceSetup, updateServiceSetup } from "@/server/services-admin";
import { createStaffService } from "@/server/staff-operations";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const localDatabase = (url: string | undefined): boolean => {
  if (!url) return false;
  const parsed = new URL(url);
  return parsed.hostname === "127.0.0.1" && ["5544", "5545"].includes(parsed.port) && ["/kalendr_local", "/nira_local"].includes(parsed.pathname);
};
const describeLocal = localDatabase(runtimeUrl) && localDatabase(ownerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

function contextFor(tenantId: string, slug: string): StaffContext {
  return { tenantId, clinicSlug: slug, clinicName: slug, role: "owner", permissions: resolvePermissions("owner", []), membershipId: null, userId: null, userName: "Test", userEmail: "test@example.com", preview: false };
}

describeLocal("service setup admin", () => {
  it("saves with version checks, duplicates, hides from the catalog and stays inside its business", async () => {
    const owner = postgres(ownerUrl!, { max: 1, prepare: false });
    let createdIds: string[] = [];
    try {
      const [dental] = await owner<{ id: string }[]>`select id from tenants where slug = 'lotus-dental' limit 1`;
      const [other] = await owner<{ id: string; slug: string }[]>`select id, slug from tenants where slug <> 'lotus-dental' limit 1`;
      if (!dental || !other) throw new Error("Seed the isolated local database before this test");
      const context = contextFor(dental.id, "lotus-dental");
      const outsider = contextFor(other.id, other.slug);
      const [practitioner] = await owner<{ id: string }[]>`
        select practitioner_id as id from practitioner_locations where tenant_id = ${dental.id} limit 1`;

      const { serviceId } = await createStaffService(context, {
        name: "Setup Test Visit", description: "Local integration test", durationMinutes: 30,
        bookingMode: "instant", practitionerIds: practitioner ? [practitioner.id] : [],
      });
      createdIds = [serviceId];

      const first = await getServiceSetup(context, serviceId);
      expect(first.lengths).toEqual([{ minutes: 30, priceMinor: null, isDefault: true }]);
      expect(first.basics.slug).toBe("setup-test-visit");
      expect(first.locationOptions.every((option) => option.kind === "in_person")).toBe(true);

      const saved = await updateServiceSetup(context, serviceId, {
        expectedVersion: first.version,
        timing: { ...first.timing, bufferAfterMinutes: 15, minimumNoticeMinutes: 1_440, window: { kind: "rolling_days", days: 30 }, slotIntervalMinutes: null, startOffsetMinutes: 0 },
        lengths: [{ minutes: 30, priceMinor: 50_000, isDefault: true }, { minutes: 45, priceMinor: 70_000, isDefault: false }, { minutes: 60, priceMinor: 90_000, isDefault: false }],
      });
      expect(saved.version).toBe(first.version + 1);
      expect(saved.lengths).toHaveLength(3);
      const [row] = await owner<{ duration_minutes: number; price_minor: number; minimum_lead_minutes: number; maximum_advance_days: number }[]>`
        select duration_minutes, price_minor, minimum_lead_minutes, maximum_advance_days from services where id = ${serviceId}`;
      expect(row).toMatchObject({ duration_minutes: 30, price_minor: 50_000, minimum_lead_minutes: 1_440, maximum_advance_days: 30 });

      // A second manager still holding the old version is told, in plain words, to reload.
      await expect(updateServiceSetup(context, serviceId, { expectedVersion: first.version, basics: { name: "Stale edit" } }))
        .rejects.toMatchObject({ code: "version_conflict", status: 409 });
      await expect(updateServiceSetup(context, serviceId, { expectedVersion: saved.version, timing: { ...saved.timing, startOffsetMinutes: 50, slotIntervalMinutes: 15 } }))
        .rejects.toMatchObject({ status: 400 });

      // The older visit-types list sends every field, including an empty price label, on every save. That must not wipe the editor's prices.
      await applyServiceSetupPatch(context, serviceId, { basics: { name: saved.basics.name }, priceLabel: null, durationMinutes: 30 });
      const afterLegacy = await getServiceSetup(context, serviceId);
      expect(afterLegacy.lengths).toEqual(saved.lengths);
      expect(afterLegacy.version).toBe(saved.version + 1);

      const copy = await duplicateService(context, serviceId);
      createdIds.push(copy.serviceId);
      const copied = await getServiceSetup(context, copy.serviceId);
      expect(copied.basics.name).toBe("Setup Test Visit (copy)");
      expect(copied.basics.slug).not.toBe(saved.basics.slug);
      expect(copied.lengths).toEqual(saved.lengths);
      expect(copied.locationOptions).toEqual(saved.locationOptions);
      expect(copied.basics.practitionerIds).toEqual(saved.basics.practitionerIds);
      expect(copied.basics.locationIds).toEqual(saved.basics.locationIds);

      // Hidden: gone from the public catalog, present for staff, found by its own link name.
      await updateServiceSetup(context, serviceId, { expectedVersion: afterLegacy.version, basics: { visibility: "hidden" } });
      const publicCatalog = await getPublicClinicCatalog("lotus-dental");
      expect(publicCatalog?.services.some((service) => service.id === serviceId)).toBe(false);
      const staffCatalog = await getPublicClinicCatalog("lotus-dental", { includeInactive: true });
      expect(staffCatalog?.services.find((service) => service.id === serviceId)?.visibility).toBe("hidden");
      const byLink = await getPublicClinicCatalog("lotus-dental", { includeHiddenSlug: saved.basics.slug });
      const found = byLink?.services.find((service) => service.id === serviceId);
      expect(found?.lengths?.map((length) => length.minutes)).toEqual([30, 45, 60]);
      expect(publicCatalog?.services.some((service) => service.id === copy.serviceId)).toBe(true);

      // The editor saves every group at once, including who and where. That must go through.
      const latest = await getServiceSetup(context, serviceId);
      const whole = await updateServiceSetup(context, serviceId, { expectedVersion: latest.version, basics: { ...latest.basics, visibility: "listed" }, timing: latest.timing, lengths: latest.lengths, locationOptions: latest.locationOptions, look: latest.look });
      expect(whole.basics.visibility).toBe("listed");
      await expect(updateServiceSetup(context, serviceId, { expectedVersion: whole.version, basics: { locationIds: [other.id] } })).rejects.toMatchObject({ status: 400 });

      // Which hours the service follows: its own schedule and a restriction, read back, cleared with null.
      const [mine] = await owner<{ id: string }[]>`select id from availability_schedules where tenant_id = ${dental.id} limit 1`;
      const [theirs] = await owner<{ id: string }[]>`select id from availability_schedules where tenant_id = ${other.id} limit 1`;
      if (mine && theirs) {
        const hours = await getServiceSetup(context, serviceId);
        const chosen = await updateServiceSetup(context, serviceId, { expectedVersion: hours.version, basics: { scheduleId: mine.id, restrictionScheduleId: mine.id } });
        expect(chosen.basics).toMatchObject({ scheduleId: mine.id, restrictionScheduleId: mine.id });
        await expect(updateServiceSetup(context, serviceId, { expectedVersion: chosen.version, basics: { restrictionScheduleId: theirs.id } })).rejects.toMatchObject({ status: 400 });
        const copied = await duplicateService(context, serviceId);
        createdIds.push(copied.serviceId);
        expect((await getServiceSetup(context, copied.serviceId)).basics.scheduleId).toBe(mine.id);
        const cleared = await updateServiceSetup(context, serviceId, { expectedVersion: chosen.version, basics: { scheduleId: null, restrictionScheduleId: null } });
        expect(cleared.basics).toMatchObject({ scheduleId: null, restrictionScheduleId: null });
      }

      // Another business can neither read nor change it.
      await expect(getServiceSetup(outsider, serviceId)).rejects.toMatchObject({ status: 404 });
      await expect(updateServiceSetup(outsider, serviceId, { expectedVersion: 1, basics: { name: "Hijacked" } })).rejects.toMatchObject({ status: 404 });
      await expect(duplicateService(outsider, serviceId)).rejects.toMatchObject({ status: 404 });
    } finally {
      for (const id of createdIds) await owner`delete from services where id = ${id}`;
      await owner.end();
    }
  });
});

describeLocal("service delete", () => {
  it("removes an unused service, records it, and keeps one that still has bookings", async () => {
    const owner = postgres(ownerUrl!, { max: 1, prepare: false });
    const createdIds: string[] = [];
    try {
      const [dental] = await owner<{ id: string }[]>`select id from tenants where slug = 'lotus-dental' limit 1`;
      const [other] = await owner<{ id: string; slug: string }[]>`select id, slug from tenants where slug <> 'lotus-dental' limit 1`;
      if (!dental || !other) throw new Error("Seed the isolated local database before this test");
      const context = contextFor(dental.id, "lotus-dental");
      const { serviceId } = await createStaffService(context, { name: "Delete Test Visit", description: "Local integration test", durationMinutes: 30, bookingMode: "instant", practitionerIds: [] });
      createdIds.push(serviceId);

      await expect(deleteService(contextFor(other.id, other.slug), serviceId)).rejects.toMatchObject({ status: 404 });
      await expect(deleteService(context, serviceId)).resolves.toEqual({ serviceId });
      const rows = await owner`select 1 from services where id = ${serviceId}`;
      expect(rows).toHaveLength(0);
      const audit = await owner`select metadata from audit_events where tenant_id = ${dental.id} and action = 'settings.service.deleted' order by created_at desc limit 1`;
      expect(audit[0]?.metadata).toEqual({ serviceId });
      await expect(deleteService(context, serviceId)).rejects.toMatchObject({ status: 404 });

      // A service that bookings point at is refused, not removed.
      const [used] = await owner<{ service_id: string }[]>`select service_id from appointments where tenant_id = ${dental.id} limit 1`;
      if (used) {
        await expect(deleteService(context, used.service_id)).rejects.toMatchObject({ status: 409, code: "service_in_use" });
        expect(await owner`select 1 from services where id = ${used.service_id}`).toHaveLength(1);
      }
    } finally {
      for (const id of createdIds) await owner`delete from services where id = ${id}`;
      await owner.end();
    }
  });
});
