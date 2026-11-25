/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createAppointment, getManageSnapshot, manageAppointment } from "@/server/appointment-repository";
import { openNote } from "@/server/booking-policy";
import { createCancelPreset, deleteCancelPreset, listCancelPresets } from "@/server/cancel-presets";
import { applyServiceSetupPatch, getServiceSetup } from "@/server/services-admin";
import { runStaffAppointmentAction } from "@/server/staff-transitions";
import { expireRescheduleRequests } from "@/worker/request-jobs";
import { describeScratch } from "@/server/testing/scratch-database";
import { createSchedulingFixture, plusMinutes, startIn, type SchedulingFixture } from "@/server/testing/scheduling-fixture";
import type { PublicBookingInput } from "@/lib/contracts";
import type { CancelPolicy } from "@/lib/cancel-policy";

const ownerUrl = process.env.KALENDR_TEST_OWNER_URL ?? "";
const workerUrl = process.env.WORKER_DATABASE_URL ?? "";

const book = (input: PublicBookingInput) => createAppointment(input, randomUUID(), randomUUID().replaceAll("-", ""));

async function setPolicy(fixture: SchedulingFixture, patch: Partial<CancelPolicy>) {
  const current = await getServiceSetup(fixture.context, fixture.serviceId);
  const base = current.cancelPolicy ?? { allowCustomerCancel: true, allowCustomerReschedule: true, cancelCutoffMinutes: 0, rescheduleCutoffMinutes: 0, rescheduleSamePerson: true, rescheduleRequestDays: 7 };
  return applyServiceSetupPatch(fixture.context, fixture.serviceId, { cancelPolicy: { ...base, ...patch } }, current.version);
}

/** Moves a booking to start `minutes` from now, as if time had passed, keeping its reservations in step. */
async function startsInMinutes(fixture: SchedulingFixture, appointmentId: string, minutes: number) {
  await fixture.owner`update appointments set starts_at = now() + ${minutes} * interval '1 minute', ends_at = now() + (${minutes} + 30) * interval '1 minute' where id = ${appointmentId}`;
  await fixture.owner`update resource_reservations set starts_at = now() + ${minutes} * interval '1 minute', ends_at = now() + (${minutes} + 30) * interval '1 minute' where appointment_id = ${appointmentId}`;
}

