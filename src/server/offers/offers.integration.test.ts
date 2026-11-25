/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { couponInputSchema } from "@/lib/offers-contracts";
import { isolatedDatabaseReady } from "@/test/isolated-database";
import { drainTenantOutbox } from "@/test/outbox-drain";
import { createBooking, createCustomer, createTenant, staffContext, type TenantFixture } from "@/test/privacy-fixture";

vi.mock("server-only", () => ({}));

import { withTenant } from "@/db/client";
import { ApiError } from "@/server/api-error";
import { createAppointment, createStaffAppointment, mutateStaffAppointment, updateAppointmentStatus } from "@/server/appointment-repository";
import type { StaffBookingInput } from "@/server/contracts";
import { getDayEnd } from "@/server/day-end";
import { getInvoice, issueCreditNote, issueVisitInvoice } from "@/server/invoicing/invoice";
import { saveTaxSettings } from "@/server/invoicing/settings";
import { prepareBookingOffers, releaseBookingOffers } from "@/server/offers/booking-offers";
import { listCoupons, saveCoupon, validateCouponPublic } from "@/server/offers/coupons";
import { applyMembershipEvent } from "@/server/offers/memberships-core";
import { enrolMembership, renewMembership, savePlan } from "@/server/offers/memberships";
import { adjustCredits, getCustomerOffers, savePackage, sellPackage, spendCreditOnAppointment } from "@/server/offers/packages";
import { refundPayment } from "@/server/payments";
import { connectPaymentAccount } from "@/server/payments/accounts";
import { loadAccount, openCredentials } from "@/server/payments/credentials";
import { FAKE_SIGNATURE_HEADER, signFakeWebhook, type FakeWebhookBody } from "@/server/payments/fake";
import { receiveWebhook } from "@/server/payments/webhook";
import { loadRecordKeys } from "@/server/record-crypto";
import { drizzleRunner, postgresRunner } from "@/server/workflows/runner";
import { localCaptureSink, type MessageSink, type OutgoingMessage } from "@/worker/delivery";
import { createHandlers } from "@/worker/handlers";
import { sweepCredits, sweepMemberships } from "@/worker/offers";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL ?? process.env.KALENDR_E2E_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const describeIsolated = isolatedDatabaseReady(runtimeUrl, ownerUrl, workerUrl) ? describe : describe.skip;

const DAY = 86_400_000;

async function expectApiError(promise: Promise<unknown>, code: string): Promise<ApiError> {
  const error = await promise.then(() => null, (cause: unknown) => cause);
  expect(error, `expected ${code}`).toBeInstanceOf(ApiError);
  expect((error as ApiError).code).toBe(code);
  return error as ApiError;
}

