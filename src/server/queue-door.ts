import "server-only";

import { sql, type SQL } from "drizzle-orm";

import { getDatabase, withTenant, type KalendrTransaction } from "@/db/client";
import { auditEvents, outboxEvents, patients } from "@/db/schema";

import { assertBookingAllowed } from "./billing/enforcement";
import { ApiError, getPostgresErrorCode, mapDatabaseError } from "./api-error";
import { createOpaqueToken, sha256 } from "./crypto";
import { isPreviewMode } from "./preview-repository";
import { issueQueueTicket } from "./queue";
import { queueTokenSchema } from "./queue-screens";
import { sendAlmostNext } from "./queue-notify";
import { closeDayInputSchema, doorJoinInputSchema, joinLinkInputSchema, type CloseDayInput, type DoorJoinInput, type JoinLinkInput, type JoinLinkResult, type QueueDayReport, type QueueJoinView } from "@/lib/queue-door-contracts";
import { andLocation, assertLocationAllowed } from "./location-scope";
import { requirePermission, type StaffContext } from "./staff-context";
import { currentTraceParent } from "./tracing";
import { applyFormMessagingConsentIn } from "./privacy/consent";

/**
 * Feature 22 on top of the trunk's queue: the door QR code that lets someone who walked in join from their
 * own phone, and closing the queue for the day. A ticket still always belongs to a visit, so joining from the
 * door records a checked-in walk-in visit and gives it the next token; where the person is from then on is
 * the visit's own status, exactly as for a customer the desk added.
 */

const notFound = () => new ApiError(404, "queue_link_not_found", "This queue link is no longer active.");
const dayClosed = () => new ApiError(409, "queue_day_closed", "The queue is closed for today. Please ask at the front desk.");

function refusePreview(context: StaffContext): void {
  if (context.preview || isPreviewMode()) throw new ApiError(409, "preview_only", "Queue links need the real database.");
}

async function retrySerialization<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error: unknown) {
      const code = getPostgresErrorCode(error);
      if ((code === "40001" || code === "40P01") && attempt < 2) continue;
      throw mapDatabaseError(error) ?? error;
    }
  }
}

interface PlaceRow extends Record<string, unknown> {
  id: string;
  name: string;
  timezone: string;
  day: string;
}

/**
 * The location (the first one when none is named) and today's date there. `scope` is a staff member's location limit
 * (`andLocation`), so a limited person who names no location gets their own first one, never another branch's.
 */
async function placeIn(transaction: KalendrTransaction, tenantId: string, locationId: string | undefined, scope: SQL = sql``): Promise<PlaceRow> {
  const [place] = await transaction.execute<PlaceRow>(sql`
    select id, name, timezone, (now() at time zone timezone)::date::text as day
    from locations
    where tenant_id = ${tenantId} ${locationId ? sql`and id = ${locationId}` : sql``} ${scope}
    order by created_at asc limit 1
  `);
  if (!place) throw new ApiError(404, "location_not_found", "That location could not be found.");
  return place;
}

async function isDayClosed(transaction: KalendrTransaction, tenantId: string, locationId: string, day: string): Promise<boolean> {
  const [counter] = await transaction.execute<{ closed_at: Date | string | null }>(sql`
    select closed_at from queue_counters
    where tenant_id = ${tenantId} and location_id = ${locationId} and day = ${day}
  `);
  return Boolean(counter?.closed_at);
}

// ── Staff: the door link ────────────────────────────────────────────────

/**
 * Makes, replaces or switches the door QR code's link for a location. It lives on the location's live queue
 * row, so it keeps working when the waiting-room screen link is replaced. The link is shown once.
 */
