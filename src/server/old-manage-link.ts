import "server-only";

import { sql } from "drizzle-orm";

import { getDatabase, withTenant } from "@/db/client";

import type { BusinessProfile } from "@/lib/terminology";

import { loadBusinessProfileIn } from "./business-profile";
import { sha256 } from "./crypto";
import { isPreviewMode } from "./preview-repository";

/**
 * What an old reschedule link may say. The link itself stays dead: nothing here reads or changes the booking
 * through it, and the new manage link is never returned. Only the new time (when the same customer still holds
 * the booking) and where to book again.
 */
export interface MovedBookingLanding {
  tenantId: string;
  profile: BusinessProfile;
  businessName: string;
  /** `/book/<business>/<service>`, or null when the service switched "Book again" off or is gone. */
  bookAgainPath: string | null;
  serviceName: string;
  /** Only when the same customer still has an active booking that came from this link's booking. */
  newTime: { startsAt: string; timezone: string } | null;
}

const activeStatuses = ["requested", "booked", "checked_in", "pending_payment", "reschedule_requested"];

export async function loadMovedBooking(token: string): Promise<MovedBookingLanding | null> {
  if (isPreviewMode()) return null;
  const database = getDatabase();
  if (!database) return null;
  const found = await database.execute<{ tenant_id: string; appointment_id: string; patient_id: string }>(
    sql`select * from kalendr_resolve_retired_manage_token(${sha256(token)})`,
  );
  const match = found[0];
  if (!match) return null;
  return withTenant(match.tenant_id, async (transaction) => {
    const rows = await transaction.execute<{
      status: string; patient_id: string; starts_at: Date | string; timezone: string;
      service_name: string; service_slug: string; rebook: boolean; visibility: string; service_active: boolean;
      business_name: string; business_slug: string; link_expired: boolean;
    }>(sql`
      select appointment.status, appointment.patient_id, appointment.starts_at, location.timezone,
             service.name as service_name, service.slug as service_slug, service.rebook_from_old_link as rebook,
             service.visibility, service.is_active as service_active,
             tenant.name as business_name, tenant.slug as business_slug,
             coalesce(appointment.manage_token_expires_at <= now(), false) as link_expired
      from appointments as appointment
      join services as service on service.tenant_id = appointment.tenant_id and service.id = appointment.service_id
      join locations as location on location.tenant_id = appointment.tenant_id and location.id = appointment.location_id
      join tenants as tenant on tenant.id = appointment.tenant_id
      where appointment.tenant_id = ${match.tenant_id} and appointment.id = ${match.appointment_id}
    `);
    const row = rows[0];
    if (!row) return null;
    // Once the live link has expired (30 days after the visit), the old one stops showing the time too.
    const sameCustomerStillHasIt = row.patient_id === match.patient_id && activeStatuses.includes(row.status) && !row.link_expired;
    // A hidden service still books from its own link, so it keeps its button; only a switched-off or deleted one loses it.
    const canRebook = row.rebook && row.service_active;
    return {
      tenantId: match.tenant_id,
      profile: await loadBusinessProfileIn(transaction, match.tenant_id),
      businessName: row.business_name,
      serviceName: row.service_name,
      bookAgainPath: canRebook ? `/book/${row.business_slug}/${row.service_slug}` : null,
      newTime: sameCustomerStillHasIt ? { startsAt: new Date(row.starts_at).toISOString(), timezone: row.timezone } : null,
    };
  });
}
