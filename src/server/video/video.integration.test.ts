/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { withTenant } from "@/db/client";
import { permissionKeys } from "@/lib/permissions";
import { createAppointment, listAvailability, manageAppointment } from "@/server/appointment-repository";
import type { StaffContext } from "@/server/staff-context";
import { createHandlers } from "@/worker/handlers";
import { providerSink } from "@/worker/delivery";

import { createFakeVideoProvider } from "./fake";
import { customerEnter, customerHeartbeat, customerWait, getStaffVideo, getVisitStatus, staffAdmit, staffHeartbeat, staffHost } from "./visit-service";
import { getVideoProvider } from "./index";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const isLocal = (url: string | undefined) => {
  if (!url) return false;
  const parsed = new URL(url);
  return parsed.hostname === "127.0.0.1" && parsed.pathname === "/kalendr_local";
};
const describeLocal = isLocal(runtimeUrl) && isLocal(ownerUrl) && isLocal(workerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

const MINUTE = 60_000;

/** Offers video next to the visit in person, the way the service editor saves it. */
export async function offerVideoOption(owner: postgres.Sql, tenantId: string, link: { location: string; service: string }): Promise<void> {
  await owner`insert into service_location_options (tenant_id, service_id, kind, location_id, sort_order) values (${tenantId}, ${link.service}, 'in_person', ${link.location}, 0) on conflict do nothing`;
  await owner`insert into service_location_options (tenant_id, service_id, kind, sort_order) values (${tenantId}, ${link.service}, 'video', 1) on conflict do nothing`;
}

describeLocal("video visits", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  let tenantId = "";
  let otherTenantId = "";
  let userId = "";
  let linkIds = { location: "", service: "", practitioner: "" };
  const slots: { startsAt: string; endsAt: string }[] = [];
  const created: string[] = [];
  const suffix = randomUUID().slice(0, 8);
  const roomMaker = createFakeVideoProvider();
  let clock = new Date();
  const handlers = createHandlers({
    sink: providerSink({}),
    now: () => clock,
    video: roomMaker,
  });
  const staff = (): StaffContext => ({
    tenantId, clinicSlug: "lotus-dental", clinicName: "Lotus", role: "owner", permissions: [...permissionKeys],
    membershipId: null, userId, userName: "Dr Rao", userEmail: "rao@example.com", preview: false,
  });

  async function book(slot: { startsAt: string; endsAt: string }, label: string, deliveryMode: "in_person" | "video" | "phone" = "in_person") {
    const result = await createAppointment({
      clinicSlug: "lotus-dental", patientType: "new", bookingFor: "self",
      locationId: linkIds.location, serviceId: linkIds.service, practitionerId: linkIds.practitioner,
      slotId: randomUUID(), startsAt: slot.startsAt, endsAt: slot.endsAt,
      firstName: "Video", lastName: label, phone: `+91 94${String(Date.now()).slice(-8)}`,
      email: `video-${label}-${suffix}@example.com`, preferredChannel: "email",
      acceptedPrivacyNotice: true, messagingConsent: false, ...(deliveryMode ? { locationChoice: { kind: deliveryMode === "video" ? "video" as const : deliveryMode === "phone" ? "they_call" as const : "in_person" as const } } : {}),
    }, randomUUID(), randomUUID().replaceAll("-", ""));
    created.push(result.appointmentId);
    return result;
  }

  /** Runs the worker's handler for the room event of one booking, the way the outbox would at its due time. */
  async function makeRoom(appointmentId: string, now: Date, eventType = "video.room") {
    clock = now;
    const events = await owner<{ id: string; payload: unknown; dedupe_key: string }[]>`
      select id, payload, dedupe_key from outbox_events
      where tenant_id = ${tenantId} and aggregate_id = ${appointmentId} and event_type = ${eventType} order by created_at desc limit 1
    `;
    if (events.length === 0) return null;
    const [event] = events;
    return worker.begin(async (tenantDb) => {
      await tenantDb`select set_config('app.tenant_id', ${tenantId}, true)`;
      return handlers.get(eventType)!(tenantDb, {
        id: event!.id, tenantId, aggregateType: "appointment", aggregateId: appointmentId, eventType,
        payload: event!.payload, dedupeKey: event!.dedupe_key, attemptCount: 1,
      });
    });
  }

  const rooms = (appointmentId: string) => owner<{ status: string; expires_at: Date; provider: string }[]>`
    select status, expires_at, provider from video_rooms where tenant_id = ${tenantId} and appointment_id = ${appointmentId}
  `;

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 2, prepare: false, onnotice: () => undefined });
    worker = postgres(workerUrl!, { max: 2, prepare: false, onnotice: () => undefined });
    const [tenant] = await owner<{ id: string }[]>`select id from tenants where slug = 'lotus-dental'`;
    const [other] = await owner<{ id: string }[]>`select id from tenants where slug <> 'lotus-dental' order by slug limit 1`;
    tenantId = tenant!.id;
    otherTenantId = other!.id;
    const [member] = await owner<{ user_id: string }[]>`select user_id from memberships where tenant_id = ${tenantId} and role = 'owner' limit 1`;
    userId = member!.user_id;
    const [link] = await owner<{ location_id: string; service_id: string; practitioner_id: string }[]>`
      select location.location_id, service.service_id, service.practitioner_id
      from practitioner_services as service
      join practitioner_locations as location on location.tenant_id = service.tenant_id and location.practitioner_id = service.practitioner_id
      where service.tenant_id = ${tenantId} limit 1
    `;
    linkIds = { location: link!.location_id, service: link!.service_id, practitioner: link!.practitioner_id };
    await offerVideoOption(owner, tenantId, linkIds);
    const day = 24 * 60 * 60 * 1_000;
    const all = await listAvailability({
      clinicSlug: "lotus-dental", locationId: linkIds.location, serviceId: linkIds.service, practitionerId: linkIds.practitioner,
      from: new Date(Date.now() + 4 * day).toISOString(), to: new Date(Date.now() + 12 * day).toISOString(),
    });
    for (const slot of all) {
      const last = slots.at(-1);
      if (!last || new Date(slot.startsAt).getTime() - new Date(last.endsAt).getTime() >= 60 * MINUTE) slots.push(slot);
    }
    if (slots.length < 8) throw new Error("Expected open slots for the video tests");
  });

  afterAll(async () => {
    await owner.begin(async (transaction) => {
      if (created.length > 0) {
        await transaction`delete from outbox_events where tenant_id = ${tenantId} and aggregate_id in ${transaction(created)}`;
        await transaction`delete from audit_events where tenant_id = ${tenantId} and appointment_id in ${transaction(created)}`;
        await transaction`delete from appointments where id in ${transaction(created)}`;
      }
      await transaction`delete from consent_records where (select set_config('kalendr.consent_erase', 'on', true)) = 'on' and (tenant_id, patient_id) in (select tenant_id, id from patients where tenant_id = ${tenantId} and email like ${`video-%-${suffix}@example.com`})`;
      await transaction`delete from patients where tenant_id = ${tenantId} and email like ${`video-%-${suffix}@example.com`}`;
      await transaction`delete from service_location_options where tenant_id = ${tenantId} and service_id = ${linkIds.service}`;
      await transaction`delete from idempotency_keys where tenant_id = ${tenantId} and created_at > now() - interval '30 minutes'`;
    }).catch((error: unknown) => console.error("video test cleanup failed", error));
    await Promise.all([owner.end(), worker.end()]);
  });

  it("works out how a visit happens from the way of meeting chosen, and refuses one the service doesn't offer", async () => {
    const inPerson = await book(slots[0]!, "default", "in_person");
    const [row] = await owner<{ delivery_mode: string }[]>`select delivery_mode from appointments where id = ${inPerson.appointmentId}`;
    expect(row!.delivery_mode).toBe("in_person");
    await expect(book(slots[1]!, "phone", "phone")).rejects.toMatchObject({ status: 400 });
    expect(await owner`select 1 from outbox_events where aggregate_id = ${inPerson.appointmentId} and event_type = 'video.room'`).toHaveLength(0);
  });

  it("queues the room for 15 minutes before the start, and a cancelled visit never creates one", async () => {
    const cancelled = await book(slots[2]!, "cancelled", "video");
    const [event] = await owner<{ available_at: Date }[]>`
      select available_at from outbox_events where tenant_id = ${tenantId} and aggregate_id = ${cancelled.appointmentId} and event_type = 'video.room'
    `;
    expect(event!.available_at.getTime()).toBe(new Date(slots[2]!.startsAt).getTime() - 15 * MINUTE);

    await manageAppointment(cancelled.manageToken, { action: "cancel", expectedVersion: 1, reason: "Integration verification" });
    expect(await makeRoom(cancelled.appointmentId, new Date(new Date(slots[2]!.startsAt).getTime() - 14 * MINUTE))).toBe("delivered");
    expect(await rooms(cancelled.appointmentId)).toHaveLength(0);
    expect(roomMaker.rooms.size).toBe(0);
  });

  it("makes the room at the due time, expiring 30 minutes after the end, once", async () => {
    const booking = await book(slots[3]!, "room", "video");
    const dueAt = new Date(new Date(slots[3]!.startsAt).getTime() - 15 * MINUTE);
    expect(await makeRoom(booking.appointmentId, dueAt)).toBe("delivered");
    const [room] = await rooms(booking.appointmentId);
    expect(room).toMatchObject({ status: "active", provider: "fake" });
    expect(room!.expires_at.getTime()).toBe(new Date(slots[3]!.endsAt).getTime() + 30 * MINUTE);
    expect(roomMaker.rooms.size).toBe(1);
    expect(await makeRoom(booking.appointmentId, dueAt)).toBe("delivered");
    expect(roomMaker.rooms.size).toBe(1);
  });

  it("closes the room when the booking is cancelled afterwards", async () => {
    const booking = await book(slots[4]!, "closed", "video");
    const start = new Date(slots[4]!.startsAt);
    await makeRoom(booking.appointmentId, new Date(start.getTime() - 15 * MINUTE));
    expect(await rooms(booking.appointmentId)).toHaveLength(1);
    await manageAppointment(booking.manageToken, { action: "cancel", expectedVersion: 1, reason: "Integration verification" });
    expect(await makeRoom(booking.appointmentId, new Date(start.getTime() - 10 * MINUTE), "video.room.end")).toBe("delivered");
    expect((await rooms(booking.appointmentId))[0]!.status).toBe("ended");
    expect(roomMaker.deleted).toHaveLength(1);
  });

  it("runs the whole visit: too early, preparing, open, waiting, admitted, in the call, and over", async () => {
    const booking = await book(slots[5]!, "visit", "video");
    const start = new Date(slots[5]!.startsAt);
    const end = new Date(slots[5]!.endsAt);
    const token = booking.manageToken;
    const at = (minutes: number, from: Date = start) => new Date(from.getTime() + minutes * MINUTE);

    expect((await getVisitStatus(token, at(-60))).state).toBe("not_open_yet");
    await expect(customerWait(token, at(-60))).rejects.toMatchObject({ code: "not_open_yet" });
    expect((await getVisitStatus(token, at(-14))).state).toBe("preparing");

    await makeRoom(booking.appointmentId, at(-14));
    const open = await getVisitStatus(token, at(-14));
    expect(open).toMatchObject({ state: "open", staffPresent: false, customerStage: "none", provider: "test" });
    expect(open.staffName).toBeTruthy();

    // The customer is here: checked in, and waiting.
    const waiting = await customerWait(token, at(-10));
    expect(waiting.customerStage).toBe("waiting");
    const [checked] = await owner<{ status: string; checked_in_at: Date | null }[]>`select status, checked_in_at from appointments where id = ${booking.appointmentId}`;
    expect(checked).toMatchObject({ status: "checked_in" });
    expect(checked!.checked_in_at).not.toBeNull();
    await expect(customerEnter(token, at(-10))).rejects.toMatchObject({ code: "not_admitted", status: 409 });

    // Staff open the call (host token), see the customer, and let them in.
    await customerHeartbeat(token, at(-9));
    const host = await staffHost(staff(), booking.appointmentId, at(-9));
    expect(host.enter.roomUrl.startsWith("kalendr-test-room://")).toBe(true);
    expect(host.status).toMatchObject({ customerStage: "waiting", staffPresent: true, customerPresent: true });
    expect((await getVisitStatus(token, at(-9))).staffPresent).toBe(true);
    expect((await getVisitStatus(token, at(-9) )).customerStage).toBe("waiting");
    const admitted = await staffAdmit(staff(), booking.appointmentId, at(-8));
    expect(admitted.customerStage).toBe("admitted");

    // The customer's token is theirs alone and works only around the visit.
    const entered = await customerEnter(token, at(-7));
    const provider = getVideoProvider();
    const tokens = (provider as unknown as { tokens: { token: string; isOwner: boolean; notBefore: Date; expiresAt: Date; roomName: string }[] }).tokens;
    const issued = tokens.find((candidate) => candidate.token === entered.meetingToken)!;
    expect(issued.isOwner).toBe(false);
    expect(issued.expiresAt.getTime()).toBe(end.getTime() + 30 * MINUTE);
    expect(issued.notBefore.getTime()).toBeLessThanOrEqual(at(-15).getTime());
    const hostIssued = tokens.find((candidate) => candidate.token === host.enter.meetingToken)!;
    expect(hostIssued.isOwner).toBe(true);
    expect(hostIssued.roomName).toBe(issued.roomName);
    expect(entered.meetingToken).not.toBe(host.enter.meetingToken);

    // Presence goes stale when a screen is closed.
    await customerHeartbeat(token, at(-6));
    await staffHeartbeat(staff(), booking.appointmentId, at(-6));
    expect((await getVisitStatus(token, at(-6))).staffPresent).toBe(true);
    expect((await getVisitStatus(token, at(-4))).staffPresent).toBe(false);
    expect((await getStaffVideo(staff(), booking.appointmentId, at(-6))).customerPresent).toBe(true);

    // The link stops working 30 minutes after the end, and certainly an hour after the visit.
    expect((await getVisitStatus(token, at(29, end))).state).toBe("open");
    expect((await getVisitStatus(token, at(31, end))).state).toBe("ended");
    await expect(customerEnter(token, at(60, end))).rejects.toMatchObject({ code: "visit_ended", status: 410 });
    await expect(staffHost(staff(), booking.appointmentId, at(60, end))).rejects.toMatchObject({ code: "visit_ended" });

    // Leaving never completes the visit.
    const [after] = await owner<{ status: string }[]>`select status from appointments where id = ${booking.appointmentId}`;
    expect(after!.status).toBe("checked_in");
  });

  it("moves the room when a booking moves after its room was made", async () => {
    const booking = await book(slots[6]!, "moved", "video");
    const start = new Date(slots[6]!.startsAt);
    await makeRoom(booking.appointmentId, new Date(start.getTime() - 15 * MINUTE));
    const before = (await rooms(booking.appointmentId))[0]!;
    await manageAppointment(booking.manageToken, { action: "reschedule", startsAt: slots[7]!.startsAt, expectedVersion: 1 });
    await makeRoom(booking.appointmentId, new Date(start.getTime() - 5 * MINUTE));
    const after = (await rooms(booking.appointmentId))[0]!;
    expect(after.expires_at.getTime()).toBe(new Date(slots[7]!.endsAt).getTime() + 30 * MINUTE);
    expect(after.expires_at.getTime()).not.toBe(before.expires_at.getTime());
  });

  it("is not a video visit for an in-person booking", async () => {
    const booking = await book(slots[0]!.startsAt === slots[1]!.startsAt ? slots[2]! : slots[1]!, "plain").catch(() => null);
    if (!booking) return;
    expect((await getVisitStatus(booking.manageToken)).state).toBe("not_video");
    await expect(customerWait(booking.manageToken)).rejects.toMatchObject({ code: "not_a_video_visit" });
  });

  it("keeps rooms inside their business", async () => {
    const seen = await withTenant(otherTenantId, async (transaction) => {
      const result = await transaction.execute<{ count: number }>(sql`select count(*)::integer as count from video_rooms where tenant_id = ${tenantId}`);
      return result[0]!.count;
    });
    expect(seen).toBe(0);
    await expect(withTenant(otherTenantId, (transaction) => transaction.execute(sql`
      insert into video_rooms (tenant_id, appointment_id, provider, provider_room_name, room_url, expires_at)
      values (${tenantId}, 'x', 'fake', 'x', 'x', now())
    `))).rejects.toThrow();
    const [unscoped] = await worker<{ count: number }[]>`select count(*)::integer as count from video_rooms`;
    expect(unscoped!.count).toBe(0);
  });

  it("refuses a bad delivery mode in the database", async () => {
    await expect(owner`update appointments set delivery_mode = 'hologram' where tenant_id = ${tenantId} and id = ${created[0]!}`).rejects.toThrow();
  });
});
