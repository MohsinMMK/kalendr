/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withTenant } from "@/db/client";
import { STAFF_DIGEST_EVENT } from "@/lib/staff-alerts";
import { addMember, contextForMember, type MemberFixture } from "@/test/enterprise-fixture";
import { isLocalDatabase } from "@/test/billing-fixture";
import { createCustomer, createTenant, type TenantFixture } from "@/test/privacy-fixture";

import { searchStaff } from "@/server/search/staff-search";
import type { StaffContext } from "@/server/staff-context";
import { notifyStaff } from "@/server/staff-notifications";
import { createStaffPractitioner, updateStaffMember, updateStaffPractitioner } from "@/server/staff-team";
import { assignThread, getThread, listThreads, markThreadRead, sendThreadReply } from "@/server/threads";
import { postgresRunner } from "@/server/workflows/runner";
import { alertStaff } from "@/worker/payments/alerts";
import { remindAboutRequests } from "@/worker/request-jobs";
import { sendStaffDigests } from "@/worker/staff-digest-jobs";
import { notifyStaffFromWorker } from "@/worker/staff-alerts";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const describeLocal = isLocalDatabase(runtimeUrl) && isLocalDatabase(ownerUrl) && Boolean(workerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

/** The rest of what a person limited to one branch sees: alerts, the morning digest, the inbox, search and doctor profiles. */
describeLocal("branch-limited staff access beyond the main screens", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  let fixture: TenantFixture;
  let locationA = "";
  let locationB = "";
  let ownerMember: MemberFixture;
  let receptionist: MemberFixture;
  let admin: MemberFixture;
  let ownerContext: StaffContext;
  let limited: StaffContext;
  let limitedAdmin: StaffContext;
  let visitA = "";
  let visitB = "";
  let customerA = "";
  let customerB = "";
  let customerNew = "";
  const surname = `Brightwater${randomUUID().slice(0, 6)}`;

  async function visit(locationId: string, patientId: string, starts: string, status = "booked"): Promise<string> {
    const [row] = await owner<{ id: string }[]>`
      insert into appointments (tenant_id, location_id, patient_id, practitioner_id, service_id, starts_at, ends_at, status, booking_source, manage_token_hash, price_minor)
      values (${fixture.tenantId}, ${locationId}, ${patientId}, ${fixture.practitionerId}, ${fixture.serviceId},
        ${starts}::timestamptz, ${starts}::timestamptz + interval '30 minutes', ${status}, 'staff', ${randomUUID().replaceAll("-", "") + randomUUID().replaceAll("-", "")}, 50000)
      returning id`;
    return row!.id;
  }

  const recipients = async (dedupeKey: string) => (await owner<{ membership_id: string }[]>`
    select membership_id from staff_notifications where tenant_id = ${fixture.tenantId} and dedupe_key = ${dedupeKey}`).map((row) => row.membership_id);

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 1, prepare: false });
    worker = postgres(workerUrl!, { max: 2, prepare: false });
    fixture = await createTenant(owner, "branch-extras");
    locationA = fixture.locationId;
    const [second] = await owner<{ id: string }[]>`
      insert into locations (tenant_id, name, address, city, timezone) values (${fixture.tenantId}, 'Second branch', '2 Test Road', 'Hyderabad', 'Asia/Kolkata') returning id`;
    locationB = second!.id;
    await owner`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${fixture.tenantId}, ${fixture.practitionerId}, ${locationA}), (${fixture.tenantId}, ${fixture.practitionerId}, ${locationB}) on conflict do nothing`;
    await owner`insert into service_locations (tenant_id, service_id, location_id) values (${fixture.tenantId}, ${fixture.serviceId}, ${locationB}) on conflict do nothing`;

    ownerMember = await addMember(owner, fixture.tenantId, "owner");
    receptionist = await addMember(owner, fixture.tenantId, "receptionist");
    admin = await addMember(owner, fixture.tenantId, "admin");
    ownerContext = await contextForMember(fixture, ownerMember);
    await updateStaffMember(ownerContext, receptionist.membershipId, { locationIds: [locationA] });
    limited = await contextForMember(fixture, receptionist, { locationIds: [locationA] });
    limitedAdmin = await contextForMember(fixture, admin, { locationIds: [locationA] });

    customerA = (await createCustomer(owner, fixture.tenantId, { lastName: surname })).id;
    customerB = (await createCustomer(owner, fixture.tenantId, { lastName: surname })).id;
    customerNew = (await createCustomer(owner, fixture.tenantId, { lastName: surname })).id;
    visitA = await visit(locationA, customerA, new Date(Date.now() + 2 * 86_400_000).toISOString());
    visitB = await visit(locationB, customerB, new Date(Date.now() + 2 * 86_400_000 + 3_600_000).toISOString());
  });

  afterAll(async () => {
    if (!owner) return;
    if (fixture?.tenantId) {
      await owner`delete from outbox_events where tenant_id = ${fixture.tenantId}`.catch(() => undefined);
      await owner`update tenants set is_active = false where id = ${fixture.tenantId}`.catch(() => undefined);
    }
    await worker.end();
    await owner.end();
  });

  it("tells the owner, an unlimited admin and staff at the visit's branch, and nobody limited elsewhere", async () => {
    const atB = `test:${randomUUID()}`;
    await withTenant(fixture.tenantId, (transaction) => notifyStaff(transaction, fixture.tenantId, { kind: "new_booking", appointmentId: visitB, dedupeKey: atB }));
    const toldB = await recipients(atB);
    expect(toldB).toEqual(expect.arrayContaining([ownerMember.membershipId, admin.membershipId]));
    expect(toldB).not.toContain(receptionist.membershipId);

    const atA = `test:${randomUUID()}`;
    await withTenant(fixture.tenantId, (transaction) => notifyStaff(transaction, fixture.tenantId, { kind: "new_booking", appointmentId: visitA, dedupeKey: atA }));
    expect(await recipients(atA)).toEqual(expect.arrayContaining([ownerMember.membershipId, admin.membershipId, receptionist.membershipId]));

    // An alert with only a location (a class seat, a waitlist offer) follows the same rule.
    const placeB = `test:${randomUUID()}`;
    await withTenant(fixture.tenantId, (transaction) => notifyStaff(transaction, fixture.tenantId, { kind: "waitlist_filled", locationId: locationB, dedupeKey: placeB }));
    expect(await recipients(placeB)).toEqual(expect.arrayContaining([ownerMember.membershipId, admin.membershipId]));
    expect(await recipients(placeB)).not.toContain(receptionist.membershipId);
    const placeA = `test:${randomUUID()}`;
    await withTenant(fixture.tenantId, (transaction) => notifyStaff(transaction, fixture.tenantId, { kind: "waitlist_filled", locationId: locationA, dedupeKey: placeA }));
    expect(await recipients(placeA)).toContain(receptionist.membershipId);
  });

  it("tells limited staff about a customer's message only when they could open that customer", async () => {
    const send = async (patientId: string) => {
      const dedupeKey = `message:${randomUUID()}`;
      await worker.begin(async (transaction) => {
        await transaction`select set_config('app.tenant_id', ${fixture.tenantId}, true)`;
        await notifyStaffFromWorker(transaction, fixture.tenantId, { kind: "message", dedupeKey, link: "/messages", patientId });
      });
      return recipients(dedupeKey);
    };
    const fromB = await send(customerB);
    expect(fromB).toEqual(expect.arrayContaining([ownerMember.membershipId, admin.membershipId]));
    expect(fromB).not.toContain(receptionist.membershipId);
    expect(await send(customerA)).toContain(receptionist.membershipId);
    expect(await send(customerNew)).toContain(receptionist.membershipId); // not seen anywhere yet
  });

  it("reminds and tells about payments only the staff who work at the visit's branch", async () => {
    // Requests waiting more than half the time to their start: one at each branch.
    const requestA = await visit(locationA, customerA, new Date(Date.now() + 2 * 86_400_000).toISOString(), "requested");
    const requestB = await visit(locationB, customerB, new Date(Date.now() + 2 * 86_400_000).toISOString(), "requested");
    await owner`update appointments set created_at = now() - interval '3 days' where id in (${requestA}, ${requestB})`;
    await remindAboutRequests(worker);
    const remindedB = await recipients(`request.reminder:${requestB}`);
    expect(remindedB).toEqual(expect.arrayContaining([ownerMember.membershipId, admin.membershipId]));
    expect(remindedB).not.toContain(receptionist.membershipId);
    expect(await recipients(`request.reminder:${requestA}`)).toContain(receptionist.membershipId);

    const pay = async (appointmentId: string) => {
      const dedupeKey = `payment:${randomUUID()}`;
      await worker.begin(async (transaction) => {
        await transaction`select set_config('app.tenant_id', ${fixture.tenantId}, true)`;
        await alertStaff(postgresRunner(transaction), fixture.tenantId, { kind: "payment", appointmentId, startsAt: new Date(), dedupeKey });
      });
      return recipients(dedupeKey);
    };
    const paidB = await pay(visitB);
    expect(paidB).toEqual(expect.arrayContaining([ownerMember.membershipId, admin.membershipId]));
    expect(paidB).not.toContain(receptionist.membershipId);
    expect(await pay(visitA)).toContain(receptionist.membershipId);
  });

  it("builds the morning digest from the person's own branches", async () => {
    const [tenant] = await owner<{ timezone: string }[]>`select timezone from tenants where id = ${fixture.tenantId}`;
    // Noon, local time, ten days from now: a day with one booking at each branch and nothing else.
    const [day] = await owner<{ noon: Date }[]>`select (((now() at time zone ${tenant!.timezone})::date + 10)::timestamp + interval '12 hours') at time zone ${tenant!.timezone} as noon`;
    const noon = day!.noon;
    await visit(locationA, customerA, new Date(noon.getTime() + 3_600_000).toISOString());
    await visit(locationB, customerB, new Date(noon.getTime() + 2 * 3_600_000).toISOString());
    await owner`delete from outbox_events where tenant_id = ${fixture.tenantId} and event_type = ${STAFF_DIGEST_EVENT}`;
    await owner`update memberships set digest_enabled = true, digest_minute = 0, digest_sent_on = null, quiet_start_minute = null, quiet_end_minute = null where tenant_id = ${fixture.tenantId}`;

    await sendStaffDigests(worker, () => noon);
    const rows = await owner<{ aggregate_id: string; payload: { todayCount: number } }[]>`
      select aggregate_id, payload from outbox_events where tenant_id = ${fixture.tenantId} and event_type = ${STAFF_DIGEST_EVENT}`;
    const countFor = (membershipId: string) => rows.find((row) => row.aggregate_id === membershipId)?.payload.todayCount;
    expect(countFor(ownerMember.membershipId)).toBe(2);
    expect(countFor(admin.membershipId)).toBe(2); // no location rows: every branch
    expect(countFor(receptionist.membershipId)).toBe(1);
  });

  it("keeps inbox threads to customers the person can open, and still shows a customer not seen anywhere", async () => {
    const thread = async (patientId: string) => (await owner<{ id: string }[]>`
      insert into message_threads (tenant_id, patient_id, channel, contact_hash) values (${fixture.tenantId}, ${patientId}, 'whatsapp', ${randomUUID()}) returning id`)[0]!.id;
    const threadA = await thread(customerA);
    const threadB = await thread(customerB);
    const threadNew = await thread(customerNew);

    const mine = (await listThreads(limited, "all")).map((row) => row.id);
    expect(mine).toEqual(expect.arrayContaining([threadA, threadNew]));
    expect(mine).not.toContain(threadB);
    expect((await listThreads(ownerContext, "all")).map((row) => row.id)).toEqual(expect.arrayContaining([threadA, threadB, threadNew]));

    await expect(getThread(limited, threadB)).rejects.toMatchObject({ status: 404 });
    await expect(markThreadRead(limited, threadB)).rejects.toMatchObject({ status: 404 });
    await expect(assignThread(limited, threadB, null)).rejects.toMatchObject({ status: 404 });
    await expect(getThread(limited, threadNew)).resolves.toBeDefined();
    await expect(markThreadRead(limited, threadA)).resolves.toBeDefined();
    await expect(assignThread(limited, threadA, null)).resolves.toBeDefined();

    // Customer A also has an earlier visit at the other branch: the next visit shown, and the one a template may name, is theirs.
    const elsewhere = await visit(locationB, customerA, new Date(Date.now() + 86_400_000).toISOString());
    expect((await getThread(ownerContext, threadA)).nextAppointment?.id).toBe(elsewhere);
    expect((await getThread(limited, threadA)).nextAppointment?.id).toBe(visitA);
    await expect(sendThreadReply(limited, threadA, { kind: "template", templateKey: "reminder", appointmentId: elsewhere }, randomUUID()))
      .rejects.toMatchObject({ status: 404, code: "appointment_not_found" });
    await expect(sendThreadReply(limited, threadA, { kind: "template", templateKey: "reminder", appointmentId: visitA }, randomUUID())).resolves.toMatchObject({ status: "queued" });
  });

  it("finds only the person's own branches in search", async () => {
    // An invoice at each branch, billed to a customer with the shared surname.
    for (const [sequence, locationId, patientId] of [[1, locationA, customerA], [2, locationB, customerB]] as const) {
      await owner`
        with made as (
          insert into invoices (tenant_id, financial_year, series, sequence, number, patient_id, location_id, kind, currency, prices_include_tax, taxable_minor, total_minor, supply, seller_legal_name, buyer_name)
          values (${fixture.tenantId}, '2026-27', 'TST', ${sequence}, ${`TST/2026-27/000${sequence}`}, ${patientId}, ${locationId}, 'tax_invoice', 'INR', false, 1000, 1000, 'none', 'Seller LLP', ${`Buyer ${surname}`})
          returning id)
        insert into invoice_lines (tenant_id, invoice_id, position, description, quantity, unit_price_minor, treatment, taxable_minor, total_minor)
        select ${fixture.tenantId}, id, 1, 'Consult', 1, 1000, 'nil', 1000, 1000 from made`;
    }
    const of = (hits: { kind: string; id: string }[], kind: string) => hits.filter((hit) => hit.kind === kind).map((hit) => hit.id);
    const hits = (await searchStaff(limitedAdmin, surname, 10)).hits;
    const customers = of(hits, "customer");
    expect(customers).toEqual(expect.arrayContaining([customerA, customerNew]));
    expect(customers).not.toContain(customerB);
    const appointments = of(hits, "appointment");
    expect(appointments).toContain(visitA);
    expect(appointments).not.toContain(visitB);
    const [invoiceA, invoiceB] = (await owner<{ id: string }[]>`select id from invoices where tenant_id = ${fixture.tenantId} and series = 'TST' order by sequence`).map((row) => row.id);
    expect(of(hits, "invoice")).toContain(invoiceA);
    expect(of(hits, "invoice")).not.toContain(invoiceB);

    // Services and people: given only at the other branch is hidden; at theirs, or nowhere listed, is shown.
    const token = `Kestrel${randomUUID().slice(0, 6)}`;
    const service = async (suffix: string, locationId: string | null) => {
      const [row] = await owner<{ id: string }[]>`
        insert into services (tenant_id, name, description, duration_minutes, booking_mode, patient_types)
        values (${fixture.tenantId}, ${`${token} ${suffix}`}, 'A service', 30, 'instant', ${["new", "returning"]}) returning id`;
      if (locationId) await owner`insert into service_locations (tenant_id, service_id, location_id) values (${fixture.tenantId}, ${row!.id}, ${locationId})`;
      return row!.id;
    };
    const person = async (suffix: string, locationIds: string[]) => {
      const [row] = await owner<{ id: string }[]>`
        insert into practitioners (tenant_id, name, title, initials, specialty) values (${fixture.tenantId}, ${`Dr ${token} ${suffix}`}, 'Doctor', 'DK', 'General') returning id`;
      for (const locationId of locationIds) await owner`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${fixture.tenantId}, ${row!.id}, ${locationId})`;
      return row!.id;
    };
    const serviceA = await service("Here", locationA);
    const serviceB = await service("There", locationB);
    const serviceAny = await service("Anywhere", null);
    const personA = await person("Here", [locationA]);
    const personB = await person("There", [locationB]);
    const personBoth = await person("Both", [locationA, locationB]);
    const catalog = (await searchStaff(limitedAdmin, token, 10)).hits;
    expect(of(catalog, "service")).toEqual(expect.arrayContaining([serviceA, serviceAny]));
    expect(of(catalog, "service")).not.toContain(serviceB);
    expect(of(catalog, "person")).toEqual(expect.arrayContaining([personA, personBoth]));
    expect(of(catalog, "person")).not.toContain(personB);
    expect(of((await searchStaff(ownerContext, token, 10)).hits, "service")).toContain(serviceB);

    const everything = (await searchStaff({ ...limitedAdmin, locationIds: null }, surname, 10)).hits;
    expect(everything.filter((hit) => hit.kind === "customer").map((hit) => hit.id)).toContain(customerB);
  });

  it("lets a limited manager change a doctor's profile only when the doctor works at their branches only", async () => {
    // The fixture doctor works at both branches.
    await expect(updateStaffPractitioner(limitedAdmin, fixture.practitionerId, { specialty: "Changed" })).rejects.toMatchObject({ status: 403, code: "cannot_manage_location" });
    await expect(updateStaffPractitioner(ownerContext, fixture.practitionerId, { specialty: "General" })).resolves.toBeDefined();

    const [local] = await owner<{ id: string }[]>`
      insert into practitioners (tenant_id, name, title, initials, specialty, is_active) values (${fixture.tenantId}, 'Dr Local', 'Doctor', 'DL', 'General', false) returning id`;
    await owner`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${fixture.tenantId}, ${local!.id}, ${locationA})`;
    await expect(updateStaffPractitioner(limitedAdmin, local!.id, { specialty: "Family" })).resolves.toBeDefined();
    // They can't move that doctor to a branch they don't work at.
    await expect(updateStaffPractitioner(limitedAdmin, local!.id, { locationIds: [locationA, locationB] })).rejects.toMatchObject({ status: 403, code: "location_not_allowed" });

    await expect(createStaffPractitioner(limitedAdmin, {
      attachToCurrentUser: false, name: "Dr Elsewhere", title: "Doctor", specialty: "General", email: `elsewhere.${randomUUID()}@example.com`,
      locationIds: [locationB], serviceIds: [fixture.serviceId], hours: { days: [1], startsAtLocal: "09:00", endsAtLocal: "12:00" },
    })).rejects.toMatchObject({ status: 403, code: "location_not_allowed" });
  });
});
