/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: async () => new Headers(), cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

import { withTenant } from "@/db/client";
import { ApiError } from "@/server/api-error";
import { staffCreatePractitionerSchema } from "@/server/contracts";
import { createStaffPractitioner, updateStaffPractitioner } from "@/server/staff-team";
import { addPractitioners, createCustomer, createTenant, isLocalDatabase, setSubscription, staffContext } from "@/test/billing-fixture";

import { assertBookingAllowed, assertCalendarEditable, assertCanAddCalendar, readOnlyCalendarIds } from "./enforcement";
import { issueInvoice } from "./invoices";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const describeLocal = isLocalDatabase(runtimeUrl) && isLocalDatabase(ownerUrl) && isLocalDatabase(workerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

async function refusal(run: () => Promise<unknown>): Promise<ApiError> {
  try { await run(); } catch (error) { if (error instanceof ApiError) return error; throw error; }
  throw new Error("expected a refusal");
}

describeLocal("plan enforcement, isolation and invoice numbers", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  let app: postgres.Sql;
  beforeAll(() => {
    owner = postgres(ownerUrl!, { max: 2, prepare: false });
    worker = postgres(workerUrl!, { max: 8, prepare: false });
    app = postgres(runtimeUrl!, { max: 2, prepare: false });
  });
  afterAll(async () => { await Promise.all([owner.end(), worker.end(), app.end()]); });

  const input = () => staffCreatePractitionerSchema.parse({
    name: "Fourth Person", title: "Doctor", specialty: "General", email: `fourth-${randomUUID().slice(0, 6)}@example.com`,
    locationIds: [randomUUID()], serviceIds: [randomUUID()], hours: { days: [1], startsAtLocal: "09:00", endsAtLocal: "17:00" },
  });

  it("a FOURTH staff calendar on Starter is refused by the server with plan_limit naming Growth", async () => {
    const fixture = await createTenant(owner, "starter"); // one calendar already
    await setSubscription(owner, fixture.tenantId, { plan: "starter", status: "active", provider: "razorpay", providerSubscriptionId: `sub_${randomUUID().slice(0, 8)}` });
    await addPractitioners(owner, fixture.tenantId, 1); // two
    await withTenant(fixture.tenantId, (tx) => assertCanAddCalendar(tx, fixture.tenantId)); // the third is fine
    await addPractitioners(owner, fixture.tenantId, 1); // three
    const error = await refusal(() => createStaffPractitioner(staffContext(fixture), input()));
    expect(error).toMatchObject({ status: 402, code: "plan_limit" });
    expect(error.message).toContain("Growth");
    expect(error.details).toMatchObject({ subject: "staffCalendars", requiredPlan: "growth", currentPlan: "starter", limit: 3 });
    expect((await owner`select count(*)::int as n from practitioners where tenant_id = ${fixture.tenantId}`)[0]?.n).toBe(3);
  });

  it("two creates at once cannot both slip under the limit", async () => {
    const fixture = await createTenant(owner, "race");
    await setSubscription(owner, fixture.tenantId, { plan: "starter", status: "active", provider: "stripe", providerSubscriptionId: `sub_${randomUUID().slice(0, 8)}` });
    await addPractitioners(owner, fixture.tenantId, 1); // two of three
    const results = await Promise.allSettled([1, 2].map(() => withTenant(fixture.tenantId, async (tx) => {
      await assertCanAddCalendar(tx, fixture.tenantId);
      await tx.execute(`insert into practitioners (tenant_id, name, title, initials, specialty) values ('${fixture.tenantId}', 'Racer', 'Doctor', 'RC', 'General')` as never);
    })));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  });

  it("after a downgrade the newest calendars are read-only: visible, not editable, not bookable; deactivating still works", async () => {
    const fixture = await createTenant(owner, "downgraded"); // oldest calendar
    const extra = await addPractitioners(owner, fixture.tenantId, 2);
    await setSubscription(owner, fixture.tenantId, { plan: "free", status: "free" });
    const readOnly = await withTenant(fixture.tenantId, (tx) => readOnlyCalendarIds(tx, fixture.tenantId));
    expect([...readOnly].sort()).toEqual([...extra].sort());
    await withTenant(fixture.tenantId, (tx) => assertCalendarEditable(tx, fixture.tenantId, fixture.practitionerId));
    const edit = await refusal(() => withTenant(fixture.tenantId, (tx) => assertCalendarEditable(tx, fixture.tenantId, extra[1]!)));
    expect(edit.code).toBe("plan_limit");
    expect((await refusal(() => updateStaffPractitioner(staffContext(fixture), extra[1]!, { name: "Renamed Person" }))).code).toBe("plan_limit");
    const staffBooking = await refusal(() => withTenant(fixture.tenantId, (tx) => assertBookingAllowed(tx, fixture.tenantId, extra[0]!, "staff")));
    expect(staffBooking.code).toBe("plan_limit");
    const publicBooking = await refusal(() => withTenant(fixture.tenantId, (tx) => assertBookingAllowed(tx, fixture.tenantId, extra[0]!, "public")));
    expect(publicBooking.message).not.toMatch(/plan|upgrade/i);
    await withTenant(fixture.tenantId, (tx) => assertBookingAllowed(tx, fixture.tenantId, fixture.practitionerId, "staff"));
    await updateStaffPractitioner(staffContext(fixture), extra[1]!, { isActive: false });
    expect((await owner`select is_active from practitioners where id = ${extra[1]}`)[0]?.is_active).toBe(false);
  });

  it("Free refuses NEW bookings after 50 this month and leaves existing ones alone", async () => {
    const fixture = await createTenant(owner, "free-month");
    await setSubscription(owner, fixture.tenantId, { plan: "free", status: "free" });
    const customer = await createCustomer(owner, fixture.tenantId);
    const book = (count: number) => owner`
      insert into appointments (tenant_id, location_id, patient_id, practitioner_id, service_id, starts_at, ends_at, status, booking_source, manage_token_hash, price_minor)
      select ${fixture.tenantId}, ${fixture.locationId}, ${customer.id}, ${fixture.practitionerId}, ${fixture.serviceId},
        now() + (n || ' hours')::interval + interval '30 days', now() + (n || ' hours')::interval + interval '30 days 30 minutes', 'booked', 'staff', md5(random()::text) || md5(random()::text), 0
      from generate_series(1, ${count}) as n`;
    await book(49);
    await withTenant(fixture.tenantId, (tx) => assertBookingAllowed(tx, fixture.tenantId, fixture.practitionerId, "staff"));
    await book(1);
    const error = await refusal(() => withTenant(fixture.tenantId, (tx) => assertBookingAllowed(tx, fixture.tenantId, fixture.practitionerId, "staff")));
    expect(error.details).toMatchObject({ subject: "bookingsPerMonth", requiredPlan: "starter", limit: 50 });
    expect((await owner`select count(*)::int as n from appointments where tenant_id = ${fixture.tenantId}`)[0]?.n).toBe(50);
    // A paid plan has no monthly cap.
    await setSubscription(owner, fixture.tenantId, { plan: "starter", status: "active", provider: "razorpay", providerSubscriptionId: `sub_${randomUUID().slice(0, 8)}` });
    await withTenant(fixture.tenantId, (tx) => assertBookingAllowed(tx, fixture.tenantId, fixture.practitionerId, "staff"));
  });

  it("business B cannot read or change business A's subscription, events, usage or invoices", async () => {
    const a = await createTenant(owner, "rls-a");
    const b = await createTenant(owner, "rls-b");
    await setSubscription(owner, a.tenantId, { plan: "starter", status: "active" });
    await owner`insert into billing_events (tenant_id, provider, provider_event_id, type, payload) values (${a.tenantId}, 'stripe', ${`rls-${randomUUID()}`}, 'invoice.paid', '{}')`;
    await owner`insert into usage_counters (tenant_id, period, metric, count) values (${a.tenantId}, date_trunc('month', now())::date, 'message:whatsapp', 5)`;
    await worker.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenantId}, true)`;
      await issueInvoice(tx, a.tenantId, "stripe", { providerPaymentId: `in_${randomUUID()}`, amountMinor: 900, currency: "USD", planKey: "starter", periodStart: null, periodEnd: null }, { kalendrGstin: null, buyerGstin: null });
    });
    const asB = <T>(run: (tx: postgres.TransactionSql) => Promise<T>) => app.begin(async (tx) => { await tx`select set_config('app.tenant_id', ${b.tenantId}, true)`; return run(tx); }) as Promise<T>;
    await asB(async (tx) => {
      for (const table of ["tenant_subscriptions", "billing_events", "usage_counters", "platform_invoices"]) {
        expect(await tx.unsafe(`select 1 from ${table} where tenant_id = '${a.tenantId}'`), table).toHaveLength(0);
      }
      expect(await tx`update tenant_subscriptions set plan_key = 'scale' where tenant_id = ${a.tenantId} returning id`).toHaveLength(0);
      expect(await tx`update usage_counters set count = 0 where tenant_id = ${a.tenantId} returning id`).toHaveLength(0);
    });
    await expect(asB((tx) => tx`insert into usage_counters (tenant_id, period, metric, count) values (${a.tenantId}, now()::date, 'x', 1)`)).rejects.toThrow();
    expect((await owner`select plan_key from tenant_subscriptions where tenant_id = ${a.tenantId}`)[0]?.plan_key).toBe("starter");
  });

  it("billing events cannot be edited or deleted (only marked processed) and invoices cannot be changed", async () => {
    const a = await createTenant(owner, "immutable");
    await setSubscription(owner, a.tenantId, { plan: "starter", status: "active" });
    const eventId = `imm-${randomUUID()}`;
    await owner`insert into billing_events (tenant_id, provider, provider_event_id, type, payload) values (${a.tenantId}, 'razorpay', ${eventId}, 'subscription.charged', '{"amountMinor":100}')`;
    await worker.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenantId}, true)`;
      await issueInvoice(tx, a.tenantId, "razorpay", { providerPaymentId: `pay_${randomUUID()}`, amountMinor: 49_900, currency: "INR", planKey: "starter", periodStart: null, periodEnd: null }, { kalendrGstin: null, buyerGstin: null });
    });
    const inTenant = (run: (tx: postgres.TransactionSql) => PromiseLike<unknown>) => app.begin(async (tx) => { await tx`select set_config('app.tenant_id', ${a.tenantId}, true)`; await run(tx); });
    await expect(inTenant((tx) => tx`update billing_events set payload = '{"amountMinor":1}' where provider_event_id = ${eventId}`)).rejects.toThrow(/never edited/);
    await expect(inTenant((tx) => tx`delete from billing_events where provider_event_id = ${eventId}`)).rejects.toThrow(/never deleted/);
    await inTenant(async (tx) => {
      expect(await tx`update billing_events set processed_at = now(), outcome = 'applied' where provider_event_id = ${eventId} returning id`).toHaveLength(1);
    });
    for (const statement of ["update platform_invoices set total_minor = 1", "delete from platform_invoices"]) {
      await expect(inTenant((tx) => tx.unsafe(`${statement} where tenant_id = '${a.tenantId}'`))).rejects.toThrow();
    }
  });

  it("invoice numbers are gapless under concurrent issues, and one payment is invoiced once", async () => {
    const tenants = await Promise.all([0, 1, 2, 3].map((index) => createTenant(owner, `gapless-${index}`)));
    const payments = Array.from({ length: 10 }, () => `pay_${randomUUID()}`);
    // Each payment is attempted twice at once, from different connections.
    await Promise.all(payments.flatMap((payment, index) => [0, 1].map(() => worker.begin(async (tx) => {
      const tenant = tenants[index % tenants.length]!;
      await tx`select set_config('app.tenant_id', ${tenant.tenantId}, true)`;
      await issueInvoice(tx, tenant.tenantId, "razorpay", { providerPaymentId: payment, amountMinor: 49_900, currency: "INR", planKey: "starter", periodStart: null, periodEnd: null }, { kalendrGstin: null, buyerGstin: null });
    }))));
    const rows = await owner<{ sequence: number }[]>`select sequence from platform_invoices where provider_payment_id = any(${payments})`;
    expect(rows).toHaveLength(10);
    const [all] = await owner<{ n: number; max: number }[]>`select count(*)::int as n, max(sequence)::int as max from platform_invoices`;
    // No gaps anywhere in the table: as many invoices as the highest number.
    expect(all?.n).toBe(all?.max);
  });
});
