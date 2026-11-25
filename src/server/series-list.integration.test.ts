/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { resolvePermissions } from "@/lib/permissions";
import type { RepeatRule } from "@/lib/series-rule";
import { seriesListQuerySchema } from "@/lib/series-list";
import { isolatedDatabaseReady } from "@/test/isolated-database";
import { createCustomer, createTenant, staffContext, type TenantFixture } from "@/test/privacy-fixture";

vi.mock("server-only", () => ({}));

import { ApiError } from "@/server/api-error";
import { listBookings } from "@/server/bookings-list";
import { bookingQuerySchema } from "@/lib/bookings-list";
import { saveSeries } from "@/server/series";
import { changeSeries } from "@/server/series-change";
import { listSeries } from "@/server/series-list";
import { addDays, isoWeekday, localDateOf, localInstant } from "@/server/slot-engine/time";
import type { StaffContext } from "@/server/staff-context";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL ?? process.env.KALENDR_E2E_OWNER_URL;
const describeIsolated = isolatedDatabaseReady(runtimeUrl, ownerUrl) ? describe : describe.skip;

const zone = "Asia/Kolkata";
const weekly = (count: number): RepeatRule => ({ frequency: "weekly", interval: 1, weekdays: [], end: { kind: "count", count } });
const query = (over: Record<string, unknown> = {}) => seriesListQuerySchema.parse(over);

function nextWeekday(weekday: number, minDays = 3): string {
  let date = localDateOf(Date.now(), zone);
  for (let guard = 0; guard < 400; guard += 1) {
    date = addDays(date, 1);
    if (isoWeekday(date) === weekday && new Date(localInstant(date, "00:00", zone)).getTime() > Date.now() + minDays * 86_400_000) return date;
  }
  throw new Error("no date");
}

interface Place { fixture: TenantFixture; context: StaffContext; patientId: string; }

