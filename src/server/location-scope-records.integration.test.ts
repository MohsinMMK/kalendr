/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { addMember, contextForMember } from "@/test/enterprise-fixture";
import { isLocalDatabase } from "@/test/billing-fixture";
import { createCustomer, createTenant, type TenantFixture } from "@/test/privacy-fixture";

import { messageEveryone } from "@/server/classes";
import { mergeCustomers, suggestDuplicates } from "@/server/customers/merge";
import { enrolMembership, renewMembership, changeMembership } from "@/server/offers/memberships";
import { adjustCredits, sellPackage } from "@/server/offers/packages";
import { getAppointmentRouting } from "@/server/routing-forms/trace";
import { getSeriesView } from "@/server/series";
import type { StaffContext } from "@/server/staff-context";
import { getStaffVideo } from "@/server/video/visit-service";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const describeLocal = isLocalDatabase(runtimeUrl) && isLocalDatabase(ownerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

/**
 * Records that hang off a customer, a class, a series or a visit (packages, memberships, merges, routing traces, video):
 * someone limited to branch B must not reach branch A's, and must still work with B's.
 */
describeLocal("branch-limited access to offers, classes, series, merges, routing and video", () => {
  let owner: postgres.Sql;
  let fixture: TenantFixture;
  let locationA = "";
  let locationB = "";
  let everyone: StaffContext; // admin, no limit
  let limitedB: StaffContext; // admin limited to the second branch
  let practitionerB: StaffContext; // the practitioner, limited to the second branch
  let customerA = "";
  let customerB = "";
  let visitA = "";
  let visitB = "";
  let packageId = "";
  let planId = "";
  let heldA = "";
  let heldB = "";
  let membershipA = "";
  let sessionA = "";
  let sessionB = "";
  let seriesA = "";
  let seriesB = "";
  const duplicates: Record<"a1" | "a2" | "b1" | "b2", string> = { a1: "", a2: "", b1: "", b2: "" };

  async function visit(locationId: string, patientId: string): Promise<string> {
    const starts = new Date(Date.now() + 3 * 86_400_000 + Math.floor(Math.random() * 1_000) * 60_000).toISOString();
    const [row] = await owner<{ id: string }[]>`
      insert into appointments (tenant_id, location_id, patient_id, practitioner_id, service_id, starts_at, ends_at, status, booking_source, manage_token_hash, price_minor)
      values (${fixture.tenantId}, ${locationId}, ${patientId}, ${fixture.practitionerId}, ${fixture.serviceId},
        ${starts}::timestamptz, ${starts}::timestamptz + interval '30 minutes', 'booked', 'staff', ${randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "")}, 50000)
      returning id`;
    return row!.id;
  }

  async function series(locationId: string, patientId: string): Promise<string> {
    const rule = { frequency: "weekly", interval: 1, weekdays: [], end: { kind: "count", count: 3 } };
    const [row] = await owner<{ id: string }[]>`
      insert into appointment_series (tenant_id, patient_id, service_id, practitioner_id, location_id, rule_text, rule, starts_on, time_of_day, duration_minutes, occurrence_count)
      values (${fixture.tenantId}, ${patientId}, ${fixture.serviceId}, ${fixture.practitionerId}, ${locationId}, 'RRULE:FREQ=WEEKLY;COUNT=3', ${owner.json(rule)}, '2030-01-07', '10:00', 30, 3)
      returning id`;
    return row!.id;
  }

  async function heldPackage(patientId: string): Promise<string> {
    const [row] = await owner<{ id: string }[]>`
      insert into customer_packages (tenant_id, patient_id, package_id, name, credits_total, service_ids, expires_at)
      values (${fixture.tenantId}, ${patientId}, ${packageId}, 'Five visits', 5, ${[fixture.serviceId]}, now() + interval '30 days') returning id`;
    await owner`insert into customer_credits (tenant_id, customer_package_id, "change", kind, reason) values (${fixture.tenantId}, ${row!.id}, 5, 'purchase', 'Package bought')`;
    return row!.id;
  }

  async function routed(appointmentId: string): Promise<void> {
    const [form] = await owner<{ id: string }[]>`
      insert into routing_forms (tenant_id, name, slug, definition) values (${fixture.tenantId}, 'Intake', ${`intake-${randomUUID().slice(0, 8)}`}, '{}'::jsonb) returning id`;
    await owner`insert into routing_form_versions (tenant_id, form_id, version, name, definition) values (${fixture.tenantId}, ${form!.id}, 1, 'Intake', '{}'::jsonb)`;
    const trace = { routes: [], matchedRouteId: "r1", matchedRouteName: "Everyone", people: [] };
    await owner`
      insert into routing_responses (tenant_id, form_id, form_version, token_hash, route_name, trace, outcome, appointment_id, booked_at, expires_at)
      values (${fixture.tenantId}, ${form!.id}, 1, ${randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "")}, 'Everyone', ${owner.json(trace)}, 'booked', ${appointmentId}, now(), now() + interval '1 day')`;
  }

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 2, prepare: false });
    fixture = await createTenant(owner, "records-scope");
    locationA = fixture.locationId;
    const [second] = await owner<{ id: string }[]>`
      insert into locations (tenant_id, name, address, city, timezone) values (${fixture.tenantId}, 'Second branch', '2 Test Road', 'Hyderabad', 'Asia/Kolkata') returning id`;
    locationB = second!.id;
    await owner`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${fixture.tenantId}, ${fixture.practitionerId}, ${locationB}) on conflict do nothing`;
    await owner`insert into service_locations (tenant_id, service_id, location_id) values (${fixture.tenantId}, ${fixture.serviceId}, ${locationB}) on conflict do nothing`;

    everyone = await contextForMember(fixture, await addMember(owner, fixture.tenantId, "admin"));
    limitedB = await contextForMember(fixture, await addMember(owner, fixture.tenantId, "admin"), { locationIds: [locationB] });
    const practitionerMember = await addMember(owner, fixture.tenantId, "practitioner");
    await owner`update practitioners set auth_user_id = ${practitionerMember.userId} where id = ${fixture.practitionerId}`;
    practitionerB = await contextForMember(fixture, practitionerMember, { locationIds: [locationB] });

    customerA = (await createCustomer(owner, fixture.tenantId)).id;
    customerB = (await createCustomer(owner, fixture.tenantId)).id;
    visitA = await visit(locationA, customerA);
    visitB = await visit(locationB, customerB);

    // Two pairs of the same person, one pair seen only at each branch.
    for (const [key, locationId, phone] of [["a1", locationA, "+919800000011"], ["a2", locationA, "+919800000011"], ["b1", locationB, "+919800000022"], ["b2", locationB, "+919800000022"]] as const) {
      duplicates[key] = (await createCustomer(owner, fixture.tenantId, { phone })).id;
      await visit(locationId, duplicates[key]);
    }

    const [pack] = await owner<{ id: string }[]>`
      insert into packages (tenant_id, name, price_minor, credits, valid_days, service_ids) values (${fixture.tenantId}, 'Five visits', 20000, 5, 90, ${[fixture.serviceId]}) returning id`;
    packageId = pack!.id;
    const [plan] = await owner<{ id: string }[]>`
      insert into membership_plans (tenant_id, name, price_minor, credits_per_period, service_ids) values (${fixture.tenantId}, 'Monthly', 5000, 2, ${[fixture.serviceId]}) returning id`;
    planId = plan!.id;
    heldA = await heldPackage(customerA);
    heldB = await heldPackage(customerB);
    const [member] = await owner<{ id: string }[]>`
      insert into customer_memberships (tenant_id, patient_id, plan_id, provider, provider_subscription_id, status, current_period_end, started_at)
      values (${fixture.tenantId}, ${customerA}, ${planId}, 'manual', ${`manual_${randomUUID()}`}, 'active', now() + interval '10 days', now()) returning id`;
    membershipA = member!.id;

    const [classService] = await owner<{ id: string }[]>`
      insert into services (tenant_id, name, description, duration_minutes, booking_mode, patient_types, kind, capacity)
      values (${fixture.tenantId}, 'Group class', 'A class', 60, 'instant', ${["new", "returning"]}, 'class', 8) returning id`;
    for (const [locationId, label] of [[locationA, "a"], [locationB, "b"]] as const) {
      const [row] = await owner<{ id: string }[]>`
        insert into class_sessions (tenant_id, service_id, practitioner_id, location_id, starts_at, ends_at, capacity)
        values (${fixture.tenantId}, ${classService!.id}, ${fixture.practitionerId}, ${locationId}, now() + interval '1 day', now() + interval '1 day 1 hour', 8) returning id`;
      if (label === "a") sessionA = row!.id; else sessionB = row!.id;
    }

    seriesA = await series(locationA, customerA);
    seriesB = await series(locationB, customerB);
    await routed(visitA);
    await routed(visitB);
  });

  afterAll(async () => {
    if (!owner) return;
    await owner`delete from outbox_events where tenant_id = ${fixture.tenantId}`.catch(() => undefined);
    await owner`update tenants set is_active = false where id = ${fixture.tenantId}`.catch(() => undefined);
    await owner.end();
  });

  it("sells a package only at an allowed location and only to a customer the person can see", async () => {
    const sale = (patientId: string, locationId: string) => ({ patientId, packageId, locationId, payments: [{ method: "cash" as const, amountMinor: 1000 }] });
    // Booked to the other branch: refused outright.
    await expect(sellPackage(limitedB, sale(customerB, locationA), randomUUID())).rejects.toMatchObject({ status: 403, code: "location_not_allowed" });
    // A customer who has only been seen at the other branch is not there.
    await expect(sellPackage(limitedB, sale(customerA, locationB), randomUUID())).rejects.toMatchObject({ status: 404 });
    await expect(sellPackage(limitedB, sale(customerB, locationB), randomUUID())).resolves.toMatchObject({ patientId: customerB });
    // Nobody is limited: both work.
    await expect(sellPackage(everyone, sale(customerA, locationA), randomUUID())).resolves.toMatchObject({ patientId: customerA });
  });

  it("adjusts credits only on packages held by customers the person can see", async () => {
    await expect(adjustCredits(limitedB, heldA, { change: 1, reason: "Goodwill" }, randomUUID())).rejects.toMatchObject({ status: 404 });
    await expect(adjustCredits(limitedB, heldB, { change: 1, reason: "Goodwill" }, randomUUID())).resolves.toMatchObject({ id: heldB, remaining: 6 });
    await expect(adjustCredits(everyone, heldA, { change: 1, reason: "Goodwill" }, randomUUID())).resolves.toMatchObject({ id: heldA, remaining: 6 });
  });

  it("enrols, renews and changes memberships only for customers the person can see", async () => {
    await expect(enrolMembership(limitedB, { patientId: customerA, planId, method: "cash" }, randomUUID())).rejects.toMatchObject({ status: 404 });
    await expect(renewMembership(limitedB, membershipA, "cash", randomUUID())).rejects.toMatchObject({ status: 404 });
    await expect(changeMembership(limitedB, membershipA, "pause")).rejects.toMatchObject({ status: 404 });
    await expect(enrolMembership(limitedB, { patientId: customerB, planId, method: "cash" }, randomUUID())).resolves.toMatchObject({ patientId: customerB });
    await expect(enrolMembership(everyone, { patientId: customerA, planId: planId, method: "cash" }, randomUUID())).rejects.toMatchObject({ code: "already_member" });
    await expect(changeMembership(everyone, membershipA, "pause")).resolves.toMatchObject({ id: membershipA, status: "paused" });
  });

  it("messages a class's roster only for a session at an allowed location", async () => {
    const note = { message: "Class moved", audience: "booked" as const };
    await expect(messageEveryone(limitedB, sessionA, note, randomUUID())).rejects.toMatchObject({ status: 404, code: "session_not_found" });
    await expect(messageEveryone(limitedB, sessionB, note, randomUUID())).resolves.toEqual({ queued: 0 });
    await expect(messageEveryone(everyone, sessionA, note, randomUUID())).resolves.toEqual({ queued: 0 });
  });

  it("opens a repeating series only at an allowed location", async () => {
    await expect(getSeriesView(limitedB, seriesA)).rejects.toMatchObject({ status: 404, code: "series_not_found" });
    await expect(getSeriesView(limitedB, seriesB)).resolves.toMatchObject({ id: seriesB, locationId: locationB });
    await expect(getSeriesView(everyone, seriesA)).resolves.toMatchObject({ id: seriesA });
  });

  it("merges only customers the person can see, and suggests only those", async () => {
    const ids = Object.values(duplicates);
    const seen = (pairs: Awaited<ReturnType<typeof suggestDuplicates>>) => pairs.filter((pair) => ids.includes(pair.a.id) && ids.includes(pair.b.id)).map((pair) => [pair.a.id, pair.b.id].sort().join("|")).sort();
    const pairA = [duplicates.a1, duplicates.a2].sort().join("|");
    const pairB = [duplicates.b1, duplicates.b2].sort().join("|");
    expect(seen(await suggestDuplicates(limitedB))).toEqual([pairB]);
    expect(seen(await suggestDuplicates(everyone))).toEqual([pairA, pairB].sort());

    await expect(mergeCustomers(limitedB, { keepId: duplicates.a1, mergeId: duplicates.a2 }, randomUUID())).rejects.toMatchObject({ status: 404 });
    await expect(mergeCustomers(limitedB, { keepId: duplicates.b1, mergeId: duplicates.a1 }, randomUUID())).rejects.toMatchObject({ status: 404 });
    await expect(mergeCustomers(limitedB, { keepId: duplicates.b1, mergeId: duplicates.b2 }, randomUUID())).resolves.toBeDefined();
    await expect(mergeCustomers(everyone, { keepId: duplicates.a1, mergeId: duplicates.a2 }, randomUUID())).resolves.toBeDefined();
  });

  it("shows a booking's routing trace only for a visit at an allowed location", async () => {
    await expect(getAppointmentRouting(limitedB, visitA)).rejects.toMatchObject({ status: 404, code: "appointment_not_found" });
    await expect(getAppointmentRouting(limitedB, visitB)).resolves.toMatchObject({ routeName: "Everyone" });
    await expect(getAppointmentRouting(everyone, visitA)).resolves.toMatchObject({ routeName: "Everyone" });
  });

  it("applies the location rule to a practitioner's own video visits too", async () => {
    // Both visits are the practitioner's own; the one at the other branch is not theirs to open.
    await expect(getStaffVideo(practitionerB, visitA)).rejects.toMatchObject({ status: 404, code: "appointment_not_found" });
    const own = await getStaffVideo(practitionerB, visitB).then(() => null, (cause: unknown) => cause);
    expect(own).not.toMatchObject({ code: "appointment_not_found" });
    expect(own).not.toMatchObject({ status: 403 });
    const unlimited = await getStaffVideo({ ...practitionerB, locationIds: null }, visitA).then(() => null, (cause: unknown) => cause);
    expect(unlimited).not.toMatchObject({ code: "appointment_not_found" });
  });
});
