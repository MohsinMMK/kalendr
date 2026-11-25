import "server-only";

import { sql } from "drizzle-orm";

import { withTenant, type KalendrTransaction } from "@/db/client";
import type {
  CustomerStage,
  StaffVideoHostView,
  StaffVideoView,
  VideoProviderMode,
  VisitEnterView,
  VisitStatusView,
} from "@/lib/video-contracts";

import { ApiError } from "../api-error";
import { assertAppointmentVisibleHere } from "../location-scope";
import { resolveManageToken } from "../appointment-repository";
import { can, type StaffContext } from "../staff-context";
import { planAppointment } from "../workflows/engine";
import { drizzleRunner } from "../workflows/runner";
import { getVideoProvider, videoMode } from "./index";
import type { VideoProvider } from "./provider";
import { customerStage, isPresent, visitState, visitWindow } from "./rules";

/**
 * Joining a video visit. The customer's page proves who they are with the booking's own link; staff use their
 * sign-in. Both only get a meeting token for the visit window, one token per person, and the customer's token is
 * only given after staff let them in. The room itself is made by the worker, never here.
 *
 * Making a token calls the video provider inside the request. That is a deliberate exception to "no outside call
 * in a request": the person is waiting to join, nothing is half-done if it fails, and the answer cannot be made earlier.
 */

interface VisitRow extends Record<string, unknown> {
  appointment_id: string;
  status: string;
  delivery_mode: string;
  starts_at: Date;
  ends_at: Date;
  customer_first_name: string;
  staff_name: string;
  service_name: string;
  business_name: string;
  business_phone: string | null;
  room_id: string | null;
  room_status: string | null;
  room_url: string | null;
  room_name: string | null;
  staff_seen_at: Date | null;
  customer_seen_at: Date | null;
  customer_waiting_at: Date | null;
  customer_admitted_at: Date | null;
}

async function loadVisit(transaction: KalendrTransaction, tenantId: string, appointmentId: string, lock: boolean): Promise<VisitRow> {
  const rows = await transaction.execute<VisitRow>(sql`
    select appointment.id as appointment_id, appointment.status, appointment.delivery_mode, appointment.starts_at, appointment.ends_at,
      patient.first_name as customer_first_name, practitioner.name as staff_name, service.name as service_name,
      tenant.name as business_name, tenant.phone as business_phone,
      room.id as room_id, room.status as room_status, room.room_url, room.provider_room_name as room_name,
      room.staff_seen_at, room.customer_seen_at, room.customer_waiting_at, room.customer_admitted_at
    from appointments as appointment
    join patients as patient on patient.tenant_id = appointment.tenant_id and patient.id = appointment.patient_id
    join practitioners as practitioner on practitioner.tenant_id = appointment.tenant_id and practitioner.id = appointment.practitioner_id
    join services as service on service.tenant_id = appointment.tenant_id and service.id = appointment.service_id
    join tenants as tenant on tenant.id = appointment.tenant_id
    left join video_rooms as room on room.tenant_id = appointment.tenant_id and room.appointment_id = appointment.id
    where appointment.tenant_id = ${tenantId} and appointment.id = ${appointmentId}
    ${lock ? sql`for update of appointment` : sql``}
  `);
  const row = rows[0];
  if (!row) throw new ApiError(404, "appointment_not_found", "Appointment not found.");
  return row;
}

const dateOf = (value: Date | string | null): Date | null => (value === null ? null : value instanceof Date ? value : new Date(value));

function providerMode(): VideoProviderMode {
  return videoMode() === "daily" ? "daily" : "test";
}

function derive(row: VisitRow, now: Date) {
  const startsAt = dateOf(row.starts_at)!;
  const endsAt = dateOf(row.ends_at)!;
  const window = visitWindow(startsAt, endsAt);
  const room = row.room_id && row.room_status === "active"
    ? {
      customerWaitingAt: dateOf(row.customer_waiting_at), customerAdmittedAt: dateOf(row.customer_admitted_at),
      staffSeenAt: dateOf(row.staff_seen_at), customerSeenAt: dateOf(row.customer_seen_at),
    }
    : null;
  const state = videoMode() === "off" && row.delivery_mode === "video" ? "ended" as const : visitState({
    deliveryMode: row.delivery_mode, status: row.status, window, roomActive: room !== null, now,
  });
  return { startsAt, endsAt, window, room, state };
}

