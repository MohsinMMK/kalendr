import "server-only";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { getDatabase, withTenant } from "@/db/client";
import { joinFullName } from "@/features/booking/full-name";
import { WAITLIST_MAX_ACTIVE_PER_CUSTOMER, WAITLIST_MAX_DAYS, type PublicWaitlistInput, type WaitlistJoinResult } from "@/lib/waitlist-contracts";
import { profileWords } from "@/lib/terminology";

import { ApiError } from "./api-error";
import { loadBusinessProfileIn } from "./business-profile";
import { assertNotBlocked } from "./customers/block";
import { findBlockMatch } from "./spam-check";
import { localDateOf, addDays } from "./slot-engine/time";
import { applyFormMessagingConsentIn } from "./privacy/consent";

/** A list of ids as a text[] value. A drizzle array parameter would be spread into separate values, so this goes through JSON. */
function textArray(values: readonly string[]) {
  return sql`array(select jsonb_array_elements_text(${JSON.stringify(values)}::text::jsonb))`;
}

async function tenantOf(slug: string): Promise<string> {
  const database = getDatabase();
  if (!database) throw new ApiError(503, "database_unavailable", "The waitlist is not available right now. Please try again shortly.");
  const [tenant] = await database.execute<{ tenant_id: string }>(sql`select tenant_id from kalendr_resolve_tenant(${slug}, null)`);
  if (!tenant) throw new ApiError(404, "clinic_not_found", "Business not found.");
  return tenant.tenant_id;
}

/**
 * Puts a customer on the waitlist from the booking page. The service, place and people are checked against what the
 * business really offers, the dates against today and the longest wait, and a customer already waiting for the same
 * service at the same place has that entry updated instead of getting a second one. Only someone who gives the same name,
 * email and phone as an existing customer can see that their request was "updated"; otherwise the reply never says whether a
 * contact was already known. Nothing is sent here.
 */
