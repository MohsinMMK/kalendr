/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import { expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createAppointment, getManageSnapshot, updateAppointmentStatus } from "@/server/appointment-repository";
import { runStaffAppointmentAction } from "@/server/staff-transitions";
import { applyServiceSetupPatch, getServiceSetup } from "@/server/services-admin";
import { expireRequests, remindAboutRequests } from "@/worker/request-jobs";
import postgres from "postgres";
import { describeScratch } from "@/server/testing/scratch-database";
import { createSchedulingFixture, plusMinutes, startIn, type SchedulingFixture } from "@/server/testing/scheduling-fixture";
import type { PublicBookingInput } from "@/lib/contracts";

const ownerUrl = process.env.KALENDR_TEST_OWNER_URL ?? "";
const workerUrl = process.env.WORKER_DATABASE_URL ?? "";

const book = (input: PublicBookingInput) => createAppointment(input, randomUUID(), randomUUID().replaceAll("-", ""));

async function setApproval(fixture: SchedulingFixture, approval: { rule: "never" | "always" | "short_notice" | "free_mail"; noticeHours?: number; requestsHoldSlot?: boolean; hideLocationUntilConfirmed?: boolean }) {
  const current = await getServiceSetup(fixture.context, fixture.serviceId);
  return applyServiceSetupPatch(fixture.context, fixture.serviceId, {
    approval: { rule: approval.rule, noticeHours: approval.noticeHours ?? 24, requestsHoldSlot: approval.requestsHoldSlot ?? true, hideLocationUntilConfirmed: approval.hideLocationUntilConfirmed ?? false },
  }, current.version);
}