function customerView(row: VisitRow, now: Date): VisitStatusView {
  const { startsAt, endsAt, window, room, state } = derive(row, now);
  return {
    state,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    opensAt: window.opensAt.toISOString(),
    closesAt: window.closesAt.toISOString(),
    businessName: row.business_name,
    businessPhone: row.business_phone,
    serviceName: row.service_name,
    staffName: row.staff_name,
    customerFirstName: row.customer_first_name,
    staffPresent: isPresent(room?.staffSeenAt ?? null, now),
    customerStage: customerStage(room),
    provider: providerMode(),
  };
}

function staffView(row: VisitRow, now: Date): StaffVideoView {
  const { startsAt, endsAt, window, room, state } = derive(row, now);
  return {
    state,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    opensAt: window.opensAt.toISOString(),
    closesAt: window.closesAt.toISOString(),
    provider: providerMode(),
    customerFirstName: row.customer_first_name,
    customerStage: customerStage(room),
    customerPresent: isPresent(room?.customerSeenAt ?? null, now),
    staffPresent: isPresent(room?.staffSeenAt ?? null, now),
    businessPhone: row.business_phone,
  };
}

async function resolveToken(token: string): Promise<{ tenantId: string; appointmentId: string }> {
  const resolved = await resolveManageToken(token);
  if (!resolved) throw new ApiError(404, "appointment_not_found", "That link isn't valid. Check the message you were sent, or phone the business.");
  return { tenantId: resolved.tenant_id, appointmentId: resolved.appointment_id };
}

function requireOpen(state: string): void {
  if (state === "not_video") throw new ApiError(409, "not_a_video_visit", "This visit isn't a video call.");
  if (state === "cancelled") throw new ApiError(409, "visit_cancelled", "This visit was cancelled.");
  if (state === "not_open_yet") throw new ApiError(409, "not_open_yet", "The call opens 15 minutes before the visit.");
  if (state === "ended") throw new ApiError(410, "visit_ended", "This visit is over, so the link no longer works.");
  if (state === "preparing") throw new ApiError(409, "room_not_ready", "The room is being made. Try again in a moment.");
}

async function mintToken(provider: VideoProvider, input: {
  roomName: string; isOwner: boolean; displayName: string; window: { opensAt: Date; closesAt: Date }; now: Date;
}): Promise<{ token: string; expiresAt: Date }> {
  // Valid for the visit window only: from 15 minutes before the start (or now, if that is later) to 30 minutes after the end.
  const notBefore = new Date(Math.min(input.now.getTime(), input.window.opensAt.getTime()) - 60_000);
  const { token } = await provider.createToken({
    roomName: input.roomName, isOwner: input.isOwner, displayName: input.displayName, notBefore, expiresAt: input.window.closesAt,
  });
  return { token, expiresAt: input.window.closesAt };
}

function providerOrThrow(): VideoProvider {
  const provider = getVideoProvider();
  if (!provider) throw new ApiError(503, "video_unavailable", "Video calls aren't available right now. Please phone the business.");
  return provider;
}

export async function getVisitStatus(token: string, now: Date = new Date()): Promise<VisitStatusView> {
  const { tenantId, appointmentId } = await resolveToken(token);
  return withTenant(tenantId, async (transaction) => customerView(await loadVisit(transaction, tenantId, appointmentId, false), now));
}

/** The customer is here: the booking is checked in and they wait for staff to let them in. */
export async function customerWait(token: string, now: Date = new Date()): Promise<VisitStatusView> {
  const { tenantId, appointmentId } = await resolveToken(token);
  return withTenant(tenantId, async (transaction) => {
    const row = await loadVisit(transaction, tenantId, appointmentId, true);
    requireOpen(derive(row, now).state);
    await transaction.execute(sql`
      update video_rooms set customer_waiting_at = coalesce(customer_waiting_at, ${now.toISOString()}::timestamptz), customer_seen_at = ${now.toISOString()}::timestamptz, updated_at = now()
      where tenant_id = ${tenantId} and appointment_id = ${appointmentId}
    `);
    await checkIn(transaction, tenantId, appointmentId, row.status, now);
    return customerView(await loadVisit(transaction, tenantId, appointmentId, false), now);
  });
}

