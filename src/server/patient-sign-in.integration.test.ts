/** @vitest-environment node */

import { createHash, randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createAppointment, listAvailability, manageAppointment, resolveManageToken } from "@/server/appointment-repository";
import { changeBookingContact } from "@/server/booking-contact";
import { ApiError } from "@/server/api-error";
import type { MessageProvider } from "@/server/messaging/provider";
import { openManageToken } from "@/server/messaging/sealed-link";
import { getPatientAccount, issueLoginCode, patientSessionCookie, requestLoginCode, sessionCookieHeader, verifyLoginCode } from "@/server/patient-auth";
import { listPatientDevices, signOutOtherPatientDevices, signOutPatientDevice } from "@/server/patient-devices";
import { finishStepUp, manageLinkExpired, requestStepUp, requireStepUp, stepUpCookie, verifyStepUp } from "@/server/patient-step-up";
import { hitRateLimit } from "@/server/rate-limit";
import { createCaptureChannel } from "@/server/channels/capture";
import { runCodeDeliveries, type CodeDeliveryDeps } from "@/worker/patient-code-delivery";
import { createTenant, createCustomer } from "@/test/privacy-fixture";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL ?? process.env.KALENDR_E2E_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
// Only an isolated database of your own, never the shared one.
const isolated = (url: string | undefined) => {
  if (!url) return false;
  const parsed = new URL(url);
  return parsed.hostname === "127.0.0.1" && ["5545", "5609", "5599"].includes(parsed.port) && ["/kalendr_local", "/kalendr_e2e"].includes(parsed.pathname);
};
const describeIsolated = isolated(runtimeUrl) && isolated(ownerUrl) && isolated(workerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const cookieHeaders = (setCookie: string) => new Headers({ cookie: setCookie.split(";")[0] ?? "" });
const day = 24 * 60 * 60 * 1_000;

async function expectApiError(promise: Promise<unknown>, code: string): Promise<ApiError> {
  const error = await promise.then(() => null, (cause: unknown) => cause);
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).code).toBe(code);
  return error as ApiError;
}

