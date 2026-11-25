/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { PublicBookingInput } from "@/lib/contracts";
import { resolvePermissions } from "@/lib/permissions";
import type { StaffContext } from "@/server/staff-context";

vi.mock("server-only", () => ({}));

import { POST as googleWebhook } from "@/app/api/webhooks/google-calendar/route";
import { POST as microsoftWebhook } from "@/app/api/webhooks/microsoft-graph/route";
import { GET as feedRoute } from "@/app/api/calendar-feed/[token]/route";
import { createAppointment, listAvailability, mutateStaffAppointment, updateAppointmentStatus } from "@/server/appointment-repository";
import { beginConnect, finishConnect } from "@/server/calendar-connect";
import { resolveConflict } from "@/server/calendar-conflicts";
import { createFeed, disconnectCalendar, getCalendarOverview, revokeFeed, saveConnection, setEventText, updateSelection } from "@/server/calendar-sync";
import { CalendarProviderError, FakeCalendarProvider } from "@/server/calendars";
import { providerStates } from "@/server/calendars/runtime";
import { getExternalBusy } from "@/server/external-busy";
import type { FileStore } from "@/server/file-store";
import { sealBytes } from "@/server/keys/records";
import { reEncryptTenant, rotateTenantKey } from "@/worker/storage-jobs";
import { localCaptureSink } from "@/worker/delivery";
import { createHandlers } from "@/worker/handlers";
import { renewCalendarChannels } from "@/worker/calendar/jobs";
import type { CalendarDeps } from "@/worker/calendar/common";
import { runOutboxBatch } from "@/worker/outbox-worker";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const isLocal = (url: string | undefined) => {
  if (!url) return false;
  const parsed = new URL(url);
  return parsed.hostname === "127.0.0.1" && ["5544", "5545"].includes(parsed.port) && ["/kalendr_local", "/nira_local"].includes(parsed.pathname);
};
const describeLocal = isLocal(runtimeUrl) && isLocal(ownerUrl) && isLocal(workerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

const WEBHOOK_TOKEN = "t".repeat(40);
describeLocal("calendar sync", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  let tenantA = "";
  let tenantB = "";
  let locationId = "";
  let ownerMembership = "";
  let ownerUserId = "";
  let staffMembership = "";
  const practitionerId = randomUUID();
  const serviceId = randomUUID();
  const idempotencyKeys: string[] = [];
  const google = new FakeCalendarProvider({ id: "google", accountEmail: "stylist@example.test" });
  const outlook = new FakeCalendarProvider({ id: "microsoft", accountEmail: "stylist@outlook.test" });
  const clock = new Date();
  /** Makes Google's next reads refresh the login and then fail, the case where a rotated token must still be saved. */
  let failWithRefresh = false;
  const deps: CalendarDeps = {
    now: () => clock,
    adapter: (id, onRefreshed) => {
      if (id === "microsoft") return outlook;
      if (!failWithRefresh) return google;
      return new Proxy(google, {
        get(target, property) {
          if (property === "syncChanges") {
            return async () => {
              onRefreshed({ refreshToken: "rotated-refresh", accessToken: "new-access", expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
              throw new CalendarProviderError("transient", "fake failure after a refresh");
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };

  const staff = (tenantId: string, membershipId: string, role: "owner" | "practitioner", userId: string | null = null): StaffContext => ({
    tenantId, clinicSlug: "x", clinicName: "X", role, permissions: resolvePermissions(role, {}),
    membershipId, userId, userName: "Staff", userEmail: "test@example.com", preview: false,
  });
  let asStaff: StaffContext;
  let asOwner: StaffContext;

  const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(Date.now() + 12 * 86_400_000));
  const at = (hour: number, minute = 0) => new Date(`${dayKey}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000+05:30`).toISOString();

  /** Works the outbox the way the worker does, with the fake calendars, until nothing is due. */
  async function drain(): Promise<void> {
    const handlers = createHandlers({ sink: localCaptureSink, now: () => clock, calendar: deps });
    for (let round = 0; round < 25; round += 1) {
      const claimed = await runOutboxBatch(worker, { workerId: "calendar-test", batchSize: 50, concurrency: 2, handlers });
      if (claimed === 0) return;
    }
  }

  async function slotsAt(hour: number): Promise<boolean> {
    const slots = await listAvailability({ clinicSlug: "lotus-dental", locationId, serviceId, practitionerId, from: at(hour), to: at(hour + 1) });
    return slots.some((slot) => slot.startsAt === at(hour));
  }

  async function book(hour: number): Promise<string> {
    const input: PublicBookingInput = {
      clinicSlug: "lotus-dental", patientType: "new", bookingFor: "self", locationId, serviceId, practitionerId, slotId: randomUUID(),
      startsAt: at(hour), endsAt: new Date(new Date(at(hour)).getTime() + 15 * 60_000).toISOString(),
      firstName: "Zorblax", lastName: "Quillfeather", phone: "+91 90000 00456", email: "zorblax@example.com", preferredChannel: "email",
      accessibilityNeed: "None", acceptedPrivacyNotice: true, messagingConsent: false,
    };
    const key = randomUUID();
    idempotencyKeys.push(key);
    return (await createAppointment(input, key, randomUUID().replaceAll("-", ""))).appointmentId;
  }

  const webhookRequest = (url: string, init: RequestInit & { headers?: Record<string, string> }) => new Request(url, { method: "POST", ...init });
  const pushGoogle = (channelId: string, message: number, token = WEBHOOK_TOKEN, state = "exists") =>
    googleWebhook(webhookRequest("https://app.example.test/api/webhooks/google-calendar", {
      headers: { "x-goog-channel-id": channelId, "x-goog-channel-token": token, "x-goog-message-number": String(message), "x-goog-resource-state": state },
    }));
  const pushOutlook = (subscriptionId: string, clientState = WEBHOOK_TOKEN, change = "updated") =>
    microsoftWebhook(webhookRequest("https://app.example.test/api/webhooks/microsoft-graph", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: [{ subscriptionId, clientState, changeType: change, resource: "me/events/x", resourceData: { id: randomUUID() } }] }),
    }));

  async function selection(provider: "google" | "microsoft", calendar: string) {
    const [row] = await owner<{ id: string; version: number; channel_id: string | null; channel_expires_at: Date | null; connection_id: string }[]>`
      select selection.id, selection.version, selection.channel_id, selection.channel_expires_at, selection.connection_id
      from calendar_selections as selection join calendar_connections as connection on connection.id = selection.connection_id
      where selection.tenant_id = ${tenantA} and selection.membership_id = ${staffMembership}
        and connection.provider = ${provider} and selection.calendar_id = ${calendar}`;
    return row!;
  }

  beforeAll(async () => {
    process.env.CALENDAR_WEBHOOK_TOKEN = WEBHOOK_TOKEN;
    process.env.CALENDAR_PROVIDER_MODE = "live";
    owner = postgres(ownerUrl!, { max: 2, prepare: false });
    worker = postgres(workerUrl!, { max: 4, prepare: false });
    const [a] = await owner<{ id: string }[]>`select id from tenants where slug = 'lotus-dental'`;
    const [b] = await owner<{ id: string }[]>`select id from tenants where slug = 'riverbend-care'`;
    tenantA = a!.id;
    tenantB = b!.id;
    locationId = (await owner<{ id: string }[]>`select id from locations where tenant_id = ${tenantA} limit 1`)[0]!.id;
    const people = await owner<{ id: string; role: string; user_id: string }[]>`select id, role, user_id from memberships where tenant_id = ${tenantA} and is_active order by role`;
    const ownerRow = people.find((row) => row.role === "owner")!;
    const staffRow = people.find((row) => row.role === "practitioner")!;
    ownerMembership = ownerRow.id;
    ownerUserId = ownerRow.user_id;
    staffMembership = staffRow.id;
    asStaff = staff(tenantA, staffMembership, "practitioner", staffRow.user_id);
    asOwner = staff(tenantA, ownerMembership, "owner", ownerUserId);

    google.addCalendar("personal", "Personal", { primary: true });
    google.addCalendar("holidays", "Holidays", { canWrite: false });
    outlook.addCalendar("main", "Calendar", { primary: true });

    await owner.begin(async (transaction) => {
      await transaction`insert into practitioners (id, tenant_id, auth_user_id, name, title, initials, specialty) values (${practitionerId}, ${tenantA}, ${staffRow.user_id}, 'Calendar Test', 'Stylist', 'CT', 'Testing')`;
      await transaction`
        insert into services (id, tenant_id, name, description, duration_minutes, buffer_before_minutes, buffer_after_minutes,
          slot_interval_minutes, minimum_lead_minutes, maximum_advance_days, booking_mode, patient_types)
        values (${serviceId}, ${tenantA}, 'Calendar Test Service', 'Local integration test', 15, 0, 0, 15, 120, 90, 'instant', ${["new", "returning"]})`;
      await transaction`insert into service_locations (tenant_id, service_id, location_id) values (${tenantA}, ${serviceId}, ${locationId})`;
      await transaction`insert into practitioner_services (tenant_id, practitioner_id, service_id) values (${tenantA}, ${practitionerId}, ${serviceId})`;
      await transaction`insert into practitioner_locations (tenant_id, practitioner_id, location_id) values (${tenantA}, ${practitionerId}, ${locationId})`;
      for (let day = 1; day <= 7; day += 1) {
        await transaction`
          insert into availability_rules (id, tenant_id, location_id, practitioner_id, day_of_week, starts_at_local, ends_at_local, timezone, valid_from, slot_interval_minutes)
          values (${randomUUID()}, ${tenantA}, ${locationId}, ${practitionerId}, ${day}, '00:00', '23:45', 'Asia/Kolkata', '2025-01-01', 15)`;
      }
    });
  });

  afterAll(async () => {
    await owner.begin(async (transaction) => {
      const patientIds = await transaction<{ patient_id: string }[]>`select distinct patient_id from appointments where service_id = ${serviceId}`;
      await transaction`delete from calendar_connections where tenant_id = ${tenantA}`;
      await transaction`delete from calendar_feed_tokens where tenant_id = ${tenantA}`;
      await transaction`delete from calendar_business_settings where tenant_id = ${tenantA}`;
      await transaction`delete from calendar_webhook_events where tenant_id = ${tenantA}`;
      await transaction`delete from staff_notifications where tenant_id = ${tenantA}`;
      await transaction`delete from audit_events where appointment_id in (select id from appointments where service_id = ${serviceId})`;
      await transaction`delete from outbox_events where tenant_id = ${tenantA}`;
      await transaction`delete from notifications where tenant_id = ${tenantA} and appointment_id in (select id from appointments where service_id = ${serviceId})`;
      await transaction`delete from resource_reservations where appointment_id in (select id from appointments where service_id = ${serviceId})`;
      await transaction`delete from appointments where service_id = ${serviceId}`;
      if (idempotencyKeys.length) await transaction`delete from idempotency_keys where tenant_id = ${tenantA} and key in ${transaction(idempotencyKeys)}`;
      if (patientIds.length) await transaction`delete from consent_records where (select set_config('kalendr.consent_erase', 'on', true)) = 'on' and (tenant_id, patient_id) in (select tenant_id, id from patients where id in ${transaction(patientIds.map((row) => row.patient_id))})`;
      if (patientIds.length) await transaction`delete from patients where id in ${transaction(patientIds.map((row) => row.patient_id))}`;
      await transaction`delete from availability_rules where practitioner_id = ${practitionerId}`;
      await transaction`delete from practitioner_services where practitioner_id = ${practitionerId}`;
      await transaction`delete from practitioner_locations where practitioner_id = ${practitionerId}`;
      await transaction`delete from service_locations where service_id = ${serviceId}`;
      await transaction`delete from services where id = ${serviceId}`;
      await transaction`delete from practitioners where id = ${practitionerId}`;
    });
    await owner.end();
    await worker.end();
  });

  it("connects a Google account: the login is stored sealed, the worker lists calendars, and the primary one blocks availability", async () => {
    await saveConnection(asStaff, staffMembership, "google", "stylist@example.test", {
      kind: "oauth", provider: "google", refreshToken: "refresh-secret-value", accessToken: "access-secret-value", expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const [stored] = await owner<{ credentials_ciphertext: string; key_version: number; status: string }[]>`select credentials_ciphertext, key_version, status from calendar_connections where tenant_id = ${tenantA}`;
    expect(stored!.status).toBe("pending");
    expect(stored!.credentials_ciphertext.startsWith("s1.")).toBe(true);
    expect(stored!.credentials_ciphertext).not.toContain("refresh-secret-value");
    expect(stored!.key_version).toBeGreaterThan(0);

    await drain();
    const overview = await getCalendarOverview(asStaff);
    expect(overview.connections).toHaveLength(1);
    expect(overview.connections[0]).toMatchObject({ provider: "google", status: "active", accountEmail: "stylist@example.test", mine: true });
    const calendars = overview.connections[0]!.calendars;
    expect(calendars.find((calendar) => calendar.name === "Personal")).toMatchObject({ blocksAvailability: true, writesHere: false });
    expect(calendars.find((calendar) => calendar.name === "Holidays")).toMatchObject({ blocksAvailability: false, canWrite: false });
    // The primary calendar is being watched.
    expect(google.channelsFor("personal")).toHaveLength(1);
    expect((await selection("google", "personal")).channel_id).not.toBeNull();
  });

  it("(a) an event added in Google removes that slot from the booking page after a webhook-triggered read", async () => {
    expect(await slotsAt(10)).toBe(true);
    google.addEvent("personal", { id: "dentist", startsAt: at(10), endsAt: at(11) });
    google.addEvent("personal", { id: "lunch-free", startsAt: at(12), endsAt: at(13), transparent: true });
    const channel = google.channelsFor("personal")[0]!;
    expect((await pushGoogle(channel.channelId, 2)).status).toBe(200);
    await drain();
    expect(await slotsAt(10)).toBe(false);
    // An event marked "free" does not block, and nothing but start, end and id was saved.
    expect(await slotsAt(12)).toBe(true);
    const rows = await owner<Record<string, unknown>[]>`select * from external_busy where tenant_id = ${tenantA}`;
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0]!).sort()).toEqual(["created_at", "ends_at", "id", "membership_id", "selection_id", "source_event_id", "starts_at", "tenant_id"]);
    expect(rows[0]!.source_event_id).toBe("dentist");
    // The read-only merged view for the slot engine.
    const busy = await getExternalBusy(practitionerId, { from: new Date(at(9)), to: new Date(at(14)) }, { tenantId: tenantA });
    expect(busy).toEqual([{ startsAt: new Date(at(10)), endsAt: new Date(at(11)) }]);
    // The booking itself is also refused, not only hidden.
    await expect(book(10)).rejects.toMatchObject({ status: 409, code: "slot_unavailable" });

    // Removing the event in Google frees the slot again.
    google.removeEvent("personal", "dentist");
    await pushGoogle(channel.channelId, 3);
    await drain();
    expect(await slotsAt(10)).toBe(true);
  });

  it("answers webhooks: a bad token is 401, a repeat is acknowledged once, an unknown channel is ignored, and Microsoft's validation token is echoed", async () => {
    const channel = google.channelsFor("personal")[0]!;
    expect((await pushGoogle(channel.channelId, 90, "wrong-token")).status).toBe(401);
    expect((await googleWebhook(webhookRequest("https://app.example.test/api/webhooks/google-calendar", { headers: { "x-goog-channel-id": channel.channelId } }))).status).toBe(401);
    const sel = await selection("google", "personal");
    const before = (await owner`select count(*)::int as count from outbox_events where tenant_id = ${tenantA} and event_type = 'calendar.sync'`)[0]!.count as number;
    const first = await (await pushGoogle(channel.channelId, 91)).json() as { data: { result: string } };
    const second = await (await pushGoogle(channel.channelId, 91)).json() as { data: { result: string } };
    expect(first.data.result).toBe("queued");
    expect(second.data.result).toBe("duplicate");
    const after = (await owner`select count(*)::int as count from outbox_events where tenant_id = ${tenantA} and event_type = 'calendar.sync'`)[0]!.count as number;
    expect(after - before).toBe(1);
    expect((await owner`select count(*)::int as count from calendar_webhook_events where tenant_id = ${tenantA} and selection_id = ${sel.id} and event_key = ${`${channel.channelId}:91`}`)[0]!.count).toBe(1);
    // The first "sync" message only says the channel exists.
    expect(((await (await pushGoogle(channel.channelId, 92, WEBHOOK_TOKEN, "sync")).json()) as { data: { result: string } }).data.result).toBe("ignored");
    expect(((await (await pushGoogle("no-such-channel", 1)).json()) as { data: { result: string } }).data.result).toBe("unknown_channel");

    const handshake = await microsoftWebhook(webhookRequest("https://app.example.test/api/webhooks/microsoft-graph?validationToken=abc%20123", {}));
    expect(handshake.status).toBe(200);
    expect(handshake.headers.get("content-type")).toContain("text/plain");
    expect(await handshake.text()).toBe("abc 123");
    expect((await pushOutlook("some-subscription", "wrong")).status).toBe(401);
    expect((await pushOutlook("some-subscription")).status).toBe(202);
    await drain();
  });

  it("(b) a Kalendr booking appears in Outlook, moves when rescheduled, and is removed when cancelled", async () => {
    await saveConnection(asStaff, staffMembership, "microsoft", "stylist@outlook.test", {
      kind: "oauth", provider: "microsoft", refreshToken: "refresh-outlook", accessToken: "access-outlook", expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await drain();
    const main = await selection("microsoft", "main");
    // Choosing where new bookings go.
    await updateSelection(asStaff, main.id, { writesHere: true, version: main.version });
    await expect(updateSelection(asStaff, main.id, { writesHere: false, version: main.version })).rejects.toMatchObject({ status: 409, code: "version_conflict" });
    await drain();

    const appointmentId = await book(14);
    await drain();
    const [link] = await owner<{ event_id: string; status: string }[]>`select event_id, status from appointment_event_links where tenant_id = ${tenantA} and appointment_id = ${appointmentId}`;
    expect(link).toMatchObject({ status: "active" });
    const event = outlook.event("main", link!.event_id)!;
    expect(event.startsAt).toBe(at(14));
    // Default text is just "Busy": no name, service or contact detail.
    expect(event.writtenTitle).toBe("Busy");
    // Kalendr's own event never blocks its own slot, and a re-read does not turn it into busy time.
    const outlookChannel = outlook.channelsFor("main")[0]!;
    await pushOutlook(outlookChannel.channelId);
    await drain();
    expect((await owner`select count(*)::int as count from external_busy where tenant_id = ${tenantA} and source_event_id = ${link!.event_id}`)[0]!.count).toBe(0);
    expect((await owner`select count(*)::int as count from calendar_conflicts where tenant_id = ${tenantA}`)[0]!.count).toBe(0);

    // The owner chooses how much to write; existing events follow.
    await expect(setEventText(asStaff, "full")).rejects.toMatchObject({ status: 403 });
    await setEventText(asOwner, "first_name_service");
    await drain();
    expect(outlook.event("main", link!.event_id)!.writtenTitle).toBe("Zorblax – Calendar Test Service");

    const [current] = await owner<{ version: number }[]>`select version from appointments where id = ${appointmentId}`;
    await mutateStaffAppointment(asOwner, appointmentId, { action: "reschedule", startsAt: at(16), practitionerId, expectedVersion: current!.version, notifyCustomer: true });
    await drain();
    expect(outlook.event("main", link!.event_id)!.startsAt).toBe(at(16));

    const [after] = await owner<{ version: number }[]>`select version from appointments where id = ${appointmentId}`;
    await updateAppointmentStatus(ownerUserId, appointmentId, { status: "cancelled", reason: "Calendar test", expectedVersion: after!.version });
    await drain();
    expect(outlook.event("main", link!.event_id)!.cancelled).toBe(true);
    expect((await owner`select status from appointment_event_links where appointment_id = ${appointmentId}`)[0]!.status).toBe("deleted");
  });

  it("(c) deleting the event outside Kalendr raises a Needs-a-person item and leaves the appointment alone; both actions work", async () => {
    const appointmentId = await book(15);
    await drain();
    const [link] = await owner<{ event_id: string }[]>`select event_id from appointment_event_links where tenant_id = ${tenantA} and appointment_id = ${appointmentId} and status = 'active'`;
    outlook.removeEvent("main", link!.event_id);
    await pushOutlook(outlook.channelsFor("main")[0]!.channelId);
    await drain();

    const [appointment] = await owner<{ status: string; starts_at: Date }[]>`select status, starts_at from appointments where id = ${appointmentId}`;
    expect(appointment!.status).not.toBe("cancelled");
    expect(appointment!.starts_at.toISOString()).toBe(at(15));
    const overview = await getCalendarOverview(asStaff);
    expect(overview.conflicts).toHaveLength(1);
    expect(overview.conflicts[0]).toMatchObject({ appointmentId, kind: "deleted", eventStartsAt: null });
    expect(overview.conflicts[0]!.appointmentStartsAt).toBe(at(15));
    const alerts = await owner<{ title: string }[]>`select title from staff_notifications where tenant_id = ${tenantA} and membership_id = ${staffMembership} and kind = 'needs_person'`;
    expect(alerts.some((alert) => alert.title.includes("deleted"))).toBe(true);
    // The owner sees it too; a read of the same items twice raises nothing new.
    expect((await getCalendarOverview(asOwner)).conflicts).toHaveLength(1);
    await pushOutlook(outlook.channelsFor("main")[0]!.channelId, WEBHOOK_TOKEN, "created");
    await drain();
    expect((await owner`select count(*)::int as count from calendar_conflicts where tenant_id = ${tenantA} and appointment_id = ${appointmentId}`)[0]!.count).toBe(1);

    // "Put the calendar event back" makes a new event at the appointment's time.
    await expect(resolveConflict(asOwner, overview.conflicts[0]!.id, "move_appointment")).rejects.toMatchObject({ status: 409, code: "calendar_conflict_not_movable" });
    // Moving an appointment is booking work: a person who cannot book is refused.
    await expect(resolveConflict(asStaff, overview.conflicts[0]!.id, "move_appointment")).rejects.toMatchObject({ status: 403 });
    await resolveConflict(asStaff, overview.conflicts[0]!.id, "restore_event");
    await drain();
    const [restored] = await owner<{ event_id: string }[]>`select event_id from appointment_event_links where tenant_id = ${tenantA} and appointment_id = ${appointmentId} and status = 'active'`;
    expect(restored!.event_id).not.toBe(link!.event_id);
    expect(outlook.event("main", restored!.event_id)).toMatchObject({ startsAt: at(15), cancelled: false });
    expect((await getCalendarOverview(asStaff)).conflicts).toHaveLength(0);

    // Moved outside: "Move the appointment to match" runs the normal reschedule and tells the customer.
    outlook.moveEvent("main", restored!.event_id, at(17), at(17, 15));
    await pushOutlook(outlook.channelsFor("main")[0]!.channelId, WEBHOOK_TOKEN, "updated");
    await drain();
    const moved = (await getCalendarOverview(asStaff)).conflicts;
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ kind: "moved", eventStartsAt: at(17), appointmentStartsAt: at(15) });
    expect((await owner`select starts_at from appointments where id = ${appointmentId}`)[0]!.starts_at.toISOString()).toBe(at(15));
    await resolveConflict(asOwner, moved[0]!.id, "move_appointment");
    expect((await owner`select starts_at from appointments where id = ${appointmentId}`)[0]!.starts_at.toISOString()).toBe(at(17));
    expect((await owner`select count(*)::int as count from outbox_events where tenant_id = ${tenantA} and aggregate_id = ${appointmentId} and event_type = 'appointment.reschedule'`)[0]!.count).toBeGreaterThan(0);
    await drain();
    // The event already sat at the new time, so no new conflict appears.
    expect((await getCalendarOverview(asStaff)).conflicts).toHaveLength(0);
    expect(outlook.event("main", restored!.event_id)!.startsAt).toBe(at(17));
  });

  it("two reads of one calendar at once take turns and leave one consistent copy", async () => {
    const sel = await selection("google", "personal");
    google.addEvent("personal", { id: "race", startsAt: at(18), endsAt: at(19) });
    for (const tag of ["one", "two"]) {
      await owner`insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
        values (${tenantA}, 'calendar_selection', ${sel.id}, 'calendar.sync', ${owner.json({ selectionId: sel.id })}, ${`test.race:${tag}:${randomUUID()}`})`;
    }
    await drain();
    expect((await owner`select count(*)::int as count from external_busy where tenant_id = ${tenantA} and source_event_id = 'race'`)[0]!.count).toBe(1);
    expect(await slotsAt(18)).toBe(false);
  });

  it("(e) a channel about to expire is renewed by the hourly job", async () => {
    const sel = await selection("google", "personal");
    const oldChannel = sel.channel_id!;
    google.setChannelExpiry(oldChannel, new Date(Date.now() + 2 * 3_600_000).toISOString());
    await owner`update calendar_selections set channel_expires_at = now() + interval '2 hours' where id = ${sel.id}`;
    const summary = await renewCalendarChannels(worker, new Date());
    expect(summary.rows).toBeGreaterThanOrEqual(1);
    // Running it again in the same hour adds nothing.
    expect((await renewCalendarChannels(worker, new Date())).rows).toBe(0);
    await drain();
    const renewed = await selection("google", "personal");
    expect(renewed.channel_id).not.toBe(oldChannel);
    expect(renewed.channel_expires_at!.getTime()).toBeGreaterThan(Date.now() + 5 * 86_400_000);
    expect(google.channels.has(oldChannel)).toBe(false);
    expect(google.channelsFor("personal")).toHaveLength(1);
  });

  it("keeps a private feed per staff member: only the hash is stored, titles follow the setting, regenerating or turning it off kills the old link", async () => {
    await setEventText(asOwner, "busy_only");
    const appointmentId = await book(19);
    const created = await createFeed(asStaff);
    const token = created.url.split("/").pop()!.replace(/\.ics$/, "");
    const [stored] = await owner<{ token_hash: string }[]>`select token_hash from calendar_feed_tokens where tenant_id = ${tenantA} and membership_id = ${staffMembership}`;
    expect(stored!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(token);
    const read = (value: string) => feedRoute(new Request(`https://app.example.test/api/calendar-feed/${value}`), { params: Promise.resolve({ token: value }) });
    const response = await read(`${token}.ics`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/calendar");
    const body = await response.text();
    expect(body).toContain("BEGIN:VEVENT");
    expect(body).toContain(`UID:${appointmentId}@kalendr.app`);
    expect(body).toContain("SUMMARY:Busy");
    for (const forbidden of ["Zorblax", "Quillfeather", "90000", "example.com"]) expect(body).not.toContain(forbidden);

    const regenerated = await createFeed(asStaff);
    expect((await read(`${token}.ics`)).status).toBe(404);
    const newToken = regenerated.url.split("/").pop()!.replace(/\.ics$/, "");
    expect((await read(newToken)).status).toBe(200);
    await revokeFeed(asStaff);
    expect((await read(newToken)).status).toBe(404);
    expect((await read("not-a-token")).status).toBe(404);
  });

  it("(d) a revoked login shows Needs reconnecting, tells the person, forgets that calendar's busy time, and booking still works", async () => {
    expect(await slotsAt(18)).toBe(false);
    google.revoke();
    await pushGoogle(google.channelsFor("personal")[0]!.channelId, 200);
    await drain();
    const overview = await getCalendarOverview(asStaff);
    expect(overview.connections.find((connection) => connection.provider === "google")).toMatchObject({ status: "needs_reconnect", lastErrorCode: "revoked" });
    const alerts = await owner<{ title: string }[]>`select title from staff_notifications where tenant_id = ${tenantA} and membership_id = ${staffMembership} and title like '%reconnecting%'`;
    expect(alerts).toHaveLength(1);
    // Availability falls back to Kalendr's own data, so the slot the dead calendar blocked is open and bookable.
    expect(await slotsAt(18)).toBe(true);
    expect(await getExternalBusy(practitionerId, { from: new Date(at(9)), to: new Date(at(23)) }, { tenantId: tenantA })).toEqual([]);
    await expect(book(18)).resolves.toBeTypeOf("string");
    // Outlook is untouched by Google's trouble.
    expect(overview.connections.find((connection) => connection.provider === "microsoft")?.status).toBe("active");

    // Reconnecting with a working login brings it back.
    google.restore();
    await saveConnection(asStaff, staffMembership, "google", "stylist@example.test", {
      kind: "oauth", provider: "google", refreshToken: "refresh-secret-2", accessToken: "access-2", expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await drain();
    expect((await getCalendarOverview(asStaff)).connections.find((connection) => connection.provider === "google")?.status).toBe("active");
    // Busy time is read again from scratch, not from the old position, so what was forgotten comes back.
    expect((await owner`select count(*)::int as count from external_busy where tenant_id = ${tenantA} and source_event_id = 'race'`)[0]!.count).toBe(1);
    expect(await getExternalBusy(practitionerId, { from: new Date(at(17)), to: new Date(at(20)) }, { tenantId: tenantA })).toEqual([{ startsAt: new Date(at(18)), endsAt: new Date(at(19)) }]);
  });

  it("saves a refreshed token even when the call that refreshed it then fails", async () => {
    const sel = await selection("google", "personal");
    const [before] = await owner<{ credentials_ciphertext: string }[]>`select credentials_ciphertext from calendar_connections where id = ${sel.connection_id}`;
    failWithRefresh = true;
    await owner`insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
      values (${tenantA}, 'calendar_selection', ${sel.id}, 'calendar.sync', ${owner.json({ selectionId: sel.id })}, ${`test.refresh:${randomUUID()}`})`;
    await drain();
    failWithRefresh = false;
    // The adapter reported the refresh on the failed call; the handler returned a retry instead of throwing, so it was kept.
    const [after] = await owner<{ credentials_ciphertext: string }[]>`select credentials_ciphertext from calendar_connections where id = ${sel.connection_id}`;
    expect(after!.credentials_ciphertext).not.toBe(before!.credentials_ciphertext);
  });

  it("moves calendar logins onto the business's new key when it is rotated, and they still open", async () => {
    const [before] = await owner<{ key_version: number }[]>`select min(key_version) as key_version from calendar_connections where tenant_id = ${tenantA}`;
    await worker.begin(async (tenantDb) => {
      await tenantDb`select set_config('app.tenant_id', ${tenantA}, true)`;
      await rotateTenantKey(tenantDb, tenantA, "admin");
    });
    for (let round = 0; round < 3; round += 1) {
      await worker.begin(async (tenantDb) => {
        await tenantDb`select set_config('app.tenant_id', ${tenantA}, true)`;
        const store = { get: async () => sealBytes(tenantA, Buffer.from("x")), replace: async () => undefined } as unknown as FileStore;
        return reEncryptTenant(tenantDb, tenantA, { store });
      });
    }
    const [after] = await owner<{ key_version: number }[]>`select min(key_version) as key_version from calendar_connections where tenant_id = ${tenantA}`;
    expect(after!.key_version).toBeGreaterThan(before!.key_version);
    // A read with the re-sealed login still works.
    const sel = await selection("google", "personal");
    google.addEvent("personal", { id: "after-rotation", startsAt: at(20), endsAt: at(21) });
    await owner`insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
      values (${tenantA}, 'calendar_selection', ${sel.id}, 'calendar.sync', ${owner.json({ selectionId: sel.id })}, ${`test.rotate:${randomUUID()}`})`;
    await drain();
    expect(await slotsAt(20)).toBe(false);
  });

  it("disconnecting hides the account at once, drops its busy time, and the worker then deletes everything saved from it", async () => {
    const sel = await selection("google", "personal");
    expect((await owner`select count(*)::int as count from external_busy where tenant_id = ${tenantA} and selection_id = ${sel.id}`)[0]!.count).toBeGreaterThan(0);
    await expect(disconnectCalendar(asOwner, sel.connection_id)).rejects.toMatchObject({ status: 404 });
    const overview = await disconnectCalendar(asStaff, sel.connection_id);
    expect(overview.connections.some((connection) => connection.provider === "google")).toBe(false);
    expect((await owner`select count(*)::int as count from external_busy where tenant_id = ${tenantA} and selection_id = ${sel.id}`)[0]!.count).toBe(0);
    await drain();
    expect((await owner`select count(*)::int as count from calendar_connections where id = ${sel.connection_id}`)[0]!.count).toBe(0);
    expect(google.channelsFor("personal")).toHaveLength(0);
    expect(await slotsAt(20)).toBe(true);
    const audits = await owner<{ action: string }[]>`select action from audit_events where tenant_id = ${tenantA} and action like 'calendar.%'`;
    expect(audits.map((row) => row.action)).toEqual(expect.arrayContaining(["calendar.connected", "calendar.selection_changed", "calendar.disconnected", "calendar.event_text_changed", "calendar.feed_created"]));
  });

  it("keeps business B out of business A's calendar rows, in reads and in writes", async () => {
    const runtime = postgres(runtimeUrl!, { max: 1, prepare: false });
    try {
      const tables = ["calendar_connections", "calendar_selections", "external_busy", "appointment_event_links", "calendar_webhook_events", "calendar_feed_tokens", "calendar_conflicts", "calendar_business_settings"];
      for (const table of tables) {
        const rows = await runtime.begin(async (transaction) => {
          await transaction`select set_config('app.tenant_id', ${tenantB}, true)`;
          return transaction.unsafe(`select id from ${table}`);
        });
        expect(rows, table).toHaveLength(0);
      }
      await expect(runtime.begin(async (transaction) => {
        await transaction`select set_config('app.tenant_id', ${tenantB}, true)`;
        await transaction`insert into calendar_business_settings (tenant_id, event_text) values (${tenantA}, 'full')`;
      })).rejects.toThrow();
      // The narrow lookup functions return ids only, and nothing for an address that is not a real channel or feed.
      const lookups = await runtime`select * from kalendr_resolve_calendar_channel('nope')`;
      expect(lookups).toHaveLength(0);
      expect(await runtime`select * from kalendr_resolve_calendar_feed('nope')`).toHaveLength(0);
    } finally {
      await runtime.end();
    }
  });

  it("the web app's role may not run the worker's calendar job lookup", async () => {
    const runtime = postgres(runtimeUrl!, { max: 1, prepare: false });
    try {
      await expect(runtime`select * from kalendr_calendar_tenants('renew')`).rejects.toThrow();
    } finally {
      await runtime.end();
    }
  });

  it("signs in through a state tied to this browser and this person, with test accounts, and the owner sees everyone's status but cannot change it", async () => {
    process.env.CALENDAR_PROVIDER_MODE = "fake";
    try {
      const begun = beginConnect(asStaff, "microsoft");
      const redirect = new URL(begun.redirectTo);
      expect(redirect.pathname).toBe("/api/staff/calendars/callback/microsoft");
      const state = redirect.searchParams.get("state");
      const code = redirect.searchParams.get("code");
      // Pasted into another browser, or answered by another staff member, it is refused.
      await expect(finishConnect(asStaff, "microsoft", { code, state, cookieNonce: "another-browsers-cookie" })).rejects.toMatchObject({ status: 400, code: "invalid_state" });
      await expect(finishConnect(asOwner, "microsoft", { code, state, cookieNonce: begun.nonce })).rejects.toMatchObject({ status: 400, code: "invalid_state" });
      await expect(finishConnect(asStaff, "microsoft", { code: "bad-code", state, cookieNonce: begun.nonce })).rejects.toMatchObject({ code: "provider_refused" });
      const { connectionId } = await finishConnect(asStaff, "microsoft", { code, state, cookieNonce: begun.nonce });
      const [row] = await owner<{ status: string; provider: string }[]>`select status, provider from calendar_connections where id = ${connectionId}`;
      expect(row).toEqual({ status: "pending", provider: "microsoft" });

      // The owner sees it, read-only, and a person without calendar rights sees nothing at all.
      const seen = (await getCalendarOverview(asOwner)).connections.find((connection) => connection.id === connectionId);
      expect(seen).toMatchObject({ mine: false, provider: "microsoft" });
      await expect(disconnectCalendar(asOwner, connectionId)).rejects.toMatchObject({ status: 404 });
      expect((await getCalendarOverview(asOwner)).canManageSettings).toBe(true);
      expect((await getCalendarOverview(asStaff)).canManageSettings).toBe(false);
      await expect(getCalendarOverview({ ...asStaff, permissions: [] })).rejects.toMatchObject({ status: 403 });

      // A fourth account is refused with a plain message.
      await saveConnection(asStaff, staffMembership, "apple", "one@icloud.test", { kind: "caldav", provider: "apple", serverUrl: "https://caldav.icloud.com", username: "one@icloud.test", appPassword: "abcd-efgh-ijkl-mnop" });
      await expect(saveConnection(asStaff, staffMembership, "apple", "two@icloud.test", { kind: "caldav", provider: "apple", serverUrl: "https://caldav.icloud.com", username: "two@icloud.test", appPassword: "abcd-efgh-ijkl-mnop" }))
        .rejects.toMatchObject({ status: 409, code: "calendar_limit" });
      expect(providerStates().every((provider) => provider.available)).toBe(true);
    } finally {
      process.env.CALENDAR_PROVIDER_MODE = "live";
    }
    expect(providerStates().find((provider) => provider.provider === "google")?.available).toBe(false);
  });
});