/** Joining marks the booking checked in. Leaving never completes it: staff do that. */
async function checkIn(transaction: KalendrTransaction, tenantId: string, appointmentId: string, status: string, now: Date): Promise<void> {
  if (status !== "booked") return;
  const [updated] = await transaction.execute<{ version: number }>(sql`
    update appointments set status = 'checked_in', checked_in_at = coalesce(checked_in_at, ${now.toISOString()}::timestamptz), version = version + 1, updated_at = now()
    where tenant_id = ${tenantId} and id = ${appointmentId} and status = 'booked'
    returning version
  `);
  if (!updated) return;
  await transaction.execute(sql`
    insert into audit_events (tenant_id, appointment_id, actor_type, action, outcome, metadata)
    values (${tenantId}, ${appointmentId}, 'patient', 'appointment.status.checked_in', 'success', jsonb_build_object('source', 'video', 'version', ${updated.version}::int))
  `);
  await transaction.execute(sql`
    insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
    values (${tenantId}, 'appointment', ${appointmentId}, 'appointment.status.checked_in',
      jsonb_build_object('appointmentId', ${appointmentId}::text, 'version', ${updated.version}::int),
      ${`appointment.status.checked_in:${appointmentId}:${updated.version}`})
    on conflict (tenant_id, dedupe_key) do nothing
  `);
  await planAppointment(drizzleRunner(transaction), tenantId, appointmentId, { action: "appointment.status.checked_in", version: updated.version }, now);
}

export async function customerHeartbeat(token: string, now: Date = new Date()): Promise<VisitStatusView> {
  const { tenantId, appointmentId } = await resolveToken(token);
  return withTenant(tenantId, async (transaction) => {
    await transaction.execute(sql`
      update video_rooms set customer_seen_at = ${now.toISOString()}::timestamptz, updated_at = now() where tenant_id = ${tenantId} and appointment_id = ${appointmentId} and status = 'active'
    `);
    return customerView(await loadVisit(transaction, tenantId, appointmentId, false), now);
  });
}

/** Staff let them in first; then this makes the customer's own short-lived token. */
export async function customerEnter(token: string, now: Date = new Date()): Promise<VisitEnterView> {
  const { tenantId, appointmentId } = await resolveToken(token);
  const provider = providerOrThrow();
  const prepared = await withTenant(tenantId, async (transaction) => {
    const row = await loadVisit(transaction, tenantId, appointmentId, true);
    const { state, window, room } = derive(row, now);
    requireOpen(state);
    if (!room?.customerAdmittedAt) throw new ApiError(409, "not_admitted", "Waiting for staff to let you in.");
    return { row, window };
  });
  const { token: meetingToken, expiresAt } = await mintToken(provider, {
    roomName: prepared.row.room_name ?? "", isOwner: false, displayName: prepared.row.customer_first_name, window: prepared.window, now,
  });
  await withTenant(tenantId, (transaction) => transaction.execute(sql`
    update video_rooms set customer_joined_at = coalesce(customer_joined_at, ${now.toISOString()}::timestamptz), customer_seen_at = ${now.toISOString()}::timestamptz, updated_at = now()
    where tenant_id = ${tenantId} and appointment_id = ${appointmentId}
  `));
  return {
    provider: providerMode(), roomUrl: prepared.row.room_url ?? "", meetingToken, expiresAt: expiresAt.toISOString(),
    displayName: prepared.row.customer_first_name,
  };
}

/** A practitioner runs only their own visits; the front desk, admins and owners run any. */
async function requireOwnVisit(transaction: KalendrTransaction, context: StaffContext, appointmentId: string): Promise<void> {
  // A person limited to some locations runs the video visits booked at those locations only, practitioner or not.
  await assertAppointmentVisibleHere(transaction, context, appointmentId);
  if (context.role !== "practitioner") return;
  const rows = await transaction.execute<{ id: string }>(sql`
    select appointment.id from appointments as appointment
    join practitioners as practitioner on practitioner.tenant_id = appointment.tenant_id and practitioner.id = appointment.practitioner_id
    where appointment.tenant_id = ${context.tenantId} and appointment.id = ${appointmentId} and practitioner.auth_user_id = ${context.userId}
  `);
  if (rows.length === 0) throw new ApiError(403, "forbidden", "You can only run your own video visits.");
}

