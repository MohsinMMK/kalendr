/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import type { PublicBookingInput } from "@/lib/contracts";
import { resolvePermissions } from "@/lib/permissions";
import type { StaffContext } from "@/server/staff-context";

vi.mock("server-only", () => ({}));

import { createAppointment, listAvailability, manageAppointment, updateAppointmentStatus } from "@/server/appointment-repository";
import { withTenant } from "@/db/client";
import { getDayEnd } from "@/server/day-end";
import { refundPayment, recordPayment, getVisitPayments } from "@/server/payments";
import { isolatedDatabaseReady } from "@/test/isolated-database";
import { loadRecordKeys } from "@/server/record-crypto";
import { drizzleRunner } from "@/server/workflows/runner";
import { paymentHandlers } from "@/worker/payments";
import { expireUnpaidHolds } from "@/worker/payments/jobs";
import { connectPaymentAccount, savePaymentPolicy, saveServicePayment } from "./accounts";
import { applyPaymentPolicy } from "./cancellation";
import { startCheckout, paymentStatus } from "./checkout";
import { loadAccount, openCredentials } from "./credentials";
import { FAKE_SIGNATURE_HEADER, signFakeWebhook, type FakeWebhookBody } from "./fake";
import { receiveWebhook } from "./webhook";
import { WebhookSignatureError } from "./types";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const describeLocal = isolatedDatabaseReady(runtimeUrl, ownerUrl, workerUrl) ? describe : describe.skip;

const DAY = 86_400_000;
const slug = "lotus-dental";