export async function joinWaitlist(input: PublicWaitlistInput): Promise<WaitlistJoinResult> {
  const tenantId = await tenantOf(input.clinicSlug);
  return withTenant(tenantId, async (transaction) => {
    // Feature 44: a blocked contact gets the usual answer and no entry, so no offer is ever made to them.
    const blockedBy = await findBlockMatch(transaction, tenantId, { email: input.email, phone: input.phone });
    if (blockedBy) {
      await transaction.execute(sql`
        insert into audit_events (tenant_id, actor_type, action, outcome, metadata)
        values (${tenantId}, 'patient', 'waitlist.refused_blocklist', 'refused', ${JSON.stringify({ source: "booking_page", matched: blockedBy })}::text::jsonb)
      `);
      return { entryId: randomUUID(), updated: false };
    }
    // Feature 27: a customer staff blocked cannot join the waitlist online either.
    await assertNotBlocked(transaction, tenantId, { email: input.email, phone: input.phone });
    const t = profileWords(await loadBusinessProfileIn(transaction, tenantId));
    const [offered] = await transaction.execute<{ timezone: string }>(sql`
      select location.timezone from services as service
      join service_locations as service_location on service_location.tenant_id = service.tenant_id and service_location.service_id = service.id and service_location.location_id = ${input.locationId}
      join locations as location on location.tenant_id = service.tenant_id and location.id = ${input.locationId} and location.is_active
      where service.tenant_id = ${tenantId} and service.id = ${input.serviceId} and service.is_active
    `);
    if (!offered) throw new ApiError(400, "validation_error", `Choose ${t.aService} this ${t.business} offers.`, { serviceId: [`Choose ${t.aService} this ${t.business} offers.`] });
    if (input.practitionerIds.length > 0) {
      const people = await transaction.execute<{ id: string }>(sql`
        select practitioner.id from practitioners as practitioner
        join practitioner_services as practitioner_service on practitioner_service.tenant_id = practitioner.tenant_id and practitioner_service.practitioner_id = practitioner.id and practitioner_service.service_id = ${input.serviceId}
        join practitioner_locations as practitioner_location on practitioner_location.tenant_id = practitioner.tenant_id and practitioner_location.practitioner_id = practitioner.id and practitioner_location.location_id = ${input.locationId}
        where practitioner.tenant_id = ${tenantId} and practitioner.is_active
      `);
      const valid = new Set(people.map((person) => person.id));
      if (!input.practitionerIds.every((id) => valid.has(id))) {
        throw new ApiError(400, "validation_error", `Choose ${t.practitioners} who offer this ${t.service}.`, { practitionerIds: [`Choose ${t.practitioners} who offer this ${t.service}.`] });
      }
    }
    const today = localDateOf(Date.now(), offered.timezone);
    if (input.dateFrom < today) throw new ApiError(400, "validation_error", "Choose dates from today onwards.", { dateFrom: ["Choose dates from today onwards."] });
    if (input.dateTo > addDays(today, WAITLIST_MAX_DAYS)) {
      throw new ApiError(400, "validation_error", `Choose dates within the next ${WAITLIST_MAX_DAYS} days.`, { dateTo: [`Choose dates within the next ${WAITLIST_MAX_DAYS} days.`] });
    }

    const consentedAt = new Date().toISOString();
    // The same match a booking makes: a returning customer only when name, email and phone all agree. Saved contact
    // details are never overwritten from a public form.
    const [matched] = await transaction.execute<{ id: string }>(sql`
      select id from patients
      where tenant_id = ${tenantId} and lower(email) = ${input.email.toLowerCase()}
        and kalendr_normalize_phone(phone) = kalendr_normalize_phone(${input.phone})
        and lower(regexp_replace(trim(first_name || ' ' || last_name), '\\s+', ' ', 'g')) = ${joinFullName(input.firstName, input.lastName).toLowerCase()}
        and not is_dependent and erased_at is null
      order by created_at limit 1 for update
    `);
    let patientId = matched?.id;
    if (patientId) {
      await transaction.execute(sql`
        update patients set privacy_accepted_at = ${consentedAt}::timestamptz, updated_at = now()
        where tenant_id = ${tenantId} and id = ${patientId}
      `);
    } else {
      const [created] = await transaction.execute<{ id: string }>(sql`
        insert into patients (tenant_id, first_name, last_name, phone, email, preferred_channel, privacy_accepted_at)
        values (${tenantId}, ${input.firstName}, ${input.lastName}, ${input.phone}, ${input.email.toLowerCase()}, ${input.preferredChannel},
          ${consentedAt}::timestamptz)
        returning id
      `);
      patientId = created?.id;
    }
    if (!patientId) throw new Error("Customer insert returned no row");
    // The messages box goes through the consent ledger (feature 7), which also keeps messaging_consent_at in step.
    await applyFormMessagingConsentIn(transaction, tenantId, patientId, { agreed: input.messagingConsent, match: matched ? "full" : "new" });

    const [existing] = await transaction.execute<{ id: string }>(sql`
      select id from waitlist_entries
      where tenant_id = ${tenantId} and patient_id = ${patientId} and service_id = ${input.serviceId} and location_id = ${input.locationId} and status in ('active', 'offered')
      order by created_at limit 1 for update
    `);
    if (existing) {
      await transaction.execute(sql`
        update waitlist_entries set preferred_practitioner_ids = ${textArray(input.practitionerIds)}, date_from = ${input.dateFrom}::date, date_to = ${input.dateTo}::date,
          time_preference = ${input.timePreference}, updated_at = now()
        where tenant_id = ${tenantId} and id = ${existing.id}
      `);
      await transaction.execute(sql`
        insert into audit_events (tenant_id, actor_type, action, outcome, metadata)
        values (${tenantId}, 'patient', 'waitlist.entry.updated', 'success', ${JSON.stringify({ entryId: existing.id })}::text::jsonb)
      `);
      return { entryId: existing.id, updated: true };
    }
    const [{ count } = { count: 0 }] = await transaction.execute<{ count: number }>(sql`
      select count(*)::int as count from waitlist_entries where tenant_id = ${tenantId} and patient_id = ${patientId} and status in ('active', 'offered')
    `);
    if (Number(count) >= WAITLIST_MAX_ACTIVE_PER_CUSTOMER) {
      throw new ApiError(409, "waitlist_full", `You are already on the waitlist for several ${t.services}. Ask the ${t.business} to remove one first.`);
    }
    const [entry] = await transaction.execute<{ id: string }>(sql`
      insert into waitlist_entries (tenant_id, patient_id, service_id, location_id, preferred_practitioner_ids, date_from, date_to, time_preference)
      values (${tenantId}, ${patientId}, ${input.serviceId}, ${input.locationId}, ${textArray(input.practitionerIds)}, ${input.dateFrom}::date, ${input.dateTo}::date, ${input.timePreference})
      returning id
    `);
    if (!entry) throw new Error("Waitlist insert returned no row");
    await transaction.execute(sql`
      insert into audit_events (tenant_id, actor_type, action, outcome, metadata)
      values (${tenantId}, 'patient', 'waitlist.entry.joined', 'success', ${JSON.stringify({ entryId: entry.id, source: "booking_page" })}::text::jsonb)
    `);
    return { entryId: entry.id, updated: false };
  });
}