export async function setupJoinLink(context: StaffContext, input: JoinLinkInput): Promise<JoinLinkResult> {
  requirePermission(context, "settings.manage");
  refusePreview(context);
  assertLocationAllowed(context, input.locationId);
  const token = createOpaqueToken();
  return withTenant(context.tenantId, async (transaction) => {
    const place = await placeIn(transaction, context.tenantId, input.locationId, andLocation(context, sql`id`));
    const [live] = await transaction.execute<{ id: string; join_token_hash: string | null; self_join_enabled: boolean }>(sql`
      select id, join_token_hash, self_join_enabled from queue_displays
      where tenant_id = ${context.tenantId} and location_id = ${place.id} and revoked_at is null
      for update
    `);
    const makeLink = input.newLink || !live?.join_token_hash;
    const selfJoinEnabled = input.selfJoinEnabled ?? live?.self_join_enabled ?? true;
    if (live) {
      await transaction.execute(sql`
        update queue_displays
        set self_join_enabled = ${selfJoinEnabled}${makeLink ? sql`, join_token_hash = ${sha256(token)}` : sql``}
        where tenant_id = ${context.tenantId} and id = ${live.id}
      `);
    } else {
      // No waiting-room screen yet: the row needs a screen token, which nobody has. Making the screen link
      // later replaces it, and the door link carries over.
      await transaction.execute(sql`
        insert into queue_displays (tenant_id, location_id, token_hash, join_token_hash, self_join_enabled, created_by_user_id)
        values (${context.tenantId}, ${place.id}, ${sha256(createOpaqueToken())}, ${sha256(token)}, ${selfJoinEnabled}, ${context.userId})
      `);
    }
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff",
      action: makeLink ? "queue.join_link_made" : "queue.join_link_changed", outcome: "success",
      metadata: { locationId: place.id, selfJoinEnabled },
    });
    return { link: makeLink ? { path: `/q/join/${token}` } : null, selfJoinEnabled };
  });
}

// ── Staff: closing the day ──────────────────────────────────────────────

/**
 * Closes the queue for today at a location. Nobody new can join from the door, and everyone still waiting
 * (checked in, not yet in the room) is let go: their visit becomes cancelled, with the same record and
 * message as marking it Left on the visit. Returns the day's numbers.
 */
export async function closeQueueDay(context: StaffContext, input: CloseDayInput): Promise<QueueDayReport> {
  requirePermission(context, "appointments.status");
  refusePreview(context);
  // A limited person closes only their own branch's queue: another branch is refused, and no location means their first.
  assertLocationAllowed(context, input.locationId);
  return retrySerialization(() => withTenant(context.tenantId, async (transaction) => {
    const place = await placeIn(transaction, context.tenantId, input.locationId, andLocation(context, sql`id`));
    await transaction.execute(sql`
      insert into queue_counters (tenant_id, location_id, day, last_number, closed_at, closed_reason)
      values (${context.tenantId}, ${place.id}, ${place.day}, 0, now(), ${input.reason})
      on conflict (tenant_id, location_id, day)
      do update set closed_at = coalesce(queue_counters.closed_at, now()),
        closed_reason = coalesce(queue_counters.closed_reason, ${input.reason})
    `);
    const waiting = await transaction.execute<{ appointment_id: string; version: number }>(sql`
      select appointment.id as appointment_id, appointment.version
      from queue_tickets as ticket
      join appointments as appointment
        on appointment.tenant_id = ticket.tenant_id and appointment.id = ticket.appointment_id
      where ticket.tenant_id = ${context.tenantId} and ticket.location_id = ${place.id} and ticket.day = ${place.day}
        and appointment.status = 'checked_in' and appointment.visit_started_at is null
      for update of appointment
    `);
    for (const row of waiting) {
      const version = Number(row.version) + 1;
      await transaction.execute(sql`
        update resource_reservations set state = 'released', updated_at = now()
        where tenant_id = ${context.tenantId} and appointment_id = ${row.appointment_id}
      `);
      await transaction.execute(sql`
        update appointments set status = 'cancelled', cancelled_at = now(), version = ${version}, updated_at = now()
        where tenant_id = ${context.tenantId} and id = ${row.appointment_id}
      `);
      await transaction.insert(auditEvents).values({
        tenantId: context.tenantId, appointmentId: row.appointment_id, actorUserId: context.userId, actorType: "staff",
        action: "appointment.status.cancelled", outcome: "success", metadata: { version, via: "queue_day_closed" },
      });
      await transaction.insert(outboxEvents).values({
        tenantId: context.tenantId,
        aggregateType: "appointment",
        aggregateId: row.appointment_id,
        eventType: "appointment.status.cancelled",
        payload: { appointmentId: row.appointment_id, version },
        dedupeKey: `appointment.status.cancelled:${row.appointment_id}:${version}`,
        traceParent: currentTraceParent(),
      });
    }
    const report = await dayReport(transaction, context.tenantId, place.id, place.day);
    // Free text stays out of the audit trail: the reason is kept on the counter row.
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "queue.day_closed", outcome: "success",
      metadata: { locationId: place.id, day: place.day, ...report },
    });
    return report;
  }));
}

