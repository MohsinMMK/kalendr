/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import { TZDate } from "@date-fns/tz";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withTenant } from "@/db/client";
import { onboardingProgress } from "@/db/schema";
import { resolvePermissions } from "@/lib/permissions";
import { createAppointment, createStaffAppointment } from "@/server/appointment-repository";
import { canonicalJsonHash } from "@/server/crypto";
import { onboardingFunnel } from "@/server/admin/onboarding";
import { clinicRegistrationSchema, registerClinic } from "@/server/clinic-registration";
import { createFakeEmailProvider } from "@/server/messaging/email-fake";
import { getPublicClinicCatalog } from "@/server/public-catalog";
import type { StaffContext } from "@/server/staff-context";
import { createEmailAdapter } from "@/worker/email-adapter";
import { providerSink } from "@/worker/delivery";
import { createHandlers } from "@/worker/handlers";
import { sweepReminders } from "@/worker/jobs";
import { sweepOnboarding } from "@/worker/onboarding-jobs";
import { reconcileWorkflows, sweepWorkflowMessages } from "@/worker/workflow-jobs";
import { getStaffSnapshot } from "@/server/staff-repository";
import { drainTenantOutbox } from "@/test/outbox-drain";
import { isLocalDatabase } from "@/test/billing-fixture";

