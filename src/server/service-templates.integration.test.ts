/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import { expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { TemplateSettings } from "@/lib/service-templates";
import { createAppointment } from "@/server/appointment-repository";
import { saveServicePayment } from "@/server/payments/accounts";
import { assignTemplate, createTemplate, deleteTemplate, getTemplate, listTemplates, unlinkServices, updateTemplate } from "@/server/service-templates";
import { applyServiceSetupPatch, getServiceSetup } from "@/server/services-admin";
import { describeScratch } from "@/server/testing/scratch-database";
import { createSchedulingFixture, plusMinutes, startIn, type SchedulingFixture } from "@/server/testing/scheduling-fixture";

const ownerUrl = process.env.KALENDR_TEST_OWNER_URL ?? "";

async function tidy(fixture: SchedulingFixture, templateIds: string[], locationIds: string[]): Promise<void> {
  const copies = await fixture.owner<{ id: string }[]>`select id from services where tenant_id = ${fixture.tenantId} and template_id = any(${templateIds}::text[]) and id <> ${fixture.serviceId}`;
  const ids = copies.map((row) => row.id);
  await fixture.owner`update services set template_id = null, template_version = null where tenant_id = ${fixture.tenantId} and template_id is not null and id = any(${[...ids, fixture.serviceId]}::text[])`;
  if (ids.length > 0) {
    for (const table of ["service_durations", "service_location_options", "service_locations", "practitioner_services"] as const) {
      await fixture.owner.unsafe(`delete from ${table} where tenant_id = $1 and service_id = any($2)`, [fixture.tenantId, ids]);
    }
    await fixture.owner`delete from services where tenant_id = ${fixture.tenantId} and id = any(${ids}::text[])`;
  }
  if (templateIds.length > 0) await fixture.owner`delete from service_templates where tenant_id = ${fixture.tenantId} and id = any(${templateIds}::text[])`;
  if (locationIds.length > 0) {
    await fixture.owner`delete from practitioner_locations where tenant_id = ${fixture.tenantId} and location_id = any(${locationIds}::text[])`;
    await fixture.owner`delete from locations where tenant_id = ${fixture.tenantId} and id = any(${locationIds}::text[])`;
  }
  await fixture.cleanup();
}

describeScratch("service templates (feature 48)", () => {
  it("a locked price holds on 12 copies, one publish updates them all, and bookings keep their price", async () => {
    const fixture = await createSchedulingFixture(ownerUrl, { name: "Tpl" });
    const templateIds: string[] = [];
    const locationIds: string[] = [];
    try {
      for (let index = 0; index < 11; index += 1) {
        const [row] = await fixture.owner<{ id: string }[]>`
          insert into locations (tenant_id, name, address, city, timezone) values (${fixture.tenantId}, ${`Tpl Branch ${index}`}, '1 Test Road', 'Pune', 'Asia/Kolkata') returning id`;
        locationIds.push(row!.id);
        await fixture.owner`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${fixture.tenantId}, ${fixture.practitionerId}, ${row!.id})`;
      }
      const template = await createTemplate(fixture.context, { name: "Standard haircut", lockedFields: ["prices", "name"], fromServiceId: fixture.serviceId });
      templateIds.push(template.id);
      const priced = (price: number): TemplateSettings => ({ ...template.settings, lengths: template.settings.lengths.map((length) => ({ ...length, priceMinor: price })) });
      const first = await updateTemplate(fixture.context, template.id, { expectedVersion: 1, settings: priced(50_000), dryRun: false });
      expect(first.summary.servicesUpdated).toBe(0);

      // Assign to 11 new branches and link the existing service (12 in all).
      const assigned = await assignTemplate(fixture.context, template.id, { locationIds, linkServiceIds: [fixture.serviceId] });
      expect(assigned.created).toHaveLength(11);
      expect(assigned.linked).toEqual([fixture.serviceId]);
      const detail = await getTemplate(fixture.context, template.id);
      expect(detail.copyCount).toBe(12);
      expect(detail.copies.every((copy) => !copy.outOfDate)).toBe(true);
      const prices = await fixture.owner<{ price_minor: number; d: number }[]>`
        select service.price_minor, (select price_minor from service_durations where service_id = service.id and is_default) as d from services as service where service.template_id = ${template.id}`;
      expect(prices).toHaveLength(12);
      expect(prices.every((row) => row.price_minor === 50_000 && row.d === 50_000)).toBe(true);

      // A branch manager may change the description, but not the price (by any route), nor the locked name.
      const copyId = assigned.created[0]!;
      const setup = await getServiceSetup(fixture.context, copyId);
      const saved = await applyServiceSetupPatch(fixture.context, copyId, { basics: { description: "Branch words for this shop" } }, setup.version);
      expect(saved.basics.description).toBe("Branch words for this shop");
      await expect(applyServiceSetupPatch(fixture.context, copyId, { lengths: saved.lengths.map((length) => ({ ...length, priceMinor: 1 })) }, saved.version)).rejects.toMatchObject({ code: "template_locked", status: 409 });
      await expect(applyServiceSetupPatch(fixture.context, copyId, { priceLabel: "₹10" }, saved.version)).rejects.toMatchObject({ code: "template_locked" });
      await expect(applyServiceSetupPatch(fixture.context, copyId, { basics: { name: "Renamed" } }, saved.version)).rejects.toMatchObject({ code: "template_locked" });
      await expect(saveServicePayment(fixture.context, copyId, { priceMinor: 1, paymentMode: "none", depositMinor: null })).rejects.toMatchObject({ code: "template_locked" });
      expect((await getServiceSetup(fixture.context, copyId)).lengths.find((length) => length.isDefault)?.priceMinor).toBe(50_000);

      // A booking made at the old price, without a price of its own (as older bookings are).
      const start = startIn(20, 10);
      const booked = await createAppointment(fixture.bookingInput(start, plusMinutes(start, 30), "t@acme-corp.in"), randomUUID(), randomUUID().replaceAll("-", ""));
      await fixture.owner`update appointments set price_minor = null where id = ${booked.appointmentId}`;

      // The summary before publishing, then one publish.
      const dry = await updateTemplate(fixture.context, template.id, { expectedVersion: 2, settings: priced(60_000), dryRun: true });
      expect(dry.published).toBe(false);
      expect(dry.summary).toMatchObject({ servicesUpdated: 12, servicesWithLocalChanges: 1, changesPrices: true });
      expect(dry.summary.changedFields).toContain("prices");
      expect(dry.summary.sentence).toMatch(/12 .*1 .* local changes to unlocked fields, which stay/);
      expect((await getTemplate(fixture.context, template.id)).version).toBe(2);
      await expect(updateTemplate(fixture.context, template.id, { expectedVersion: 1, settings: priced(60_000), dryRun: false })).rejects.toMatchObject({ code: "version_conflict" });

      const published = await updateTemplate(fixture.context, template.id, { expectedVersion: 2, settings: priced(60_000), dryRun: false });
      expect(published.published).toBe(true);
      expect(published.template.version).toBe(3);
      const after = await fixture.owner<{ price_minor: number; d: number; template_version: number; description: string }[]>`
        select service.price_minor, service.template_version, service.description,
          (select price_minor from service_durations where service_id = service.id and is_default) as d from services as service where service.template_id = ${template.id}`;
      expect(after).toHaveLength(12);
      expect(after.every((row) => row.price_minor === 60_000 && row.d === 60_000 && row.template_version === 3)).toBe(true);
      // The unlocked description set on one branch stays.
      expect(after.filter((row) => row.description === "Branch words for this shop")).toHaveLength(1);
      // The booking made before keeps the old price.
      const [booking] = await fixture.owner<{ price_minor: number | null }[]>`select price_minor from appointments where id = ${booked.appointmentId}`;
      expect(booking!.price_minor).toBe(50_000);

      // Unlinking keeps current settings and frees the price.
      expect(await unlinkServices(fixture.context, template.id, [copyId])).toEqual({ unlinked: 1 });
      const free = await getServiceSetup(fixture.context, copyId);
      expect(free.lengths.find((length) => length.isDefault)?.priceMinor).toBe(60_000);
      await applyServiceSetupPatch(fixture.context, copyId, { lengths: free.lengths.map((length) => ({ ...length, priceMinor: 70_000 })) }, free.version);
      expect(await listTemplates(fixture.context)).toHaveLength(1);

      // Another business sees nothing of this.
      expect(await listTemplates(fixture.outsider)).toEqual([]);
      await expect(getTemplate(fixture.outsider, template.id)).rejects.toMatchObject({ code: "template_not_found" });
      await expect(updateTemplate(fixture.outsider, template.id, { expectedVersion: 3, name: "Hijack", dryRun: false })).rejects.toMatchObject({ code: "template_not_found" });

      // Deleting keeps the services.
      const gone = await deleteTemplate(fixture.context, template.id);
      expect(gone.unlinked).toBe(11);
      templateIds.length = 0;
      expect((await fixture.owner<{ n: number }[]>`select count(*)::int as n from services where tenant_id = ${fixture.tenantId} and name = 'Standard haircut'`)[0]!.n).toBeGreaterThanOrEqual(11);
      await fixture.owner`delete from services where tenant_id = ${fixture.tenantId} and id = ${copyId}`.catch(() => undefined);
    } finally {
      const rest = await fixture.owner<{ id: string }[]>`select id from services where tenant_id = ${fixture.tenantId} and id <> ${fixture.serviceId} and name = 'Standard haircut'`;
      for (const row of rest) {
        for (const table of ["service_durations", "service_location_options", "service_locations", "practitioner_services"] as const) {
          await fixture.owner.unsafe(`delete from ${table} where tenant_id = $1 and service_id = $2`, [fixture.tenantId, row.id]);
        }
        await fixture.owner`delete from services where id = ${row.id}`;
      }
      await tidy(fixture, templateIds, locationIds);
    }
  });
});