async function dayReport(transaction: KalendrTransaction, tenantId: string, locationId: string, day: string): Promise<QueueDayReport> {
  const [row] = await transaction.execute<{ issued: number | string; served: number | string; left: number | string; wait_seconds: number | string | null }>(sql`
    select count(*) as issued,
      count(*) filter (where appointment.status = 'completed') as served,
      count(*) filter (where appointment.status in ('cancelled', 'no_show')) as left,
      avg(extract(epoch from ticket.called_at - appointment.checked_in_at)) filter (where ticket.called_at is not null and appointment.checked_in_at is not null) as wait_seconds
    from queue_tickets as ticket
    join appointments as appointment
      on appointment.tenant_id = ticket.tenant_id and appointment.id = ticket.appointment_id
    where ticket.tenant_id = ${tenantId} and ticket.location_id = ${locationId} and ticket.day = ${day}
  `);
  return {
    issued: Number(row?.issued ?? 0),
    served: Number(row?.served ?? 0),
    left: Number(row?.left ?? 0),
    averageWaitMinutes: row?.wait_seconds === null || row?.wait_seconds === undefined ? null : Math.max(0, Math.round(Number(row.wait_seconds) / 60)),
  };
}

// ── Public: the door QR code ────────────────────────────────────────────

async function resolveJoin(token: string): Promise<{ tenantId: string; locationId: string }> {
  const parsed = queueTokenSchema.safeParse(token);
  const database = getDatabase();
  if (!parsed.success || !database || isPreviewMode()) throw notFound();
  const rows = await database.execute<{ tenant_id: string; location_id: string }>(sql`select * from kalendr_resolve_queue_join(${sha256(parsed.data)})`);
  const row = rows[0];
  if (!row) throw notFound();
  return { tenantId: row.tenant_id, locationId: row.location_id };
}

/** What the page behind the door QR code shows. Never a customer's name. */
export async function getJoinView(token: string): Promise<QueueJoinView> {
  const resolved = await resolveJoin(token);
  return withTenant(resolved.tenantId, async (transaction) => {
    const place = await placeIn(transaction, resolved.tenantId, resolved.locationId);
    const [business] = await transaction.execute<{ name: string; self_join_enabled: boolean }>(sql`
      select tenant.name, display.self_join_enabled
      from queue_displays as display join tenants as tenant on tenant.id = display.tenant_id
      where display.tenant_id = ${resolved.tenantId} and display.location_id = ${place.id} and display.revoked_at is null
    `);
    if (!business) throw notFound();
    const closed = await isDayClosed(transaction, resolved.tenantId, place.id, place.day);
    const [count] = await transaction.execute<{ waiting: number | string }>(sql`
      select count(*) as waiting
      from queue_tickets as ticket
      join appointments as appointment
        on appointment.tenant_id = ticket.tenant_id and appointment.id = ticket.appointment_id
      where ticket.tenant_id = ${resolved.tenantId} and ticket.location_id = ${place.id} and ticket.day = ${place.day}
        and ticket.called_at is null and appointment.status = 'checked_in' and appointment.visit_started_at is null
    `);
    const staff = await transaction.execute<{ id: string; name: string }>(sql`
      select practitioner.id, practitioner.name
      from practitioners as practitioner
      where practitioner.tenant_id = ${resolved.tenantId} and practitioner.is_active
        and ${practitionerServes(resolved.tenantId, place.id)}
      order by practitioner.name
    `);
    return {
      businessName: business.name,
      locationName: place.name,
      open: business.self_join_enabled && !closed,
      closed,
      waitingCount: Number(count?.waiting ?? 0),
      practitioners: staff.map((row) => ({ id: row.id, name: row.name })),
    };
  });
}