describeLocal("online payments against a real database", () => {
  it("holds, confirms by webhook only, expires, refunds by policy, and stays inside its business", async () => {
    const owner = postgres(ownerUrl!, { max: 1, prepare: false });
    const worker = postgres(workerUrl!, { max: 1, prepare: false });
    const runtime = postgres(runtimeUrl!, { max: 1, prepare: false });
    const person = randomUUID();
    const service = randomUUID();
    let tenantId = "";
    try {
      const [tenant] = await owner<{ id: string }[]>`select id from tenants where slug = ${slug} limit 1`;
      const [other] = await owner<{ id: string }[]>`select id from tenants where slug <> ${slug} limit 1`;
      const [location] = await owner<{ id: string; timezone: string }[]>`select id, timezone from locations where tenant_id = ${tenant?.id ?? ""} limit 1`;
      if (!tenant || !other || !location) throw new Error("Seed the isolated local database before this test");
      tenantId = tenant.id;
      const locationId = location.id;
      await owner.begin(async (transaction) => {
        await transaction`insert into practitioners (id, tenant_id, name, title, initials, specialty) values (${person}, ${tenantId}, 'Pay Test', 'Dentist', 'PT', 'Testing')`;
        await transaction`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${tenantId}, ${person}, ${locationId})`;
        await transaction`
          insert into services (id, tenant_id, name, description, duration_minutes, buffer_before_minutes, buffer_after_minutes,
            slot_interval_minutes, minimum_lead_minutes, maximum_advance_days, booking_mode, patient_types, price_minor)
          values (${service}, ${tenantId}, 'Pay Test Service', 'Local integration test', 60, 0, 0, 60, 0, 60, 'instant', ${["new", "returning"]}, 80000)`;
        await transaction`insert into service_locations (tenant_id, service_id, location_id) values (${tenantId}, ${service}, ${locationId})`;
        await transaction`insert into practitioner_services (tenant_id, practitioner_id, service_id) values (${tenantId}, ${person}, ${service})`;
        for (let dayOfWeek = 1; dayOfWeek <= 7; dayOfWeek += 1) {
          await transaction`insert into availability_rules (id, tenant_id, location_id, practitioner_id, day_of_week, starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes)
            values (${randomUUID()}, ${tenantId}, ${locationId}, ${person}, ${dayOfWeek}, '09:00', '17:00', ${location.timezone}, '2025-01-01', 60)`;
        }
      });

      const staff: StaffContext = {
        tenantId, clinicSlug: slug, clinicName: "Lotus Dental Studio", role: "owner", permissions: resolvePermissions("owner", {}),
        membershipId: null, userId: null, userName: "Pay Tester", userEmail: "test@example.com", preview: false,
      };

      // Nothing is asked for online until the business has an account.
      await saveServicePayment(staff, service, { priceMinor: 80000, paymentMode: "deposit", depositMinor: 20000 });
      const openSlots = async () => listAvailability({ clinicSlug: slug, locationId, serviceId: service, practitionerId: person, from: new Date(Date.now() + 3 * DAY).toISOString(), to: new Date(Date.now() + 5 * DAY).toISOString() });
      const slots = await openSlots();
      expect(slots.length).toBeGreaterThan(6);
      const [first, second, third, fourth, fifth, sixth] = slots as [typeof slots[number], typeof slots[number], typeof slots[number], typeof slots[number], typeof slots[number], typeof slots[number]];
      const book = (slot: typeof first, extra: Partial<PublicBookingInput> = {}): PublicBookingInput => ({
        clinicSlug: slug, patientType: "new", bookingFor: "self", locationId, serviceId: service, practitionerId: person,
        slotId: slot.id, startsAt: slot.startsAt, endsAt: slot.endsAt, firstName: "Pay", lastName: "Test", phone: "+919000000066",
        email: `pay-${randomUUID().slice(0, 6)}@example.com`, preferredChannel: "email", acceptedPrivacyNotice: true, messagingConsent: false, ...extra,
      });
      const create = (input: PublicBookingInput) => createAppointment(input, randomUUID(), randomUUID().replaceAll("-", ""));
      const free = await create(book(first));
      expect(free.status).toBe("booked");
      expect(free.payment).toBeUndefined();

      // Connect the built-in test account (no keys needed) and set the policy.
      const account = await connectPaymentAccount(staff, { provider: "fake" }, "http://localhost:3000");
      expect(account).toMatchObject({ provider: "fake", mode: "test", status: "active" });
      expect(JSON.stringify(account)).not.toMatch(/secret/i);
      const stored = await owner<{ secret_ciphertext: string | null; webhook_secret_ciphertext: string; public_id: string }[]>`select secret_ciphertext, webhook_secret_ciphertext, public_id from tenant_payment_accounts where tenant_id = ${tenantId}`;
      expect(stored[0]?.webhook_secret_ciphertext.startsWith("s1.")).toBe(true);
      await savePaymentPolicy(staff, { freeCancelHours: 24, afterWindowRule: "no_refund", noShowRule: "deposit" });
      const publicId = stored[0]!.public_id;
      const webhookSecret = await withTenant(tenantId, async (transaction) => {
        await loadRecordKeys(transaction, tenantId);
        const row = await loadAccount(drizzleRunner(transaction), tenantId);
        return openCredentials(row!).webhookSecret;
      });

      // The booking asks for the policy to be accepted, then holds the time instead of confirming it.
      await expect(create(book(second))).rejects.toMatchObject({ code: "payment_terms_required" });
      const pending = await create(book(second, { acceptedPaymentPolicy: true }));
      expect(pending).toMatchObject({ status: "pending_payment", payment: { dueNowMinor: 20000, currency: "INR" } });
      expect(pending.payment?.policyText).toContain("full refund");
      const held = Date.parse(pending.payment!.expiresAt) - Date.now();
      expect(held).toBeGreaterThan(9 * 60_000);
      expect(held).toBeLessThanOrEqual(10 * 60_000);
      const events = await owner`select 1 from outbox_events where aggregate_id = ${pending.appointmentId}`;
      expect(events).toHaveLength(0);
      const terms = await owner<{ payment_terms_text: string; payment_terms: { dueNowMinor: number } }[]>`select payment_terms_text, payment_terms from appointments where id = ${pending.appointmentId}`;
      expect(terms[0]?.payment_terms.dueNowMinor).toBe(20000);
      expect(terms[0]?.payment_terms_text).toBe(pending.payment?.policyText);

      // The time left public availability at once, and a second customer cannot take it.
      expect((await openSlots()).some((slot) => slot.id === second.id)).toBe(false);
      await expect(create(book(second, { acceptedPaymentPolicy: true }))).rejects.toMatchObject({ code: "slot_unavailable" });

      // The amount is the server's own: there is nothing in the request that could change it.
      const checkout = await startCheckout({ clinicSlug: slug, manageToken: pending.manageToken }, "http://localhost:3000");
      expect(checkout).toMatchObject({ provider: "fake", amountMinor: 20000, currency: "INR", mode: "test" });
      expect(checkout.checkoutUrl).toContain("/pay/test/");
      const again = await startCheckout({ clinicSlug: slug, manageToken: pending.manageToken }, "http://localhost:3000");
      expect(again.orderId).toBe(checkout.orderId);

      // A forged webhook is refused; a real one is stored once, and on its own confirms nothing.
      const capture: FakeWebhookBody = { id: `evt_${randomUUID()}`, type: "payment.captured", orderId: checkout.orderId, paymentId: `pay_${randomUUID()}`, amountMinor: 20000, currency: "INR" };
      const signed = signFakeWebhook(webhookSecret, capture);
      const headers = (signature: string) => new Headers({ [FAKE_SIGNATURE_HEADER]: signature });
      await expect(receiveWebhook("fake", publicId, signed.rawBody, headers("0".repeat(64)))).rejects.toBeInstanceOf(WebhookSignatureError);
      await expect(receiveWebhook("fake", publicId, signed.rawBody, new Headers())).rejects.toBeInstanceOf(WebhookSignatureError);
      await expect(receiveWebhook("fake", "not-a-real-account-id", signed.rawBody, headers(signed.signature))).rejects.toBeInstanceOf(WebhookSignatureError);
      const tampered = signFakeWebhook(webhookSecret, { ...capture, amountMinor: 100 });
      await expect(receiveWebhook("fake", publicId, tampered.rawBody, headers(signed.signature))).rejects.toBeInstanceOf(WebhookSignatureError);
      expect(await receiveWebhook("fake", publicId, signed.rawBody, headers(signed.signature))).toBe("queued");
      expect(await receiveWebhook("fake", publicId, signed.rawBody, headers(signed.signature))).toBe("duplicate");
      expect(await paymentStatus({ clinicSlug: slug, manageToken: pending.manageToken })).toMatchObject({ state: "waiting" });
      expect(Number((await owner`select count(*) from payment_events where tenant_id = ${tenantId} and provider_event_id = ${capture.id}`)[0]?.count)).toBe(1);

      // The worker confirms it: payment recorded once, booking confirmed, hold turned into the booking, message queued.
      const handlers = new Map(paymentHandlers({ now: () => new Date() }));
      const run = async (eventType: string, dedupePrefix: string) => {
        const rows = await owner<{ id: string; aggregate_type: string; aggregate_id: string; payload: unknown; dedupe_key: string }[]>`
          select id, aggregate_type, aggregate_id, payload, dedupe_key from outbox_events
          where tenant_id = ${tenantId} and event_type = ${eventType} and dedupe_key like ${`${dedupePrefix}%`} and status = 'pending' order by created_at`;
        const outcomes: unknown[] = [];
        for (const row of rows) {
          const outcome = await worker.begin(async (tenantDb) => {
            await tenantDb`select set_config('app.tenant_id', ${tenantId}, true)`;
            return handlers.get(eventType)!(tenantDb, { id: row.id, tenantId, aggregateType: row.aggregate_type, aggregateId: row.aggregate_id, eventType, payload: row.payload, dedupeKey: row.dedupe_key, attemptCount: 0 });
          });
          await owner`update outbox_events set status = 'delivered' where id = ${row.id}`;
          outcomes.push(outcome);
        }
        return outcomes;
      };
      expect(await run("payment.event", "payment.event:fake:")).toEqual(["delivered"]);
      const paidAppointment = await owner<{ status: string; version: number }[]>`select status::text, version from appointments where id = ${pending.appointmentId}`;
      expect(paidAppointment[0]?.status).toBe("booked");
      const ledger = await owner<{ amount_minor: number; method: string; provider: string; is_test: boolean }[]>`select amount_minor, method::text, provider, is_test from payments where appointment_id = ${pending.appointmentId}`;
      expect(ledger).toEqual([{ amount_minor: 20000, method: "upi", provider: "fake", is_test: true }]);
      const reservations = await owner<{ state: string }[]>`select state::text from resource_reservations where appointment_id = ${pending.appointmentId}`;
      expect(reservations.every((row) => row.state === "confirmed")).toBe(true);
      const confirmation = await owner<{ dedupe_key: string }[]>`select dedupe_key from outbox_events where aggregate_id = ${pending.appointmentId} and event_type = 'appointment.created'`;
      expect(confirmation).toHaveLength(1);
      // Stored as a real JSON object, so the message handler can read it (not a JSON string inside JSON).
      expect((await owner`select payload->>'appointmentId' as id from outbox_events where aggregate_id = ${pending.appointmentId} and event_type = 'appointment.created'`)[0]?.id).toBe(pending.appointmentId);
      expect(await paymentStatus({ clinicSlug: slug, manageToken: pending.manageToken })).toMatchObject({ state: "confirmed" });
      // The same event delivered by another route (a different event id for the same payment) still pays once.
      const replay = signFakeWebhook(webhookSecret, { ...capture, id: `evt_${randomUUID()}` });
      expect(await receiveWebhook("fake", publicId, replay.rawBody, headers(replay.signature))).toBe("queued");
      await run("payment.event", "payment.event:fake:");
      expect(Number((await owner`select count(*) from payments where appointment_id = ${pending.appointmentId}`)[0]?.count)).toBe(1);

      // Test money stays out of the day close.
      const dayEnd = await getDayEnd(staff, { locationId });
      expect(dayEnd.summary.money.byMethod.upi).toBe(0);

      // Cancelling inside the free window refunds the deposit, through the worker and the same ledger.
      const cancelled = await manageAppointment(pending.manageToken, { action: "cancel", expectedVersion: paidAppointment[0]!.version });
      expect(cancelled.status).toBe("cancelled");
      const request = await owner<{ amount_minor: number; source: string; status: string }[]>`select amount_minor, source, status from refund_requests where tenant_id = ${tenantId} and payment_id in (select id from payments where appointment_id = ${pending.appointmentId})`;
      expect(request).toEqual([{ amount_minor: 20000, source: "policy", status: "pending" }]);
      const visit = await getVisitPayments(staff, pending.appointmentId);
      expect(visit.payments[0]).toMatchObject({ provider: "fake", isTest: true, pendingRefundMinor: 20000, refundableMinor: 0 });
      expect(await run("refund.process", "refund.process:")).toEqual(["delivered"]);
      const refunded = await owner<{ amount_minor: number; provider_refund_id: string }[]>`select amount_minor, provider_refund_id from payment_refunds where tenant_id = ${tenantId} and payment_id in (select id from payments where appointment_id = ${pending.appointmentId})`;
      expect(refunded).toHaveLength(1);
      expect(refunded[0]?.amount_minor).toBe(20000);
      expect((await owner<{ status: string }[]>`select status from refund_requests where tenant_id = ${tenantId} and payment_id in (select id from payments where appointment_id = ${pending.appointmentId})`)[0]?.status).toBe("done");
      // Asking again for the same cancellation does nothing more, and a staff refund cannot go past the payment.
      const [paymentRow] = await owner<{ id: string }[]>`select id from payments where appointment_id = ${pending.appointmentId}`;
      await expect(refundPayment(staff, paymentRow!.id, { amountMinor: 100, reason: "Too much" }, randomUUID())).rejects.toMatchObject({ code: "refund_exceeds_payment" });
      const repeat = await withTenant(tenantId, (transaction) => applyPaymentPolicy(drizzleRunner(transaction), { tenantId, appointmentId: pending.appointmentId, event: "cancel" }));
      expect(repeat.refundMinor).toBe(0);

      // Outside the window the deposit is kept: nothing is refunded.
      const late = await create(book(third, { acceptedPaymentPolicy: true }));
      const lateCheckout = await startCheckout({ clinicSlug: slug, manageToken: late.manageToken }, "http://localhost:3000");
      const lateSigned = signFakeWebhook(webhookSecret, { id: `evt_${randomUUID()}`, type: "payment.captured", orderId: lateCheckout.orderId, paymentId: `pay_${randomUUID()}`, amountMinor: 20000, currency: "INR" });
      await receiveWebhook("fake", publicId, lateSigned.rawBody, headers(lateSigned.signature));
      await run("payment.event", "payment.event:fake:");
      await owner`update appointments set starts_at = now() + interval '2 hours' where id = ${late.appointmentId}`;
      const lateVersion = (await owner<{ version: number }[]>`select version from appointments where id = ${late.appointmentId}`)[0]!.version;
      await manageAppointment(late.manageToken, { action: "cancel", expectedVersion: lateVersion });
      expect(Number((await owner`select count(*) from refund_requests where tenant_id = ${tenantId} and payment_id in (select id from payments where appointment_id = ${late.appointmentId})`)[0]?.count)).toBe(0);

      // A payment for another amount is never trusted: no ledger row, and the owner is told.
      const odd = await create(book(fourth, { acceptedPaymentPolicy: true }));
      const oddCheckout = await startCheckout({ clinicSlug: slug, manageToken: odd.manageToken }, "http://localhost:3000");
      const oddSigned = signFakeWebhook(webhookSecret, { id: `evt_${randomUUID()}`, type: "payment.captured", orderId: oddCheckout.orderId, paymentId: `pay_${randomUUID()}`, amountMinor: 100, currency: "INR" });
      await receiveWebhook("fake", publicId, oddSigned.rawBody, headers(oddSigned.signature));
      await run("payment.event", "payment.event:fake:");
      expect(Number((await owner`select count(*) from payments where appointment_id = ${odd.appointmentId}`)[0]?.count)).toBe(0);
      expect((await owner<{ kind: string }[]>`select kind from payment_mismatches where tenant_id = ${tenantId}`).map((row) => row.kind)).toContain("amount_differs");
      expect((await owner<{ status: string }[]>`select status::text from appointments where id = ${odd.appointmentId}`)[0]?.status).toBe("pending_payment");

      // Closing the checkout releases the time: the unpaid hold runs out and the slot is offered again.
      await owner`update resource_reservations set hold_expires_at = now() - interval '1 second' where appointment_id = ${odd.appointmentId}`;
      expect((await openSlots()).some((slot) => slot.id === fourth.id)).toBe(true);
      await expireUnpaidHolds(worker);
      expect((await owner<{ status: string }[]>`select status::text from appointments where id = ${odd.appointmentId}`)[0]?.status).toBe("expired");
      expect((await owner<{ status: string }[]>`select status from payment_orders where appointment_id = ${odd.appointmentId}`)[0]?.status).toBe("expired");
      expect(await paymentStatus({ clinicSlug: slug, manageToken: odd.manageToken })).toMatchObject({ state: "expired" });
      await expect(startCheckout({ clinicSlug: slug, manageToken: odd.manageToken }, "http://localhost:3000")).rejects.toMatchObject({ code: "not_payable" });

      // Paying after the hold ran out takes the time back when it is still free...
      const slow = await create(book(fifth, { acceptedPaymentPolicy: true }));
      const slowCheckout = await startCheckout({ clinicSlug: slug, manageToken: slow.manageToken }, "http://localhost:3000");
      await owner`update resource_reservations set hold_expires_at = now() - interval '1 second' where appointment_id = ${slow.appointmentId}`;
      await expireUnpaidHolds(worker);
      const slowSigned = signFakeWebhook(webhookSecret, { id: `evt_${randomUUID()}`, type: "payment.captured", orderId: slowCheckout.orderId, paymentId: `pay_${randomUUID()}`, amountMinor: 20000, currency: "INR" });
      await receiveWebhook("fake", publicId, slowSigned.rawBody, headers(slowSigned.signature));
      await run("payment.event", "payment.event:fake:");
      expect((await owner<{ status: string }[]>`select status::text from appointments where id = ${slow.appointmentId}`)[0]?.status).toBe("booked");

      // ...and refunds it automatically when someone else has taken the time.
      const taken = await create(book(sixth, { acceptedPaymentPolicy: true }));
      const takenCheckout = await startCheckout({ clinicSlug: slug, manageToken: taken.manageToken }, "http://localhost:3000");
      await owner`update resource_reservations set hold_expires_at = now() - interval '1 second' where appointment_id = ${taken.appointmentId}`;
      await expireUnpaidHolds(worker);
      const rival = await create(book(sixth, { firstName: "Rival", phone: "+919000000067", acceptedPaymentPolicy: true }));
      expect(rival.status).toBe("pending_payment");
      const takenSigned = signFakeWebhook(webhookSecret, { id: `evt_${randomUUID()}`, type: "payment.captured", orderId: takenCheckout.orderId, paymentId: `pay_${randomUUID()}`, amountMinor: 20000, currency: "INR" });
      await receiveWebhook("fake", publicId, takenSigned.rawBody, headers(takenSigned.signature));
      await run("payment.event", "payment.event:fake:");
      expect((await owner<{ status: string }[]>`select status::text from appointments where id = ${taken.appointmentId}`)[0]?.status).toBe("expired");
      const lateRefund = await owner<{ source: string; amount_minor: number }[]>`select source, amount_minor from refund_requests where tenant_id = ${tenantId} and payment_id in (select id from payments where appointment_id = ${taken.appointmentId})`;
      expect(lateRefund).toEqual([{ source: "late_payment", amount_minor: 20000 }]);
      expect(await run("refund.process", "refund.process:")).toEqual(["delivered"]);
      expect(await owner`select status, failure_code from refund_requests where tenant_id = ${tenantId} and source = 'late_payment'`).toEqual([{ status: "done", failure_code: null }]);
      expect(Number((await owner`select count(*) from payment_refunds where payment_id in (select id from payments where appointment_id = ${taken.appointmentId})`)[0]?.count)).toBe(1);

      // A refund the provider reports before the capture it belongs to is kept and tried again, not dropped.
      const earlyRefund = signFakeWebhook(webhookSecret, { id: `evt_${randomUUID()}`, type: "refund.processed", paymentId: `pay_${randomUUID()}`, refundId: `rfnd_${randomUUID().slice(0, 8)}`, amountMinor: 500, currency: "INR" });
      await receiveWebhook("fake", publicId, earlyRefund.rawBody, headers(earlyRefund.signature));
      expect(await run("payment.event", "payment.event:fake:")).toEqual([{ outcome: "retry", code: "refund_waiting" }]);

      // Staff cannot confirm an unpaid booking by hand (the time would stay only held); they can let it go, which frees the time.
      const seventh = slots[6]!;
      const unpaid = await create(book(seventh, { acceptedPaymentPolicy: true }));
      const [member] = await owner<{ user_id: string }[]>`select user_id from memberships where tenant_id = ${tenantId} and role = 'owner' limit 1`;
      await expect(updateAppointmentStatus(member!.user_id, unpaid.appointmentId, { status: "booked", expectedVersion: 1 })).rejects.toMatchObject({ code: "invalid_status_transition" });
      expect((await openSlots()).some((slot) => slot.id === seventh.id)).toBe(false);
      await expect(updateAppointmentStatus(member!.user_id, unpaid.appointmentId, { status: "cancelled", expectedVersion: 1 })).resolves.toMatchObject({ status: "cancelled" });
      expect((await openSlots()).some((slot) => slot.id === seventh.id)).toBe(true);

      // Money rows are never edited; desk payments still work beside online ones.
      await expect(owner`update payments set amount_minor = 1 where appointment_id = ${slow.appointmentId}`).rejects.toThrow();
      await expect(owner`delete from payments where appointment_id = ${slow.appointmentId}`).rejects.toThrow(/cannot be changed/);
      const desk = await recordPayment(staff, slow.appointmentId, { amountMinor: 60000, method: "cash" }, randomUUID());
      expect(desk.balance.dueMinor).toBe(0);
      expect(desk.payments).toHaveLength(2);

      // A checkout link paid after the desk already took the full price: the extra goes back, and only the extra.
      const [slowOrder] = await owner<{ id: string }[]>`select account_id as id from payment_orders where appointment_id = ${slow.appointmentId} limit 1`;
      const extraOrder = `order_${randomUUID().slice(0, 12)}`;
      await owner`insert into payment_orders (tenant_id, appointment_id, account_id, provider, mode, amount_minor, currency, expires_at, provider_order_id)
        values (${tenantId}, ${slow.appointmentId}, ${slowOrder!.id}, 'fake', 'test', 30000, 'INR', now() + interval '1 hour', ${extraOrder})`;
      const extraSigned = signFakeWebhook(webhookSecret, { id: `evt_${randomUUID()}`, type: "payment.captured", orderId: extraOrder, paymentId: `pay_${randomUUID()}`, amountMinor: 30000, currency: "INR" });
      await receiveWebhook("fake", publicId, extraSigned.rawBody, headers(extraSigned.signature));
      expect(await run("payment.event", "payment.event:fake:")).toEqual(["delivered"]);
      expect(await owner`select amount_minor from refund_requests where tenant_id = ${tenantId} and payment_id in (select id from payments where appointment_id = ${slow.appointmentId})`).toEqual([{ amount_minor: 30000 }]);

      // Another business sees none of it, and the runtime role cannot read the sealed keys of a business it is not acting for.
      const seen = await runtime.begin(async (transaction) => {
        await transaction`select set_config('app.tenant_id', ${other.id}, true)`;
        const accounts = await transaction<{ count: string }[]>`select count(*) from tenant_payment_accounts where tenant_id = ${tenantId}`;
        const orders = await transaction<{ count: string }[]>`select count(*) from payment_orders where tenant_id = ${tenantId}`;
        const requests = await transaction<{ count: string }[]>`select count(*) from refund_requests where tenant_id = ${tenantId}`;
        const hooks = await transaction<{ count: string }[]>`select count(*) from payment_events where tenant_id = ${tenantId}`;
        return [accounts, orders, requests, hooks].map((rows) => Number(rows[0]?.count));
      });
      expect(seen).toEqual([0, 0, 0, 0]);
      await expect(runtime.begin(async (transaction) => {
        await transaction`select set_config('app.tenant_id', ${other.id}, true)`;
        await transaction`insert into tenant_payment_policies (tenant_id, free_cancel_hours) values (${tenantId}, 1)`;
      })).rejects.toThrow();
    } finally {
      if (tenantId) {
        await owner.begin(async (transaction) => {
          await transaction`alter table payments disable trigger payments_final`;
          await transaction`alter table payment_refunds disable trigger payment_refunds_final`;
          const appointments = await transaction<{ id: string; patient_id: string }[]>`select id, patient_id from appointments where service_id = ${service}`;
          const ids = appointments.map((row) => row.id);
          if (ids.length) {
            await transaction`delete from refund_requests where tenant_id = ${tenantId} and payment_id in (select id from payments where appointment_id in ${transaction(ids)})`;
            await transaction`delete from payment_refunds where tenant_id = ${tenantId} and payment_id in (select id from payments where appointment_id in ${transaction(ids)})`;
            await transaction`delete from payments where appointment_id in ${transaction(ids)}`;
            await transaction`delete from payment_orders where appointment_id in ${transaction(ids)}`;
            await transaction`delete from audit_events where appointment_id in ${transaction(ids)}`;
            await transaction`delete from outbox_events where tenant_id = ${tenantId} and aggregate_id in ${transaction(ids)}`;
            await transaction`delete from staff_notifications where tenant_id = ${tenantId} and dedupe_key in ${transaction(ids.flatMap((id) => [`appointment.created:${id}`]))}`;
          }
          await transaction`alter table payments enable trigger payments_final`;
          await transaction`alter table payment_refunds enable trigger payment_refunds_final`;
          await transaction`delete from outbox_events where tenant_id = ${tenantId} and event_type in ('payment.event', 'refund.process')`;
          await transaction`delete from payment_events where tenant_id = ${tenantId}`;
          await transaction`delete from payment_mismatches where tenant_id = ${tenantId}`;
          // Another journey's orders may still point at the account, in which case it is only switched off.
          await transaction`delete from tenant_payment_accounts as account where tenant_id = ${tenantId} and not exists (select 1 from payment_orders where account_id = account.id)`;
          await transaction`update tenant_payment_accounts set status = 'disabled', secret_ciphertext = null, webhook_secret_ciphertext = null where tenant_id = ${tenantId}`;
          await transaction`delete from tenant_payment_policies where tenant_id = ${tenantId}`;
          if (ids.length) await transaction`delete from appointments where id in ${transaction(ids)}`;
          await transaction`delete from idempotency_keys where tenant_id = ${tenantId} and created_at > now() - interval '30 minutes'`;
          await transaction`delete from availability_rules where practitioner_id = ${person}`;
          await transaction`delete from practitioner_services where practitioner_id = ${person}`;
          await transaction`delete from practitioner_locations where practitioner_id = ${person}`;
          await transaction`delete from service_locations where service_id = ${service}`;
          await transaction`delete from services where id = ${service}`;
          await transaction`delete from practitioners where id = ${person}`;
        });
      }
      await Promise.all([owner.end(), worker.end(), runtime.end()]);
    }
  }, 120_000);
});