describeScratch("approval rules against a real database", () => {
  it("decides booked or requested by the service's rule", async () => {
    const fixture = await createSchedulingFixture(ownerUrl, { name: "Rule" });
    try {
      // Short notice: the notice window is 48 hours here, so tomorrow waits and next week books at once.
      await setApproval(fixture, { rule: "short_notice", noticeHours: 48 });
      const tomorrow = startIn(1, 10);
      const nextWeek = startIn(8, 10);
      const soon = await book(fixture.bookingInput(tomorrow, plusMinutes(tomorrow, 30), "a@acme-corp.in"));
      const later = await book(fixture.bookingInput(nextWeek, plusMinutes(nextWeek, 30), "b@acme-corp.in"));
      expect(soon.status).toBe("requested");
      expect(later.status).toBe("booked");

      // Free mail: gmail waits, a company address books.
      await setApproval(fixture, { rule: "free_mail" });
      const a = startIn(9, 10);
      const b = startIn(9, 11);
      expect((await book(fixture.bookingInput(a, plusMinutes(a, 30), "someone@gmail.com"))).status).toBe("requested");
      expect((await book(fixture.bookingInput(b, plusMinutes(b, 30), "ops@acme-corp.in"))).status).toBe("booked");

      // The old booking mode follows the rule so older code keeps working.
      const [row] = await fixture.owner<{ booking_mode: string; approval_rule: string }[]>`select booking_mode, approval_rule from services where id = ${fixture.serviceId}`;
      expect(row).toEqual({ booking_mode: "request", approval_rule: "free_mail" });
      await setApproval(fixture, { rule: "never" });
      expect((await fixture.owner<{ booking_mode: string }[]>`select booking_mode from services where id = ${fixture.serviceId}`)[0]!.booking_mode).toBe("instant");
    } finally {
      await fixture.cleanup();
    }
  });

  it("holds the slot by default, and lets a second customer take it when requests do not hold", async () => {
    const fixture = await createSchedulingFixture(ownerUrl, { name: "Hold" });
    try {
      await setApproval(fixture, { rule: "always", requestsHoldSlot: true });
      const t1 = startIn(10, 10);
      const held = await book(fixture.bookingInput(t1, plusMinutes(t1, 30), "x@acme-corp.in"));
      expect(held.status).toBe("requested");
      await expect(book(fixture.bookingInput(t1, plusMinutes(t1, 30), "y@acme-corp.in"))).rejects.toMatchObject({ code: "slot_unavailable" });

      await setApproval(fixture, { rule: "always", requestsHoldSlot: false });
      const t2 = startIn(10, 12);
      const first = await book(fixture.bookingInput(t2, plusMinutes(t2, 30), "p@acme-corp.in"));
      expect(first.status).toBe("requested");
      expect(await fixture.owner`select 1 from resource_reservations where appointment_id = ${first.appointmentId}`).toHaveLength(0);
      // A second customer takes the same time. Approval is only the booking rule, so give them an instant service.
      await setApproval(fixture, { rule: "never" });
      const second = await book(fixture.bookingInput(t2, plusMinutes(t2, 30), "q@acme-corp.in"));
      expect(second.status).toBe("booked");
      // Approving the first now asks staff to choose another time, through the action and through the plain status route.
      await expect(runStaffAppointmentAction(fixture.context, first.appointmentId, { action: "approve", expectedVersion: 1 }))
        .rejects.toMatchObject({ status: 409, code: "request_slot_taken" });
      await expect(updateAppointmentStatus(fixture.context.userId!, first.appointmentId, { status: "booked", expectedVersion: 1 }))
        .rejects.toMatchObject({ status: 409, code: "request_slot_taken" });
      const [still] = await fixture.owner<{ status: string; version: number }[]>`select status, version from appointments where id = ${first.appointmentId}`;
      expect(still).toEqual({ status: "requested", version: 1 });
    } finally {
      await fixture.cleanup();
    }
  });

  it("approves a request that did not hold its slot when the time is still free, and then holds it", async () => {
    const fixture = await createSchedulingFixture(ownerUrl, { name: "NoHoldOk" });
    try {
      await setApproval(fixture, { rule: "always", requestsHoldSlot: false });
      const t = startIn(11, 10);
      const request = await book(fixture.bookingInput(t, plusMinutes(t, 30), "free@acme-corp.in"));
      const result = await runStaffAppointmentAction(fixture.context, request.appointmentId, { action: "approve", expectedVersion: 1 });
      expect(result.status).toBe("booked");
      expect(await fixture.owner`select 1 from resource_reservations where appointment_id = ${request.appointmentId} and state = 'confirmed'`).toHaveLength(1);
      // A stale version is refused and the approval cannot be repeated.
      await expect(runStaffAppointmentAction(fixture.context, request.appointmentId, { action: "approve", expectedVersion: 1 })).rejects.toMatchObject({ code: "version_conflict" });
      await expect(runStaffAppointmentAction(fixture.context, request.appointmentId, { action: "approve", expectedVersion: 2 })).rejects.toMatchObject({ code: "invalid_status_transition" });
      const [event] = await fixture.owner<{ event_type: string }[]>`select event_type from outbox_events where aggregate_id = ${request.appointmentId} and event_type = 'appointment.status.booked'`;
      expect(event?.event_type).toBe("appointment.status.booked");
    } finally {
      await fixture.cleanup();
    }
  });

  it("moves a request to one of the customer's offered times in one approval", async () => {
    const fixture = await createSchedulingFixture(ownerUrl, { name: "Propose" });
    try {
      await setApproval(fixture, { rule: "always" });
      const original = startIn(12, 10);
      const alt1 = startIn(12, 14);
      const alt2 = startIn(13, 9);
      const request = await book(fixture.bookingInput(original, plusMinutes(original, 30), "prop@acme-corp.in", { proposedStarts: [alt1, alt2, alt1, original] }));
      const [row] = await fixture.owner<{ proposed_starts: Date[] }[]>`select proposed_starts from appointments where id = ${request.appointmentId}`;
      // De-duplicated, and the requested time itself is not repeated.
      expect(row!.proposed_starts.map((d) => d.toISOString()).sort()).toEqual([alt1, alt2].sort());
      const snapshot = await getManageSnapshot(request.manageToken);
      expect(snapshot.proposedStarts?.length).toBe(2);
      // A time the customer did not offer is refused.
      await expect(runStaffAppointmentAction(fixture.context, request.appointmentId, { action: "approve", chosenStart: startIn(12, 16), expectedVersion: 1 }))
        .rejects.toMatchObject({ status: 400 });
      const approved = await runStaffAppointmentAction(fixture.context, request.appointmentId, { action: "approve", chosenStart: alt1, expectedVersion: 1 });
      expect(approved.startsAt).toBe(alt1);
      expect(approved.status).toBe("booked");
      const reservations = await fixture.owner<{ starts_at: Date }[]>`select starts_at from resource_reservations where appointment_id = ${request.appointmentId} and state = 'confirmed'`;
      expect(reservations.map((r) => r.starts_at.toISOString())).toEqual([alt1]);
      // An instant booking drops the offered times.
      await setApproval(fixture, { rule: "never" });
      const instant = await book(fixture.bookingInput(startIn(14, 10), plusMinutes(startIn(14, 10), 30), "i@acme-corp.in", { proposedStarts: [alt2] }));
      expect((await fixture.owner<{ proposed_starts: Date[] | null }[]>`select proposed_starts from appointments where id = ${instant.appointmentId}`)[0]!.proposed_starts).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it("declines with a reason the customer sees, keeps the message out of the audit trail and frees the slot", async () => {
    const fixture = await createSchedulingFixture(ownerUrl, { name: "Decline" });
    try {
      await setApproval(fixture, { rule: "always" });
      const t = startIn(15, 10);
      const request = await book(fixture.bookingInput(t, plusMinutes(t, 30), "dec@acme-corp.in"));
      const secret = "Please-call-us-about-your-X-ray";
      const declined = await runStaffAppointmentAction(fixture.context, request.appointmentId, { action: "decline", reason: "need_information", message: secret, expectedVersion: 1 });
      expect(declined.status).toBe("declined");
      const snapshot = await getManageSnapshot(request.manageToken);
      expect(snapshot.appointment.status).toBe("declined");
      expect(snapshot.declineReason).toBe("need_information");
      expect(snapshot.canCancel).toBe(false);
      expect(snapshot.canReschedule).toBe(false);
      // The message is in the outbox for the worker, never in the audit trail.
      const audit = await fixture.owner<{ metadata: unknown }[]>`select metadata from audit_events where appointment_id = ${request.appointmentId}`;
      expect(JSON.stringify(audit)).not.toContain(secret);
      const [outbox] = await fixture.owner<{ payload: { message?: string; reason?: string } }[]>`select payload from outbox_events where aggregate_id = ${request.appointmentId} and event_type = 'appointment.status.declined'`;
      expect(outbox?.payload).toMatchObject({ message: secret, reason: "need_information" });
      expect(await fixture.owner`select 1 from resource_reservations where appointment_id = ${request.appointmentId} and state in ('held', 'confirmed')`).toHaveLength(0);
      // The time is open again, and the decision cannot be changed.
      expect((await book(fixture.bookingInput(t, plusMinutes(t, 30), "next@acme-corp.in"))).status).toBe("requested");
      await expect(runStaffAppointmentAction(fixture.context, request.appointmentId, { action: "approve", expectedVersion: 2 })).rejects.toMatchObject({ code: "invalid_status_transition" });
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps one business's requests away from another's staff", async () => {
    const fixture = await createSchedulingFixture(ownerUrl, { name: "Tenant" });
    try {
      await setApproval(fixture, { rule: "always" });
      const t = startIn(16, 10);
      const request = await book(fixture.bookingInput(t, plusMinutes(t, 30), "tenant@acme-corp.in"));
      await expect(runStaffAppointmentAction(fixture.outsider, request.appointmentId, { action: "approve", expectedVersion: 1 })).rejects.toMatchObject({ status: 404 });
      await expect(runStaffAppointmentAction(fixture.outsider, request.appointmentId, { action: "decline", reason: "other", expectedVersion: 1 })).rejects.toMatchObject({ status: 404 });
      expect((await fixture.owner<{ status: string }[]>`select status from appointments where id = ${request.appointmentId}`)[0]!.status).toBe("requested");
    } finally {
      await fixture.cleanup();
    }
  });

  it("hides the address on the manage page until the request is approved", async () => {
    const fixture = await createSchedulingFixture(ownerUrl, { name: "Hide" });
    try {
      await setApproval(fixture, { rule: "always", hideLocationUntilConfirmed: true });
      const t = startIn(17, 10);
      const request = await book(fixture.bookingInput(t, plusMinutes(t, 30), "hide@acme-corp.in"));
      const waiting = await getManageSnapshot(request.manageToken);
      expect(waiting.locationHidden).toBe(true);
      expect(waiting.location.address).toBe("");
      expect(waiting.location.name).toBe("");
      await runStaffAppointmentAction(fixture.context, request.appointmentId, { action: "approve", expectedVersion: 1 });
      const approved = await getManageSnapshot(request.manageToken);
      expect(approved.locationHidden).toBeUndefined();
      expect(approved.location.address).not.toBe("");
    } finally {
      await fixture.cleanup();
    }
  });

  it("expires requests whose start has passed, once, and reminds staff at the halfway point", async () => {
    const fixture = await createSchedulingFixture(ownerUrl, { name: "Expire" });
    const worker = postgres(workerUrl, { max: 2, prepare: false });
    try {
      await setApproval(fixture, { rule: "always" });
      const t = startIn(18, 10);
      const request = await book(fixture.bookingInput(t, plusMinutes(t, 30), "exp@acme-corp.in"));
      const waiting = await book(fixture.bookingInput(startIn(19, 10), plusMinutes(startIn(19, 10), 30), "wait@acme-corp.in"));
      // Pretend the first request was asked long ago and its start has just passed.
      await fixture.owner`update appointments set created_at = now() - interval '3 days', starts_at = now() - interval '1 minute', ends_at = now() + interval '29 minutes' where id = ${request.appointmentId}`;
      await fixture.owner`update resource_reservations set starts_at = now() - interval '1 minute', ends_at = now() + interval '29 minutes' where appointment_id = ${request.appointmentId}`;
      const first = await expireRequests(worker);
      expect(first.rows).toBeGreaterThanOrEqual(1);
      const [row] = await fixture.owner<{ status: string; version: number }[]>`select status, version from appointments where id = ${request.appointmentId}`;
      expect(row).toEqual({ status: "expired", version: 2 });
      expect(await fixture.owner`select 1 from resource_reservations where appointment_id = ${request.appointmentId} and state in ('held', 'confirmed')`).toHaveLength(0);
      expect(await fixture.owner`select 1 from outbox_events where aggregate_id = ${request.appointmentId} and event_type = 'appointment.status.expired'`).toHaveLength(1);
      expect(await fixture.owner`select 1 from audit_events where appointment_id = ${request.appointmentId} and action = 'appointment.status.expired' and actor_type = 'system'`).toHaveLength(1);
      // The future request is untouched, and running the job again changes nothing.
      await expireRequests(worker);
      expect(await fixture.owner`select 1 from outbox_events where aggregate_id = ${request.appointmentId} and event_type = 'appointment.status.expired'`).toHaveLength(1);
      expect((await fixture.owner<{ status: string }[]>`select status from appointments where id = ${waiting.appointmentId}`)[0]!.status).toBe("requested");

      // Halfway reminder: only once, only for a request that has used half its time.
      await fixture.owner`update appointments set created_at = now() - interval '5 days' where id = ${waiting.appointmentId}`;
      await fixture.owner`update appointments set starts_at = now() + interval '1 day', ends_at = now() + interval '1 day 30 minutes' where id = ${waiting.appointmentId}`;
      await fixture.owner`update resource_reservations set starts_at = now() + interval '1 day', ends_at = now() + interval '1 day 30 minutes' where appointment_id = ${waiting.appointmentId}`;
      await remindAboutRequests(worker);
      await remindAboutRequests(worker);
      const alerts = await fixture.owner<{ id: string }[]>`select id from staff_notifications where tenant_id = ${fixture.tenantId} and dedupe_key = ${`request.reminder:${waiting.appointmentId}`}`;
      expect(alerts.length).toBeGreaterThanOrEqual(1);
      const people = await fixture.owner<{ n: number }[]>`select count(distinct membership_id)::int as n from staff_notifications where dedupe_key = ${`request.reminder:${waiting.appointmentId}`}`;
      expect(alerts.length).toBe(people[0]!.n);
      await fixture.owner`delete from staff_notifications where dedupe_key like 'request.reminder:%'`;
    } finally {
      await worker.end();
      await fixture.cleanup();
    }
  });
});
