/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createAppointment, manageAppointment } from "@/server/appointment-repository";
import { runStaffAppointmentAction } from "@/server/staff-transitions";
import { applyServiceSetupPatch, getServiceSetup } from "@/server/services-admin";
import { expireRescheduleRequests } from "@/worker/request-jobs";
import { describeScratch } from "@/server/testing/scratch-database";
import { createSchedulingFixture, plusMinutes, startIn, type SchedulingFixture } from "@/server/testing/scheduling-fixture";
import type { PublicBookingInput } from "@/lib/contracts";

const ownerUrl = process.env.KALENDR_TEST_OWNER_URL ?? "";
const workerUrl = process.env.WORKER_DATABASE_URL ?? "";

const book = (input: PublicBookingInput) => createAppointment(input, randomUUID(), randomUUID().replaceAll("-", ""));

/** Pretends the booking was paid online: a ledger row and the terms the customer agreed to, as feature 23 stores them. */
async function paid(fixture: SchedulingFixture, appointmentId: string, amountMinor = 20_000) {
  const [payment] = await fixture.owner<{ id: string }[]>`
    insert into payments (tenant_id, appointment_id, amount_minor, currency, method, provider, provider_payment_id, is_test)
    values (${fixture.tenantId}, ${appointmentId}, ${amountMinor}, 'INR', 'other', 'fake', ${`pay_${randomUUID()}`}, true) returning id`;
  await fixture.owner`update appointments set payment_terms = ${fixture.owner.json({ depositMinor: amountMinor, freeCancelHours: 24, afterWindowRule: "no_refund", noShowRule: "deposit" })} where id = ${appointmentId}`;
  return payment!.id;
}

const refunds = (fixture: SchedulingFixture, paymentId: string) => fixture.owner<{ amount_minor: number; source: string }[]>`
  select amount_minor, source from refund_requests where payment_id = ${paymentId} order by created_at`;

async function startsInMinutes(fixture: SchedulingFixture, appointmentId: string, minutes: number) {
  await fixture.owner`update appointments set starts_at = now() + ${minutes} * interval '1 minute', ends_at = now() + (${minutes} + 30) * interval '1 minute' where id = ${appointmentId}`;
  await fixture.owner`update resource_reservations set starts_at = now() + ${minutes} * interval '1 minute', ends_at = now() + (${minutes} + 30) * interval '1 minute' where appointment_id = ${appointmentId}`;
}

describeScratch("cancellation and online payments (feature 42 meets feature 23)", () => {
  it("refunds the deposit for a customer cancelling inside the free window, and keeps it outside", async () => {
    const fixture = await createSchedulingFixture(ownerUrl, { name: "Seam" });
    try {
      const early = await book(fixture.bookingInput(startIn(10, 10), plusMinutes(startIn(10, 10), 30), "early@acme-corp.in"));
      const earlyPayment = await paid(fixture, early.appointmentId);
      await manageAppointment(early.manageToken, { action: "cancel", reasonCode: "cant_make_it", expectedVersion: 1 });
      expect(await refunds(fixture, earlyPayment)).toEqual([{ amount_minor: 20_000, source: "policy" }]);

      const late = await book(fixture.bookingInput(startIn(11, 10), plusMinutes(startIn(11, 10), 30), "late@acme-corp.in"));
      const latePayment = await paid(fixture, late.appointmentId);
      await startsInMinutes(fixture, late.appointmentId, 6 * 60);
      await manageAppointment(late.manageToken, { action: "cancel", reasonCode: "cant_make_it", expectedVersion: 1 });
      expect(await refunds(fixture, latePayment)).toEqual([]);
      const audit = await fixture.owner<{ metadata: { refundMinor: number; keptMinor: number } }[]>`select metadata from audit_events where appointment_id = ${late.appointmentId} and action = 'payment.policy_applied'`;
      expect(audit[0]!.metadata).toMatchObject({ refundMinor: 0, keptMinor: 20_000 });
    } finally {
      await fixture.cleanup();
    }
  });

  it("gives everything back when the business did not turn up or a requested move was never answered", async () => {
    const fixture = await createSchedulingFixture(ownerUrl, { name: "Fault" });
    const worker = postgres(workerUrl, { max: 2, prepare: false });
    try {
      const missed = await book(fixture.bookingInput(startIn(12, 10), plusMinutes(startIn(12, 10), 30), "missed@acme-corp.in"));
      const missedPayment = await paid(fixture, missed.appointmentId);
      await startsInMinutes(fixture, missed.appointmentId, -120);
      await runStaffAppointmentAction(fixture.context, missed.appointmentId, { action: "mark_no_show", who: "host", expectedVersion: 1 });
      const total = (await refunds(fixture, missedPayment)).reduce((sum, row) => sum + row.amount_minor, 0);
      expect(total).toBe(20_000);

      const moved = await book(fixture.bookingInput(startIn(13, 10), plusMinutes(startIn(13, 10), 30), "moved@acme-corp.in"));
      const movedPayment = await paid(fixture, moved.appointmentId);
      await startsInMinutes(fixture, moved.appointmentId, 3 * 60);
      await runStaffAppointmentAction(fixture.context, moved.appointmentId, { action: "request_reschedule", expectedVersion: 1 });
      expect(await refunds(fixture, movedPayment)).toEqual([]);
      const setup = await getServiceSetup(fixture.context, fixture.serviceId);
      await applyServiceSetupPatch(fixture.context, fixture.serviceId, { cancelPolicy: { ...setup.cancelPolicy!, rescheduleRequestDays: 1 } }, setup.version);
      await fixture.owner`update appointments set reschedule_requested_at = now() - interval '2 days' where id = ${moved.appointmentId}`;
      await expireRescheduleRequests(worker);
      await expireRescheduleRequests(worker);
      expect(await refunds(fixture, movedPayment)).toEqual([{ amount_minor: 20_000, source: "reschedule" }]);
    } finally {
      await worker.end();
      await fixture.cleanup();
    }
  });
});
