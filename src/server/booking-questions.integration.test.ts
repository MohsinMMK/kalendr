/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import type { PublicBookingInput } from "@/lib/contracts";
import { resolvePermissions } from "@/lib/permissions";
import type { StaffContext } from "@/server/staff-context";

vi.mock("server-only", () => ({}));

import { createAppointment, listAvailability } from "@/server/appointment-repository";
import { createStaffForm, loadAppointmentFormAnswers } from "@/server/booking-forms";
import { sendEmailCode, verifyEmailCode } from "@/server/email-check";
import { openPrivate } from "@/server/messaging/sealed-link";
import type { MessageProvider, RenderedMessage } from "@/server/messaging/provider";
import { createEmailAdapter } from "@/worker/email-adapter";
import { EMAIL_CHECK_EVENT, emailCheckHandler } from "@/worker/handlers/email-check";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const localDatabase = (url: string | undefined): boolean => {
  if (!url) return false;
  const parsed = new URL(url);
  return parsed.hostname === "127.0.0.1" && ["5544", "5545"].includes(parsed.port) && ["/kalendr_local", "/nira_local"].includes(parsed.pathname);
};
const describeLocal = localDatabase(runtimeUrl) && localDatabase(ownerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

const DAY = 86_400_000;
const slug = "lotus-dental";

describeLocal("booking questions against a real database", () => {
  it("drops answers to hidden questions, books phone-only, takes guests, and checks email with a code", async () => {
    const owner = postgres(ownerUrl!, { max: 2, prepare: false });
    const person = randomUUID();
    const plain = randomUUID();
    const checked = randomUUID();
    const phoneOnly = randomUUID();
    const guestly = randomUUID();
    const serviceIds = [plain, checked, phoneOnly, guestly];
    let tenantId = "";
    let formKey = "";
    try {
      const [tenant] = await owner<{ id: string }[]>`select id from tenants where slug = ${slug} limit 1`;
      const [location] = await owner<{ id: string; timezone: string }[]>`select id, timezone from locations where tenant_id = ${tenant?.id ?? ""} limit 1`;
      const [member] = await owner<{ user_id: string }[]>`select user_id from memberships where tenant_id = ${tenant?.id ?? ""} limit 1`;
      if (!tenant || !location || !member) throw new Error("Seed the isolated local database before this test");
      tenantId = tenant.id;
      const locationId = location.id;
      await owner.begin(async (transaction) => {
        await transaction`insert into practitioners (id, tenant_id, name, title, initials, specialty) values (${person}, ${tenantId}, 'Questions Test', 'Dentist', 'QT', 'Testing')`;
        await transaction`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${tenantId}, ${person}, ${locationId})`;
        for (const id of serviceIds) {
          await transaction`
            insert into services (id, tenant_id, name, description, duration_minutes, buffer_before_minutes, buffer_after_minutes,
              slot_interval_minutes, minimum_lead_minutes, maximum_advance_days, booking_mode, patient_types, price_minor,
              verify_email, contact_mode, allow_guests, max_guests)
            values (${id}, ${tenantId}, 'Questions Test Service', 'Local integration test', 30, 0, 0, 30, 0, 60, 'instant', ${["new", "returning"]}, 1000,
              ${id === checked}, ${id === phoneOnly ? "phone_only" : "email_or_phone"}, ${id === guestly}, 2)`;
          await transaction`insert into service_locations (tenant_id, service_id, location_id) values (${tenantId}, ${id}, ${locationId})`;
          await transaction`insert into practitioner_services (tenant_id, practitioner_id, service_id) values (${tenantId}, ${person}, ${id})`;
        }
        for (let dayOfWeek = 1; dayOfWeek <= 7; dayOfWeek += 1) {
          await transaction`insert into availability_rules (id, tenant_id, location_id, practitioner_id, day_of_week, starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes)
            values (${randomUUID()}, ${tenantId}, ${locationId}, ${person}, ${dayOfWeek}, '09:00', '17:00', ${location.timezone}, '2025-01-01', 30)`;
        }
      });

      const context: StaffContext = {
        tenantId, clinicSlug: slug, clinicName: slug, role: "owner", permissions: resolvePermissions("owner", {}),
        membershipId: null, userId: member.user_id, userName: "Owner", userEmail: "owner@example.com", preview: false,
      };
      const openings = await listAvailability({ clinicSlug: slug, locationId, serviceId: plain, practitionerId: person, from: new Date(Date.now() + 2 * DAY).toISOString(), to: new Date(Date.now() + 6 * DAY).toISOString() });
      expect(openings.length).toBeGreaterThan(10);
      let next = 0;
      const book = (serviceId: string, extra: Partial<PublicBookingInput> = {}): PublicBookingInput => {
        const slot = openings[next++]!;
        return {
          clinicSlug: slug, patientType: "new", bookingFor: "self", locationId, serviceId, practitionerId: person, slotId: slot.id, startsAt: slot.startsAt, endsAt: slot.endsAt,
          firstName: "Questions", lastName: "Test", phone: `+9190001${Math.floor(10000 + Math.random() * 89999)}`, email: `q-${randomUUID().slice(0, 8)}@example.com`,
          preferredChannel: "email", acceptedPrivacyNotice: true, messagingConsent: false, ...extra,
        };
      };
      const create = (input: PublicBookingInput) => createAppointment(input, randomUUID(), randomUUID().replaceAll("-", ""));

      // A question that appears only on "No"; a crafted answer to it on "Yes" is dropped, not stored.
      const form = await createStaffForm(context, {
        name: "Questions test form", description: "", isActive: true, appliesToAll: false, serviceIds: [plain],
        fields: [
          { id: "visited", type: "yes_no", label: "Have you visited before?", required: true },
          { id: "heard", type: "short_text", label: "How did you hear about us?", required: true, showWhen: [{ fieldId: "visited", operator: "equals", value: "no" }] },
          { id: "campaign", type: "short_text", label: "Campaign", required: false, hidden: true, prefillKey: "campaign" },
        ],
      });
      formKey = form.key;
      const yes = await create(book(plain, { formAnswers: { visited: true, heard: "crafted", campaign: "diwali" } }));
      const stored = await loadAppointmentFormAnswers(context, yes.appointmentId);
      expect(stored?.answers).toEqual({ visited: true, campaign: "diwali" });
      await expect(create(book(plain, { formAnswers: { visited: false } }))).rejects.toMatchObject({ code: "form_invalid" });
      const no = await create(book(plain, { formAnswers: { visited: false, heard: "A friend" } }));
      expect((await loadAppointmentFormAnswers(context, no.appointmentId))?.answers).toMatchObject({ heard: "A friend" });

      // A phone-only service books without an email, and refuses a booking with no phone.
      const withoutEmail = await create(book(phoneOnly, { email: "" }));
      expect(withoutEmail.status).toBe("booked");
      await expect(create(book(phoneOnly, { phone: "", email: "x@example.com" }))).rejects.toMatchObject({ status: 422 });

      // A couple's booking with one guest: the list is sealed, and the guest gets the confirmation without the manage link.
      const withGuest = await create(book(guestly, { guests: ["partner@example.com"] }));
      const [row] = await owner<{ guest_emails_ciphertext: string | null }[]>`select guest_emails_ciphertext from appointments where id = ${withGuest.appointmentId}`;
      expect(row?.guest_emails_ciphertext).toBeTruthy();
      expect(row?.guest_emails_ciphertext).not.toContain("partner");
      expect(JSON.parse(openPrivate("guests", tenantId, withGuest.appointmentId, row?.guest_emails_ciphertext ?? null) ?? "[]")).toEqual(["partner@example.com"]);
      await expect(create(book(guestly, { guests: ["a@example.com", "b@example.com", "c@example.com"] }))).rejects.toMatchObject({ status: 422 });
      await expect(create(book(plain, { guests: ["a@example.com"], formAnswers: { visited: true } }))).rejects.toMatchObject({ status: 422 });

      const sent: RenderedMessage[] = [];
      const provider: MessageProvider = { channel: "email", send: async (message) => { sent.push(message); return { providerMessageId: `m${sent.length}` }; } };
      const adapter = createEmailAdapter({ provider, origin: "https://example.test", fallbackReplyTo: null });
      const [patient] = await owner<{ patient_id: string }[]>`select patient_id from appointments where id = ${withGuest.appointmentId}`;
      await owner.begin(async (transaction) => {
        const result = await adapter.send({ tenantDb: transaction, tenantId, appointmentId: withGuest.appointmentId, patientId: patient!.patient_id, channel: "email", templateKey: "appointment.created", body: "", idempotencyKey: `test:${randomUUID()}` });
        expect(result.status).toBe("sent");
      });
      expect(sent).toHaveLength(2);
      expect(sent[1]?.to).toBe("partner@example.com");
      expect(sent[0]?.html).toContain("/manage/");
      expect(sent[1]?.html).not.toContain("/manage/");

      // The email check: three wrong codes, then the right one, books once; the proof cannot be used twice.
      const email = `check-${randomUUID().slice(0, 8)}@example.com`;
      await expect(create(book(checked, { email }))).rejects.toMatchObject({ code: "email_not_verified" });
      await sendEmailCode({ action: "send", clinicSlug: slug, serviceId: checked, email });
      const codeOf = async (): Promise<string> => {
        const [check] = await owner<{ id: string; delivery_sealed: string | null }[]>`select id, delivery_sealed from email_checks where tenant_id = ${tenantId} order by created_at desc limit 1`;
        const opened = JSON.parse(openPrivate("email_check", tenantId, check!.id, check!.delivery_sealed) ?? "{}") as { code?: string };
        return opened.code ?? "";
      };
      const right = await codeOf();
      const wrong = right === "000000" ? "111111" : "000000";
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(verifyEmailCode({ action: "verify", clinicSlug: slug, email, code: wrong })).rejects.toMatchObject({ code: "invalid_code" });
      }
      // The worker sends the code from the outbox, once, and clears what it sealed.
      const [event] = await owner<{ id: string; aggregate_id: string; dedupe_key: string }[]>`select id, aggregate_id, dedupe_key from outbox_events where tenant_id = ${tenantId} and event_type = ${EMAIL_CHECK_EVENT} order by created_at desc limit 1`;
      const before = sent.length;
      const mailer = { provider, fallbackReplyTo: null };
      const handler = emailCheckHandler({ sink: undefined as never, now: () => new Date(), email: mailer });
      // The worker would clear the sealed copy after sending, which also removes it here, so read the right code first.
      expect(await owner.begin((transaction) => handler(transaction, { id: event!.id, tenantId, aggregateType: "email_check", aggregateId: event!.aggregate_id, eventType: EMAIL_CHECK_EVENT, payload: {}, dedupeKey: event!.dedupe_key, attemptCount: 0 }))).toBe("delivered");
      expect(sent.length).toBe(before + 1);
      expect(sent.at(-1)?.text).toContain(right);
      const proof = (await verifyEmailCode({ action: "verify", clinicSlug: slug, email, code: right })).proof;
      expect((await create(book(checked, { email, emailProof: proof }))).status).toBe("booked");
      await expect(create(book(checked, { email, emailProof: proof }))).rejects.toMatchObject({ code: "email_not_verified" });
      await expect(create(book(checked, { email: "someone-else@example.com", emailProof: proof }))).rejects.toMatchObject({ code: "email_not_verified" });

      // Five wrong guesses use the code up: a sixth try is refused even with the right code.
      const lockedEmail = `locked-${randomUUID().slice(0, 8)}@example.com`;
      await sendEmailCode({ action: "send", clinicSlug: slug, serviceId: checked, email: lockedEmail });
      const lockedRight = await codeOf();
      const lockedWrong = lockedRight === "000000" ? "111111" : "000000";
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await expect(verifyEmailCode({ action: "verify", clinicSlug: slug, email: lockedEmail, code: lockedWrong })).rejects.toMatchObject({ code: "invalid_code" });
      }
      await expect(verifyEmailCode({ action: "verify", clinicSlug: slug, email: lockedEmail, code: lockedRight })).rejects.toMatchObject({ status: 429, code: "too_many_attempts" });
      // Sends are limited per address: five an hour.
      const spam = `spam-${randomUUID().slice(0, 8)}@example.com`;
      for (let index = 0; index < 5; index += 1) await sendEmailCode({ action: "send", clinicSlug: slug, serviceId: checked, email: spam });
      await expect(sendEmailCode({ action: "send", clinicSlug: slug, serviceId: checked, email: spam })).rejects.toMatchObject({ status: 429 });
      await expect(sendEmailCode({ action: "send", clinicSlug: slug, serviceId: plain, email })).rejects.toMatchObject({ code: "email_check_not_required" });
    } finally {
      if (tenantId) {
        await owner.begin(async (transaction) => {
          const patients = await transaction<{ patient_id: string }[]>`select patient_id from appointments where service_id in ${transaction(serviceIds)}`;
          await transaction`delete from forms where tenant_id = ${tenantId} and appointment_id in (select id from appointments where service_id in ${transaction(serviceIds)})`;
          await transaction`delete from audit_events where appointment_id in (select id from appointments where service_id in ${transaction(serviceIds)})`;
          await transaction`delete from outbox_events where tenant_id = ${tenantId} and (aggregate_id in (select id from appointments where service_id in ${transaction(serviceIds)}) or aggregate_type = 'email_check')`;
          await transaction`delete from appointments where service_id in ${transaction(serviceIds)}`;
          await transaction`delete from email_checks where tenant_id = ${tenantId}`;
          await transaction`delete from idempotency_keys where tenant_id = ${tenantId} and created_at > now() - interval '10 minutes'`;
          if (patients.length) await transaction`delete from consent_records where (select set_config('kalendr.consent_erase', 'on', true)) = 'on' and (tenant_id, patient_id) in (select tenant_id, id from patients where id in ${transaction(patients.map((patient) => patient.patient_id))})`;
          if (patients.length) await transaction`delete from patients where id in ${transaction(patients.map((patient) => patient.patient_id))}`;
          if (formKey) {
            await transaction`delete from form_definition_services where tenant_id = ${tenantId} and form_definition_id in (select id from form_definitions where tenant_id = ${tenantId} and key = ${formKey})`;
            await transaction`delete from form_definitions where tenant_id = ${tenantId} and key = ${formKey}`;
          }
          await transaction`delete from availability_rules where practitioner_id = ${person}`;
          await transaction`delete from practitioner_services where practitioner_id = ${person}`;
          await transaction`delete from practitioner_locations where practitioner_id = ${person}`;
          await transaction`delete from service_locations where service_id in ${transaction(serviceIds)}`;
          await transaction`delete from services where id in ${transaction(serviceIds)}`;
          await transaction`delete from practitioners where id = ${person}`;
        });
      }
      await owner.end();
    }
  }, 120_000);
});
