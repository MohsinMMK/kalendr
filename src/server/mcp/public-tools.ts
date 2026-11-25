import "server-only";

import { z } from "zod";

import { ApiError } from "@/server/api-error";
import { listAvailabilityDetailed } from "@/server/appointment-repository";
import { appOrigin } from "@/server/env";
import { getPublicClinicCatalog, type PublicClinicCatalog } from "@/server/public-catalog";
import { createSlotHold } from "@/server/slot-holds";
import { assertSlugNotPaused } from "@/server/tenant-pause";

/**
 * The tools anyone may use without a key (feature 54). They call the same catalog, availability and hold code the
 * booking page calls, and they return only what that page already shows to a visitor: no customer data, no staff contact details.
 * Starting a booking never books: it holds the time and hands back the link where the customer confirms.
 */

export const businessSchema = z.string().trim().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .describe("The business's link name, the part after /book/ in its booking page address.");
const idSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

export const listServicesInput = { business: businessSchema };
export const listPeopleInput = { business: businessSchema, serviceId: idSchema.optional().describe("Only people who take this service.") };
export const findTimesInput = {
  business: businessSchema,
  serviceId: idSchema,
  from: z.iso.datetime({ offset: true }).optional().describe("Start of the window. Defaults to now."),
  to: z.iso.datetime({ offset: true }).optional().describe("End of the window. At most 14 days after `from`; defaults to 7 days."),
  personId: idSchema.optional().describe("Only this person's times. Defaults to anyone available."),
  locationId: idSchema.optional(),
};
export const startBookingInput = {
  business: businessSchema,
  serviceId: idSchema,
  personId: idSchema,
  startsAt: z.iso.datetime({ offset: true }).describe("The `startsAt` of a time returned by find_open_times."),
  locationId: idSchema.optional(),
};

const MAX_WINDOW_DAYS = 14;
const DAY_MS = 86_400_000;
const MAX_TIMES = 60;

async function catalogOf(business: string): Promise<PublicClinicCatalog> {
  await assertSlugNotPaused(business);
  const catalog = await getPublicClinicCatalog(business);
  if (!catalog) throw new ApiError(404, "clinic_not_found", "Business not found.");
  return catalog;
}

export async function listServicesTool(input: { business: string }) {
  const catalog = await catalogOf(input.business);
  return {
    business: { name: catalog.clinic.name, timezone: catalog.clinic.timezone },
    services: catalog.services.filter((service) => service.isActive !== false).map((service) => ({
      id: service.id, name: service.name, description: service.description, durationMinutes: service.durationMinutes,
      priceLabel: service.priceLabel ?? null, priceMinor: service.priceMinor ?? null, category: service.category ?? null,
      personIds: service.practitionerIds, locationIds: service.locationIds,
    })),
  };
}

export async function listPeopleTool(input: { business: string; serviceId?: string | undefined }) {
  const catalog = await catalogOf(input.business);
  const service = input.serviceId ? catalog.services.find((entry) => entry.id === input.serviceId) : undefined;
  if (input.serviceId && !service) throw new ApiError(404, "service_not_found", "Service not found.");
  return {
    people: catalog.practitioners
      .filter((person) => person.isActive !== false && (!service || service.practitionerIds.includes(person.id)))
      .map((person) => ({ id: person.id, name: person.name, title: person.title, specialty: person.specialty })),
  };
}

function pickLocation(catalog: PublicClinicCatalog, serviceId: string, requested: string | undefined): { locationId: string; timezone: string } {
  const service = catalog.services.find((entry) => entry.id === serviceId && entry.isActive !== false);
  if (!service) throw new ApiError(404, "service_not_found", "Service not found.");
  const options = catalog.locations.filter((place) => place.isActive !== false && (service.locationIds.length === 0 || service.locationIds.includes(place.id)));
  const chosen = requested ? options.find((place) => place.id === requested) : options[0];
  if (!chosen) throw new ApiError(404, "location_not_found", "Location not found for this service.");
  return { locationId: chosen.id, timezone: chosen.timezone || catalog.clinic.timezone };
}

