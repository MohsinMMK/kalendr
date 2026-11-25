import { sql } from "drizzle-orm";

import type { KalendrTransaction } from "@/db/client";
import type { BookingWindow } from "@/lib/service-setup";

import { readOnlyCalendarIds } from "../billing/enforcement";
import { closedHolidayDates } from "./holidays";
import { loadLimits } from "./limits-load";
import { addDays, DAY, localDateOf } from "./time";
import type { BusySpan, DateOverrideInput, PersonInput, ResourceInput, ScheduleInput, ServiceRules, SlotEngineInput, SlotMode, Span, WorkingRule } from "./types";

/**
 * Reads what `offerableSlots` needs from the database, inside the caller's transaction and
 * business scope. Keeping the reading here and the rules in the pure files means the commit
 * can load fresh data after it takes its locks and run the very same rules.
 */

export interface SlotQuery {
  tenantId: string;
  locationId: string;
  serviceId: string;
  /** One of the service's lengths. Defaults to the service's usual length. */
  durationMinutes?: number;
  /** A person's id, or `first_available` for everyone who offers the service here. */
  practitionerId: string;
  from: Date;
  to: Date;
  mode: SlotMode;
  now?: Date;
  /** A visit being moved: its own bookings do not count as busy time. */
  excludeAppointmentId?: string;
  /** Offer only this room (or other resource), when staff picked one. */
  preferredResourceId?: string;
  /** Lock the candidate resources so two bookings cannot take the same room. Used by the commit. */
  lockResources?: boolean;
  /** Staff chose to go past the limits and gave a reason: leave limits and "first slot only" out. */
  overrideLimits?: boolean;
  /** `existing` skips notice, window and limits; set this to keep the limits (a request being approved, a waitlist offer). */
  enforceLimits?: boolean;
  /** The customer's own hold (feature 39): it does not block the booking it was made for. */
  ignoreHoldId?: string;
}

export interface LoadedSlotInput {
  input: SlotEngineInput;
  /** The lengths the service offers. A service saved before lengths existed has one: its usual length. */
  lengths: Array<{ minutes: number; priceMinor: number | null; isDefault: boolean }>;
  bookingMode: "instant" | "request";
  requiredResourceKind: string | null;
  /** People who are away in the range, with the note and cover to show on the booking page. */
  outOfOffice: Array<{ practitionerId: string; startsAt: string; endsAt: string; note: string | null; coverPractitionerId: string | null }>;
}

interface ServiceRow extends Record<string, unknown> {
  duration_minutes: number;
  price_minor: number | null;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  slot_interval_minutes: number | null;
  minimum_lead_minutes: number;
  maximum_advance_days: number;
  start_offset_minutes: number;
  booking_window_kind: BookingWindow["kind"];
  booking_window_from: string | null;
  booking_window_through: string | null;
  booking_mode: "instant" | "request";
  required_resource_kind: string | null;
  location_timezone: string;
  schedule_id: string | null;
  restriction_schedule_id: string | null;
  schedule_name: string | null;
  first_slot_only: boolean;
  optimized_slots: boolean;
}

interface SpanRow extends Record<string, unknown> {
  owner_id: string | null;
  starts_at: Date | string;
  ends_at: Date | string;
}

function toSpan(row: SpanRow): Span {
  return { start: new Date(row.starts_at).getTime(), end: new Date(row.ends_at).getTime() };
}

function windowOf(row: ServiceRow): BookingWindow {
  if (row.booking_window_kind === "date_range" && row.booking_window_from && row.booking_window_through) {
    return { kind: "date_range", from: row.booking_window_from, through: row.booking_window_through };
  }
  return { kind: row.booking_window_kind === "business_days" ? "business_days" : "rolling_days", days: row.maximum_advance_days };
}