function requireDesk(context: StaffContext): void {
  if (!can(context, "appointments.status") && !can(context, "appointments.book")) {
    throw new ApiError(403, "forbidden", "You don't have permission to run video visits.");
  }
}

export async function getStaffVideo(context: StaffContext, appointmentId: string, now: Date = new Date()): Promise<StaffVideoView> {
  requireDesk(context);
  if (context.preview) throw new ApiError(409, "preview_unavailable", "Video visits aren't available in the preview.");
  return withTenant(context.tenantId, async (transaction) => {
    await requireOwnVisit(transaction, context, appointmentId);
    return staffView(await loadVisit(transaction, context.tenantId, appointmentId, false), now);
  });
}

export async function staffHost(context: StaffContext, appointmentId: string, now: Date = new Date()): Promise<StaffVideoHostView> {
  requireDesk(context);
  if (context.preview) throw new ApiError(409, "preview_unavailable", "Video visits aren't available in the preview.");
  const provider = providerOrThrow();
  const prepared = await withTenant(context.tenantId, async (transaction) => {
    await requireOwnVisit(transaction, context, appointmentId);
    const row = await loadVisit(transaction, context.tenantId, appointmentId, true);
    const { state, window } = derive(row, now);
    requireOpen(state);
    await transaction.execute(sql`
      update video_rooms set staff_joined_at = coalesce(staff_joined_at, ${now.toISOString()}::timestamptz), staff_seen_at = ${now.toISOString()}::timestamptz, updated_at = now()
      where tenant_id = ${context.tenantId} and appointment_id = ${appointmentId}
    `);
    return { row, window };
  });
  const { token, expiresAt } = await mintToken(provider, {
    roomName: prepared.row.room_name ?? "", isOwner: true, displayName: context.userName.slice(0, 80) || prepared.row.staff_name, window: prepared.window, now,
  });
  const status = await getStaffVideo(context, appointmentId, now);
  return {
    status,
    enter: { provider: providerMode(), roomUrl: prepared.row.room_url ?? "", meetingToken: token, expiresAt: expiresAt.toISOString(), displayName: context.userName },
  };
}

export async function staffAdmit(context: StaffContext, appointmentId: string, now: Date = new Date()): Promise<StaffVideoView> {
  requireDesk(context);
  if (context.preview) throw new ApiError(409, "preview_unavailable", "Video visits aren't available in the preview.");
  return withTenant(context.tenantId, async (transaction) => {
    await requireOwnVisit(transaction, context, appointmentId);
    const row = await loadVisit(transaction, context.tenantId, appointmentId, true);
    requireOpen(derive(row, now).state);
    const [admitted] = await transaction.execute<{ id: string }>(sql`
      update video_rooms set customer_admitted_at = coalesce(customer_admitted_at, ${now.toISOString()}::timestamptz), staff_seen_at = ${now.toISOString()}::timestamptz, updated_at = now()
      where tenant_id = ${context.tenantId} and appointment_id = ${appointmentId} and status = 'active' and customer_waiting_at is not null
      returning id
    `);
    if (!admitted) throw new ApiError(409, "nobody_waiting", "Nobody is waiting yet.");
    return staffView(await loadVisit(transaction, context.tenantId, appointmentId, false), now);
  });
}

export async function staffHeartbeat(context: StaffContext, appointmentId: string, now: Date = new Date()): Promise<StaffVideoView> {
  requireDesk(context);
  if (context.preview) throw new ApiError(409, "preview_unavailable", "Video visits aren't available in the preview.");
  return withTenant(context.tenantId, async (transaction) => {
    await requireOwnVisit(transaction, context, appointmentId);
    await transaction.execute(sql`
      update video_rooms set staff_seen_at = ${now.toISOString()}::timestamptz, updated_at = now()
      where tenant_id = ${context.tenantId} and appointment_id = ${appointmentId} and status = 'active'
    `);
    return staffView(await loadVisit(transaction, context.tenantId, appointmentId, false), now);
  });
}

export type { CustomerStage };
