/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { resolvePermissions } from "@/lib/permissions";
import { drainTenantOutbox } from "@/test/outbox-drain";
import { createAppointment } from "@/server/appointment-repository";
import { customerInviteEntry } from "@/server/calendar-invite";
import { saveConnection, updateSelection } from "@/server/calendar-sync";
import { FakeCalendarProvider } from "@/server/calendars";
import { createAppointmentCalendar } from "@/server/icalendar";
import { openPrivate } from "@/server/messaging/sealed-link";
import { createFakeEmailProvider } from "@/server/messaging/email-fake";
import { clearReplyTo, getReplyTo, sendReplyToCode, verifyReplyTo } from "@/server/reply-to";
import { applyServiceSetupPatch, getServiceSetup } from "@/server/services-admin";
import type { StaffContext } from "@/server/staff-context";
import { describeScratch } from "@/server/testing/scratch-database";
import { createSchedulingFixture, plusMinutes, startIn, type SchedulingFixture } from "@/server/testing/scheduling-fixture";
import { providerSink } from "@/worker/delivery";
import { createEmailAdapter } from "@/worker/email-adapter";
import { createHandlers } from "@/worker/handlers";
import type { CalendarDeps } from "@/worker/calendar/common";

const ownerUrl = process.env.KALENDR_TEST_OWNER_URL ?? "";
const workerUrl = process.env.WORKER_DATABASE_URL ?? "";