/** Returns null when the service is not offered at this location. */
export async function loadSlotInput(transaction: KalendrTransaction, query: SlotQuery): Promise<LoadedSlotInput | null> {
  const [service] = await transaction.execute<ServiceRow>(sql`
    select
      service.duration_minutes, service.price_minor, service.buffer_before_minutes, service.buffer_after_minutes,
      service.slot_interval_minutes, service.minimum_lead_minutes, service.maximum_advance_days,
      service.start_offset_minutes, service.booking_window_kind,
      service.booking_window_from::text as booking_window_from,
      service.booking_window_through::text as booking_window_through,
      service.booking_mode, service.required_resource_kind, location.timezone as location_timezone,
      service.schedule_id, service.restriction_schedule_id, service.first_slot_only, service.optimized_slots,
      (select name from availability_schedules where tenant_id = service.tenant_id and id = service.schedule_id) as schedule_name
    from services as service
    join service_locations as service_location
      on service_location.tenant_id = service.tenant_id
     and service_location.service_id = service.id
     and service_location.location_id = ${query.locationId}
    join locations as location
      on location.tenant_id = service.tenant_id and location.id = ${query.locationId} and location.is_active
    where service.tenant_id = ${query.tenantId} and service.id = ${query.serviceId} and service.is_active
  `);
  if (!service) return null;

  const lengthRows = await transaction.execute<{ minutes: number; price_minor: number | null; is_default: boolean }>(sql`
    select minutes, price_minor, is_default from service_durations
    where tenant_id = ${query.tenantId} and service_id = ${query.serviceId}
    order by sort_order, minutes
  `);
  const lengths = lengthRows.length > 0
    ? lengthRows.map((row) => ({ minutes: row.minutes, priceMinor: row.price_minor, isDefault: row.is_default }))
    : [{ minutes: service.duration_minutes, priceMinor: service.price_minor, isDefault: true }];
  const duration = query.durationMinutes ?? lengths.find((length) => length.isDefault)?.minutes ?? service.duration_minutes;

  const eligible = await transaction.execute<{ id: string }>(sql`
    select practitioner.id
    from practitioners as practitioner
    join practitioner_services as practitioner_service
      on practitioner_service.tenant_id = practitioner.tenant_id
     and practitioner_service.practitioner_id = practitioner.id
     and practitioner_service.service_id = ${query.serviceId}
    join practitioner_locations as practitioner_location
      on practitioner_location.tenant_id = practitioner.tenant_id
     and practitioner_location.practitioner_id = practitioner.id
     and practitioner_location.location_id = ${query.locationId}
    where practitioner.tenant_id = ${query.tenantId} and practitioner.is_active
    order by practitioner.id
  `);
  // Calendars beyond the plan's limit are read-only and take no new bookings (feature 14).
  const closedByPlan = await readOnlyCalendarIds(transaction, query.tenantId);
  const personIds = eligible.map((row) => row.id).filter((id) => !closedByPlan.has(id));

  // Busy time and blocks can reach into the range from a day either side because of buffers.
  const busyFrom = new Date(query.from.getTime() - DAY).toISOString();
  const busyTo = new Date(query.to.getTime() + DAY).toISOString();
  // Time away and blocked time are read from today, whatever range was asked for: counting business days for
  // the booking window starts at today, so a one-slot check at commit must see the same closed days a listing does.
  const closuresFrom = new Date(Math.min(query.from.getTime(), (query.now ?? new Date()).getTime()) - DAY).toISOString();
  const personList = sql.join(personIds.map((id) => sql`${id}`), sql`, `);
  const dateFrom = addDays(localDateOf(Math.min(query.from.getTime(), (query.now ?? new Date()).getTime()), service.location_timezone), -3);
  const dateTo = addDays(localDateOf(query.to.getTime(), service.location_timezone), 3);

  const scheduleRows = personIds.length === 0 ? [] : await transaction.execute<{ id: string; practitioner_id: string; name: string; timezone: string; is_default: boolean }>(sql`
    select id, practitioner_id, name, timezone, is_default from availability_schedules
    where tenant_id = ${query.tenantId} and practitioner_id in (${personList})
  `);
  // The service's own schedule is found by name, so each person uses their schedule of that name, else their default.
  const chosenSchedule = (personId: string) => {
    const own = scheduleRows.filter((row) => row.practitioner_id === personId);
    return (service.schedule_name ? own.find((row) => row.name === service.schedule_name) : undefined) ?? own.find((row) => row.is_default);
  };
  const chosenIds = [...new Set(personIds.flatMap((id) => chosenSchedule(id)?.id ?? []))];
  const wantedScheduleIds = [...new Set([...chosenIds, ...(service.restriction_schedule_id ? [service.restriction_schedule_id] : [])])];
  const idList = wantedScheduleIds.length === 0 ? sql`null` : sql.join(wantedScheduleIds.map((id) => sql`${id}`), sql`, `);

  const ruleRows = wantedScheduleIds.length === 0 ? [] : await transaction.execute<{
    schedule_id: string; location_id: string; day_of_week: number; starts_at_local: string; ends_at_local: string;
    valid_from: string; valid_through: string | null;
  }>(sql`
    select schedule_id, location_id, day_of_week, starts_at_local::text as starts_at_local, ends_at_local::text as ends_at_local,
      valid_from::text as valid_from, valid_through::text as valid_through
    from availability_rules
    where tenant_id = ${query.tenantId} and is_active and schedule_id in (${idList})
  `);
  const overrideRows = wantedScheduleIds.length === 0 ? [] : await transaction.execute<{ schedule_id: string; date: string; ranges: Array<{ start: string; end: string }> | null }>(sql`
    select schedule_id, date::text as date, ranges from availability_overrides
    where tenant_id = ${query.tenantId} and schedule_id in (${idList})
      and date between ${dateFrom}::date and ${dateTo}::date
  `);
  const scheduleInput = (scheduleId: string, timezone: string, atLocation: boolean): ScheduleInput => {
    const seen = new Set<string>();
    const rules: WorkingRule[] = [];
    for (const row of ruleRows) {
      if (row.schedule_id !== scheduleId || (atLocation && row.location_id !== query.locationId)) continue;
      // A restriction is read without caring about the branch, so the same range at two branches counts once.
      const key = `${row.day_of_week}|${row.starts_at_local}|${row.ends_at_local}|${row.valid_from}|${row.valid_through}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rules.push({ dayOfWeek: row.day_of_week, startsAtLocal: row.starts_at_local, endsAtLocal: row.ends_at_local, validFrom: row.valid_from, validThrough: row.valid_through });
    }
    const overrides: DateOverrideInput[] = overrideRows.filter((row) => row.schedule_id === scheduleId).map((row) => ({ date: row.date, ranges: row.ranges }));
    return { timezone, rules, overrides };
  };
  const restrictionRow = service.restriction_schedule_id ? scheduleRows.find((row) => row.id === service.restriction_schedule_id) : undefined;
  const restrictionZone = restrictionRow?.timezone ?? (service.restriction_schedule_id
    ? (await transaction.execute<{ timezone: string }>(sql`select timezone from availability_schedules where tenant_id = ${query.tenantId} and id = ${service.restriction_schedule_id}`))[0]?.timezone
    : undefined);
  const restriction = service.restriction_schedule_id && restrictionZone ? scheduleInput(service.restriction_schedule_id, restrictionZone, false) : null;

  const travelRows = personIds.length === 0 ? [] : await transaction.execute<{ practitioner_id: string; starts_on: string; ends_on: string; timezone: string }>(sql`
    select practitioner_id, starts_on::text as starts_on, ends_on::text as ends_on, timezone from travel_periods
    where tenant_id = ${query.tenantId} and practitioner_id in (${personList})
      and ends_on >= ${dateFrom}::date and starts_on <= ${dateTo}::date
  `);
  const timeOffRows = personIds.length === 0 ? [] : await transaction.execute<{ practitioner_id: string; starts_at: Date | string; ends_at: Date | string; public_note: string | null; cover_practitioner_id: string | null }>(sql`
    select practitioner_id, starts_at, ends_at, public_note, cover_practitioner_id from time_off
    where tenant_id = ${query.tenantId} and practitioner_id in (${personList})
      and tstzrange(starts_at, ends_at, '[)') && tstzrange(${closuresFrom}::timestamptz, ${busyTo}::timestamptz, '[)')
  `);
  const holidayRow = (await transaction.execute<{ country: string; region: string | null; opted_out: Record<string, string[]>; custom_days: Array<{ date: string; name: string }> }>(sql`
    select country, region, opted_out, custom_days from holiday_settings where tenant_id = ${query.tenantId}
  `))[0];
  const holidays = closedHolidayDates(holidayRow ? { country: holidayRow.country, region: holidayRow.region, optedOut: holidayRow.opted_out, customDays: holidayRow.custom_days } : null, dateFrom, dateTo);

  const reservationRows = personIds.length === 0 ? [] : await transaction.execute<SpanRow & { visit_starts_at: Date | string | null; visit_ends_at: Date | string | null }>(sql`
    select reservation.practitioner_id as owner_id, reservation.starts_at, reservation.ends_at,
      appointment.starts_at as visit_starts_at, appointment.ends_at as visit_ends_at
    from resource_reservations as reservation
    left join appointments as appointment
      on appointment.tenant_id = reservation.tenant_id and appointment.id = reservation.appointment_id
    where reservation.tenant_id = ${query.tenantId} and reservation.practitioner_id in (${personList})
      and (reservation.state = 'confirmed' or (reservation.state = 'held' and reservation.hold_expires_at > now()))
      and (${query.excludeAppointmentId ?? null}::text is null or reservation.appointment_id is distinct from ${query.excludeAppointmentId ?? null})
      and tstzrange(reservation.starts_at, reservation.ends_at, '[)') && tstzrange(${busyFrom}::timestamptz, ${busyTo}::timestamptz, '[)')
  `);
  // A live hold keeps a time for the customer filling in the form. One past its expiry is ignored, whether or not the clean-up job ran.
  const holdRows = await transaction.execute<SpanRow & { visit_starts_at: Date | string; visit_ends_at: Date | string; resource_id: string | null }>(sql`
    select practitioner_id as owner_id, reserved_starts_at as starts_at, reserved_ends_at as ends_at,
      starts_at as visit_starts_at, ends_at as visit_ends_at, resource_id
    from slot_holds
    -- Any location: the person (or room) held elsewhere is just as busy here.
    where tenant_id = ${query.tenantId} and expires_at > now()
      and (${query.ignoreHoldId ?? null}::text is null or id <> ${query.ignoreHoldId ?? null})
      and tstzrange(reserved_starts_at, reserved_ends_at, '[)') && tstzrange(${busyFrom}::timestamptz, ${busyTo}::timestamptz, '[)')
  `);
  const blockRows = await transaction.execute<SpanRow>(sql`
    select practitioner_id as owner_id, starts_at, ends_at from schedule_blocks
    where tenant_id = ${query.tenantId}
      and (location_id is null or location_id = ${query.locationId})
      and tstzrange(starts_at, ends_at, '[)') && tstzrange(${closuresFrom}::timestamptz, ${busyTo}::timestamptz, '[)')
  `);

  // Busy time from the staff members' own connected calendars (feature 16), read from the cache.
  const calendarRows = personIds.length === 0 ? [] : await transaction.execute<SpanRow>(sql`
    select person.id as owner_id, busy.starts_at, busy.ends_at
    from external_busy as busy
    join calendar_selections as selection on selection.tenant_id = busy.tenant_id and selection.id = busy.selection_id and selection.blocks_availability
    join calendar_connections as connection on connection.tenant_id = selection.tenant_id and connection.id = selection.connection_id and connection.status = 'active'
    join memberships as membership on membership.tenant_id = busy.tenant_id and membership.id = busy.membership_id and membership.is_active
    join practitioners as person on person.tenant_id = membership.tenant_id and person.auth_user_id = membership.user_id
    where busy.tenant_id = ${query.tenantId} and person.id in (${personList})
      and tstzrange(busy.starts_at, busy.ends_at, '[)') && tstzrange(${busyFrom}::timestamptz, ${busyTo}::timestamptz, '[)')
      and not exists (
        select 1 from appointment_event_links as link
        where link.tenant_id = busy.tenant_id and link.selection_id = busy.selection_id and link.event_id = busy.source_event_id
      )
  `);

  const requested = query.practitionerId === "first_available" ? null : query.practitionerId;
  // While the person asked for is away with a cover teammate, the cover's slots are offered for those days.
  const coverWindows = new Map<string, Span[]>();
  if (requested) {
    for (const row of timeOffRows) {
      if (row.practitioner_id !== requested || !row.cover_practitioner_id) continue;
      const list = coverWindows.get(row.cover_practitioner_id) ?? [];
      list.push(toSpan({ owner_id: null, starts_at: row.starts_at, ends_at: row.ends_at }));
      coverWindows.set(row.cover_practitioner_id, list);
    }
  }

  const people: PersonInput[] = personIds.map((id) => {
    const schedule = chosenSchedule(id);
    const cover = coverWindows.get(id);
    return {
      id,
      candidate: requested === null || requested === id || cover !== undefined,
      ...(cover && requested !== id ? { candidateWithin: cover } : {}),
      schedule: schedule ? scheduleInput(schedule.id, schedule.timezone, true) : null,
      travel: travelRows.filter((row) => row.practitioner_id === id).map((row) => ({ from: row.starts_on, through: row.ends_on, timezone: row.timezone })),
      outOfOffice: timeOffRows.filter((row) => row.practitioner_id === id).map((row) => ({ span: toSpan({ owner_id: null, starts_at: row.starts_at, ends_at: row.ends_at }), note: row.public_note })),
      busy: [
        ...reservationRows.filter((row) => row.owner_id === id).map((row): BusySpan => ({
          ...toSpan(row),
          ...(row.visit_starts_at && row.visit_ends_at ? { visitStart: new Date(row.visit_starts_at).getTime(), visitEnd: new Date(row.visit_ends_at).getTime() } : {}),
        })),
        ...holdRows.filter((row) => row.owner_id === id).map((row): BusySpan => ({
          ...toSpan(row), visitStart: new Date(row.visit_starts_at).getTime(), visitEnd: new Date(row.visit_ends_at).getTime(),
        })),
      ],
      // A block with no person closes everyone.
      blocks: blockRows.filter((row) => row.owner_id === null || row.owner_id === id).map(toSpan),
      calendarBusy: calendarRows.filter((row) => row.owner_id === id).map(toSpan),
    };
  });

  const resources: ResourceInput[] = [];
  if (service.required_resource_kind) {
    const resourceRows = await transaction.execute<{ id: string }>(sql`
      select id from resources
      where tenant_id = ${query.tenantId} and location_id = ${query.locationId}
        and kind = ${service.required_resource_kind} and is_active
        and (${query.preferredResourceId ?? null}::text is null or id = ${query.preferredResourceId ?? null})
      order by id
      ${query.lockResources ? sql`for update` : sql``}
    `);
    const resourceIds = resourceRows.map((row) => row.id);
    const resourceBusy = resourceIds.length === 0 ? [] : await transaction.execute<SpanRow>(sql`
      select resource_id as owner_id, starts_at, ends_at from resource_reservations
      where tenant_id = ${query.tenantId} and resource_id in (${sql.join(resourceIds.map((id) => sql`${id}`), sql`, `)})
        and (state = 'confirmed' or (state = 'held' and hold_expires_at > now()))
        and (${query.excludeAppointmentId ?? null}::text is null or appointment_id is distinct from ${query.excludeAppointmentId ?? null})
        and tstzrange(starts_at, ends_at, '[)') && tstzrange(${busyFrom}::timestamptz, ${busyTo}::timestamptz, '[)')
    `);
    for (const id of resourceIds) {
      resources.push({ id, busy: [...resourceBusy.filter((row) => row.owner_id === id).map(toSpan), ...holdRows.filter((row) => row.resource_id === id).map(toSpan)] });
    }
  }

  const { limits, usage } = query.overrideLimits || (query.mode === "existing" && !query.enforceLimits)
    ? { limits: [], usage: [] }
    : await loadLimits(transaction, {
      tenantId: query.tenantId, serviceId: query.serviceId, locationId: query.locationId, personIds, resourceIds: resources.map((resource) => resource.id),
      timezone: service.location_timezone, from: query.from, to: query.to, excludeAppointmentId: query.excludeAppointmentId ?? null,
    });

  const rules: ServiceRules = {
    durationMinutes: duration,
    bufferBeforeMinutes: service.buffer_before_minutes,
    bufferAfterMinutes: service.buffer_after_minutes,
    minimumNoticeMinutes: service.minimum_lead_minutes,
    window: windowOf(service),
    slotIntervalMinutes: service.slot_interval_minutes,
    startOffsetMinutes: service.start_offset_minutes,
    requiresResource: service.required_resource_kind !== null,
    firstSlotOnly: service.first_slot_only && !query.overrideLimits,
    optimizedSlots: service.optimized_slots,
  };
  return {
    input: {
      now: query.now ?? new Date(),
      from: query.from,
      to: query.to,
      mode: query.mode,
      timezone: service.location_timezone,
      service: rules,
      people,
      resources,
      holidays,
      restriction,
      serviceId: query.serviceId,
      locationId: query.locationId,
      limits,
      usage,
    },
    lengths,
    bookingMode: service.booking_mode,
    requiredResourceKind: service.required_resource_kind,
    // Only the person whose own link was asked for: a general list does not tell the public who is away.
    outOfOffice: timeOffRows
      .filter((row) => requested !== null && row.practitioner_id === requested && (row.public_note || row.cover_practitioner_id))
      .map((row) => ({
        practitionerId: row.practitioner_id,
        startsAt: new Date(row.starts_at).toISOString(),
        endsAt: new Date(row.ends_at).toISOString(),
        note: row.public_note,
        coverPractitionerId: row.cover_practitioner_id,
      })),
  };
}