describeIsolated("the Repeating tab of the bookings list", () => {
  let owner: postgres.Sql;
  let place: Place;
  let other: Place;

  async function setup(label: string, customer: { firstName: string; lastName: string }): Promise<Place> {
    const fixture = await createTenant(owner, label);
    await owner`update tenants set timezone = ${zone} where id = ${fixture.tenantId}`;
    await owner`update locations set timezone = ${zone} where id = ${fixture.locationId}`;
    await owner`update services set duration_minutes = 60, slot_interval_minutes = 60, minimum_lead_minutes = 0, maximum_advance_days = 500 where id = ${fixture.serviceId}`;
    await owner`insert into service_locations (tenant_id, service_id, location_id) values (${fixture.tenantId}, ${fixture.serviceId}, ${fixture.locationId})`;
    await owner`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${fixture.tenantId}, ${fixture.practitionerId}, ${fixture.locationId})`;
    await owner`insert into practitioner_services (tenant_id, practitioner_id, service_id) values (${fixture.tenantId}, ${fixture.practitionerId}, ${fixture.serviceId})`;
    for (let day = 1; day <= 7; day += 1) {
      await owner`insert into availability_rules (id, tenant_id, location_id, practitioner_id, day_of_week, starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes)
        values (${randomUUID()}, ${fixture.tenantId}, ${fixture.locationId}, ${fixture.practitionerId}, ${day}, '08:00', '18:00', ${zone}, '2025-01-01', 60)`;
    }
    const [user] = await owner<{ id: string }[]>`insert into auth_users (name, email, email_verified) values (${`Staff ${label}`}, ${`staff-${randomUUID().slice(0, 8)}@example.com`}, true) returning id`;
    await owner`insert into memberships (tenant_id, user_id, role) values (${fixture.tenantId}, ${user!.id}, 'owner')`;
    const patient = await createCustomer(owner, fixture.tenantId, customer);
    await owner`update patients set preferred_channel = 'email' where id = ${patient.id}`;
    return { fixture, patientId: patient.id, context: staffContext(fixture, { userId: user!.id }) };
  }

  const bookingFor = (p: Place, date: string, time: string, patientId = p.patientId) => ({
    clinicSlug: p.fixture.slug, locationId: p.fixture.locationId, serviceId: p.fixture.serviceId, practitionerId: p.fixture.practitionerId,
    startsAt: new Date(localInstant(date, time, zone)).toISOString(), source: "desk" as const, patientId,
  });
  async function save(p: Place, date: string, time: string, count: number, patientId = p.patientId): Promise<string> {
    const result = await saveSeries(p.context, { booking: bookingFor(p, date, time, patientId), rule: weekly(count), resolutions: [] }, `list-${randomUUID()}`);
    if (!result.saved) throw new Error("not saved");
    return result.seriesId;
  }

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 3, prepare: false });
    place = await setup("slist-main", { firstName: "Asha", lastName: "Lister" });
    other = await setup("slist-other", { firstName: "Other", lastName: "Business" });
  });
  afterAll(async () => { await owner?.end(); });

  it("lists a running series with its rule in words, next visit and how many visits are done", async () => {
    const start = nextWeekday(2);
    const id = await save(place, start, "10:00", 4);
    const page = await listSeries(place.context, query());
    const row = page.rows.find((item) => item.id === id)!;
    expect(row).toBeTruthy();
    expect(row.status).toBe("active");
    expect(row.customer.name).toBe("Asha Lister");
    expect(row.summary).toMatch(/Every Tuesday at 10:00 am for 4 weeks/i);
    expect(row.visitsTotal).toBe(4);
    expect(row.visitsDone).toBe(0);
    expect(row.nextVisit?.index).toBe(1);
    expect(row.nextVisit?.startsAt).toBe(new Date(localInstant(start, "10:00", zone)).toISOString());
    expect(row.timezone).toBe(zone);
    // The first page carries every tab's count, including this one.
    expect(page.repeatingCount).toBe(1);
    expect(page.counts?.upcoming).toBe(4);
  });

  it("counts a finished visit as done and moves the next visit on", async () => {
    const start = nextWeekday(3);
    const id = await save(place, start, "11:00", 3);
    await owner`update appointments set status = 'completed', version = version + 1 where tenant_id = ${place.fixture.tenantId} and series_id = ${id} and series_index = 1`;
    const row = (await listSeries(place.context, query())).rows.find((item) => item.id === id)!;
    expect(row.visitsDone).toBe(1);
    expect(row.visitsTotal).toBe(3);
    expect(row.nextVisit?.index).toBe(2);
  });

  it("shows running series by default, and ended or cancelled ones when asked, with the same count the tab shows", async () => {
    const start = nextWeekday(4);
    const id = await save(place, start, "09:00", 3);
    const visits = await owner<{ id: string }[]>`select id from appointments where tenant_id = ${place.fixture.tenantId} and series_id = ${id} order by series_index limit 1`;
    const [view] = await owner<{ version: number }[]>`select version from appointment_series where id = ${id}`;
    const changed = await changeSeries(place.context, id, { action: "cancel", scope: "all", fromAppointmentId: visits[0]!.id, expectedVersion: view!.version }, `cancel-${randomUUID()}`);
    expect(changed.changed).toBe(true);
    const running = await listSeries(place.context, query());
    expect(running.rows.some((item) => item.id === id)).toBe(false);
    const cancelled = await listSeries(place.context, query({ seriesStatuses: ["cancelled"] }));
    const row = cancelled.rows.find((item) => item.id === id)!;
    expect(row.status).toBe("cancelled");
    expect(row.nextVisit).toBeNull();
    expect(row.visitsTotal).toBe(0);
    expect(cancelled.repeatingCount).toBe(cancelled.rows.length);
    expect(running.repeatingCount).toBe(running.rows.length);
  });

  it("filters by customer name, person and service, and applies the same filters to the other tabs' counts", async () => {
    const byName = await listSeries(place.context, query({ q: "lister" }));
    expect(byName.rows.length).toBeGreaterThan(0);
    expect((await listSeries(place.context, query({ q: "nobody-by-this-name" }))).rows).toEqual([]);
    expect((await listSeries(place.context, query({ practitionerIds: [place.fixture.practitionerId] }))).rows.length).toBe(byName.rows.length);
    expect((await listSeries(place.context, query({ practitionerIds: ["not-a-person"] }))).rows).toEqual([]);
    expect((await listSeries(place.context, query({ serviceIds: [place.fixture.serviceId] }))).rows.length).toBe(byName.rows.length);
    const none = await listSeries(place.context, query({ q: "nobody-by-this-name" }));
    expect(none.counts).toEqual({ upcoming: 0, needs_approval: 0, past: 0, cancelled: 0 });
    expect(none.repeatingCount).toBe(0);
  });

  it("pages by cursor in a stable order, with counts on the first page only, soonest next visit first and newest last when reversed", async () => {
    const all = await listSeries(place.context, query({ limit: 100 }));
    expect(all.rows.length).toBeGreaterThanOrEqual(2);
    const times = all.rows.map((row) => row.nextVisit?.startsAt ?? "9999");
    expect([...times].sort()).toEqual(times);
    const seen: string[] = [];
    let cursor: string | undefined;
    let first = true;
    for (let guard = 0; guard < 20; guard += 1) {
      const page = await listSeries(place.context, query({ limit: 1, ...(cursor ? { cursor } : {}) }));
      if (first) { expect(page.counts).not.toBeNull(); first = false; } else { expect(page.counts).toBeNull(); expect(page.repeatingCount).toBeNull(); }
      seen.push(...page.rows.map((row) => row.id));
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(all.rows.map((row) => row.id));
    const reversed = await listSeries(place.context, query({ limit: 100, sort: "desc" }));
    expect(reversed.rows.map((row) => row.id)).toEqual([...all.rows.map((row) => row.id)].reverse());
    await expect(listSeries(place.context, query({ cursor: "not-a-cursor" }))).rejects.toMatchObject({ code: "validation_error" });
  });

  it("never shows another business's series, in the list or in the counts (row-level security)", async () => {
    const otherId = await save(other, nextWeekday(5), "10:00", 2);
    const mine = await listSeries(place.context, query({ limit: 100 }));
    expect(mine.rows.some((row) => row.id === otherId)).toBe(false);
    const theirs = await listSeries(other.context, query({ limit: 100 }));
    expect(theirs.rows.map((row) => row.id)).toEqual([otherId]);
    expect(theirs.repeatingCount).toBe(1);
    expect(theirs.counts?.upcoming).toBe(2);
    // The other business's number is on the bookings list's badge too, and only its own.
    const booking = await listBookings(place.context, bookingQuerySchema.parse({ tab: "upcoming" }));
    expect(booking.repeatingCount).toBe(mine.repeatingCount);
    // And the application's own database role, outside a business, sees no series at all.
    const runtime = postgres(runtimeUrl!, { max: 1, prepare: false });
    try {
      const [row] = await runtime<{ total: number }[]>`select count(*)::int as total from appointment_series`;
      expect(row!.total).toBe(0);
    } finally { await runtime.end(); }
  });

  it("shows a practitioner their own series only, and refuses people who cannot see the bookings list", async () => {
    const asPractitioner = { ...place.context, role: "practitioner" as const, permissions: resolvePermissions("practitioner", {}), userId: `nobody-${randomUUID().slice(0, 8)}` };
    const none = await listSeries(asPractitioner, query());
    expect(none.rows).toEqual([]);
    expect(none.repeatingCount).toBe(0);
    // Once the person is linked to the practitioner, the same practitioner sees what is theirs.
    await owner`update practitioners set auth_user_id = ${place.context.userId} where id = ${place.fixture.practitionerId}`;
    expect((await listSeries({ ...asPractitioner, userId: place.context.userId }, query())).rows.length).toBeGreaterThan(0);
    const readOnly = { ...place.context, role: "read_only" as const, permissions: resolvePermissions("read_only", {}) };
    const error = await listSeries(readOnly, query()).then(() => null, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
    const preview = await listSeries({ ...place.context, preview: true }, query()).then(() => null, (cause: unknown) => cause);
    expect((preview as ApiError).code).toBe("preview_only");
  });

  it("refuses a query the schema does not accept", () => {
    expect(seriesListQuerySchema.safeParse({ seriesStatuses: ["gone"] }).success).toBe(false);
    expect(seriesListQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(seriesListQuerySchema.safeParse({ sort: "sideways" }).success).toBe(false);
  });
});