describeScratch("calendar entry wording (feature 50)", () => {
  let fixture: SchedulingFixture;
  let worker: postgres.Sql;
  let staff: StaffContext;
  let membershipId = "";
  const google = new FakeCalendarProvider({ id: "google", accountEmail: "stylist@example.test" });
  const email = createFakeEmailProvider();
  const deps: CalendarDeps = { now: () => new Date(), adapter: () => google };
  const handlers = createHandlers({
    sink: providerSink({ email: createEmailAdapter({ provider: email, origin: "https://app.example.test", fallbackReplyTo: null }) }),
    now: () => new Date(),
    calendar: deps,
  });
  const drain = () => drainTenantOutbox(worker, fixture.tenantId, handlers);
  let businessName = "";

  beforeAll(async () => {
    process.env.CALENDAR_PROVIDER_MODE = "live";
    fixture = await createSchedulingFixture(ownerUrl, { name: "Wording" });
    worker = postgres(workerUrl, { max: 3, prepare: false });
    const [tenant] = await fixture.owner<{ name: string }[]>`select name from tenants where id = ${fixture.tenantId}`;
    businessName = tenant!.name;
    const [member] = await fixture.owner<{ id: string; user_id: string }[]>`select id, user_id from memberships where tenant_id = ${fixture.tenantId} and role = 'owner' limit 1`;
    membershipId = member!.id;
    await fixture.owner`update practitioners set auth_user_id = ${member!.user_id} where id = ${fixture.practitionerId}`;
    staff = { ...fixture.context, membershipId: member!.id, userId: member!.user_id, role: "owner", permissions: resolvePermissions("owner", {}) };
    google.addCalendar("personal", "Personal", { primary: true });
  });

  afterAll(async () => {
    await fixture.owner`delete from calendar_connections where tenant_id = ${fixture.tenantId}`;
    await fixture.owner`delete from calendar_business_settings where tenant_id = ${fixture.tenantId}`;
    await fixture.owner`update tenants set reply_to_email = null, reply_to_verified_at = null where id = ${fixture.tenantId}`;
    await fixture.owner`delete from email_checks where tenant_id = ${fixture.tenantId}`;
    await fixture.owner`update practitioners set auth_user_id = null where id = ${fixture.practitionerId}`;
    await fixture.owner`delete from calendar_webhook_events where tenant_id = ${fixture.tenantId}`;
    await fixture.owner`delete from appointment_event_links where tenant_id = ${fixture.tenantId} and appointment_id in (select id from appointments where service_id = ${fixture.serviceId})`;
    await fixture.owner`delete from notifications where tenant_id = ${fixture.tenantId} and appointment_id in (select id from appointments where service_id = ${fixture.serviceId})`;
    await fixture.owner`delete from staff_notifications where tenant_id = ${fixture.tenantId}`;
    await fixture.owner`delete from outbox_events where tenant_id = ${fixture.tenantId}`;
    await fixture.cleanup();
    await worker.end();
  });

  async function patch(calendarEntry: { customerTitle: string | null; staffTitle: string | null; description: string | null; hideNotes: boolean; hideDetails: boolean }) {
    const current = await getServiceSetup(fixture.context, fixture.serviceId);
    return applyServiceSetupPatch(fixture.context, fixture.serviceId, { calendarEntry }, current.version);
  }

  it("writes the customer's invite in the business's words, escaped once, and keeps the staff entry separate", async () => {
    await saveConnection(staff, membershipId, "google", "stylist@example.test", { kind: "oauth", provider: "google", refreshToken: "r", accessToken: "a", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
    await drain();
    const [selection] = await fixture.owner<{ id: string; version: number }[]>`select id, version from calendar_selections where tenant_id = ${fixture.tenantId} and calendar_id = 'personal'`;
    await updateSelection(staff, selection!.id, { writesHere: true, version: selection!.version });
    await drain();

    const saved = await patch({ customerTitle: "{service} with {person} (Kalendr)", staffTitle: "{customer}: {service}, {length}", description: "Welcome, {customer_first_name}; see you at {branch}.", hideNotes: false, hideDetails: false });
    expect(saved.calendarEntry).toMatchObject({ customerTitle: "{service} with {person} (Kalendr)" });
    const start = startIn(21, 10);
    const made = await createAppointment(fixture.bookingInput(start, plusMinutes(start, 30), "w@acme-corp.in", { firstName: "Anna, Maria", lastName: "O'Neil; Jr 🎉" }), randomUUID(), randomUUID().replaceAll("-", ""));
    await drain();

    // The customer's invite, as the email adapter attached it.
    const confirmation = email.sent.find((message) => message.attachments?.some((file) => file.filename === "appointment.ics"));
    const ics = String(confirmation!.attachments![0]!.content);
    expect(ics).toContain("SUMMARY:Wording Service with Wording (Kalendr)");
    expect(ics).toMatch(/DESCRIPTION:Welcome\\, Anna\\, Maria\; see you at/);
    // The staff calendar got the staff title, with the name's comma left as typed (the provider escapes its own text).
    const [link] = await fixture.owner<{ event_id: string }[]>`select event_id from appointment_event_links where tenant_id = ${fixture.tenantId} and appointment_id = ${made.appointmentId} and status = 'active'`;
    const event = google.event("personal", link!.event_id)!;
    expect(event.writtenTitle).toBe("Anna, Maria O'Neil; Jr 🎉: Wording Service, 30 min");

    // The same invite from the web route's helper, and an unset service keeps the usual wording.
    const viaRoute = await customerInviteEntry(fixture.tenantId, made.appointmentId);
    expect(viaRoute?.title).toBe("Wording Service with Wording (Kalendr)");
    const plain = createAppointmentCalendar({ appointmentId: made.appointmentId, version: 1, status: "booked", startsAt: start, endsAt: plusMinutes(start, 30), clinicName: "Glow, Salon; 1", clinicPhone: "1", serviceName: "Cut", practitionerName: "P", locationName: "", locationAddress: "", locationCity: "" });
    expect(plain).toContain("SUMMARY:Cut · Glow\\, Salon\; 1");
  });

  it("with details hidden, the staff calendar shows only 'Busy: business' and nothing else is written", async () => {
    await patch({ customerTitle: null, staffTitle: "{customer}: {service}", description: "Private {customer}", hideNotes: false, hideDetails: true });
    const start = startIn(22, 10);
    const made = await createAppointment(fixture.bookingInput(start, plusMinutes(start, 30), "h@acme-corp.in", { firstName: "Hidden", lastName: "Person" }), randomUUID(), randomUUID().replaceAll("-", ""));
    await drain();
    const [link] = await fixture.owner<{ event_id: string }[]>`select event_id from appointment_event_links where tenant_id = ${fixture.tenantId} and appointment_id = ${made.appointmentId} and status = 'active'`;
    const event = google.event("personal", link!.event_id)!;
    expect(event.writtenTitle).toBe(`Busy: ${businessName}`);
    expect(event.writtenDescription).toBeNull();
    expect(event.writtenLocation).toBeNull();
    // Turning it off brings the details back on the next change.
    await patch({ customerTitle: null, staffTitle: "{customer}: {service}", description: null, hideNotes: false, hideDetails: false });
  });

  it("replies reach the business's verified address, and only a right code stores it", async () => {
    expect(await getReplyTo(staff)).toEqual({ email: null, verifiedAt: null });
    await sendReplyToCode(staff, "Hello@Glow-Salon.example");
    const [check] = await fixture.owner<{ id: string; delivery_sealed: string }[]>`select id, delivery_sealed from email_checks where tenant_id = ${fixture.tenantId} order by created_at desc limit 1`;
    const opened = JSON.parse(openPrivate("email_check", fixture.tenantId, check!.id, check!.delivery_sealed)!) as { email: string; code: string };
    await expect(verifyReplyTo(staff, "hello@glow-salon.example", opened.code === "000000" ? "111111" : "000000")).rejects.toMatchObject({ code: "invalid_code" });
    expect((await getReplyTo(staff)).email).toBeNull();
    const verified = await verifyReplyTo(staff, "hello@glow-salon.example", opened.code);
    expect(verified.email).toBe("hello@glow-salon.example");
    expect(verified.verifiedAt).not.toBeNull();
    // The audit trail names no address.
    const audit = await fixture.owner<{ metadata: unknown }[]>`select metadata from audit_events where tenant_id = ${fixture.tenantId} and action like 'reply_to.%'`;
    expect(JSON.stringify(audit)).not.toContain("glow-salon");

    // The next confirmation uses it as Reply-To.
    email.reset();
    const start = startIn(23, 10);
    await createAppointment(fixture.bookingInput(start, plusMinutes(start, 30), "r@acme-corp.in"), randomUUID(), randomUUID().replaceAll("-", ""));
    await drain();
    expect(email.sent.some((message) => message.replyTo === "hello@glow-salon.example")).toBe(true);
    // Another business has nothing set, and removing falls back to the business email.
    const [other] = await fixture.owner<{ reply_to_email: string | null }[]>`select reply_to_email from tenants where id = ${fixture.otherTenantId}`;
    expect(other!.reply_to_email).toBeNull();
    await clearReplyTo(staff);
    expect(await getReplyTo(staff)).toEqual({ email: null, verifiedAt: null });
  });
});