describeScratch("cancel and reschedule policy against a real database", () => {
  it("refuses a customer inside the cut-off, on the page's hint and on a direct call", async () => {
    const fixture = await createSchedulingFixture(ownerUrl, { name: "Cutoff" });
    try {
      await setPolicy(fixture, { cancelCutoffMinutes: 12 * 60, rescheduleCutoffMinutes: 12 * 60 });
      const t = startIn(6, 10);
      const booked = await book(fixture.bookingInput(t, plusMinutes(t, 30), "cut@acme-corp.in"));
      expect((await getManageSnapshot(booked.manageToken)).canCancel).toBe(true);

      // 11 hours before the visit: the page hides the button and gives the rule; the server refuses the same call.
      await startsInMinutes(fixture, booked.appointmentId, 11 * 60);
      const snapshot = await getManageSnapshot(booked.manageToken);
      expect(snapshot.canCancel).toBe(false);
      expect(snapshot.canReschedule).toBe(false);
      expect(snapshot.manage?.cancelBlockedMessage).toContain("within 12 hours");
      await expect(manageAppointment(booked.manageToken, { action: "cancel", reasonCode: "cant_make_it", expectedVersion: 1 }))
        .rejects.toMatchObject({ status: 403, code: "cancel_not_allowed" });
      await expect(manageAppointment(booked.manageToken, { action: "reschedule", startsAt: startIn(7, 10), expectedVersion: 1 }))
        .rejects.toMatchObject({ status: 403, code: "reschedule_not_allowed" });
      expect((await fixture.owner<{ status: string }[]>`select status from appointments where id = ${booked.appointmentId}`)[0]!.status).toBe("booked");

      // 13 hours before: allowed again.
      await startsInMinutes(fixture, booked.appointmentId, 13 * 60);
      expect((await getManageSnapshot(booked.manageToken)).canCancel).toBe(true);
      const cancelled = await manageAppointment(booked.manageToken, { action: "cancel", reasonCode: "found_another_time", note: "Booked with my usual dentist instead.", expectedVersion: 1 });
      expect(cancelled.status).toBe("cancelled");
    } finally {
      await fixture.cleanup();
    }
  });

  it("records the reason a customer picks, keeps the note sealed and out of the audit trail, and says who cancelled", async () => {
    const fixture = await createSchedulingFixture(ownerUrl, { name: "Reason" });
    try {
      const t = startIn(7, 10);
      const booked = await book(fixture.bookingInput(t, plusMinutes(t, 30), "why@acme-corp.in"));
      const note = "My-sister-is-getting-married-that-day";
      await manageAppointment(booked.manageToken, { action: "cancel", reasonCode: "cant_make_it", note, expectedVersion: 1 });
      const [row] = await fixture.owner<{ cancel_reason_code: string; cancelled_by: string; cancel_reason_text: string | null }[]>`
        select cancel_reason_code, cancelled_by, cancel_reason_text from appointments where id = ${booked.appointmentId}`;
      expect(row).toMatchObject({ cancel_reason_code: "cant_make_it", cancelled_by: "customer" });
      expect(row!.cancel_reason_text).not.toBeNull();
      expect(row!.cancel_reason_text).not.toContain(note);
      expect(openNote("cancel", fixture.tenantId, booked.appointmentId, row!.cancel_reason_text)).toBe(note);
      const audit = JSON.stringify(await fixture.owner`select metadata from audit_events where appointment_id = ${booked.appointmentId}`);
      expect(audit).not.toContain(note);
      expect(audit).toContain("cant_make_it");
      const outbox = JSON.stringify(await fixture.owner`select payload from outbox_events where aggregate_id = ${booked.appointmentId}`);
      expect(outbox).not.toContain(note);
    } finally {
      await fixture.cleanup();
    }
  });

  it("shows no reschedule anywhere to a customer when the business turned it off, and refuses a direct call", async () => {
    const fixture = await createSchedulingFixture(ownerUrl, { name: "NoMove" });
    try {
      await setPolicy(fixture, { allowCustomerReschedule: false });
      const t = startIn(8, 10);
      const booked = await book(fixture.bookingInput(t, plusMinutes(t, 30), "nomove@acme-corp.in"));
      const snapshot = await getManageSnapshot(booked.manageToken);
      expect(snapshot.canReschedule).toBe(false);
      expect(snapshot.canCancel).toBe(true);
      expect(snapshot.manage?.rescheduleBlockedMessage).toContain("can't be moved online");
      await expect(manageAppointment(booked.manageToken, { action: "reschedule", startsAt: startIn(9, 10), expectedVersion: 1 }))
        .rejects.toMatchObject({ status: 403, code: "reschedule_not_allowed" });
      // Staff are never held to the customer's rules.
      const moved = await runStaffAppointmentAction(fixture.context, booked.appointmentId, { action: "reschedule", startsAt: startIn(9, 10), practitionerId: fixture.practitionerId, expectedVersion: 1 });
      expect(moved.status).toBe("booked");
    } finally {
      await fixture.cleanup();
    }
  });

  it("asks a customer to choose a new time: frees the slot, keeps the booking, and the customer's pick restores it", async () => {
    const fixture = await createSchedulingFixture(ownerUrl, { name: "Ask" });
    try {
      // Even a business that does not let customers move bookings gets the customer's answer to its own request.
      await setPolicy(fixture, { allowCustomerReschedule: false, allowCustomerCancel: false });
      const t = startIn(9, 10);
      const booked = await book(fixture.bookingInput(t, plusMinutes(t, 30), "ask@acme-corp.in"));
      const message = "The-doctor-is-unwell-please-pick-another-day";
      const asked = await runStaffAppointmentAction(fixture.context, booked.appointmentId, { action: "request_reschedule", message, expectedVersion: 1 });
      expect(asked.status).toBe("reschedule_requested");
      expect(await fixture.owner`select 1 from resource_reservations where appointment_id = ${booked.appointmentId} and state in ('held', 'confirmed')`).toHaveLength(0);
      // The slot is free for someone else straight away.
      const other = await book(fixture.bookingInput(t, plusMinutes(t, 30), "other@acme-corp.in"));
      expect(other.status).toBe("booked");
      // The note travels in the outbox only.
      const audit = JSON.stringify(await fixture.owner`select metadata from audit_events where appointment_id = ${booked.appointmentId}`);
      expect(audit).not.toContain(message);
      const [event] = await fixture.owner<{ payload: { message?: string } }[]>`select payload from outbox_events where aggregate_id = ${booked.appointmentId} and event_type = 'appointment.reschedule_requested'`;
      expect(event?.payload.message).toBe(message);
      // Asking twice, or asking a visit that is not booked, is refused.
      await expect(runStaffAppointmentAction(fixture.context, booked.appointmentId, { action: "request_reschedule", expectedVersion: 2 })).rejects.toMatchObject({ code: "invalid_status_transition" });

      // The customer's link opens on the picker, and they may answer despite the policy.
      const snapshot = await getManageSnapshot(booked.manageToken);
      expect(snapshot.manage?.rescheduleRequested).toBe(true);
      expect(snapshot.canReschedule).toBe(true);
      expect(snapshot.canCancel).toBe(true);
      const newTime = startIn(10, 14);
      await expect(manageAppointment(booked.manageToken, { action: "confirm", expectedVersion: 2 })).rejects.toMatchObject({ code: "reschedule_requested" });
      const answered = await manageAppointment(booked.manageToken, { action: "reschedule", startsAt: newTime, note: "Thursday works better", expectedVersion: 2 });
      expect(answered.status).toBe("booked");
      expect(answered.appointmentId).toBe(booked.appointmentId);
      expect(answered.startsAt).toBe(newTime);
      expect(await fixture.owner`select 1 from resource_reservations where appointment_id = ${booked.appointmentId} and state = 'confirmed'`).toHaveLength(1);
      const [row] = await fixture.owner<{ reschedule_requested_at: Date | null; reschedule_reason_text: string | null }[]>`select reschedule_requested_at, reschedule_reason_text from appointments where id = ${booked.appointmentId}`;
      expect(row!.reschedule_requested_at).toBeNull();
      expect(openNote("reschedule", fixture.tenantId, booked.appointmentId, row!.reschedule_reason_text)).toBe("Thursday works better");
      // The history keeps every step under the same id.
      const actions = (await fixture.owner<{ action: string }[]>`select action from audit_events where appointment_id = ${booked.appointmentId} order by occurred_at, id`).map((r) => r.action);
      expect(actions).toEqual(["appointment.created", "appointment.reschedule_requested", "appointment.reschedule"]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("cancels by the system when the customer never answers a request to move", async () => {
    const fixture = await createSchedulingFixture(ownerUrl, { name: "Silence" });
    const worker = postgres(workerUrl, { max: 2, prepare: false });
    try {
      await setPolicy(fixture, { rescheduleRequestDays: 3 });
      const t = startIn(12, 10);
      const booked = await book(fixture.bookingInput(t, plusMinutes(t, 30), "silent@acme-corp.in"));
      await runStaffAppointmentAction(fixture.context, booked.appointmentId, { action: "request_reschedule", expectedVersion: 1 });
      await fixture.owner`update appointments set reschedule_requested_at = now() - interval '2 days' where id = ${booked.appointmentId}`;
      await expireRescheduleRequests(worker);
      expect((await fixture.owner<{ status: string }[]>`select status from appointments where id = ${booked.appointmentId}`)[0]!.status).toBe("reschedule_requested");
      await fixture.owner`update appointments set reschedule_requested_at = now() - interval '4 days' where id = ${booked.appointmentId}`;
      await expireRescheduleRequests(worker);
      await expireRescheduleRequests(worker);
      const [row] = await fixture.owner<{ status: string; cancelled_by: string; cancel_reason_code: string; version: number }[]>`select status, cancelled_by, cancel_reason_code, version from appointments where id = ${booked.appointmentId}`;
      expect(row).toEqual({ status: "cancelled", cancelled_by: "system", cancel_reason_code: "reschedule_expired", version: 3 });
      expect(await fixture.owner`select 1 from outbox_events where aggregate_id = ${booked.appointmentId} and event_type = 'appointment.status.cancelled'`).toHaveLength(1);
    } finally {
      await worker.end();
      await fixture.cleanup();
    }
  });

  it("keeps the customer on the same person unless the service lets them pick anyone", async () => {
    const fixture = await createSchedulingFixture(ownerUrl, { name: "Person" });
    const second = randomUUID();
    try {
      const [location] = await fixture.owner<{ id: string; timezone: string }[]>`select id, timezone from locations where tenant_id = ${fixture.tenantId} limit 1`;
      await fixture.owner.begin(async (transaction) => {
        await transaction`insert into practitioners (id, tenant_id, name, title, initials, specialty) values (${second}, ${fixture.tenantId}, 'Second Person', 'Dentist', 'SP', 'Testing')`;
        await transaction`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${fixture.tenantId}, ${second}, ${location!.id})`;
        await transaction`insert into practitioner_services (tenant_id, practitioner_id, service_id) values (${fixture.tenantId}, ${second}, ${fixture.serviceId})`;
        for (let day = 1; day <= 7; day += 1) {
          await transaction`insert into availability_rules (id, tenant_id, location_id, practitioner_id, day_of_week, starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes)
            values (${randomUUID()}, ${fixture.tenantId}, ${location!.id}, ${second}, ${day}, '00:00', '23:59', ${location!.timezone}, '2025-01-01', 30)`;
        }
      });
      const t = startIn(13, 10);
      const booked = await book(fixture.bookingInput(t, plusMinutes(t, 30), "pp@acme-corp.in"));
      await expect(manageAppointment(booked.manageToken, { action: "reschedule", startsAt: startIn(14, 10), practitionerId: second, expectedVersion: 1 }))
        .rejects.toMatchObject({ status: 403, code: "reschedule_same_person" });
      await setPolicy(fixture, { rescheduleSamePerson: false });
      const snapshot = await getManageSnapshot(booked.manageToken);
      expect(snapshot.manage?.sameStaffOnly).toBe(false);
      const moved = await manageAppointment(booked.manageToken, { action: "reschedule", startsAt: startIn(14, 10), practitionerId: second, expectedVersion: 1 });
      expect(moved.status).toBe("booked");
      expect((await fixture.owner<{ practitioner_id: string }[]>`select practitioner_id from appointments where id = ${booked.appointmentId}`)[0]!.practitioner_id).toBe(second);
    } finally {
      await fixture.owner`delete from audit_events where appointment_id in (select id from appointments where service_id = ${fixture.serviceId})`;
      await fixture.owner`delete from appointments where service_id = ${fixture.serviceId}`;
      await fixture.owner`delete from practitioners where id = ${second}`;
      await fixture.cleanup();
    }
  });

  it("cancels on the business's side with a preset, tells nobody else's business, and rebooks with the history linked", async () => {
    const fixture = await createSchedulingFixture(ownerUrl, { name: "Staff" });
    try {
      await fixture.owner`delete from cancel_note_presets where tenant_id = ${fixture.tenantId}`;
      const preset = await createCancelPreset(fixture.context, { label: "Doctor unwell" });
      expect(await listCancelPresets(fixture.context)).toContainEqual(expect.objectContaining({ id: preset.id, label: "Doctor unwell" }));
      // Another business cannot see, use or delete it.
      expect(await listCancelPresets(fixture.outsider)).not.toContainEqual(expect.objectContaining({ id: preset.id }));
      await expect(deleteCancelPreset(fixture.outsider, preset.id)).rejects.toMatchObject({ status: 404 });
      await expect(createCancelPreset(fixture.context, { label: "Doctor unwell" })).rejects.toMatchObject({ code: "preset_exists" });

      const t = startIn(15, 10);
      const booked = await book(fixture.bookingInput(t, plusMinutes(t, 30), "st@acme-corp.in"));
      await expect(runStaffAppointmentAction(fixture.outsider, booked.appointmentId, { action: "cancel", presetId: preset.id, expectedVersion: 1 })).rejects.toMatchObject({ status: 404 });
      await expect(runStaffAppointmentAction(fixture.context, booked.appointmentId, { action: "cancel", presetId: "nope-nope", expectedVersion: 1 })).rejects.toMatchObject({ code: "preset_not_found" });
      // Rebooking a live future booking is refused.
      await expect(runStaffAppointmentAction(fixture.context, booked.appointmentId, { action: "rebook", startsAt: startIn(16, 10), expectedVersion: 1 })).rejects.toMatchObject({ code: "invalid_status_transition" });

      const cancelled = await runStaffAppointmentAction(fixture.context, booked.appointmentId, { action: "cancel", presetId: preset.id, note: "staff only note", expectedVersion: 1 });
      expect(cancelled.status).toBe("cancelled");
      const [row] = await fixture.owner<{ cancelled_by: string; cancel_reason_code: string; cancel_preset_label: string }[]>`select cancelled_by, cancel_reason_code, cancel_preset_label from appointments where id = ${booked.appointmentId}`;
      expect(row).toEqual({ cancelled_by: "staff", cancel_reason_code: "staff_preset", cancel_preset_label: "Doctor unwell" });
      // Editing the preset's name later does not rewrite history.
      await deleteCancelPreset(fixture.context, preset.id);
      expect((await fixture.owner<{ cancel_preset_label: string }[]>`select cancel_preset_label from appointments where id = ${booked.appointmentId}`)[0]!.cancel_preset_label).toBe("Doctor unwell");
      await expect(runStaffAppointmentAction(fixture.context, booked.appointmentId, { action: "cancel", expectedVersion: 2 })).rejects.toMatchObject({ code: "invalid_status_transition" });

      const rebooked = await runStaffAppointmentAction(fixture.context, booked.appointmentId, { action: "rebook", startsAt: startIn(16, 10), expectedVersion: 2 });
      expect(rebooked.status).toBe("booked");
      expect(rebooked.appointmentId).not.toBe(booked.appointmentId);
      const [link] = await fixture.owner<{ rebooked_from_id: string; patient_id: string }[]>`select rebooked_from_id, patient_id from appointments where id = ${rebooked.appointmentId}`;
      const [original] = await fixture.owner<{ patient_id: string; status: string }[]>`select patient_id, status from appointments where id = ${booked.appointmentId}`;
      expect(link!.rebooked_from_id).toBe(booked.appointmentId);
      expect(link!.patient_id).toBe(original!.patient_id);
      expect(original!.status).toBe("cancelled");
    } finally {
      await fixture.cleanup();
    }
  });

  it("seeds the two quick cancellation reasons once, in the business's own words", async () => {
    const fixture = await createSchedulingFixture(ownerUrl, { name: "Seed" });
    try {
      await fixture.owner`delete from cancel_note_presets where tenant_id = ${fixture.otherTenantId}`;
      await fixture.owner`delete from audit_events where tenant_id = ${fixture.otherTenantId} and action like 'settings.cancel_preset.%'`;
      const first = await listCancelPresets(fixture.outsider);
      expect(first).toHaveLength(2);
      expect(first.map((preset) => preset.label).join(" | ")).toMatch(/unwell.*closed/);
      // Reading again adds nothing, and removing them all does not bring them back.
      expect(await listCancelPresets(fixture.outsider)).toHaveLength(2);
      for (const preset of first) await deleteCancelPreset(fixture.outsider, preset.id);
      expect(await listCancelPresets(fixture.outsider)).toEqual([]);
      await fixture.owner`delete from audit_events where tenant_id = ${fixture.otherTenantId} and action like 'settings.cancel_preset.%'`;
    } finally {
      await fixture.cleanup();
    }
  });

  it("lets staff and the customer change the guest list within the service's limit", async () => {
    const fixture = await createSchedulingFixture(ownerUrl, { name: "Guests", service: { allow_guests: true, max_guests: 2 } });
    try {
      const t = startIn(17, 10);
      const booked = await book(fixture.bookingInput(t, plusMinutes(t, 30), "g@acme-corp.in", { guests: ["one@example.com"] }));
      const staff = await runStaffAppointmentAction(fixture.context, booked.appointmentId, { action: "edit_guests", guests: ["one@example.com", "two@example.com"], expectedVersion: 1 });
      expect(staff.version).toBe(2);
      await expect(runStaffAppointmentAction(fixture.context, booked.appointmentId, { action: "edit_guests", guests: ["a@example.com", "b@example.com", "c@example.com"], expectedVersion: 2 })).rejects.toMatchObject({ status: 422 });
      // Guests never include the customer themselves, and are never in the audit trail.
      const customer = await manageAppointment(booked.manageToken, { action: "edit_guests", guests: ["g@acme-corp.in", "three@example.com"], expectedVersion: 2 });
      expect(customer.version).toBe(3);
      expect(JSON.stringify(await fixture.owner`select metadata from audit_events where appointment_id = ${booked.appointmentId}`)).not.toContain("example.com");
      // A service that takes no guests refuses.
      await fixture.owner`update services set allow_guests = false where id = ${fixture.serviceId}`;
      await expect(manageAppointment(booked.manageToken, { action: "edit_guests", guests: ["x@example.com"], expectedVersion: 3 })).rejects.toMatchObject({ status: 422 });
    } finally {
      await fixture.cleanup();
    }
  });
});