/** True for a practitioner who works at the location and offers at least one active service there. */
function practitionerServes(tenantId: string, locationId: string) {
  return sql`exists (
    select 1 from practitioner_locations as works
    join practitioner_services as offered
      on offered.tenant_id = works.tenant_id and offered.practitioner_id = works.practitioner_id
    join service_locations as at_location
      on at_location.tenant_id = offered.tenant_id and at_location.service_id = offered.service_id and at_location.location_id = works.location_id
    join services as service
      on service.tenant_id = offered.tenant_id and service.id = offered.service_id and service.is_active
    where works.tenant_id = ${tenantId} and works.practitioner_id = practitioner.id and works.location_id = ${locationId}
  )`;
}

/**
 * Someone scanned the QR code at the door and gave a first name and phone number. They get a checked-in
 * walk-in visit and the next token. Returns the path of their own queue page.
 */
export async function joinFromDoor(token: string, input: DoorJoinInput): Promise<{ ticketPath: string }> {
  const resolved = await resolveJoin(token);
  const ticketToken = createOpaqueToken();
  await retrySerialization(() => withTenant(resolved.tenantId, async (transaction) => {
    const place = await placeIn(transaction, resolved.tenantId, resolved.locationId);
    const [display] = await transaction.execute<{ id: string; self_join_enabled: boolean }>(sql`
      select id, self_join_enabled from queue_displays
      where tenant_id = ${resolved.tenantId} and location_id = ${place.id} and revoked_at is null
    `);
    if (!display) throw notFound();
    if (!display.self_join_enabled) {
      throw new ApiError(409, "self_join_off", "Joining from the door is turned off here. Please ask at the front desk.");
    }
    if (await isDayClosed(transaction, resolved.tenantId, place.id, place.day)) throw dayClosed();

    const practitioner = await pickPractitioner(transaction, resolved.tenantId, place.id, place.day, input.practitionerId);
    const patientId = await findOrCreatePatient(transaction, resolved.tenantId, input.firstName, input.phone, input.notify ?? false);
    await assertBookingAllowed(transaction, resolved.tenantId, practitioner.id, "public"); // plan limits (feature 14)
    const now = new Date();
    const [created] = await transaction.execute<{ id: string; version: number }>(sql`
      insert into appointments (
        tenant_id, location_id, patient_id, practitioner_id, service_id, starts_at, ends_at, status,
        confirmation_status, booking_source, form_status, reminder_status, manage_token_hash, checked_in_at
      )
      values (
        ${resolved.tenantId}, ${place.id}, ${patientId}, ${practitioner.id}, ${practitioner.service_id},
        ${now.toISOString()}, ${new Date(now.getTime() + Number(practitioner.duration_minutes) * 60_000).toISOString()}, 'checked_in',
        'confirmed', 'walk_in', 'not_assigned', 'not_scheduled', ${sha256(createOpaqueToken())}, ${now.toISOString()}
      )
      returning id, version
    `);
    if (!created) throw new Error("Walk-in visit insert did not return a row");
    await transaction.insert(auditEvents).values({
      tenantId: resolved.tenantId, appointmentId: created.id, actorType: "patient", action: "appointment.created", outcome: "success",
      metadata: { version: Number(created.version), via: "queue_door" },
    });
    await transaction.insert(outboxEvents).values({
      tenantId: resolved.tenantId,
      aggregateType: "appointment",
      aggregateId: created.id,
      eventType: "appointment.created",
      payload: { appointmentId: created.id, version: Number(created.version) },
      dedupeKey: `appointment.created:${created.id}:${created.version}`,
      traceParent: currentTraceParent(),
    });
    await issueQueueTicket(transaction, resolved.tenantId, created.id);
    await transaction.execute(sql`
      update queue_tickets
      set phone_token_hash = ${sha256(ticketToken)}, notify_when_next = ${input.notify ?? false}
      where tenant_id = ${resolved.tenantId} and appointment_id = ${created.id}
    `);
    await sendAlmostNext(transaction, resolved.tenantId, place.id);
  }));
  return { ticketPath: `/q/${ticketToken}` };
}