describeIsolated("packages, memberships and coupons against a real database", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  const sent: OutgoingMessage[] = [];
  const sink: MessageSink = { mode: "local_capture", async deliver(tenantDb, message, now) { sent.push(message); return localCaptureSink.deliver(tenantDb, message, now); } };

  beforeAll(() => {
    owner = postgres(ownerUrl!, { max: 6, prepare: false });
    worker = postgres(workerUrl!, { max: 3, prepare: false });
  });
  afterAll(async () => {
    await owner.end({ timeout: 5 });
    await worker.end({ timeout: 5 });
  });

  interface Place { fixture: TenantFixture; context: ReturnType<typeof staffContext>; patientId: string; }

  async function place(label: string, priceMinor = 100_000): Promise<Place> {
    const fixture = await createTenant(owner, label, "wellness");
    await owner`update services set duration_minutes = 30, slot_interval_minutes = 30, minimum_lead_minutes = 0, maximum_advance_days = 400, price_minor = ${priceMinor} where id = ${fixture.serviceId}`;
    await owner`insert into service_locations (tenant_id, service_id, location_id) values (${fixture.tenantId}, ${fixture.serviceId}, ${fixture.locationId})`;
    await owner`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${fixture.tenantId}, ${fixture.practitionerId}, ${fixture.locationId})`;
    await owner`insert into practitioner_services (tenant_id, practitioner_id, service_id) values (${fixture.tenantId}, ${fixture.practitionerId}, ${fixture.serviceId})`;
    for (let day = 1; day <= 7; day += 1) {
      await owner`insert into availability_rules (id, tenant_id, location_id, practitioner_id, day_of_week, starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes)
        values (${randomUUID()}, ${fixture.tenantId}, ${fixture.locationId}, ${fixture.practitionerId}, ${day}, '00:00', '23:59', 'Asia/Kolkata', '2025-01-01', 30)`;
    }
    const [user] = await owner<{ id: string }[]>`insert into auth_users (name, email, email_verified) values (${`Staff ${label}`}, ${`staff-${randomUUID().slice(0, 8)}@example.com`}, true) returning id`;
    await owner`insert into memberships (tenant_id, user_id, role) values (${fixture.tenantId}, ${user!.id}, 'owner')`;
    const patient = await createCustomer(owner, fixture.tenantId);
    return { fixture, patientId: patient.id, context: staffContext(fixture, { userId: user!.id }) };
  }

  /** An ISO start `days` ahead at hh:mm Kolkata. */
  const at = (days: number, time: string): string => {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + days * DAY));
    return new Date(`${day}T${time}:00.000+05:30`).toISOString();
  };
  const booking = (p: Place, startsAt: string, over: Partial<StaffBookingInput> = {}): StaffBookingInput => ({
    clinicSlug: p.fixture.slug, locationId: p.fixture.locationId, serviceId: p.fixture.serviceId, practitionerId: p.fixture.practitionerId, startsAt, source: "desk", patientId: p.patientId, ...over,
  });
  const staffBook = (p: Place, input: StaffBookingInput) => createStaffAppointment(p.context, input, randomUUID(), randomUUID());

  async function package10(p: Place, priceMinor = 80_000, credits = 10) {
    const pack = await savePackage(p.context, null, { name: `${credits} sessions`, priceMinor, credits, validDays: 90, serviceIds: [p.fixture.serviceId], isActive: true });
    return sellPackage(p.context, { patientId: p.patientId, packageId: pack.id, locationId: p.fixture.locationId, payments: [{ method: "cash", amountMinor: priceMinor }] }, randomUUID());
  }
  const balance = async (customerPackageId: string) => Number((await owner`select coalesce(sum("change"), 0) as n from customer_credits where customer_package_id = ${customerPackageId}`)[0]!.n);

  it("sells a 10-session package, spends one credit on a booking and gives it back when cancelled in time", async () => {
    const p = await place("pack");
    await saveTaxSettings(p.context, { registered: true, gstin: "36AABCU9603R1ZO", legalName: "Glow Pvt Ltd", address: "1 Road", stateCode: "36", pricesIncludeTax: true, defaultTreatment: "taxable", defaultRateBps: 1800, defaultSacCode: "999722", confirm: true });
    const sold = await package10(p);
    expect(sold).toMatchObject({ creditsTotal: 10, remaining: 10, status: "active" });
    expect(sold.ledger).toMatchObject([{ change: 10, kind: "purchase" }]);
    // One invoice for the sale, the money in the same ledger as everything else, and it shows in the day's payments.
    const [invoice] = await owner<{ number: string; total_minor: number; source: string }[]>`select number, total_minor, source from invoices where id = ${sold.invoiceId}`;
    expect(invoice).toMatchObject({ total_minor: 80_000, source: "package" });
    const [payment] = await owner<{ patient_id: string; location_id: string; appointment_id: string | null; amount_minor: number }[]>`select patient_id, location_id, appointment_id, amount_minor from payments where invoice_id = ${sold.invoiceId}`;
    expect(payment).toMatchObject({ patient_id: p.patientId, location_id: p.fixture.locationId, appointment_id: null, amount_minor: 80_000 });

    const visit = await staffBook(p, booking(p, at(5, "10:00"), { customerPackageId: sold.id }));
    const [row] = await owner<{ price_minor: number; version: number }[]>`select price_minor, version from appointments where id = ${visit.appointmentId}`;
    expect(row!.price_minor).toBe(0);
    expect(await balance(sold.id)).toBe(9);
    const afterUse = (await getCustomerOffers(p.context, p.patientId)).packages[0]!;
    expect(afterUse.remaining).toBe(9);
    expect(afterUse.ledger.map((entry) => [entry.kind, entry.change])).toEqual([["purchase", 10], ["use", -1]]);
    expect(afterUse.ledger[1]!.appointmentId).toBe(visit.appointmentId);
    await expectApiError(issueVisitInvoice(p.context, { appointmentId: visit.appointmentId }, randomUUID()), "paid_with_package");

    await updateAppointmentStatus(p.context.userId!, visit.appointmentId, { status: "cancelled", expectedVersion: row!.version, reason: "Cancelled for the test" });
    expect(await balance(sold.id)).toBe(10);
    const rows = await owner<{ kind: string; change: number }[]>`select kind, "change" from customer_credits where customer_package_id = ${sold.id} order by created_at, id`;
    expect(rows.map((entry) => entry.kind)).toEqual(["purchase", "use", "return"]);
    // Asking again gives nothing more back.
    await withTenant(p.fixture.tenantId, (transaction) => releaseBookingOffers(drizzleRunner(transaction), { tenantId: p.fixture.tenantId, appointmentId: visit.appointmentId, action: "appointment.cancel" }));
    expect(await balance(sold.id)).toBe(10);
  });

  it("gives money back for a credited package sale, which has no visit to refund through", async () => {
    const p = await place("saleback");
    const sold = await package10(p, 40_000, 4);
    const before = await getDayEnd(p.context, { locationId: p.fixture.locationId });
    const invoice = await getInvoice(p.context, sold.invoiceId!);
    expect(invoice).toMatchObject({ source: "package", state: "paid", paidMinor: 40_000 });
    expect(invoice.payments).toMatchObject([{ method: "cash", amountMinor: 40_000, refundableMinor: 40_000 }]);
    const credited = await issueCreditNote(p.context, invoice.id, { reason: "Changed their mind" }, randomUUID());
    expect(credited).toMatchObject({ state: "refund_due", refundDueMinor: 40_000 });
    // Credited in full, the package's credits are gone too: nothing is left to book for free.
    expect(await balance(sold.id)).toBe(0);

    const key = randomUUID();
    const refund = await refundPayment(p.context, credited.payments[0]!.id, { amountMinor: 25_000, reason: "Credit note" }, key);
    expect(refund).toMatchObject({ amountMinor: 25_000, refundQueued: false });
    // The same click twice is one refund.
    expect(await refundPayment(p.context, credited.payments[0]!.id, { amountMinor: 25_000, reason: "Credit note" }, key)).toEqual(refund);
    await expectApiError(refundPayment(p.context, credited.payments[0]!.id, { amountMinor: 20_000, reason: "Too much" }, randomUUID()), "refund_exceeds_payment");
    expect(await getInvoice(p.context, invoice.id)).toMatchObject({ state: "refund_due", refundDueMinor: 15_000 });
    await refundPayment(p.context, credited.payments[0]!.id, { amountMinor: 15_000, reason: "Credit note" }, randomUUID());
    expect(await getInvoice(p.context, invoice.id)).toMatchObject({ state: "credited", refundDueMinor: 0 });
    // The day's refunds include money given back for a sale with no visit.
    const after = await getDayEnd(p.context, { locationId: p.fixture.locationId });
    expect(after.summary.money.refundedMinor - before.summary.money.refundedMinor).toBe(40_000);
    expect(after.summary.money.byMethod.cash - before.summary.money.byMethod.cash).toBe(0);
  });

  it("refuses to change the service of a visit that has a credit or code taken for it", async () => {
    const p = await place("svcchange");
    const sold = await package10(p, 10_000, 2);
    const visit = await staffBook(p, booking(p, at(7, "13:00"), { customerPackageId: sold.id }));
    const [other] = await owner<{ id: string }[]>`
      insert into services (tenant_id, name, description, duration_minutes, booking_mode, patient_types, price_minor) values (${p.fixture.tenantId}, 'Other service', 'Another', 30, 'instant', ${["new", "returning"]}, 9000) returning id`;
    await owner`insert into service_locations (tenant_id, service_id, location_id) values (${p.fixture.tenantId}, ${other!.id}, ${p.fixture.locationId})`;
    await owner`insert into practitioner_services (tenant_id, practitioner_id, service_id) values (${p.fixture.tenantId}, ${p.fixture.practitionerId}, ${other!.id})`;
    const [row] = await owner<{ version: number }[]>`select version from appointments where id = ${visit.appointmentId}`;
    await expectApiError(mutateStaffAppointment(p.context, visit.appointmentId, { action: "reschedule", startsAt: at(7, "13:00"), practitionerId: p.fixture.practitionerId, serviceId: other!.id, expectedVersion: row!.version }), "discount_applied");
    expect(await balance(sold.id)).toBe(1);
  });

  it("keeps the credit when the customer cancels late, and refuses to take a package below zero by hand", async () => {
    const p = await place("late");
    const sold = await package10(p, 10_000, 2);
    const visit = await staffBook(p, booking(p, at(6, "11:00"), { customerPackageId: sold.id }));
    await owner`update appointments set starts_at = now() + interval '2 hours', ends_at = now() + interval '2 hours 30 minutes', status = 'cancelled', cancelled_by = 'customer' where id = ${visit.appointmentId}`;
    await withTenant(p.fixture.tenantId, (transaction) => releaseBookingOffers(drizzleRunner(transaction), { tenantId: p.fixture.tenantId, appointmentId: visit.appointmentId, action: "appointment.status.cancelled" }));
    expect(await balance(sold.id)).toBe(1);
    await expectApiError(adjustCredits(p.context, sold.id, { change: -5, reason: "Too many" }, randomUUID()), "no_credits");
    const adjusted = await adjustCredits(p.context, sold.id, { change: 3, reason: "Goodwill" }, randomUUID());
    expect(adjusted.remaining).toBe(4);
    // The database itself refuses a row that would leave a package below zero, even from outside the app.
    await expect(owner`insert into customer_credits (tenant_id, customer_package_id, "change", kind, reason) values (${p.fixture.tenantId}, ${sold.id}, -9, 'adjust', 'direct')`).rejects.toMatchObject({ code: "23514" });
    await expect(owner`update customer_credits set "change" = 100 where customer_package_id = ${sold.id}`).rejects.toMatchObject({ code: "23001" });
  });

  it("lets exactly one of ten simultaneous bookings spend the last credit", async () => {
    const p = await place("raceone");
    const sold = await package10(p, 10_000, 1);
    const visits = await Promise.all(Array.from({ length: 10 }, async () => {
      const id = await createBooking(owner, p.fixture, p.patientId, { status: "booked", endsDaysAgo: -3 });
      await owner`update appointments set price_minor = 5000 where id = ${id}`;
      return id;
    }));
    const results = await Promise.allSettled(visits.map((id) => spendCreditOnAppointment(p.context, id, sold.id, randomUUID())));
    const won = results.filter((result) => result.status === "fulfilled");
    const lost = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(9);
    for (const failure of lost) expect((failure.reason as ApiError).code).toBe("no_credits");
    expect(await balance(sold.id)).toBe(0);
    expect(Number((await owner`select count(*) as n from customer_credits where customer_package_id = ${sold.id} and kind = 'use'`)[0]!.n)).toBe(1);
  });

  it("stops a coupon limited to 100 uses at 100 under load", async () => {
    const p = await place("race100");
    await saveCoupon(p.context, null, couponInputSchema.parse({ code: "HUNDRED", kind: "fixed", value: 1000, maxUses: 100, serviceIds: [] }));
    const customers = await Promise.all(Array.from({ length: 110 }, async () => {
      const customer = await createCustomer(owner, p.fixture.tenantId);
      const appointmentId = await createBooking(owner, p.fixture, customer.id, { status: "booked", endsDaysAgo: -2 });
      return { patientId: customer.id, appointmentId };
    }));
    const results = await Promise.allSettled(customers.map(({ patientId, appointmentId }) => withTenant(p.fixture.tenantId, async (transaction) => {
      const prepared = await prepareBookingOffers(drizzleRunner(transaction), {
        tenantId: p.fixture.tenantId, serviceId: p.fixture.serviceId, patientId, listPriceMinor: 50_000, request: { couponCode: "hundred" }, mode: "customer",
      });
      await prepared.record(appointmentId);
      return prepared.priceMinor;
    })));
    const won = results.filter((result) => result.status === "fulfilled");
    const lost = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(won).toHaveLength(100);
    expect(lost).toHaveLength(10);
    for (const failure of lost) expect((failure.reason as ApiError).code).toBe("coupon_invalid");
    expect((won[0] as PromiseFulfilledResult<number | null>).value).toBe(49_000);
    expect((await listCoupons(p.context))[0]).toMatchObject({ code: "HUNDRED", used: 100 });
  }, 60_000);

  it("holds the limits through the real booking path, which runs at serializable isolation and retries", async () => {
    const p = await place("realpath");
    // Ten desk bookings at once, on ten different times, against one credit: one wins, the rest are refused with a plain reason.
    const sold = await package10(p, 10_000, 1);
    const attempts = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => staffBook(p, booking(p, at(12, `${String(8 + index).padStart(2, "0")}:00`), { customerPackageId: sold.id }))));
    const lost = attempts.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    for (const failure of lost) expect(["no_credits", "temporarily_unavailable"]).toContain((failure.reason as ApiError).code);
    expect(await balance(sold.id)).toBe(0);
    expect(Number((await owner`select count(*) as n from customer_credits where customer_package_id = ${sold.id} and kind = 'use'`)[0]!.n)).toBe(1);

    // A code limited to 6 uses, twelve desk bookings at once, each a new customer on its own time.
    await saveCoupon(p.context, null, couponInputSchema.parse({ code: "SIXONLY", kind: "fixed", value: 1000, maxUses: 6 }));
    const codes = await Promise.allSettled(Array.from({ length: 12 }, (_, index) => staffBook(p, booking(p, at(13, `${String(8 + index).padStart(2, "0")}:00`), {
      couponCode: "sixonly", patientId: undefined,
      newPatient: { firstName: `Code${index}`, lastName: "Race", phone: `+9190000${String(10_000 + index)}`, email: `code-race-${index}-${randomUUID().slice(0, 6)}@example.com`, preferredChannel: "email", isDependent: false, messagingConsent: false },
    }))));
    const used = Number((await owner`select count(*) as n from coupon_redemptions where tenant_id = ${p.fixture.tenantId} and released_at is null`)[0]!.n);
    expect(used).toBeLessThanOrEqual(6);
    expect(codes.filter((result) => result.status === "fulfilled").length).toBe(used);
    for (const failure of codes.filter((result): result is PromiseRejectedResult => result.status === "rejected")) {
      expect(["coupon_invalid", "temporarily_unavailable"]).toContain((failure.reason as ApiError).code);
    }
    // A loser that was only told to try again (the retries ran out under the pile-up) did not take a use; with the limit reached, a fresh attempt is refused by the limit itself.
    if (used === 6) await expectApiError(staffBook(p, booking(p, at(14, "09:00"), { couponCode: "sixonly" })), "coupon_invalid");
  }, 90_000);

  it("applies the rules of a code, gives one answer for a wrong or expired code, and counts a code again once its booking is cancelled", async () => {
    const p = await place("rules");
    const run = (callback: (transaction: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<unknown>) => withTenant(p.fixture.tenantId, callback);
    const ask = async (code: string, patientId: string | null, mode: "staff" | "customer" = "staff") => run(async (transaction) => {
      const prepared = await prepareBookingOffers(drizzleRunner(transaction), { tenantId: p.fixture.tenantId, serviceId: p.fixture.serviceId, patientId, listPriceMinor: 100_000, request: { couponCode: code }, mode });
      return prepared.priceMinor;
    });
    await saveCoupon(p.context, null, couponInputSchema.parse({ code: "WELCOME", kind: "percent", value: 10, firstVisitOnly: true, perCustomerLimit: 1 }));
    await saveCoupon(p.context, null, couponInputSchema.parse({ code: "OLD", kind: "percent", value: 10, validFrom: new Date(Date.now() - 20 * DAY).toISOString(), validTo: new Date(Date.now() - 10 * DAY).toISOString() }));
    const [otherService] = await owner<{ id: string }[]>`
      insert into services (tenant_id, name, description, duration_minutes, booking_mode, patient_types) values (${p.fixture.tenantId}, 'Other', 'Another service', 30, 'instant', ${["new", "returning"]}) returning id`;
    await saveCoupon(p.context, null, couponInputSchema.parse({ code: "OTHERSVC", kind: "percent", value: 10, serviceIds: [otherService!.id] }));
    await expect(saveCoupon(p.context, null, couponInputSchema.parse({ code: "WELCOME", kind: "percent", value: 5 }))).rejects.toMatchObject({ code: "code_taken" });
    expect(couponInputSchema.safeParse({ code: "BAD", kind: "percent", value: 150 }).success).toBe(false);

    expect(await ask(" welcome ", p.patientId)).toBe(90_000);
    // A first-visit code stops working once the customer has a visit.
    const first = await createBooking(owner, p.fixture, p.patientId, { status: "booked", endsDaysAgo: -2 });
    await expect(ask("WELCOME", p.patientId)).rejects.toMatchObject({ code: "coupon_invalid", message: expect.stringMatching(/first visits only/) });
    // Staff are told why; a customer is told only that it isn't valid.
    await expect(ask("WELCOME", p.patientId, "customer")).rejects.toMatchObject({ message: "That code isn't valid for this booking." });
    await expect(ask("OLD", null)).rejects.toMatchObject({ message: expect.stringMatching(/expired/) });
    await expect(ask("OTHERSVC", null)).rejects.toMatchObject({ message: expect.stringMatching(/doesn't apply/) });

    // Public check: a wrong code, an expired code and one for another service all look the same.
    const publicCheck = (code: string) => validateCouponPublic({ clinicSlug: p.fixture.slug, code, serviceId: p.fixture.serviceId });
    const wrong = await publicCheck("NOSUCHCODE");
    expect(wrong).toEqual({ valid: false, message: "That code isn't valid for this booking." });
    expect(await publicCheck("OLD")).toEqual(wrong);
    expect(await publicCheck("OTHERSVC")).toEqual(wrong);
    expect(await publicCheck("welcome")).toMatchObject({ valid: true, description: "10% off", discountMinor: 10_000, netMinor: 90_000 });

    // A per-customer limit counts redemptions that still stand; cancelling the booking lets the code count again.
    await saveCoupon(p.context, null, couponInputSchema.parse({ code: "ONCE", kind: "fixed", value: 5_000, perCustomerLimit: 1 }));
    const apply = (appointmentId: string) => run(async (transaction) => {
      const prepared = await prepareBookingOffers(drizzleRunner(transaction), { tenantId: p.fixture.tenantId, serviceId: p.fixture.serviceId, patientId: p.patientId, listPriceMinor: 100_000, request: { couponCode: "ONCE" }, mode: "staff" });
      await prepared.record(appointmentId);
    });
    await apply(first);
    const second = await createBooking(owner, p.fixture, p.patientId, { status: "booked", endsDaysAgo: -3 });
    await expect(apply(second)).rejects.toMatchObject({ message: expect.stringMatching(/as many times/) });
    await run((transaction) => releaseBookingOffers(drizzleRunner(transaction), { tenantId: p.fixture.tenantId, appointmentId: first, action: "appointment.status.cancelled" }));
    await apply(second);
    expect(Number((await owner`select count(*) as n from coupon_redemptions where tenant_id = ${p.fixture.tenantId} and released_at is null`)[0]!.n)).toBe(1);
    await expect(owner`update coupon_redemptions set discount_minor = 1 where tenant_id = ${p.fixture.tenantId}`).rejects.toMatchObject({ code: "23001" });
    await expect(owner`delete from coupon_redemptions where tenant_id = ${p.fixture.tenantId}`).rejects.toMatchObject({ code: "23001" });
  });

  it("takes a code on a public booking, in the same transaction, and shows the list price and discount on the invoice", async () => {
    const p = await place("public");
    await saveTaxSettings(p.context, { registered: true, gstin: "36AABCU9603R1ZO", legalName: "Glow Pvt Ltd", address: "1 Road", stateCode: "36", pricesIncludeTax: true, defaultTreatment: "taxable", defaultRateBps: 1800, defaultSacCode: "999722", confirm: true });
    await saveCoupon(p.context, null, couponInputSchema.parse({ code: "TWENTY", kind: "percent", value: 20 }));
    const slotStart = at(8, "12:00");
    const input = {
      clinicSlug: p.fixture.slug, patientType: "new" as const, bookingFor: "self" as const, locationId: p.fixture.locationId, serviceId: p.fixture.serviceId, practitionerId: p.fixture.practitionerId,
      slotId: `${p.fixture.practitionerId}:${slotStart}`, startsAt: slotStart, endsAt: new Date(Date.parse(slotStart) + 30 * 60_000).toISOString(), firstName: "Pub", lastName: "Lic",
      phone: "+919000000077", email: `pub-${randomUUID().slice(0, 6)}@example.com`, preferredChannel: "email" as const, acceptedPrivacyNotice: true as const, messagingConsent: false, couponCode: "twenty",
    };
    await expectApiError(createAppointment({ ...input, couponCode: "NOPE" }, randomUUID(), randomUUID().replaceAll("-", "")), "coupon_invalid");
    const made = await createAppointment(input, randomUUID(), randomUUID().replaceAll("-", ""));
    const [row] = await owner<{ price_minor: number; patient_id: string }[]>`select price_minor, patient_id from appointments where id = ${made.appointmentId}`;
    expect(row!.price_minor).toBe(80_000);
    expect(await owner`select discount_minor from coupon_redemptions where appointment_id = ${made.appointmentId}`).toMatchObject([{ discount_minor: 20_000 }]);
    const invoice = await issueVisitInvoice(p.context, { appointmentId: made.appointmentId }, randomUUID());
    expect(invoice.totalMinor).toBe(80_000);
    expect(invoice.lines[0]).toMatchObject({ unitPriceMinor: 100_000, discountMinor: 20_000, taxableMinor: 67_797, cgstMinor: 6_101, sgstMinor: 6_102 });
  });

  it("takes the member price first, then the coupon, then tax, and allows one discount unless the code can stack", async () => {
    const p = await place("order");
    const plan = await savePlan(p.context, null, { name: "Gold", priceMinor: 200_000, creditsPerPeriod: 2, memberDiscountPercent: 20, serviceIds: [p.fixture.serviceId], isActive: true });
    const member = await enrolMembership(p.context, { patientId: p.patientId, planId: plan.id, method: "upi" }, randomUUID());
    expect(member).toMatchObject({ status: "active", benefitsOn: true });
    await saveCoupon(p.context, null, couponInputSchema.parse({ code: "SOLO", kind: "fixed", value: 30_000 }));
    await saveCoupon(p.context, null, couponInputSchema.parse({ code: "STACK", kind: "fixed", value: 30_000, stackable: true }));
    const memberOnly = await staffBook(p, booking(p, at(9, "09:00")));
    expect((await owner`select price_minor from appointments where id = ${memberOnly.appointmentId}`)[0]!.price_minor).toBe(80_000);
    await expectApiError(staffBook(p, booking(p, at(9, "10:00"), { couponCode: "SOLO" })), "coupon_not_combinable");
    const stacked = await staffBook(p, booking(p, at(9, "11:00"), { couponCode: "STACK" }));
    // 100,000 list, 20% member price leaves 80,000, then 30,000 off leaves 50,000.
    expect((await owner`select price_minor from appointments where id = ${stacked.appointmentId}`)[0]!.price_minor).toBe(50_000);
    expect(await owner`select kind, amount_minor from appointment_discounts where appointment_id = ${stacked.appointmentId} order by amount_minor desc`).toMatchObject([{ kind: "coupon", amount_minor: 30_000 }, { kind: "member_price", amount_minor: 20_000 }]);
    // One credit or one code, not both.
    const sold = await package10(p, 10_000, 3);
    await expectApiError(staffBook(p, booking(p, at(9, "12:00"), { couponCode: "STACK", customerPackageId: sold.id })), "one_discount");
  });

  it("adds a membership renewal's credits once even when the webhook arrives twice, then pauses benefits after 7 days of grace", async () => {
    const p = await place("member");
    const plan = await savePlan(p.context, null, { name: "Monthly", priceMinor: 150_000, creditsPerPeriod: 4, memberDiscountPercent: 0, serviceIds: [p.fixture.serviceId], isActive: true });
    const account = await connectPaymentAccount(p.context, { provider: "fake" }, "http://localhost:3000");
    expect(account.provider).toBe("fake");
    const [stored] = await owner<{ public_id: string }[]>`select public_id from tenant_payment_accounts where tenant_id = ${p.fixture.tenantId}`;
    const secret = await withTenant(p.fixture.tenantId, async (transaction) => {
      await loadRecordKeys(transaction, p.fixture.tenantId);
      return openCredentials((await loadAccount(drizzleRunner(transaction), p.fixture.tenantId))!).webhookSecret;
    });
    const subscriptionId = `sub_${randomUUID()}`;
    const [membership] = await owner<{ id: string }[]>`
      insert into customer_memberships (tenant_id, patient_id, plan_id, provider, provider_subscription_id, status, current_period_end)
      values (${p.fixture.tenantId}, ${p.patientId}, ${plan.id}, 'fake', ${subscriptionId}, 'active', now()) returning id`;
    const periodStart = new Date(Date.now() + 1000);
    const renewal = (id: string): FakeWebhookBody => ({ id, type: "subscription.renewed", subscriptionId, periodStart: periodStart.toISOString(), periodEnd: new Date(periodStart.getTime() + 30 * DAY).toISOString(), amountMinor: 150_000, currency: "INR" });
    const headers = (signature: string) => new Headers({ [FAKE_SIGNATURE_HEADER]: signature });
    const first = signFakeWebhook(secret, renewal(`evt_${randomUUID()}`));
    expect(await receiveWebhook("fake", stored!.public_id, first.rawBody, headers(first.signature))).toBe("queued");
    expect(await receiveWebhook("fake", stored!.public_id, first.rawBody, headers(first.signature))).toBe("duplicate");
    // The provider re-sends the same period under a new event id: still one month of credits.
    const resend = signFakeWebhook(secret, renewal(`evt_${randomUUID()}`));
    expect(await receiveWebhook("fake", stored!.public_id, resend.rawBody, headers(resend.signature))).toBe("queued");
    await drainTenantOutbox(worker, p.fixture.tenantId, createHandlers({ sink, now: () => new Date(), origin: "https://app.example.test", available: { whatsapp: false, sms: false } }));
    const packages = await owner<{ id: string }[]>`select id from customer_packages where membership_id = ${membership!.id}`;
    expect(packages).toHaveLength(1);
    expect(await balance(packages[0]!.id)).toBe(4);
    expect(Number((await owner`select count(*) as n from customer_credits where customer_package_id = ${packages[0]!.id} and kind = 'renewal'`)[0]!.n)).toBe(1);
    const [invoices] = await owner<{ n: string }[]>`select count(*) as n from invoices where tenant_id = ${p.fixture.tenantId} and source = 'membership'`;
    expect(Number(invoices!.n)).toBe(1);

    // A failed renewal gives 7 days of grace, then benefits pause.
    const run = postgresRunner(worker);
    const failure = await worker.begin(async (transaction) => {
      await transaction`select set_config('app.tenant_id', ${p.fixture.tenantId}, true)`;
      return applyMembershipEvent(postgresRunner(transaction), { tenantId: p.fixture.tenantId, provider: "fake", providerSubscriptionId: subscriptionId, eventId: `evt_${randomUUID()}` }, { kind: "payment_failed" }, new Date());
    });
    expect(failure).toBe("applied");
    expect((await getCustomerOffers(p.context, p.patientId)).memberships[0]).toMatchObject({ status: "past_due", benefitsOn: true });
    await owner`update customer_memberships set past_due_since = now() - interval '8 days' where id = ${membership!.id}`;
    expect((await getCustomerOffers(p.context, p.patientId)).memberships[0]!.benefitsOn).toBe(false);
    await sweepMemberships(worker);
    expect((await getCustomerOffers(p.context, p.patientId)).memberships[0]).toMatchObject({ status: "paused", benefitsOn: false });
    void run;
    // Credits from a paused membership cannot be spent.
    const visit = await createBooking(owner, p.fixture, p.patientId, { status: "booked", endsDaysAgo: -3 });
    await owner`update appointments set price_minor = 5000 where id = ${visit}`;
    await expectApiError(spendCreditOnAppointment(p.context, visit, packages[0]!.id, randomUUID()), "membership_inactive");
  });

  it("bills a desk membership by hand, month by month, with the same credits and invoice", async () => {
    const p = await place("manual");
    const plan = await savePlan(p.context, null, { name: "Desk plan", priceMinor: 50_000, creditsPerPeriod: 2, memberDiscountPercent: 0, serviceIds: [p.fixture.serviceId], isActive: true });
    const member = await enrolMembership(p.context, { patientId: p.patientId, planId: plan.id, method: "cash" }, randomUUID());
    await expectApiError(enrolMembership(p.context, { patientId: p.patientId, planId: plan.id, method: "cash" }, randomUUID()), "already_member");
    const renewed = await renewMembership(p.context, member.id, "upi", randomUUID());
    expect(new Date(renewed.currentPeriodEnd).getTime()).toBeGreaterThan(new Date(member.currentPeriodEnd).getTime() + 25 * DAY);
    expect(Number((await owner`select count(*) as n from customer_packages where membership_id = ${member.id}`)[0]!.n)).toBe(2);
    expect(Number((await owner`select count(*) as n from invoices where tenant_id = ${p.fixture.tenantId} and source = 'membership'`)[0]!.n)).toBe(2);
  });

  it("writes off expired credits once and sends the 14-day and 3-day reminders once each", async () => {
    const p = await place("expiry");
    const sold = await package10(p, 30_000, 3);
    const reminders = async () => Number((await owner`select count(*) as n from outbox_events where tenant_id = ${p.fixture.tenantId} and event_type = 'package.expiry_reminder'`)[0]!.n);
    await owner`update customer_packages set expires_at = now() + interval '10 days' where id = ${sold.id}`;
    await sweepCredits(worker);
    await sweepCredits(worker);
    expect(await reminders()).toBe(1);
    await owner`update customer_packages set expires_at = now() + interval '2 days' where id = ${sold.id}`;
    await sweepCredits(worker);
    await sweepCredits(worker);
    expect(await reminders()).toBe(2);
    sent.length = 0;
    await drainTenantOutbox(worker, p.fixture.tenantId, createHandlers({ sink, now: () => new Date(), origin: "https://app.example.test", available: { whatsapp: false, sms: false } }));
    expect(sent.filter((message) => message.message.templateKey === "package.expiry_reminder").length).toBe(2);
    expect(sent.at(-1)!.message.body).toMatch(/You have 3 sessions left on 3 sessions, valid until \d+ \w+\./);

    await owner`update customer_packages set expires_at = now() - interval '1 hour' where id = ${sold.id}`;
    await sweepCredits(worker);
    await sweepCredits(worker);
    expect(await balance(sold.id)).toBe(0);
    expect(await owner`select kind, "change" from customer_credits where customer_package_id = ${sold.id} and kind = 'expiry'`).toMatchObject([{ change: -3 }]);
    expect((await getCustomerOffers(p.context, p.patientId)).packages[0]!).toMatchObject({ status: "expired", remaining: 0 });
    await expectApiError(spendCreditOnAppointment(p.context, await createBooking(owner, p.fixture, p.patientId, { status: "booked", endsDaysAgo: -3 }).then(async (id) => { await owner`update appointments set price_minor = 5000 where id = ${id}`; return id; }), sold.id, randomUUID()), "package_expired");
  });

  it("keeps one business's offers from another and refuses a role without the permission", async () => {
    const mine = await place("iso-a");
    const theirs = await place("iso-b");
    const sold = await package10(mine, 10_000, 2);
    await expectApiError(adjustCredits(theirs.context, sold.id, { change: 1, reason: "Not mine" }, randomUUID()), "package_not_found");
    expect((await getCustomerOffers(theirs.context, theirs.patientId)).packages).toHaveLength(0);
    await expectApiError(getCustomerOffers(theirs.context, mine.patientId), "patient_not_found");
    await expect(sellPackage(staffContext(mine.fixture, { permissions: [] }), { patientId: mine.patientId, packageId: "x", locationId: mine.fixture.locationId, payments: [{ method: "cash", amountMinor: 100 }] }, randomUUID())).rejects.toMatchObject({ status: 403 });
    const runtime = postgres(runtimeUrl!, { max: 1, prepare: false });
    try {
      const rows = await runtime.begin(async (transaction) => {
        await transaction`select set_config('app.tenant_id', ${theirs.fixture.tenantId}, true)`;
        return transaction`select id from customer_packages where id = ${sold.id}`;
      });
      expect(rows).toHaveLength(0);
    } finally {
      await runtime.end({ timeout: 5 });
    }
  });
});
