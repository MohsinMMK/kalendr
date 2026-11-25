import "server-only";

import { sql } from "drizzle-orm";

import { getDatabase, withTenant } from "@/db/client";
import type { AppointmentStatus } from "@/lib/domain";
import { eventContent } from "@/server/calendars/logic";
import { eventTextSchema } from "@/lib/calendar-sync";
import { sampleValues, staffEntry } from "@/lib/event-wording";

import { feedTokenHash, isFeedToken } from "./calendar-feed-token";
import { appOrigin } from "./env";
import { createFeedCalendar, type FeedEvent } from "./icalendar";

interface FeedRow extends Record<string, unknown> {
  id: string;
  version: number;
  status: AppointmentStatus;
  starts_at: Date;
  ends_at: Date;
  first_name: string;
  last_name: string;
  service_name: string;
  location_name: string;
  location_address: string;
  location_city: string;
  business_name: string;
  person_name: string;
  customer_event_title: string | null;
  staff_event_title: string | null;
  event_description: string | null;
  hide_notes_in_calendar: boolean;
  hide_details_in_calendar: boolean;
}

/** Days of past and future appointments a feed carries. Enough for a phone calendar; small enough to stay quick. */
const FEED_PAST_DAYS = 14;
const FEED_FUTURE_DAYS = 180;

/**
 * The .ics text for a feed token, or null when the token is not valid (never made, regenerated, revoked, or
 * its owner is deactivated). Titles follow the business's privacy setting; no phone, email or notes are ever included.
 */
export async function renderFeed(rawToken: string): Promise<string | null> {
  const token = rawToken.replace(/\.ics$/i, "");
  if (!isFeedToken(token)) return null;
  const database = getDatabase();
  if (!database) return null;
  const owner = (await database.execute<{ tenant_id: string; membership_id: string }>(sql`select tenant_id, membership_id from kalendr_resolve_calendar_feed(${feedTokenHash(token)})`))[0];
  if (!owner) return null;
  return withTenant(owner.tenant_id, async (transaction) => {
    const [setting] = await transaction.execute<{ event_text: string }>(sql`select event_text from calendar_business_settings where tenant_id = ${owner.tenant_id}`);
    const eventText = eventTextSchema.catch("busy_only").parse(setting?.event_text);
    const rows = await transaction.execute<FeedRow>(sql`
      select appointment.id, appointment.version, appointment.status, appointment.starts_at, appointment.ends_at,
        patient.first_name, patient.last_name, service.name as service_name, location.name as location_name,
        location.address as location_address, location.city as location_city, tenant.name as business_name, practitioner.name as person_name,
        service.customer_event_title, service.staff_event_title, service.event_description, service.hide_notes_in_calendar, service.hide_details_in_calendar
      from memberships as membership
      join practitioners as practitioner on practitioner.tenant_id = membership.tenant_id and practitioner.auth_user_id = membership.user_id
      join appointments as appointment on appointment.tenant_id = practitioner.tenant_id and appointment.practitioner_id = practitioner.id
      join patients as patient on patient.tenant_id = appointment.tenant_id and patient.id = appointment.patient_id
      join services as service on service.tenant_id = appointment.tenant_id and service.id = appointment.service_id
      join locations as location on location.tenant_id = appointment.tenant_id and location.id = appointment.location_id
      join tenants as tenant on tenant.id = appointment.tenant_id
      where membership.tenant_id = ${owner.tenant_id} and membership.id = ${owner.membership_id}
        and appointment.status in ('requested', 'booked', 'checked_in', 'completed')
        and appointment.starts_at >= now() - ${FEED_PAST_DAYS} * interval '1 day'
        and appointment.starts_at <= now() + ${FEED_FUTURE_DAYS} * interval '1 day'
      order by appointment.starts_at
      limit 2000`);
    const events: FeedEvent[] = rows.map((row) => {
      const content = eventContent(eventText, {
        firstName: row.first_name,
        lastName: row.last_name,
        serviceName: row.service_name,
        locationName: row.location_name,
        appointmentUrl: `${appOrigin()}/schedule?open=${encodeURIComponent(row.id)}`,
      });
      // The service's own wording (feature 50); the owner's per-service choice wins over the business-wide setting. Answers to
      // booking questions are not read here, so a feed shows a question placeholder as typed.
      const usesWording = eventText !== "busy_only" || row.hide_details_in_calendar || Boolean(row.staff_event_title?.trim());
      const entry = !usesWording ? null : staffEntry(
        { customerTitle: row.customer_event_title, staffTitle: row.staff_event_title, description: row.event_description, hideNotes: row.hide_notes_in_calendar, hideDetails: row.hide_details_in_calendar },
        {
          ...sampleValues(row.business_name, row.location_name, [row.location_address, row.location_city].filter(Boolean).join(", "), row.service_name, row.person_name, Math.round((new Date(row.ends_at).getTime() - new Date(row.starts_at).getTime()) / 60_000)),
          customer: `${row.first_name} ${row.last_name}`.trim(), customerFirstName: row.first_name,
        },
        { title: content.title, description: content.description ?? null, ...(content.location ? { location: content.location } : {}) },
      );
      const shown = entry ?? { title: content.title, description: content.description ?? null, ...(content.location ? { location: content.location } : {}) };
      return {
        appointmentId: row.id,
        version: row.version,
        status: row.status,
        startsAt: new Date(row.starts_at).toISOString(),
        endsAt: new Date(row.ends_at).toISOString(),
        summary: shown.title,
        ...(shown.description ? { description: shown.description } : {}),
        ...("location" in shown && shown.location ? { location: shown.location } : {}),
      };
    });
    return createFeedCalendar(events);
  });
}
