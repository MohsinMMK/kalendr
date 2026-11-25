import "server-only";

import { and, eq, gte, isNull, lte, or, sql } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { availabilityRules } from "@/db/schema";
import {
  NEXT_FREE_DAYS_WINDOW,
  dateKeyIn,
  freeDayQueries,
  freeDaysFromTimes,
  freeTimesByPerson,
  mergeFreeTimes,
  openingHoursFromRules,
  type FreeTimes,
  type WeekHours,
} from "@/lib/business-page";
import type { PublicReview } from "@/lib/reviews";
import type { ClinicCatalog } from "@/lib/staff-snapshot";

import { listAvailability } from "./appointment-repository";
import { listPublicReviews } from "./reviews";

const day = 24 * 60 * 60 * 1000;

/** The preview's sample hours: Monday to Saturday, 9 to 6. */
const previewWeek: WeekHours = [0, 1, 2, 3, 4, 5, 6].map((index) => (index < 6 ? { opens: "09:00", closes: "18:00" } : null));

/** Opening hours per location, from the team's current working hours. */
export async function loadOpeningHours(catalog: ClinicCatalog, now: Date = new Date()): Promise<Record<string, WeekHours>> {
  if (catalog.preview) {
    return Object.fromEntries(catalog.locations.map((location) => [location.id, previewWeek]));
  }
  const tenantId = catalog.clinic.id;
  const today = dateKeyIn(now, catalog.clinic.timezone);
  const activePeople = new Set(catalog.practitioners.map((person) => person.id));
  const rules = await withTenant(tenantId, (transaction) =>
    transaction
      .select({
        locationId: availabilityRules.locationId,
        practitionerId: availabilityRules.practitionerId,
        dayOfWeek: availabilityRules.dayOfWeek,
        startsAtLocal: availabilityRules.startsAtLocal,
        endsAtLocal: availabilityRules.endsAtLocal,
      })
      .from(availabilityRules)
      .where(
        and(
          eq(availabilityRules.tenantId, tenantId),
          eq(availabilityRules.isActive, true),
          lte(availabilityRules.validFrom, today),
          or(isNull(availabilityRules.validThrough), gte(availabilityRules.validThrough, today)),
          // The business page shows usual hours: each person's default schedule, not a seasonal or home-visit one.
          sql`exists (select 1 from availability_schedules as schedule where schedule.tenant_id = ${availabilityRules.tenantId} and schedule.id = ${availabilityRules.scheduleId} and schedule.is_default)`,
        ),
      ),
  );
  return openingHoursFromRules(rules.filter((rule) => activePeople.has(rule.practitionerId)));
}

interface FreeTimesCacheEntry {
  expiresAt: number;
  value: Promise<FreeTimes>;
}

interface FreeTimesGlobals {
  kalendrFreeTimesCache?: Map<string, FreeTimesCacheEntry>;
}

const FREE_TIMES_TTL = 60 * 1000;

function freeTimesCache(): Map<string, FreeTimesCacheEntry> {
  const globals = globalThis as typeof globalThis & FreeTimesGlobals;
  globals.kalendrFreeTimesCache ??= new Map();
  return globals.kalendrFreeTimesCache;
}

/** Sample free times for the preview: the coming week except Sunday, a little different for each person. */
function previewFreeTimes(catalog: ClinicCatalog, now: Date): FreeTimes {
  const times: FreeTimes = {};
  catalog.practitioners.forEach((person, index) => {
    const days: Record<string, number> = {};
    for (let offset = 1 + (index % 2); offset <= NEXT_FREE_DAYS_WINDOW; offset += 1) {
      const date = new Date(now.getTime() + offset * day);
      const weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: catalog.clinic.timezone }).format(date);
      if (weekday !== "Sun") days[dateKeyIn(date, catalog.clinic.timezone)] = 2 + ((index * 5 + offset * 3) % 7);
    }
    times[person.id] = days;
  });
  return times;
}