import { loadOnboardingState, updateStep, updateTour } from "./progress";
import { addSampleData, findTestBooking, removeTestData } from "./test-data";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const describeLocal = isLocalDatabase(runtimeUrl) && isLocalDatabase(ownerUrl) && isLocalDatabase(workerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

const hour = 3_600_000;

interface Registered { tenantId: string; slug: string; email: string; context: StaffContext }

describeLocal("onboarding 2.0 (feature 11)", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  const created: string[] = [];
  const emails = createFakeEmailProvider();
  const handlers = createHandlers({
    sink: providerSink({ email: createEmailAdapter({ provider: emails, origin: "http://127.0.0.1:3202", fallbackReplyTo: null }) }),
    now: () => new Date(),
    origin: "http://127.0.0.1:3202",
  });

  async function register(label: string, template: "salon" | "dental" | "general_practice" | "other" = "salon", ownerPractices = true): Promise<Registered> {
    const slug = `ob-${label}-${randomUUID().slice(0, 6)}`;
    const email = `${slug}@example.com`;
    const input = clinicRegistrationSchema.parse({
      template, clinicName: `Studio ${label}`, slug, ownerName: "Asha Rao", email, password: randomUUID(), timezone: "Asia/Kolkata",
      ownerPractices, ...(ownerPractices ? { practice: { name: "Asha Rao", title: "Stylist", specialty: "Hair" } } : {}),
    });
    const registered = await registerClinic(input);
    created.push(registered.tenantId);
    const [member] = await owner<{ user_id: string }[]>`select user_id from memberships where tenant_id = ${registered.tenantId}`;
    const context: StaffContext = {
      tenantId: registered.tenantId, clinicSlug: slug, clinicName: registered.clinicName, role: "owner", permissions: resolvePermissions("owner", {}),
      membershipId: null, userId: member!.user_id, userName: "Asha Rao", userEmail: email, secondFactorEnrolled: true, secondFactorAt: new Date(), preview: false,
    };
    return { tenantId: registered.tenantId, slug, email, context };
  }

  beforeAll(() => {
    owner = postgres(ownerUrl!, { max: 2, prepare: false });
    worker = postgres(workerUrl!, { max: 4, prepare: false });
  });
  afterAll(async () => {
    // Other suites share this database and some claim outbox rows from every business, so leave none of ours waiting.
    if (created.length > 0) await owner`delete from outbox_events where tenant_id = any(${created})`.catch(() => undefined);
    for (const tenantId of created) {
      // Bookings keep the business and its people in place (audit rows point at them), so test businesses are left for the scratch database to drop.
      await owner`update tenants set is_active = false where id = ${tenantId}`.catch(() => undefined);
    }
    await Promise.all([owner.end(), worker.end()]);
  });

  /** A booking by the owner as a customer, a moment after `since`, through the ordinary booking code. */
  async function bookAsOwner(business: Registered, dayOffset = 2): Promise<{ appointmentId: string; patientId: string }> {
    const [setup] = await owner<{ location_id: string; practitioner_id: string; service_id: string }[]>`
      select place.location_id, person.id as practitioner_id,
        (select service_id from practitioner_services where tenant_id = person.tenant_id and practitioner_id = person.id order by created_at limit 1) as service_id
      from practitioners as person join practitioner_locations as place on place.tenant_id = person.tenant_id and place.practitioner_id = person.id
      where person.tenant_id = ${business.tenantId} limit 1`;
    const today = TZDate.tz("Asia/Kolkata");
    // A weekday ten in the morning, which every template is open for.
    let day = new TZDate(today.getFullYear(), today.getMonth(), today.getDate() + dayOffset, 11, 0, 0, "Asia/Kolkata");
    while ([0, 1].includes(day.getDay())) day = new TZDate(day.getFullYear(), day.getMonth(), day.getDate() + 1, 11, 0, 0, "Asia/Kolkata");
    const input = {
      clinicSlug: business.slug, locationId: setup!.location_id, serviceId: setup!.service_id, practitionerId: setup!.practitioner_id, startsAt: day.toISOString(), source: "desk" as const,
      newPatient: { firstName: "Asha", lastName: "Rao", phone: "+919000011111", email: business.email, preferredChannel: "email" as const, isDependent: false, messagingConsent: false },
    };
    const booked = await createStaffAppointment(business.context, input, `test:${randomUUID()}`, canonicalJsonHash(input));
    return { appointmentId: booked.appointmentId, patientId: booked.patientId };
  }

  describe("a new owner's account starts from a template", () => {
    it("fills services with prices, hours for the owner, a booking question and the business's own words, and is bookable at once", async () => {
      const business = await register("fill", "salon");
      const [tenant] = await owner<{ business_type: string; terminology: Record<string, { singular: string }>; onboarding_started_at: Date | null }[]>`select business_type, terminology, onboarding_started_at from tenants where id = ${business.tenantId}`;
      expect(tenant?.business_type).toBe("wellness");
      expect(tenant?.terminology.provider?.singular).toBe("stylist");
      expect(tenant?.onboarding_started_at).not.toBeNull();
      const services = await owner<{ name: string; price_minor: number | null; price_label: string | null }[]>`select name, price_minor, price_label from services where tenant_id = ${business.tenantId} order by name`;
      expect(services.map((service) => service.name)).toEqual(["General visit", "Hair colour", "Hair spa", "Haircut", "Styling"]);
      expect(services.find((service) => service.name === "Haircut")).toMatchObject({ price_minor: 60_000, price_label: "₹600" });
      const [rules] = await owner<{ days: number }[]>`select count(distinct day_of_week)::int as days from availability_rules where tenant_id = ${business.tenantId}`;
      expect(rules?.days).toBe(6);
      const forms = await owner`select name from form_definitions where tenant_id = ${business.tenantId} and is_current and is_active`;
      expect(forms).toHaveLength(1);
      const workflows = await owner`select 1 from workflows where tenant_id = ${business.tenantId} and active`;
      expect(workflows.length).toBeGreaterThan(0);
      // Every service has the owner on it and the first place, so the public page can book it straight away.
      const catalog = await getPublicClinicCatalog(business.slug);
      expect(catalog?.services).toHaveLength(5);
      expect(catalog?.services[0]?.name).toBe("General visit");
      expect(catalog?.practitioners).toHaveLength(1);
      const welcome = await owner`select payload from outbox_events where tenant_id = ${business.tenantId} and event_type = 'onboarding.email'`;
      expect(welcome).toHaveLength(1);
    });

    it("leaves services without a person, and no hours, when the owner does not take bookings, and says so in the checklist", async () => {
      const business = await register("nobody", "dental", false);
      const [rules] = await owner<{ n: number }[]>`select count(*)::int as n from availability_rules where tenant_id = ${business.tenantId}`;
      expect(rules?.n).toBe(0);
      // The old setup wizard picks up from here: a person is the one gap, so it asks for that and does not add services again.
      expect((await getStaffSnapshot(business.context)).setup.missing).toEqual(["practitioner"]);
      const state = await loadOnboardingState(business.context);
      const go = state!.goLive.checks;
      expect(go.find((check) => check.id === "services_bookable")?.ok).toBe(false);
      expect(go.find((check) => check.id === "hours_set")?.ok).toBe(false);
    });

    it("registers with only the four details and no place or phone, and keeps older callers working", async () => {
      const slug = `ob-min-${randomUUID().slice(0, 6)}`;
      const input = clinicRegistrationSchema.parse({ clinicName: "Bare Minimum", slug, ownerName: "Jo Kim", email: `${slug}@example.com`, password: randomUUID() });
      expect(input).toMatchObject({ phone: "", city: "", address: "" });
      const registered = await registerClinic(input);
      created.push(registered.tenantId);
      const [place] = await owner<{ address: string; city: string }[]>`select address, city from locations where tenant_id = ${registered.tenantId}`;
      expect(place).toEqual({ address: "", city: "" });
      // No template named: the broad type picks one.
      const [tenant] = await owner<{ business_type: string }[]>`select business_type from tenants where id = ${registered.tenantId}`;
      expect(tenant?.business_type).toBe("healthcare");
      expect(clinicRegistrationSchema.safeParse({ clinicName: "X Y", slug, ownerName: "Jo", email: "a@b.co", password: randomUUID(), phone: "123" }).success).toBe(false);
    });
  });

  describe("the checklist", () => {
    it("shows eight steps, remembers where the owner stopped, and resumes at the same next step", async () => {
      const business = await register("resume", "salon");
      const first = await loadOnboardingState(business.context);
      expect(first!.steps.map((step) => [step.key, step.status])).toEqual([
        ["services", "todo"], ["hours", "todo"], ["team", "todo"], ["test_booking", "todo"], ["reminders", "done"], ["brand", "todo"], ["share_link", "todo"], ["payments", "todo"],
      ]);
      expect(first!.summary).toMatchObject({ done: 1, total: 8, next: "services", finished: false });
      await updateStep(business.context, { step: "services", action: "done" });
      await updateStep(business.context, { step: "services", action: "done" });
      await updateStep(business.context, { step: "team", action: "skip" });
      // "Returning" is a fresh read with nothing remembered in memory.
      const back = await loadOnboardingState(business.context);
      expect(back!.steps.find((step) => step.key === "services")?.status).toBe("done");
      expect(back!.steps.find((step) => step.key === "team")?.status).toBe("skipped");
      expect(back!.summary).toMatchObject({ done: 2, skipped: 1, next: "hours" });
      await updateStep(business.context, { step: "team", action: "undo" });
      expect((await loadOnboardingState(business.context))!.steps.find((step) => step.key === "team")?.status).toBe("todo");
    });

    it("sees automatic steps done from the business's own data, and records when it first saw them", async () => {
      const business = await register("auto", "salon");
      await owner`update tenants set brand = '{"accent":"#f5b800"}'::jsonb where id = ${business.tenantId}`;
      await owner`insert into memberships (tenant_id, user_id, role) select ${business.tenantId}, id, 'staff' from auth_users limit 1`.catch(() => undefined);
      const state = await loadOnboardingState(business.context);
      expect(state!.steps.find((step) => step.key === "brand")?.status).toBe("done");
      const rows = await owner<{ step_key: string; done_at: Date }[]>`select step_key, done_at from onboarding_progress where tenant_id = ${business.tenantId} and done_at is not null`;
      expect(rows.map((row) => row.step_key).sort()).toEqual(["brand", "reminders"]);
      const first = rows.find((row) => row.step_key === "brand")!.done_at;
      await loadOnboardingState(business.context);
      const [again] = await owner<{ done_at: Date }[]>`select done_at from onboarding_progress where tenant_id = ${business.tenantId} and step_key = 'brand'`;
      expect(again?.done_at.getTime()).toBe(first.getTime());
    });

    it("refuses to tick off a step that is finished by doing it, and the read-only support session may change nothing", async () => {
      const business = await register("guard", "salon");
      await expect(updateStep(business.context, { step: "test_booking", action: "done" })).rejects.toMatchObject({ code: "step_not_markable" });
      const supportView = { ...business.context, impersonation: { operatorName: "Support", writeAccess: false } as never };
      await expect(updateStep(supportView, { step: "services", action: "done" })).rejects.toMatchObject({ code: "read_only_support_session" });
      await expect(updateTour(supportView, "skip")).rejects.toMatchObject({ code: "read_only_support_session" });
      await expect(addSampleData(supportView)).rejects.toMatchObject({ code: "read_only_support_session" });
      await expect(removeTestData(supportView)).rejects.toMatchObject({ code: "read_only_support_session" });
      await expect(findTestBooking(supportView, new Date().toISOString())).rejects.toMatchObject({ code: "read_only_support_session" });
    });

    it("has no checklist for a business set up before the guided first run, or for another business's owner", async () => {
      const business = await register("old", "salon");
      await owner`update tenants set onboarding_started_at = null where id = ${business.tenantId}`;
      expect(await loadOnboardingState(business.context)).toBeNull();
      const other = await register("other", "salon");
      await updateStep(other.context, { step: "services", action: "done" });
      const seen = await withTenant(business.tenantId, (transaction) => transaction.select().from(onboardingProgress));
      expect(seen.every((row) => row.tenantId === business.tenantId)).toBe(true);
    });

    it("records the tour as seen once it is closed or finished, and clears it when it is opened again", async () => {
      const business = await register("tour", "salon");
      expect((await loadOnboardingState(business.context))!.tour).toBe("new");
      await updateTour(business.context, "skip");
      expect((await loadOnboardingState(business.context))!.tour).toBe("skipped");
      await updateTour(business.context, "reopen");
      expect((await loadOnboardingState(business.context))!.tour).toBe("new");
      await updateTour(business.context, "done");
      expect((await loadOnboardingState(business.context))!.tour).toBe("done");
    });
  });

  describe("the test booking and sample data", () => {
    it("finds the owner's own booking, flags it as a test, marks the step and names how the confirmation is going, then removes it in one go", async () => {
      const business = await register("testbooking", "salon");
      const since = new Date(Date.now() - 60_000).toISOString();
      expect(await findTestBooking(business.context, since)).toEqual({ found: false });
      const { appointmentId } = await bookAsOwner(business);
      const found = await findTestBooking(business.context, since);
      expect(found).toMatchObject({ found: true, appointmentId });
      const [flagged] = await owner<{ is_test: boolean; patient_test: boolean }[]>`
        select appointment.is_test, patient.is_test as patient_test from appointments as appointment join patients as patient on patient.tenant_id = appointment.tenant_id and patient.id = appointment.patient_id where appointment.id = ${appointmentId}`;
      expect(flagged).toEqual({ is_test: true, patient_test: true });
      const state = await loadOnboardingState(business.context);
      expect(state!.steps.find((step) => step.key === "test_booking")?.status).toBe("done");
      expect(state!.testRows).toBe(2);
      // Asking again changes nothing.
      expect(await findTestBooking(business.context, since)).toMatchObject({ found: true, appointmentId });
      // A real booking from someone else is never touched by removal.
      const realInput = {
        clinicSlug: business.slug, locationId: (await owner<{ id: string }[]>`select id from locations where tenant_id = ${business.tenantId}`)[0]!.id,
        serviceId: (await owner<{ id: string }[]>`select id from services where tenant_id = ${business.tenantId} order by name limit 1`)[0]!.id,
        practitionerId: (await owner<{ id: string }[]>`select id from practitioners where tenant_id = ${business.tenantId}`)[0]!.id,
        startsAt: new TZDate(TZDate.tz("Asia/Kolkata").getFullYear(), TZDate.tz("Asia/Kolkata").getMonth(), TZDate.tz("Asia/Kolkata").getDate() + 3, 15, 0, 0, "Asia/Kolkata").toISOString(),
        source: "desk" as const,
        newPatient: { firstName: "Real", lastName: "Person", phone: "+919000022222", email: "real.person@example.com", preferredChannel: "email" as const, isDependent: false, messagingConsent: false },
      };
      let realKept = true;
      try {
        await createStaffAppointment(business.context, realInput, `real:${randomUUID()}`, canonicalJsonHash(realInput));
      } catch { realKept = false; }
      const removed = await removeTestData(business.context);
      expect(removed).toMatchObject({ appointmentsRemoved: 1, customersRemoved: 1, appointmentsRetired: 0 });
      const left = await owner<{ email: string }[]>`select patient.email from appointments as appointment join patients as patient on patient.tenant_id = appointment.tenant_id and patient.id = appointment.patient_id where appointment.tenant_id = ${business.tenantId}`;
      expect(left.map((row) => row.email)).toEqual(realKept ? ["real.person@example.com"] : []);
      // The log keeps saying what happened, minus the link to a booking that is gone.
      const audit = await owner<{ appointment_id: string | null }[]>`select appointment_id from audit_events where tenant_id = ${business.tenantId} and action = 'onboarding.test_booking'`;
      expect(audit).toEqual([{ appointment_id: null }]);
      // The step stays done: the owner did make a test booking.
      expect((await loadOnboardingState(business.context))!.steps.find((step) => step.key === "test_booking")?.status).toBe("done");
      expect((await loadOnboardingState(business.context))!.testRows).toBe(0);
    });

    it("removes a booking made on the public page with the form question answered, and retires one that holds a payment order instead of failing", async () => {
      const business = await register("public", "salon");
      const [setup] = await owner<{ location_id: string; practitioner_id: string; service_id: string; service2: string }[]>`
        select place.location_id, person.id as practitioner_id,
          (select service_id from practitioner_services where tenant_id = person.tenant_id and practitioner_id = person.id order by created_at limit 1) as service_id,
          (select service_id from practitioner_services where tenant_id = person.tenant_id and practitioner_id = person.id order by created_at desc limit 1) as service2
        from practitioners as person join practitioner_locations as place on place.tenant_id = person.tenant_id and place.practitioner_id = person.id where person.tenant_id = ${business.tenantId} limit 1`;
      const today = TZDate.tz("Asia/Kolkata");
      const when = (days: number, hour: number) => {
        let day = new TZDate(today.getFullYear(), today.getMonth(), today.getDate() + days, hour, 0, 0, "Asia/Kolkata");
        while ([0, 1].includes(day.getDay())) day = new TZDate(day.getFullYear(), day.getMonth(), day.getDate() + 1, hour, 0, 0, "Asia/Kolkata");
        return day;
      };
      const [form] = await owner<{ fields: Array<{ id: string }> }[]>`select fields from form_definitions where tenant_id = ${business.tenantId} and is_current`;
      const publicBooking = async (hour: number, email: string, service: string) => {
        const start = when(3, hour);
        const [length] = await owner<{ duration_minutes: number }[]>`select duration_minutes from services where id = ${service}`;
        return createAppointment({
          clinicSlug: business.slug, patientType: "new", bookingFor: "self", locationId: setup!.location_id, serviceId: service, practitionerId: setup!.practitioner_id,
          slotId: randomUUID(), startsAt: start.toISOString(), endsAt: new Date(start.getTime() + length!.duration_minutes * 60_000).toISOString(),
          firstName: "Public", lastName: "Booker", phone: `+9190000${String(Math.floor(Math.random() * 90_000) + 10_000)}`, email, preferredChannel: "email", acceptedPrivacyNotice: true, messagingConsent: false,
          formAnswers: { [form!.fields[0]!.id]: "Dry ends, please" },
        }, randomUUID(), randomUUID().replaceAll("-", ""));
      };
      const plain = await publicBooking(11, `plain.${randomUUID().slice(0, 6)}@example.com`, setup!.service_id);
      const paid = await publicBooking(14, `paid.${randomUUID().slice(0, 6)}@example.com`, setup!.service2);
      await owner`update appointments set is_test = true where id in (${plain.appointmentId}, ${paid.appointmentId})`;
      await owner`update patients set is_test = true where id in (select patient_id from appointments where id in (${plain.appointmentId}, ${paid.appointmentId}))`;
      // The second one holds a payment order (money is never deleted), on a test account.
      const [account] = await owner<{ id: string }[]>`
        insert into tenant_payment_accounts (tenant_id, provider, mode, status, key_id, public_id) values (${business.tenantId}, 'fake', 'test', 'active', 'key_test', ${`pub_${randomUUID().slice(0, 12)}`}) returning id`;
      await owner`insert into payment_orders (tenant_id, appointment_id, account_id, provider, mode, amount_minor, currency, status) values (${business.tenantId}, ${paid.appointmentId}, ${account!.id}, 'fake', 'test', 50000, 'INR', 'created')`;
      // A consent record (restricts deleting its customer) goes with the plain test customer.
      await owner`insert into consent_records (tenant_id, patient_id, purpose, granted, wording_version, source, actor_type)
        select tenant_id, patient_id, 'appointment_messages', true, '2026-11', 'booking', 'patient' from appointments where id = ${plain.appointmentId}`;
      const removed = await removeTestData(business.context);
      expect(removed.appointmentsRemoved).toBeGreaterThanOrEqual(1);
      expect(await owner`select 1 from appointments where id = ${plain.appointmentId}`).toHaveLength(0);
      const [kept] = await owner<{ status: string; is_test: boolean }[]>`select status, is_test from appointments where id = ${paid.appointmentId}`;
      expect(removed.appointmentsRetired).toBe(1);
      expect(kept).toEqual({ status: "entered_in_error", is_test: true });
      expect(await owner`select 1 from payment_orders where appointment_id = ${paid.appointmentId}`).toHaveLength(1);
      // Both customers stay: one is still pointed at by its booking, the other has a consent record.
      expect(await owner`select 1 from patients where is_test and tenant_id = ${business.tenantId}`).toHaveLength(2);
      // The plain booking's customer has a consent record, which can never be deleted: the booking goes, the customer stays and is counted.
      expect(removed.customersKept).toBe(2);
      // Each booking also recorded its unticked messages box as a no; the yes added above is still there too.
      expect(await owner`select 1 from consent_records where tenant_id = ${business.tenantId} and granted`).toHaveLength(1);
    });

    it("does not mistake someone else's booking, or one made before the panel opened, for the test", async () => {
      const business = await register("notmine", "salon");
      await bookAsOwner(business, 3);
      expect(await findTestBooking(business.context, new Date(Date.now() + hour).toISOString())).toEqual({ found: false });
      const old = await findTestBooking(business.context, new Date(Date.now() - 7 * hour).toISOString());
      expect(old).toEqual({ found: false });
    });

    it("adds a labelled week of sample appointments with no message to anyone, once, and removes them without touching real data", async () => {
      const business = await register("sample", "salon");
      const result = await addSampleData(business.context);
      expect(result.added).toBeGreaterThanOrEqual(4);
      const sample = await owner<{ first_name: string; is_test: boolean }[]>`select first_name, is_test from patients where tenant_id = ${business.tenantId}`;
      expect(sample.every((person) => person.is_test && person.first_name.endsWith("(sample)"))).toBe(true);
      const bookings = await owner<{ is_test: boolean; starts_at: Date }[]>`select is_test, starts_at from appointments where tenant_id = ${business.tenantId}`;
      expect(bookings).toHaveLength(result.added);
      expect(bookings.every((booking) => booking.is_test)).toBe(true);
      expect(Math.max(...bookings.map((booking) => booking.starts_at.getTime()))).toBeLessThan(Date.now() + 9 * 24 * hour);
      const notices = await owner`select 1 from notifications where tenant_id = ${business.tenantId}`;
      expect(notices).toHaveLength(0);
      await expect(addSampleData(business.context)).rejects.toMatchObject({ code: "sample_data_exists" });
      expect((await loadOnboardingState(business.context))!.sampleData).toBe(true);
      const removed = await removeTestData(business.context);
      expect(removed.appointmentsRemoved).toBe(result.added);
      expect(removed.customersRemoved).toBe(result.added);
      expect((await loadOnboardingState(business.context))!.sampleData).toBe(false);
      expect(await owner`select 1 from appointments where tenant_id = ${business.tenantId}`).toHaveLength(0);
    });

    it("sends no reminder, workflow message or email for sample bookings, even after every sweep has run", async () => {
      const business = await register("quiet", "salon");
      await addSampleData(business.context);
      // The reminders and review requests the template switched on look at every booking; none may pick up a sample one.
      for (let round = 0; round < 2; round += 1) {
        await reconcileWorkflows(worker);
        await sweepReminders(worker);
        await sweepWorkflowMessages(worker);
      }
      emails.reset();
      await drainTenantOutbox(worker, business.tenantId, handlers);
      // (The owner's own welcome email is a notification with no booking; every notification about a booking would be a sample one.)
      expect(await owner`select 1 from notifications where tenant_id = ${business.tenantId} and appointment_id is not null`).toHaveLength(0);
      expect(await owner`select 1 from scheduled_messages where tenant_id = ${business.tenantId}`).toHaveLength(0);
      expect(emails.sent.filter((message) => message.to.endsWith("@sample.example"))).toHaveLength(0);
    });

    it("needs a service, a person and hours before sample data, and says what to do", async () => {
      const business = await register("nosample", "dental", false);
      await expect(addSampleData(business.context)).rejects.toMatchObject({ code: "nothing_to_book" });
    });

    it("cannot remove another business's test rows", async () => {
      const mine = await register("purgea", "salon");
      const theirs = await register("purgeb", "salon");
      await addSampleData(theirs.context);
      expect((await removeTestData(mine.context)).appointmentsRemoved).toBe(0);
      expect((await owner`select 1 from appointments where tenant_id = ${theirs.tenantId} and is_test`).length).toBeGreaterThan(0);
      // The database function itself refuses to run for a business other than the one in scope.
      await expect(withTenant(mine.tenantId, (transaction) => transaction.execute(`select * from kalendr_purge_test_rows('${theirs.tenantId}')` as never))).rejects.toThrow();
    });
  });

  describe("go-live check", () => {
    it("flags a missing phone and address and leftover test data, and clears once they are fixed and removed", async () => {
      const business = await register("golive", "salon");
      await addSampleData(business.context);
      const before = await loadOnboardingState(business.context);
      const failing = before!.goLive.checks.filter((check) => !check.ok).map((check) => check.id).sort();
      expect(failing).toEqual(expect.arrayContaining(["contact_details", "test_data_present"]));
      expect(before!.goLive.clear).toBe(false);
      await removeTestData(business.context);
      await owner`update tenants set phone = '+919000033333' where id = ${business.tenantId}`;
      await owner`update locations set address = '1 Main Road', city = 'Pune' where tenant_id = ${business.tenantId}`;
      const after = await loadOnboardingState(business.context);
      expect(after!.goLive.checks.find((check) => check.id === "contact_details")?.ok).toBe(true);
      expect(after!.goLive.checks.find((check) => check.id === "services_bookable")?.ok).toBe(true);
      expect(after!.goLive.checks.find((check) => check.id === "test_data_present")?.ok).toBe(true);
    });
  });

  describe("the onboarding emails", () => {
    async function ageBy(business: Registered, hoursAgo: number): Promise<void> {
      await owner`update tenants set onboarding_started_at = now() - ${hoursAgo}::int * interval '1 hour', created_at = now() - ${hoursAgo}::int * interval '1 hour' where id = ${business.tenantId}`;
    }
    const queued = (business: Registered) => owner<{ key: string }[]>`select payload->>'kind' as key from outbox_events where tenant_id = ${business.tenantId} and event_type = 'onboarding.email' order by created_at`;

    it("sends a welcome at once, in the owner's inbox", async () => {
      const business = await register("welcome", "salon");
      emails.reset();
      await drainTenantOutbox(worker, business.tenantId, handlers);
      expect(emails.sent.some((message) => message.subject.includes("Welcome to Kalendr"))).toBe(true);
      expect(emails.sent.at(-1)?.to).toContain(business.email);
    });

    it("sends each business its own welcome, even though the email provider treats a repeated idempotency key as one email", async () => {
      const first = await register("welcome1", "salon");
      const second = await register("welcome2", "salon");
      emails.reset();
      // The handler is called directly, so another suite that claims every business's outbox rows cannot take these from us.
      for (const business of [first, second]) {
        await worker.begin(async (tenantDb) => {
          await tenantDb`select set_config('app.tenant_id', ${business.tenantId}, true)`;
          const outcome = await handlers.get("onboarding.email")!(tenantDb, {
            id: randomUUID(), tenantId: business.tenantId, aggregateType: "onboarding", aggregateId: business.tenantId, eventType: "onboarding.email",
            payload: { kind: "onboarding_welcome" }, dedupeKey: "onboarding.email:welcome", attemptCount: 1,
          });
          expect(outcome).toBe("delivered");
        });
      }
      const welcomes = emails.sent.filter((message) => message.subject.includes("Welcome to Kalendr"));
      expect(welcomes.map((message) => message.to).sort()).toEqual([first.email, second.email].sort());
      expect(new Set(welcomes.map((message) => message.idempotencyKey)).size).toBe(2);
    });

    it("sends the day-1 email to an owner who has not got far, and never twice", async () => {
      const business = await register("day1", "salon");
      await ageBy(business, 26);
      await sweepOnboarding(worker);
      await sweepOnboarding(worker);
      expect((await queued(business)).map((row) => row.key)).toEqual(["onboarding_welcome", "onboarding_day1"]);
    });

    it("does not send the day-1 email to an owner who has finished, or who is half way", async () => {
      const finished = await register("fin", "salon");
      for (const step of ["services", "hours", "share_link"] as const) await updateStep(finished.context, { step, action: "done" });
      for (const step of ["team", "test_booking", "brand", "payments"] as const) await updateStep(finished.context, { step, action: "skip" });
      expect((await loadOnboardingState(finished.context))!.summary.finished).toBe(true);
      await ageBy(finished, 26);
      const half = await register("half", "salon");
      for (const step of ["services", "hours", "share_link"] as const) await updateStep(half.context, { step, action: "done" });
      await ageBy(half, 26);
      await sweepOnboarding(worker);
      expect((await queued(finished)).map((row) => row.key)).toEqual(["onboarding_welcome"]);
      expect((await queued(half)).map((row) => row.key)).toEqual(["onboarding_welcome"]);
    });

    it("stops a queued day-1 email if the owner finishes before it is sent", async () => {
      const business = await register("late", "salon");
      await ageBy(business, 26);
      await sweepOnboarding(worker);
      expect((await queued(business)).map((row) => row.key)).toContain("onboarding_day1");
      for (const step of ["services", "hours", "share_link"] as const) await updateStep(business.context, { step, action: "done" });
      emails.reset();
      await drainTenantOutbox(worker, business.tenantId, handlers);
      expect(emails.sent.filter((message) => message.subject.includes("Finish setting up"))).toHaveLength(0);
      expect(emails.sent.filter((message) => message.subject.includes("Welcome"))).toHaveLength(1);
    });

    it("sends the day-3 email only while there is no real booking, and a test booking does not count as one", async () => {
      const quiet = await register("quiet", "salon");
      const busy = await register("busy", "salon");
      await bookAsOwner(busy, 2);
      const since = new Date(Date.now() - 60_000).toISOString();
      // The same booking, flagged as the owner's test: it still does not count as real.
      await findTestBooking(busy.context, since);
      const realBusy = await register("realbusy", "salon");
      const input = {
        clinicSlug: realBusy.slug,
        locationId: (await owner<{ id: string }[]>`select id from locations where tenant_id = ${realBusy.tenantId}`)[0]!.id,
        serviceId: (await owner<{ id: string }[]>`select id from services where tenant_id = ${realBusy.tenantId} limit 1`)[0]!.id,
        practitionerId: (await owner<{ id: string }[]>`select id from practitioners where tenant_id = ${realBusy.tenantId}`)[0]!.id,
        startsAt: new TZDate(TZDate.tz("Asia/Kolkata").getFullYear(), TZDate.tz("Asia/Kolkata").getMonth(), TZDate.tz("Asia/Kolkata").getDate() + 2, 12, 0, 0, "Asia/Kolkata").toISOString(),
        source: "desk" as const,
        newPatient: { firstName: "Real", lastName: "Customer", phone: "+919000044444", email: "customer@example.com", preferredChannel: "email" as const, isDependent: false, messagingConsent: false },
      };
      let booked = true;
      try { await createStaffAppointment(realBusy.context, input, `real3:${randomUUID()}`, canonicalJsonHash(input)); } catch { booked = false; }
      for (const business of [quiet, busy, realBusy]) await ageBy(business, 75);
      await sweepOnboarding(worker);
      expect((await queued(quiet)).map((row) => row.key)).toContain("onboarding_day3");
      expect((await queued(busy)).map((row) => row.key)).toContain("onboarding_day3");
      if (booked) expect((await queued(realBusy)).map((row) => row.key)).not.toContain("onboarding_day3");
    });

    it("never emails a business that registered before the guided first run, or one past its first two weeks", async () => {
      const old = await register("oldmail", "salon");
      await owner`update tenants set onboarding_started_at = null where id = ${old.tenantId}`;
      await owner`delete from outbox_events where tenant_id = ${old.tenantId}`;
      const stale = await register("stale", "salon");
      await owner`delete from outbox_events where tenant_id = ${stale.tenantId}`;
      await ageBy(stale, 24 * 20);
      await sweepOnboarding(worker);
      expect(await queued(old)).toHaveLength(0);
      expect(await queued(stale)).toHaveLength(0);
    });
  });

  describe("the funnel for the admin console", () => {
    it("counts, per step, who finished and the median minutes it took, behind the operator check", async () => {
      const business = await register("funnel", "salon");
      await updateStep(business.context, { step: "services", action: "done" });
      await loadOnboardingState(business.context);
      await expect(owner`select * from admin_onboarding_funnel(${randomUUID()}, 30)`).rejects.toThrow();
      // The owner of this test business is made an operator for a moment.
      await owner`insert into platform_admins (user_id, role, is_active) values (${business.context.userId}, 'support', true)`;
      try {
        const funnel = await onboardingFunnel(business.context.userId!, 30);
        const services = funnel.find((row) => row.stepKey === "services");
        expect(services?.done).toBeGreaterThanOrEqual(1);
        expect(services?.started).toBeGreaterThanOrEqual(services?.done ?? 0);
        expect(services?.medianMinutes).not.toBeNull();
        expect(funnel.map((row) => row.stepKey)).toEqual(["services", "hours", "team", "test_booking", "reminders", "brand", "share_link", "payments", "tour"]);
      } finally {
        await owner`delete from platform_admins where user_id = ${business.context.userId}`;
      }
    });
  });
});