describeIsolated("customer sign-in upgrade (feature 8)", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  const whatsapp = createCaptureChannel("whatsapp");
  const sms = createCaptureChannel("sms");
  const emailSent: Array<{ to: string; subject: string; text: string }> = [];
  const deps = (over: Partial<CodeDeliveryDeps> = {}): CodeDeliveryDeps => ({
    workerId: "test-worker",
    whatsapp,
    sms,
    email: {
      provider: { channel: "email", send: async (message) => { emailSent.push({ to: message.to, subject: message.subject, text: message.text }); return { providerMessageId: "e" }; } } satisfies MessageProvider,
      fallbackReplyTo: null,
    },
    allowUnapproved: true,
    devConsole: false,
    ...over,
  });
  const run = (over: Partial<CodeDeliveryDeps> = {}) => runCodeDeliveries(worker, deps(over), 50);
  const phoneOf = () => `+9197${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;

  beforeAll(() => {
    owner = postgres(ownerUrl!, { max: 2, prepare: false });
    worker = postgres(workerUrl!, { max: 2, prepare: false });
  });
  afterAll(async () => {
    await owner.end();
    await worker.end();
  });

  describe("code delivery", () => {
    it("keeps the sealed delivery table out of reach of the app role and sends a phone-only customer's code by WhatsApp with a copy-code button", async () => {
      whatsapp.reset();
      sms.reset();
      const phone = phoneOf();
      await requestLoginCode("phone", phone);
      // The app role cannot read or write the table directly; only the definer functions reach it.
      const app = postgres(runtimeUrl!, { max: 1, prepare: false });
      try {
        expect(await app`select * from patient_code_deliveries`).toHaveLength(0);
        await expect(app`insert into patient_code_deliveries (purpose, expires_at) values ('sign_in', now())`).rejects.toThrow();
        await expect(app`select * from kalendr_claim_code_deliveries('x', 1)`).rejects.toThrow();
      } finally {
        await app.end();
      }
      const [pending] = await owner<{ status: string; sealed: string | null }[]>`select status, sealed from patient_code_deliveries order by created_at desc limit 1`;
      expect(pending!.status).toBe("pending");
      expect(pending!.sealed).not.toContain(phone.replace(/\D/g, ""));

      await run();
      expect(whatsapp.sent).toHaveLength(1);
      const message = whatsapp.sent[0]!;
      expect(message.to).toBe(`+${phone.replace(/\D/g, "")}`);
      expect(message.content.kind).toBe("template");
      const content = message.content as { copyCode?: string; variables: string[]; templateKey: string };
      expect(content.templateKey).toBe("sign_in_code");
      expect(content.copyCode).toMatch(/^\d{6}$/);
      expect(content.variables).toEqual([content.copyCode]);
      expect(sms.sent).toHaveLength(0);

      const [done] = await owner<{ status: string; sealed: string | null }[]>`select status, sealed from patient_code_deliveries order by created_at desc limit 1`;
      expect(done).toEqual({ status: "sent", sealed: null });

      // The code that arrived signs this customer in.
      const grant = await verifyLoginCode("phone", phone, content.copyCode!);
      const account = await getPatientAccount(cookieHeaders(sessionCookieHeader(grant)));
      expect(account?.contactKind).toBe("phone");
    });

    it("falls back from WhatsApp to a text message, and to email for an email contact", async () => {
      whatsapp.reset();
      sms.reset();
      const phone = phoneOf();
      await requestLoginCode("phone", phone);
      whatsapp.failNext("rejected");
      await run();
      expect(whatsapp.sent).toHaveLength(0);
      expect(sms.sent).toHaveLength(1);

      whatsapp.reset();
      sms.reset();
      await requestLoginCode("phone", phoneOf(), { via: "text" });
      await run();
      expect(whatsapp.attempts).toBe(0);
      expect(sms.sent).toHaveLength(1);

      const email = `fallback-${randomUUID().slice(0, 8)}@example.com`;
      await requestLoginCode("email", email);
      await run();
      expect(emailSent.some((message) => message.to === email && /\d{6}/.test(message.text))).toBe(true);
    });

    it("retries a transient failure, then gives up, and drops an expired code unsent", async () => {
      whatsapp.reset();
      sms.reset();
      await requestLoginCode("phone", phoneOf());
      whatsapp.failNext("retry");
      sms.failNext("retry");
      await run({ email: null });
      const [retrying] = await owner<{ status: string; sealed: string | null }[]>`select status, sealed from patient_code_deliveries order by created_at desc limit 1`;
      expect(retrying!.status).toBe("pending");
      expect(retrying!.sealed).not.toBeNull();

      await owner`update patient_code_deliveries set expires_at = now() - interval '1 second' where status = 'pending'`;
      await run();
      const [dropped] = await owner<{ status: string; sealed: string | null; last_error_code: string }[]>`select status, sealed, last_error_code from patient_code_deliveries order by created_at desc limit 1`;
      expect(dropped).toEqual({ status: "failed", sealed: null, last_error_code: "expired" });
      expect(whatsapp.sent).toHaveLength(0);
    });
  });

  describe("limits and sessions", () => {
    it("refuses the sixth code request in an hour from one network", async () => {
      const key = `203.0.113.${Math.floor(Math.random() * 250)}-${randomUUID()}`;
      const now = new Date(Math.floor(Date.now() / (60 * 60 * 1_000)) * 60 * 60 * 1_000 + 60_000);
      const results = [];
      for (let attempt = 0; attempt < 6; attempt += 1) results.push(await hitRateLimit("code_request.ip", key, { now }));
      expect(results.map((result) => result.allowed)).toEqual([true, true, true, true, true, false]);
      expect(results[5]!.retryAfterSeconds).toBeGreaterThan(0);
      // A device has its own count, separate from the network.
      expect((await hitRateLimit("code_request.device", key, { now })).count).toBe(1);
    });

    it("makes the next try wait after a wrong code, without counting the refused try", async () => {
      const email = `backoff-${randomUUID().slice(0, 8)}@example.com`;
      const code = await issueLoginCode("email", email);
      const wrong = code === "000000" ? "111111" : "000000";
      await expectApiError(verifyLoginCode("email", email, wrong), "invalid_code");
      const locked = await expectApiError(verifyLoginCode("email", email, code), "code_retry_later");
      expect(locked.status).toBe(429);
      expect(Number(locked.headers?.["Retry-After"])).toBeGreaterThan(0);
      const [row] = await owner<{ attempt_count: number }[]>`select attempt_count from patient_login_codes where contact_hash = ${sha(`email:${email}`)}`;
      expect(row!.attempt_count).toBe(1);
      await owner`update patient_login_codes set locked_until = now() - interval '1 second' where contact_hash = ${sha(`email:${email}`)}`;
      await expect(verifyLoginCode("email", email, code)).resolves.toMatchObject({ token: expect.any(String) });
    });

    it("remembers a device for 30 days, lists devices, and signs out only this account's own", async () => {
      const emailA = `devices-a-${randomUUID().slice(0, 8)}@example.com`;
      const emailB = `devices-b-${randomUUID().slice(0, 8)}@example.com`;
      const remembered = await verifyLoginCode("email", emailA, await issueLoginCode("email", emailA), { remember: true, userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0 Safari/537.36" });
      const plain = await verifyLoginCode("email", emailA, await issueLoginCode("email", emailA), { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/605.1" });
      expect(remembered.expiresAt.getTime() - Date.now()).toBeGreaterThan(29 * day);
      expect(plain.expiresAt.getTime() - Date.now()).toBeLessThan(2 * day);
      const headersA = new Headers({ cookie: `${patientSessionCookie}=${remembered.token}` });
      const accountA = (await getPatientAccount(headersA))!;
      const devices = await listPatientDevices(accountA, headersA);
      expect(devices).toHaveLength(2);
      expect(devices.find((device) => device.current)).toMatchObject({ label: "Chrome on macOS", remember: true });
      expect(devices.find((device) => !device.current)).toMatchObject({ label: "Safari on iOS", remember: false });

      const grantB = await verifyLoginCode("email", emailB, await issueLoginCode("email", emailB));
      const headersB = new Headers({ cookie: `${patientSessionCookie}=${grantB.token}` });
      const accountB = (await getPatientAccount(headersB))!;
      const [mine] = await listPatientDevices(accountB, headersB);
      // Account A cannot sign out account B's device by id.
      await expectApiError(signOutPatientDevice(accountA, headersA, mine!.id), "device_not_found");
      expect(await listPatientDevices(accountB, headersB)).toHaveLength(1);

      expect(await signOutOtherPatientDevices(accountA, headersA)).toBe(1);
      expect(await listPatientDevices(accountA, headersA)).toHaveLength(1);
      expect(await getPatientAccount(new Headers({ cookie: `${patientSessionCookie}=${plain.token}` }))).toBeNull();
    });
  });

  describe("manage links", () => {
    let tenantId = "";
    let otherTenantId = "";
    const token = (label: string) => `${label}-${randomUUID().replaceAll("-", "")}`;

    async function bookingEndedDaysAgo(days: number): Promise<{ appointmentId: string; token: string }> {
      const fixture = await createTenant(owner, "expiry");
      const customer = await createCustomer(owner, fixture.tenantId);
      const linkToken = token("exp");
      const [row] = await owner<{ id: string }[]>`
        insert into appointments (tenant_id, location_id, patient_id, practitioner_id, service_id, starts_at, ends_at, status, booking_source, manage_token_hash)
        values (${fixture.tenantId}, ${fixture.locationId}, ${customer.id}, ${fixture.practitionerId}, ${fixture.serviceId},
          now() - ${days} * interval '1 day' - interval '30 minutes', now() - ${days} * interval '1 day', 'booked', 'staff', ${sha(linkToken)})
        returning id`;
      return { appointmentId: row!.id, token: linkToken };
    }

    beforeAll(async () => {
      const [tenant] = await owner<{ id: string }[]>`select id from tenants where slug = 'lotus-dental'`;
      const [other] = await owner<{ id: string }[]>`select id from tenants where slug <> 'lotus-dental' order by slug limit 1`;
      tenantId = tenant!.id;
      otherTenantId = other!.id;
    });

    it("stops opening a booking 31 days after it ended, and keeps it open at 29", async () => {
      const old = await bookingEndedDaysAgo(31);
      expect(await resolveManageToken(old.token)).toBeNull();
      expect(await manageLinkExpired(old.token)).toBe(true);
      const recent = await bookingEndedDaysAgo(29);
      expect(await resolveManageToken(recent.token)).not.toBeNull();
      expect(await manageLinkExpired(recent.token)).toBe(false);
      // An unknown token is not "expired": nothing says which tokens exist.
      expect(await manageLinkExpired(token("nope"))).toBe(false);
      // Moving the end of a booking moves the expiry with it (the trigger).
      await owner`update appointments set starts_at = now() - interval '1 hour', ends_at = now() where id = ${old.appointmentId}`;
      expect(await resolveManageToken(old.token)).not.toBeNull();
    });

    it("gives a rescheduled booking a new link, the old one stops, and the queued message carries the new one", async () => {
      const created = await createBookedAppointment();
      const slots = await listAvailability({
        clinicSlug: "lotus-dental", locationId: created.locationId, serviceId: created.serviceId, practitionerId: created.practitionerId,
        from: new Date(Date.now() + 10 * day).toISOString(), to: new Date(Date.now() + 17 * day).toISOString(),
      });
      const target = slots.find((slot) => slot.startsAt !== created.startsAt);
      expect(target).toBeDefined();
      const moved = await manageAppointment(created.manageToken, { action: "reschedule", startsAt: target!.startsAt, expectedVersion: created.version });
      expect(moved.manageToken).toBeTruthy();
      expect(moved.manageToken).not.toBe(created.manageToken);
      expect(await resolveManageToken(created.manageToken)).toBeNull();
      expect(await resolveManageToken(moved.manageToken!)).toMatchObject({ appointment_id: created.appointmentId });
      const [row] = await owner<{ manage_token_ciphertext: string }[]>`select manage_token_ciphertext from appointments where id = ${created.appointmentId}`;
      expect(openManageToken(tenantId, created.appointmentId, row!.manage_token_ciphertext)).toBe(moved.manageToken);
      // The reschedule event was written in the same transaction, after the new token was sealed.
      const events = await owner`select 1 from outbox_events where tenant_id = ${tenantId} and aggregate_id = ${created.appointmentId} and event_type = 'appointment.reschedule'`;
      expect(events).toHaveLength(1);
    });

    interface Booked { appointmentId: string; manageToken: string; version: number; startsAt: string; locationId: string; serviceId: string; practitionerId: string; patientId: string }

    async function createBookedAppointment(contact: { phone?: string; email?: string } = {}): Promise<Booked> {
      const [link] = await owner<{ location_id: string; service_id: string; practitioner_id: string }[]>`
        select location.location_id, service.service_id, service.practitioner_id
        from practitioner_services as service
        join practitioner_locations as location on location.tenant_id = service.tenant_id and location.practitioner_id = service.practitioner_id
        where service.tenant_id = ${tenantId} limit 1`;
      const slots = await listAvailability({
        clinicSlug: "lotus-dental", locationId: link!.location_id, serviceId: link!.service_id, practitionerId: link!.practitioner_id,
        from: new Date(Date.now() + 18 * day).toISOString(), to: new Date(Date.now() + 26 * day).toISOString(),
      });
      const slot = slots[Math.floor(Math.random() * slots.length)];
      if (!slot) throw new Error("Expected an open slot");
      const created = await createAppointment({
        clinicSlug: "lotus-dental", patientType: "new", bookingFor: "self", locationId: link!.location_id, serviceId: link!.service_id,
        practitionerId: link!.practitioner_id, slotId: randomUUID(), startsAt: slot.startsAt, endsAt: slot.endsAt,
        firstName: "Step", lastName: "Up", phone: contact.phone ?? phoneOf(), email: contact.email ?? `stepup-${randomUUID().slice(0, 8)}@example.com`,
        preferredChannel: "email", acceptedPrivacyNotice: true, messagingConsent: false,
      }, randomUUID(), randomUUID().replaceAll("-", ""));
      const [row] = await owner<{ patient_id: string; version: number }[]>`select patient_id, version from appointments where id = ${created.appointmentId}`;
      return {
        appointmentId: created.appointmentId, manageToken: created.manageToken, version: row!.version, startsAt: slot.startsAt,
        locationId: link!.location_id, serviceId: link!.service_id, practitionerId: link!.practitioner_id, patientId: row!.patient_id,
      };
    }

    async function codeFromWhatsApp(phone: string): Promise<string> {
      whatsapp.reset();
      await run();
      const message = whatsapp.sent.find((entry) => entry.to === `+${phone.replace(/\D/g, "")}`);
      const code = (message?.content as { copyCode?: string } | undefined)?.copyCode;
      if (!code) throw new Error("Expected a code on WhatsApp");
      return code;
    }

    it("asks a forwarded link for a code that only the contact on the booking has", async () => {
      const phone = phoneOf();
      const booked = await createBookedAppointment({ phone });
      const forwarder = new Headers();
      await expectApiError(requireStepUp(forwarder, booked.manageToken), "step_up_required");

      const { hint } = await requestStepUp(booked.manageToken, "cancel");
      expect(hint).toMatch(/^•••• \d{4}$/);
      const code = await codeFromWhatsApp(phone);
      // The forwarder never sees the code; guessing fails, and a wrong guess makes the next try wait.
      const wrong = code === "000000" ? "111111" : "000000";
      await expectApiError(verifyStepUp(booked.manageToken, wrong), "invalid_code");
      await expectApiError(verifyStepUp(booked.manageToken, code), "code_retry_later");
      await owner`update booking_step_ups set locked_until = null where appointment_id = ${booked.appointmentId}`;
      const { grant } = await verifyStepUp(booked.manageToken, code);
      const holder = new Headers({ cookie: `${stepUpCookie}=${grant}` });
      await expect(requireStepUp(holder, booked.manageToken)).resolves.toMatchObject({ appointmentId: booked.appointmentId, paid: false });

      // The grant belongs to this booking only.
      const other = await createBookedAppointment();
      await expectApiError(requireStepUp(holder, other.manageToken), "step_up_required");
      // The same code cannot be used twice.
      await expectApiError(verifyStepUp(booked.manageToken, code), "invalid_code");
    });

    it("lets this customer's own portal session skip the code, but not another customer's, and a paid booking always asks", async () => {
      const phone = phoneOf();
      const booked = await createBookedAppointment({ phone });
      const [patient] = await owner<{ phone: string }[]>`select phone from patients where id = ${booked.patientId}`;
      const ownContact = patient!.phone;
      const own = await verifyLoginCode("phone", ownContact, await issueLoginCode("phone", ownContact));
      const ownHeaders = new Headers({ cookie: `${patientSessionCookie}=${own.token}` });
      await expect(requireStepUp(ownHeaders, booked.manageToken)).resolves.toMatchObject({ paid: false });

      const strangerEmail = `stranger-${randomUUID().slice(0, 8)}@example.com`;
      const stranger = await verifyLoginCode("email", strangerEmail, await issueLoginCode("email", strangerEmail));
      await expectApiError(requireStepUp(new Headers({ cookie: `${patientSessionCookie}=${stranger.token}` }), booked.manageToken), "step_up_required");

      // Money taken at the desk: the signed-in device is no longer enough, and the code works once.
      await owner`insert into payments (tenant_id, appointment_id, amount_minor, currency, method) values (${tenantId}, ${booked.appointmentId}, 50000, 'INR', 'cash')`;
      await expectApiError(requireStepUp(ownHeaders, booked.manageToken), "step_up_required");
      await requestStepUp(booked.manageToken, "reschedule");
      const code = await codeFromWhatsApp(ownContact);
      const { grant } = await verifyStepUp(booked.manageToken, code);
      const holder = new Headers({ cookie: `${stepUpCookie}=${grant}` });
      const context = await requireStepUp(holder, booked.manageToken);
      expect(context).toMatchObject({ paid: true });
      await finishStepUp(context);
      await expectApiError(requireStepUp(holder, booked.manageToken), "step_up_required");
    });

    it("keeps step-up codes inside their own business", async () => {
      const booked = await createBookedAppointment();
      await requestStepUp(booked.manageToken, "contact");
      const app = postgres(runtimeUrl!, { max: 1, prepare: false });
      try {
        const rows = await app.begin(async (transaction) => {
          await transaction`select set_config('app.tenant_id', ${otherTenantId}, true)`;
          return transaction`select id from booking_step_ups where appointment_id = ${booked.appointmentId}`;
        });
        expect(rows).toHaveLength(0);
        const own = await app.begin(async (transaction) => {
          await transaction`select set_config('app.tenant_id', ${tenantId}, true)`;
          return transaction`select id from booking_step_ups where appointment_id = ${booked.appointmentId}`;
        });
        expect(own.length).toBeGreaterThan(0);
      } finally {
        await app.end();
      }
    });

    it("tells the other contact when details change, without naming the new one", async () => {
      const phone = phoneOf();
      const email = `change-${randomUUID().slice(0, 8)}@example.com`;
      const booked = await createBookedAppointment({ phone, email });
      whatsapp.reset();
      sms.reset();
      emailSent.length = 0;
      const newPhone = phoneOf();
      expect(await changeBookingContact(booked.manageToken, { phone: newPhone })).toEqual({ updated: true });
      await run();
      // Only the email (the channel that did not change) is told, and the new number is nowhere in it.
      const told = emailSent.filter((message) => message.to === email);
      expect(told).toHaveLength(1);
      expect(told[0]!.text).not.toContain(newPhone.replace(/\D/g, "").slice(-6));
      const digitsOf = (value: string) => value.replace(/\D/g, "");
      expect(whatsapp.sent.filter((message) => [digitsOf(phone), digitsOf(newPhone)].includes(digitsOf(message.to)))).toHaveLength(0);
      const [row] = await owner<{ phone: string }[]>`select phone from patients where id = ${booked.patientId}`;
      expect(row!.phone).toBe(`+${newPhone.replace(/\D/g, "")}`);
      // Nothing changed, nothing sent.
      expect(await changeBookingContact(booked.manageToken, { phone: newPhone })).toEqual({ updated: false });
      const audit = await owner<{ metadata: { fields: string[] } }[]>`select metadata from audit_events where appointment_id = ${booked.appointmentId} and action = 'patient.contact_changed'`;
      expect(audit[0]!.metadata).toEqual({ fields: ["phone"] });
    });
  });
});
