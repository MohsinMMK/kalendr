/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { bookingQuerySchema } from "@/lib/bookings-list";
import { resolvePermissions } from "@/lib/permissions";
import { listBookings } from "@/server/bookings-list";
import { getSession, listSessions } from "@/server/classes";
import { clinicRegistrationSchema, registerClinic } from "@/server/clinic-registration";
import { getCustomerOffers } from "@/server/offers/packages";
import { addSampleData } from "@/server/onboarding/test-data";
import { callNextTicket, updateQueueTicket } from "@/server/queue";
import { sendDelayNotice, sendQuickMessage } from "@/server/quick-messages";
import type { StaffContext } from "@/server/staff-context";
import { getStaffSnapshot } from "@/server/staff-repository";
import { invitePractitionerLogin } from "@/server/staff-team";
import { isLocalDatabase } from "@/test/billing-fixture";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const describeLocal = isLocalDatabase(runtimeUrl) && isLocalDatabase(ownerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

describeLocal("a practitioner's own login", () => {
  let owner: postgres.Sql;
  const created: string[] = [];

  beforeAll(() => { owner = postgres(ownerUrl!, { max: 1, prepare: false }); });
  afterAll(async () => {
    if (created.length > 0) await owner`delete from outbox_events where tenant_id = any(${created})`.catch(() => undefined);
    for (const tenantId of created) await owner`update tenants set is_active = false where id = ${tenantId}`.catch(() => undefined);
    await owner.end();
  });

  it("is given to a practitioner who had none, once, and then sees only their own visits", async () => {
    const slug = `doc-login-${randomUUID().slice(0, 6)}`;
    const email = `${slug}@example.com`;
    const registered = await registerClinic(clinicRegistrationSchema.parse({
      template: "general_practice", clinicName: "Login Test Clinic", slug, ownerName: "Asha Rao", email, password: randomUUID(), timezone: "Asia/Kolkata",
      ownerPractices: true, practice: { name: "Asha Rao", title: "Doctor", specialty: "General medicine" },
    }));
    created.push(registered.tenantId);
    const [member] = await owner<{ user_id: string }[]>`select user_id from memberships where tenant_id = ${registered.tenantId}`;
    const ownerContext: StaffContext = {
      tenantId: registered.tenantId, clinicSlug: slug, clinicName: registered.clinicName, role: "owner", permissions: resolvePermissions("owner", {}),
      membershipId: null, userId: member!.user_id, userName: "Asha Rao", userEmail: email, secondFactorEnrolled: true, secondFactorAt: new Date(), preview: false,
    };
    // Sample visits all go to the owner, who is the only bookable person so far.
    expect((await addSampleData(ownerContext)).added).toBeGreaterThan(0);

    // A doctor added before they had a login, as a seed or an older setup leaves them.
    const [doctor] = await owner<{ id: string }[]>`
      insert into practitioners (tenant_id, name, title, initials, specialty) values (${registered.tenantId}, 'Dr Imran Ali', 'Doctor', 'IA', 'Paediatrics') returning id`;
    const doctorEmail = `imran-${slug}@example.com`;

    const result = await invitePractitionerLogin(ownerContext, doctor!.id, ` ${doctorEmail.toUpperCase()} `);
    expect(result.email).toBe(doctorEmail);
    expect(result.invite?.url).toMatch(/^http/);
    const [link] = await owner<{ auth_user_id: string; role: string; email: string }[]>`
      select person.auth_user_id, membership.role, login.email from practitioners person
        join memberships membership on membership.user_id = person.auth_user_id and membership.tenant_id = person.tenant_id
        join auth_users login on login.id = person.auth_user_id
      where person.id = ${doctor!.id}`;
    expect(link).toMatchObject({ role: "practitioner", email: doctorEmail });

    await expect(invitePractitionerLogin(ownerContext, doctor!.id, `again-${doctorEmail}`)).rejects.toMatchObject({ status: 409, code: "already_has_login" });
    const doctorContext: StaffContext = {
      ...ownerContext, role: "practitioner", permissions: resolvePermissions("practitioner", {}), membershipId: null,
      userId: link!.auth_user_id, userName: "Dr Imran Ali", userEmail: doctorEmail,
    };
    await expect(invitePractitionerLogin(doctorContext, doctor!.id, doctorEmail)).rejects.toMatchObject({ status: 403 });

    // The owner sees every visit; the new doctor sees none of the owner's.
    const query = bookingQuerySchema.parse({ tab: "upcoming" });
    expect((await getStaffSnapshot(ownerContext)).appointments.length).toBeGreaterThan(0);
    expect((await listBookings(ownerContext, query)).rows.length).toBeGreaterThan(0);
    expect((await getStaffSnapshot(doctorContext)).appointments).toEqual([]);
    expect((await listBookings(doctorContext, query)).rows).toEqual([]);

    // One of the owner's visits, moved to later today with the customer in the waiting room.
    const [visit] = await owner<{ id: string; patient_id: string; location_id: string; practitioner_id: string; service_id: string }[]>`
      update appointments set starts_at = now() + interval '30 minutes', ends_at = now() + interval '60 minutes', status = 'checked_in', visit_started_at = null
      where id = (select id from appointments where tenant_id = ${registered.tenantId} order by starts_at limit 1)
      returning id, patient_id, location_id, practitioner_id, service_id`;
    const [ticket] = await owner<{ id: string }[]>`
      insert into queue_tickets (tenant_id, location_id, day, number, appointment_id)
      select ${registered.tenantId}, location.id, (now() at time zone location.timezone)::date, 1, ${visit!.id}
      from locations location where location.id = ${visit!.location_id}
      returning id`;

    // The doctor can't call, message or tell "running late" to the owner's customer.
    expect(await callNextTicket(doctorContext, {})).toBeNull();
    await expect(updateQueueTicket(doctorContext, ticket!.id, { action: "call_again" })).rejects.toMatchObject({ status: 404 });
    await expect(sendQuickMessage(doctorContext, visit!.id, { kind: "your_turn" }, randomUUID())).rejects.toMatchObject({ status: 404 });
    expect(await sendDelayNotice(doctorContext, { delayMinutes: 10 }, randomUUID())).toEqual({ count: 0 });
    await expect(getCustomerOffers(doctorContext, visit!.patient_id)).rejects.toMatchObject({ status: 404 });

    // A class the owner teaches, and its roster, stay with the owner.
    const [session] = await owner<{ id: string }[]>`
      insert into class_sessions (tenant_id, service_id, practitioner_id, location_id, starts_at, ends_at, capacity)
      values (${registered.tenantId}, ${visit!.service_id}, ${visit!.practitioner_id}, ${visit!.location_id}, now() + interval '1 day', now() + interval '1 day 1 hour', 8)
      returning id`;
    const range = { from: new Date(), to: new Date(Date.now() + 3 * 86_400_000) };
    expect((await listSessions(ownerContext, range)).map((row) => row.id)).toContain(session!.id);
    expect(await listSessions(doctorContext, range)).toEqual([]);
    await expect(getSession(doctorContext, session!.id)).rejects.toMatchObject({ status: 404 });

    // The owner still reaches all of it.
    await expect(getCustomerOffers(ownerContext, visit!.patient_id)).resolves.toBeDefined();
    expect((await sendDelayNotice(ownerContext, { delayMinutes: 10 }, randomUUID())).count).toBeGreaterThan(0);
    expect((await callNextTicket(ownerContext, {}))?.ticketId).toBe(ticket!.id);
  });
});
