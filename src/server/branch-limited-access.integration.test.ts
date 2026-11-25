/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { bookingQuerySchema } from "@/lib/bookings-list";
import { addMember, contextForMember, type MemberFixture } from "@/test/enterprise-fixture";
import { isLocalDatabase } from "@/test/billing-fixture";
import { createCustomer, createTenant, staffContext, type TenantFixture } from "@/test/privacy-fixture";

import { mutateStaffAppointment, createStaffAppointment, updateAppointmentStatus } from "@/server/appointment-repository";
import { listBookings } from "@/server/bookings-list";
import { getSession, listSessions } from "@/server/classes";
import { staffBookingSchema, type StaffBookingInput } from "@/server/contracts";
import { loadCustomerSummary } from "@/server/customers/profile";
import { getBookingHistory } from "@/server/booking-history";
import { loadAppointmentFormAnswers } from "@/server/booking-forms";
import { getVisitPayments } from "@/server/payments";
import { updateStaffPatient } from "@/server/staff-operations";
import { callNextTicket, updateQueueTicket } from "@/server/queue";
import { runReport } from "@/server/reports/service";
import { sendQuickMessage } from "@/server/quick-messages";
import type { StaffContext } from "@/server/staff-context";
import { createStaffWaitlist } from "@/server/staff-operations";
import { getStaffSnapshot, searchStaffPatients } from "@/server/staff-repository";
import { updateStaffMember } from "@/server/staff-team";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const describeLocal = isLocalDatabase(runtimeUrl) && isLocalDatabase(ownerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

/** A business with two branches: a receptionist limited to the first sees and acts there only. */
describeLocal("branch-limited staff access", () => {
  let owner: postgres.Sql;
  let runtime: postgres.Sql;
  let fixture: TenantFixture;
  let other: TenantFixture;
  let locationA = "";
  let locationB = "";
  let ownerMember: MemberFixture;
  let receptionist: MemberFixture;
  let ownerContext: StaffContext;
  let limited: StaffContext;
  let visitA = "";
  let visitB = "";
  let ticketA = "";
  let ticketB = "";
  let customerA = "";
  let customerB = "";
  let customerNew = "";
  let sessionA = "";
  let sessionB = "";

  async function visit(locationId: string, patientId: string, starts: string): Promise<string> {
    const [row] = await owner<{ id: string }[]>`
      insert into appointments (tenant_id, location_id, patient_id, practitioner_id, service_id, starts_at, ends_at, status, booking_source, manage_token_hash, price_minor)
      values (${fixture.tenantId}, ${locationId}, ${patientId}, ${fixture.practitionerId}, ${fixture.serviceId},
        ${starts}::timestamptz, ${starts}::timestamptz + interval '30 minutes', 'checked_in', 'staff', ${randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "")}, 50000)
      returning id`;
    return row!.id;
  }

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 1, prepare: false });
    runtime = postgres(runtimeUrl!, { max: 1, prepare: false });
    fixture = await createTenant(owner, "branch");
    other = await createTenant(owner, "branch-other");
    locationA = fixture.locationId;
    const [second] = await owner<{ id: string }[]>`
      insert into locations (tenant_id, name, address, city, timezone) values (${fixture.tenantId}, 'Second branch', '2 Test Road', 'Hyderabad', 'Asia/Kolkata') returning id`;
    locationB = second!.id;
    await owner`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${fixture.tenantId}, ${fixture.practitionerId}, ${locationB}) on conflict do nothing`;
    await owner`insert into service_locations (tenant_id, service_id, location_id) values (${fixture.tenantId}, ${fixture.serviceId}, ${locationB}) on conflict do nothing`;

    ownerMember = await addMember(owner, fixture.tenantId, "owner");
    receptionist = await addMember(owner, fixture.tenantId, "receptionist");
    ownerContext = await contextForMember(fixture, ownerMember);

    customerA = (await createCustomer(owner, fixture.tenantId)).id;
    customerB = (await createCustomer(owner, fixture.tenantId)).id;
    customerNew = (await createCustomer(owner, fixture.tenantId)).id;
    visitA = await visit(locationA, customerA, new Date(Date.now() + 40 * 60_000).toISOString());
    visitB = await visit(locationB, customerB, new Date(Date.now() + 80 * 60_000).toISOString());
    for (const [id, locationId, state] of [[visitA, locationA, "a"], [visitB, locationB, "b"]] as const) {
      const [ticket] = await owner<{ id: string }[]>`
        insert into queue_tickets (tenant_id, location_id, day, number, appointment_id)
        select ${fixture.tenantId}, location.id, (now() at time zone location.timezone)::date, 1, ${id} from locations location where location.id = ${locationId}
        returning id`;
      if (state === "a") ticketA = ticket!.id; else ticketB = ticket!.id;
    }
    const [classService] = await owner<{ id: string }[]>`
      insert into services (tenant_id, name, description, duration_minutes, booking_mode, patient_types, kind, capacity)
      values (${fixture.tenantId}, 'Group class', 'A class', 60, 'instant', ${["new", "returning"]}, 'class', 8) returning id`;
    for (const [locationId, label] of [[locationA, "a"], [locationB, "b"]] as const) {
      const [row] = await owner<{ id: string }[]>`
        insert into class_sessions (tenant_id, service_id, practitioner_id, location_id, starts_at, ends_at, capacity)
        values (${fixture.tenantId}, ${classService!.id}, ${fixture.practitionerId}, ${locationId}, now() + interval '1 day', now() + interval '1 day 1 hour', 8) returning id`;
      if (label === "a") sessionA = row!.id; else sessionB = row!.id;
    }

    // The owner limits the receptionist to the first branch, the way the Edit access dialog does.
    await updateStaffMember(ownerContext, receptionist.membershipId, { locationIds: [locationA] });
    // The context getStaffContext builds: the locations come from the staff-access function, as the runtime role.
    const [access] = await runtime<{ location_ids: string[] }[]>`select location_ids from kalendr_resolve_staff_access(${receptionist.userId})`;
    limited = await contextForMember(fixture, receptionist, { locationIds: access!.location_ids });
  });

  afterAll(async () => {
    if (!owner) return;
    for (const tenantId of [fixture?.tenantId, other?.tenantId].filter((id): id is string => Boolean(id))) {
      await owner`delete from outbox_events where tenant_id = ${tenantId}`.catch(() => undefined);
      await owner`update tenants set is_active = false where id = ${tenantId}`.catch(() => undefined);
    }
    await runtime.end();
    await owner.end();
  });

  it("hands the allowed locations to the runtime role with no business selected, and keeps them private to the business", async () => {
    const [access] = await runtime<{ location_ids: string[] }[]>`select location_ids from kalendr_resolve_staff_access(${receptionist.userId})`;
    expect(access?.location_ids).toEqual([locationA]);
    const [everyone] = await runtime<{ location_ids: string[] }[]>`select location_ids from kalendr_resolve_staff_access(${ownerMember.userId})`;
    expect(everyone?.location_ids).toEqual([]);
    // The table itself is under forced row-level security: no business selected sees nothing, and another business sees nothing.
    expect(await runtime`select 1 from membership_locations`).toHaveLength(0);
    const seenByOther = await runtime.begin(async (transaction) => {
      await transaction`select set_config('app.tenant_id', ${other.tenantId}, true)`;
      return transaction`select 1 from membership_locations`;
    });
    expect(seenByOther).toHaveLength(0);
    const seenByOwn = await runtime.begin(async (transaction) => {
      await transaction`select set_config('app.tenant_id', ${fixture.tenantId}, true)`;
      return transaction`select location_id from membership_locations`;
    });
    expect(seenByOwn.map((row) => row.location_id)).toEqual([locationA]);
  });

  it("shows the limited person only their branch in the snapshot, and the owner both", async () => {
    const mine = await getStaffSnapshot(limited);
    expect(mine.appointments.map((row) => row.id)).toEqual([visitA]);
    expect(mine.catalog.locations.map((row) => row.id)).toEqual([locationA]);
    const patientIds = mine.patients.map((row) => row.id);
    expect(patientIds).toContain(customerA);
    expect(patientIds).toContain(customerNew); // no visit anywhere yet: not tied to a branch
    expect(patientIds).not.toContain(customerB);
    expect(JSON.stringify(mine.historicalNames.locations)).not.toContain("Second branch");
    expect(mine.team).toEqual([]); // team.manage is not a receptionist permission

    const all = await getStaffSnapshot(ownerContext);
    expect(all.appointments.map((row) => row.id).sort()).toEqual([visitA, visitB].sort());
    expect(all.catalog.locations.map((row) => row.id).sort()).toEqual([locationA, locationB].sort());
    expect(all.team.find((row) => row.membershipId === receptionist.membershipId)?.locationIds).toEqual([locationA]);
  });

  it("lists bookings, searches customers and opens profiles at the allowed branch only", async () => {
    const query = bookingQuerySchema.parse({ tab: "upcoming" });
    expect((await listBookings(limited, query)).rows.map((row) => row.id)).toEqual([visitA]);
    expect((await listBookings(ownerContext, query)).rows.map((row) => row.id).sort()).toEqual([visitA, visitB].sort());

    const found = await searchStaffPatients(limited, "", 50);
    expect(found.patients.map((row) => row.id)).not.toContain(customerB);
    expect(found.patients.map((row) => row.id)).toContain(customerA);

    await expect(loadCustomerSummary(limited, customerA)).resolves.toBeDefined();
    await expect(loadCustomerSummary(limited, customerNew)).resolves.toBeDefined();
    await expect(loadCustomerSummary(limited, customerB)).rejects.toMatchObject({ status: 404 });
    await expect(loadCustomerSummary(ownerContext, customerB)).resolves.toBeDefined();
  });

  it("works the queue, messages and history for the allowed branch and answers 404 for the other", async () => {
    await expect(updateQueueTicket(limited, ticketB, { action: "call_again" })).rejects.toMatchObject({ status: 404 });
    await expect(updateQueueTicket(limited, ticketA, { action: "call_again" })).resolves.toBeDefined();
    expect(await callNextTicket(limited, { locationId: locationB })).toBeNull();
    await expect(sendQuickMessage(limited, visitB, { kind: "your_turn" }, randomUUID())).rejects.toMatchObject({ status: 404 });
    await expect(getBookingHistory(limited, visitB)).rejects.toMatchObject({ status: 404 });
    await expect(getBookingHistory(limited, visitA)).resolves.toBeDefined();
    // The owner reaches the second branch's ticket.
    await expect(updateQueueTicket(ownerContext, ticketB, { action: "call_again" })).resolves.toBeDefined();
  });

  it("refuses changes to the other branch's visit as not found, and booking there as forbidden", async () => {
    await expect(mutateStaffAppointment(limited, visitB, { action: "details", notes: "x", expectedVersion: 1 })).rejects.toMatchObject({ status: 404 });
    await expect(updateAppointmentStatus(limited.userId ?? "", visitB, { status: "no_show", expectedVersion: 1 }, undefined, { locationIds: limited.locationIds })).rejects.toMatchObject({ status: 404 });
    await expect(mutateStaffAppointment(ownerContext, visitB, { action: "details", notes: "x", expectedVersion: 1 })).resolves.toBeDefined();

    const booking: StaffBookingInput = staffBookingSchema.parse({
      clinicSlug: fixture.slug, locationId: locationB, serviceId: fixture.serviceId, practitionerId: fixture.practitionerId,
      startsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(), patientId: customerNew,
    });
    await expect(createStaffAppointment(limited, booking, randomUUID(), "hash")).rejects.toMatchObject({ status: 403, code: "location_not_allowed" });
    await expect(createStaffWaitlist(limited, {
      patientId: customerNew, serviceId: fixture.serviceId, locationId: locationB, preferredPractitionerIds: [], dateFrom: "2030-01-01", dateTo: "2030-01-02", timePreference: "any",
    })).rejects.toMatchObject({ status: 403, code: "location_not_allowed" });
  });

  it("keeps a visit's payments, form answers and the customer's details to the allowed branch", async () => {
    await expect(getVisitPayments(limited, visitB)).rejects.toMatchObject({ status: 404 });
    await expect(getVisitPayments(limited, visitA)).resolves.toBeDefined();
    await expect(loadAppointmentFormAnswers(limited, visitB)).rejects.toMatchObject({ status: 404 });
    await expect(updateStaffPatient(limited, customerB, { firstName: "Changed" })).rejects.toMatchObject({ status: 404 });
    await expect(updateStaffPatient(limited, customerA, { firstName: "Changed" })).resolves.toBeDefined();
  });

  it("shows the limited person only their branch's classes and reports", async () => {
    const range = { from: new Date(), to: new Date(Date.now() + 3 * 86_400_000) };
    expect((await listSessions(limited, range)).map((row) => row.id)).toEqual([sessionA]);
    await expect(getSession(limited, sessionB)).rejects.toMatchObject({ status: 404 });
    expect((await listSessions(ownerContext, range)).map((row) => row.id).sort()).toEqual([sessionA, sessionB].sort());

    const admin = await contextForMember(fixture, await addMember(owner, fixture.tenantId, "admin"), { locationIds: [locationA] });
    const day = new Date().toISOString().slice(0, 10);
    const params = { from: day, to: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10) };
    const limitedReport = await runReport(admin, "bookings", params);
    const fullReport = await runReport({ ...admin, locationIds: null }, "bookings", params);
    expect(limitedReport.metrics[0]?.value).toBe(1);
    expect(fullReport.metrics[0]?.value).toBe(2);
  });

  it("guards who may limit whom", async () => {
    const adminMember = await addMember(owner, fixture.tenantId, "admin");
    const adminContext = await contextForMember(fixture, adminMember);
    // An owner is never limited, and an admin can't touch the owner's access.
    await expect(updateStaffMember(adminContext, ownerMember.membershipId, { locationIds: [locationA] })).rejects.toMatchObject({ code: "owner_required" });
    // Nobody changes their own access.
    await expect(updateStaffMember(adminContext, adminMember.membershipId, { locationIds: [locationA] })).rejects.toMatchObject({ code: "own_access" });
    // A fresh second factor is needed.
    await expect(updateStaffMember(staffContext(fixture, { secondFactorAt: null, userId: ownerMember.userId }), receptionist.membershipId, { locationIds: [locationB] })).rejects.toMatchObject({ status: 403 });
    // The other business's location is not a choice.
    const stranger = await owner<{ id: string }[]>`select id from locations where tenant_id = ${other.tenantId} limit 1`;
    await expect(updateStaffMember(ownerContext, receptionist.membershipId, { locationIds: [stranger[0]!.id] })).rejects.toMatchObject({ status: 400, code: "location_not_found" });
    // A limited admin can hand out only their own locations and can't lift a limit.
    const limitedAdmin = await contextForMember(fixture, adminMember, { locationIds: [locationA] });
    const helper = await addMember(owner, fixture.tenantId, "receptionist");
    // Someone who sees every location is out of reach of a limited admin altogether.
    await expect(updateStaffMember(limitedAdmin, helper.membershipId, { locationIds: [locationA] })).rejects.toMatchObject({ code: "cannot_manage_location" });
    await owner`insert into membership_locations (tenant_id, membership_id, location_id) values (${fixture.tenantId}, ${helper.membershipId}, ${locationA})`;
    await expect(updateStaffMember(limitedAdmin, helper.membershipId, { locationIds: [locationB] })).rejects.toMatchObject({ code: "cannot_grant" });
    await expect(updateStaffMember(limitedAdmin, helper.membershipId, { locationIds: [] })).rejects.toMatchObject({ code: "cannot_grant" });
    await expect(updateStaffMember(limitedAdmin, helper.membershipId, { locationIds: [locationA] })).resolves.toBeDefined();
  });

  it("writes one audit row with location ids only, and lifting the limit shows everything again", async () => {
    const [audit] = await owner<{ metadata: { locations?: { from: string[]; to: string[] } } }[]>`
      select metadata from audit_events where tenant_id = ${fixture.tenantId} and action = 'staff.member.locations_changed' and metadata->>'membershipId' = ${receptionist.membershipId}
      order by occurred_at limit 1`;
    expect(audit?.metadata.locations).toEqual({ from: [], to: [locationA] });
    expect(JSON.stringify(audit?.metadata)).not.toContain("@");

    await updateStaffMember(ownerContext, receptionist.membershipId, { locationIds: [] });
    const [access] = await runtime<{ location_ids: string[] }[]>`select location_ids from kalendr_resolve_staff_access(${receptionist.userId})`;
    expect(access?.location_ids).toEqual([]);
    const everything = await contextForMember(fixture, receptionist, { locationIds: null });
    expect((await getStaffSnapshot(everything)).appointments.map((row) => row.id).sort()).toEqual([visitA, visitB].sort());
  });
});