/** The practitioner asked for, or whoever at the location has the fewest people waiting. */
async function pickPractitioner(
  transaction: KalendrTransaction,
  tenantId: string,
  locationId: string,
  day: string,
  requested: string | undefined,
): Promise<{ id: string; service_id: string; duration_minutes: number }> {
  const [row] = await transaction.execute<{ id: string; service_id: string; duration_minutes: number }>(sql`
    select practitioner.id,
      (select service.id from practitioner_services as offered
         join service_locations as at_location
           on at_location.tenant_id = offered.tenant_id and at_location.service_id = offered.service_id and at_location.location_id = ${locationId}
         join services as service on service.tenant_id = offered.tenant_id and service.id = offered.service_id and service.is_active
         where offered.tenant_id = practitioner.tenant_id and offered.practitioner_id = practitioner.id
         order by service.duration_minutes, service.name limit 1) as service_id,
      (select service.duration_minutes from practitioner_services as offered
         join service_locations as at_location
           on at_location.tenant_id = offered.tenant_id and at_location.service_id = offered.service_id and at_location.location_id = ${locationId}
         join services as service on service.tenant_id = offered.tenant_id and service.id = offered.service_id and service.is_active
         where offered.tenant_id = practitioner.tenant_id and offered.practitioner_id = practitioner.id
         order by service.duration_minutes, service.name limit 1) as duration_minutes
    from practitioners as practitioner
    where practitioner.tenant_id = ${tenantId} and practitioner.is_active
      and ${practitionerServes(tenantId, locationId)}
      ${requested ? sql`and practitioner.id = ${requested}` : sql``}
    order by (
      select count(*) from queue_tickets as ticket
      join appointments as appointment on appointment.tenant_id = ticket.tenant_id and appointment.id = ticket.appointment_id
      where ticket.tenant_id = practitioner.tenant_id and ticket.location_id = ${locationId} and ticket.day = ${day}
        and appointment.practitioner_id = practitioner.id and appointment.status = 'checked_in' and appointment.visit_started_at is null
    ), practitioner.name
    limit 1
  `);
  if (!row) {
    throw new ApiError(requested ? 404 : 409, requested ? "practitioner_not_found" : "no_one_available",
      requested ? "That person doesn't see people here." : "Nobody is available to see walk-ins here. Please ask at the front desk.");
  }
  return row;
}

async function findOrCreatePatient(
  transaction: KalendrTransaction,
  tenantId: string,
  firstName: string,
  phone: string,
  messagingConsent: boolean,
): Promise<string> {
  const [existing] = await transaction.execute<{ id: string }>(sql`
    select id from patients
    where tenant_id = ${tenantId}
      and kalendr_normalize_phone(phone) = kalendr_normalize_phone(${phone})
      and lower(first_name) = lower(${firstName})
      and erased_at is null
    order by created_at limit 1
  `);
  if (existing) {
    // Phone and first name are not enough to speak for the customer: a tick here can't undo a STOP or an earlier no.
    await applyFormMessagingConsentIn(transaction, tenantId, existing.id, { agreed: messagingConsent, match: "partial" });
    return existing.id;
  }
  const [created] = await transaction.insert(patients).values({
    tenantId,
    firstName,
    lastName: "",
    phone,
    // A walk-in gives a first name and a phone number only.
    email: "",
    preferredChannel: "whatsapp",
  }).returning({ id: patients.id });
  if (!created) throw new Error("Patient insert did not return a row");
  // "Tell me when I'm next" left unticked is about this queue, not a no to every message, so only a yes is recorded.
  if (messagingConsent) await applyFormMessagingConsentIn(transaction, tenantId, created.id, { agreed: true, match: "new" });
  return created.id;
}

export { closeDayInputSchema, doorJoinInputSchema, joinLinkInputSchema };
export type { CloseDayInput, DoorJoinInput, JoinLinkInput, JoinLinkResult, QueueDayReport, QueueJoinView };