/**
 * How many free times each team member has on each day, up to a week ahead. Counted with one of the
 * services each person offers, so a much longer service can have fewer. Cached for a minute per
 * business, since every visit to the page would otherwise search the whole week again. A search that
 * fails is left out, so the page still shows.
 */
export async function loadFreeTimes(catalog: ClinicCatalog, now: Date = new Date()): Promise<FreeTimes> {
  if (catalog.preview) return previewFreeTimes(catalog, now);
  const key = catalog.clinic.slug;
  const cache = freeTimesCache();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now.getTime()) return cached.value;

  const queries = freeDayQueries(catalog.services, catalog.locations);
  const from = now.toISOString();
  const to = new Date(now.getTime() + NEXT_FREE_DAYS_WINDOW * day).toISOString();
  const value = Promise.all(
    queries.map(async (query) => {
      const location = catalog.locations.find((entry) => entry.id === query.locationId);
      try {
        const slots = await listAvailability({ clinicSlug: catalog.clinic.slug, locationId: query.locationId, serviceId: query.serviceId, practitionerId: "first_available", from, to });
        return freeTimesByPerson(slots, location?.timezone ?? catalog.clinic.timezone);
      } catch {
        return {};
      }
    }),
  ).then((parts) => mergeFreeTimes(parts));
  cache.set(key, { expiresAt: now.getTime() + FREE_TIMES_TTL, value });
  // Keep the map small: drop anything expired.
  for (const [entryKey, entry] of cache) if (entry.expiresAt <= now.getTime()) cache.delete(entryKey);
  return value;
}

interface NextOpeningEntry { expiresAt: number; value: Promise<Record<string, string>> }
interface NextOpeningGlobals { kalendrNextOpeningCache?: Map<string, NextOpeningEntry> }

/**
 * The soonest free start for each team member, as a UTC time, within a week. Like `loadFreeTimes`, each person is
 * searched through one of the services they offer, and the answer is kept for a minute. A search that fails is left out.
 */
export async function loadNextOpenings(catalog: ClinicCatalog, now: Date = new Date()): Promise<Record<string, string>> {
  if (catalog.preview) {
    return Object.fromEntries(catalog.practitioners.map((person, index) => [person.id, new Date(now.getTime() + (index + 1) * 3_600_000 + day).toISOString()]));
  }
  const globals = globalThis as typeof globalThis & NextOpeningGlobals;
  const cache = (globals.kalendrNextOpeningCache ??= new Map());
  const cached = cache.get(catalog.clinic.slug);
  if (cached && cached.expiresAt > now.getTime()) return cached.value;
  const queries = freeDayQueries(catalog.services, catalog.locations);
  const from = now.toISOString();
  const to = new Date(now.getTime() + NEXT_FREE_DAYS_WINDOW * day).toISOString();
  const value = Promise.all(queries.map(async (query) => {
    try {
      return await listAvailability({ clinicSlug: catalog.clinic.slug, locationId: query.locationId, serviceId: query.serviceId, practitionerId: "first_available", from, to });
    } catch {
      return [];
    }
  })).then((lists) => {
    const earliest: Record<string, string> = {};
    for (const slot of lists.flat()) {
      const current = earliest[slot.practitionerId];
      if (!current || slot.startsAt < current) earliest[slot.practitionerId] = slot.startsAt;
    }
    return earliest;
  });
  cache.set(catalog.clinic.slug, { expiresAt: now.getTime() + FREE_TIMES_TTL, value });
  for (const [key, entry] of cache) if (entry.expiresAt <= now.getTime()) cache.delete(key);
  return value;
}

/** The next few days each team member has a free time, up to a week ahead. */
export async function loadNextFreeDays(catalog: ClinicCatalog, now: Date = new Date()): Promise<Record<string, string[]>> {
  return freeDaysFromTimes(await loadFreeTimes(catalog, now));
}

/** Latest published reviews; an empty list if they can't be loaded. */
export async function loadLatestReviews(catalog: ClinicCatalog, options: { practitionerId?: string; limit?: number } = {}): Promise<PublicReview[]> {
  try {
    return await listPublicReviews(catalog.clinic.id, options);
  } catch {
    return [];
  }
}