export async function findOpenTimesTool(input: { business: string; serviceId: string; from?: string | undefined; to?: string | undefined; personId?: string | undefined; locationId?: string | undefined }) {
  const catalog = await catalogOf(input.business);
  const place = pickLocation(catalog, input.serviceId, input.locationId);
  const from = input.from ? new Date(input.from) : new Date();
  const to = input.to ? new Date(input.to) : new Date(from.getTime() + 7 * DAY_MS);
  if (to <= from) throw new ApiError(400, "validation_error", "`to` must be after `from`.");
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
    throw new ApiError(400, "validation_error", `Ask for at most ${MAX_WINDOW_DAYS} days at a time.`);
  }
  const listing = await listAvailabilityDetailed({
    clinicSlug: input.business, locationId: place.locationId, serviceId: input.serviceId,
    practitionerId: input.personId ?? "first_available", from: from.toISOString(), to: to.toISOString(),
  });
  const names = new Map(catalog.practitioners.map((person) => [person.id, person.name]));
  return {
    timezone: place.timezone,
    locationId: place.locationId,
    times: listing.slots.slice(0, MAX_TIMES).map((slot) => ({
      startsAt: slot.startsAt, endsAt: slot.endsAt, personId: slot.practitionerId, personName: names.get(slot.practitionerId) ?? null,
    })),
    truncated: listing.slots.length > MAX_TIMES,
  };
}

/** `YYYY-MM-DD` of a moment in a time zone, for the booking page's `date` hint. */
function localDay(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

export async function startBookingTool(input: { business: string; serviceId: string; personId: string; startsAt: string; locationId?: string | undefined }) {
  const catalog = await catalogOf(input.business);
  const place = pickLocation(catalog, input.serviceId, input.locationId);
  const service = catalog.services.find((entry) => entry.id === input.serviceId);
  if (!service?.slug) throw new ApiError(409, "service_not_bookable", "This service cannot be booked online.");
  const startsAt = new Date(input.startsAt);
  // The time must be one the booking page would offer, so an assistant cannot invent a slot.
  const listing = await listAvailabilityDetailed({
    clinicSlug: input.business, locationId: place.locationId, serviceId: input.serviceId, practitionerId: input.personId,
    from: new Date(startsAt.getTime() - 60_000).toISOString(), to: new Date(startsAt.getTime() + 24 * 3_600_000).toISOString(),
  });
  const slot = listing.slots.find((entry) => entry.practitionerId === input.personId && new Date(entry.startsAt).getTime() === startsAt.getTime());
  if (!slot) throw new ApiError(409, "slot_unavailable", "That time is not available. Ask for open times again.");
  const hold = await createSlotHold({
    clinicSlug: input.business, locationId: place.locationId, serviceId: input.serviceId, practitionerId: input.personId,
    startsAt: slot.startsAt, endsAt: slot.endsAt,
  });
  const link = new URL(`/book/${encodeURIComponent(input.business)}/${encodeURIComponent(service.slug)}`, appOrigin());
  link.searchParams.set("person", input.personId);
  link.searchParams.set("date", localDay(startsAt, place.timezone));
  link.searchParams.set("time", slot.startsAt);
  link.searchParams.set("utm_source", "mcp");
  // The booking page swaps this hold for the customer's own, so the time held for them never blocks them.
  link.searchParams.set("hold", hold.holdToken);
  return {
    status: "awaiting_customer_confirmation",
    bookingLink: link.toString(),
    heldUntil: hold.expiresAt,
    instructions: "Give this link to the customer. The booking is made only when they open it, check the details and confirm. The time is held for them until heldUntil.",
  };
}

/**
 * Everything a website component needs to start: the business, its places, services and people, in one answer
 * (served at /api/public/catalog for the Booker component). The same trimmed shape the tools return.
 */
export async function publicCatalogSummary(business: string) {
  const catalog = await catalogOf(business);
  const { services } = await listServicesTool({ business });
  const { people } = await listPeopleTool({ business });
  return {
    business: { name: catalog.clinic.name, timezone: catalog.clinic.timezone },
    locations: catalog.locations.filter((place) => place.isActive !== false).map((place) => ({ id: place.id, name: place.name, timezone: place.timezone })),
    services,
    people,
  };
}
