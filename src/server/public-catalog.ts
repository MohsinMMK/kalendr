import { afterBookingModes, type PublicAfterBooking } from "@/lib/after-booking";
import { approvalRules, type ApprovalSettings } from "@/lib/approval";
import type { CancelPolicy } from "@/lib/cancel-policy";
import { contactModes, type IntakeSettings } from "@/lib/booking-intake";
import { bookingLayouts, clockModes, type BookingPageSettings } from "@/lib/booking-page";
import "server-only";

import { sql } from "drizzle-orm";

import { getDatabase, withTenant } from "@/db/client";
import { demoClinic, demoLocations, demoSlots } from "@/lib/demo-data";
import { previewResourcesFor, previewServicesFor, previewTeamFor } from "@/lib/preview-sample";
import { parseStoredGuide, publicGuide } from "@/lib/booking-guide";
import { mediaUrl } from "@/lib/media";
import type { Clinic, Location, Practitioner, Resource, Service } from "@/lib/domain";
import type { ServiceLength, ServiceLocationOption } from "@/lib/service-setup";
import type { ClinicCatalog } from "@/lib/staff-snapshot";
import { resolveBusinessProfile } from "@/lib/terminology";
import { orderServices } from "@/lib/workspace-layout";

import { previewBusinessClinic, profileFromRow, publicProfileFields, storedProfileFields, type BusinessProfileRow } from "./business-profile";
import { loadPublicFormsIn, previewPublicForms } from "./booking-forms";
import { previewGuide } from "./booking-guide";
import { loadMediaUrlsIn } from "./media";
import { effectiveBrand } from "./brand";
import { loadEntitlements } from "./entitlements";
import { quoteCatalog } from "./payments/quote";
import { loadWorkspaceLayout } from "./workspace-layout";
import { loadRatingSummariesIn, previewRatingSummaries } from "./reviews";
import { isPreviewMode } from "./preview-repository";
import { videoMode } from "./video";

export type PublicClinicCatalog = ClinicCatalog;

interface TenantRow extends Record<string, unknown> {
  tenant_id: string;
  slug: string;
  name: string;
  legal_name: string;
  phone: string;
  email: string;
  timezone: string;
  locale: string;
}

/** The stored business type and overrides, cleaned so a hand-edited row can't put odd values on screen. Customers don't get the staff role names. */
function clinicProfileFields(row: BusinessProfileRow | undefined, forStaff: boolean): Pick<Clinic, "businessType" | "terminology" | "features"> {
  if (!row) return {};
  const profile = profileFromRow(row);
  return forStaff ? storedProfileFields(profile) : publicProfileFields(profile);
}

interface LocationRow extends Record<string, unknown> {
  id: string;
  name: string;
  address: string;
  city: string;
  timezone: string;
  accessible_entrance: boolean;
  is_active: boolean;
}

interface ServiceRow extends Record<string, unknown> {
  id: string;
  name: string;
  description: string;
  duration_minutes: number;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  booking_mode: Service["bookingMode"];
  patient_types: Service["patientTypes"];
  required_resource_kind: Resource["kind"] | null;
  price_label: string | null;
  category: string | null;
  is_active: boolean;
  price_minor: number | null;
  payment_mode: "none" | "deposit" | "full";
  deposit_minor: number | null;
  slug: string;
  visibility: "listed" | "hidden";
  version: number;
  color_light: Service["colorLight"];
  color_dark: Service["colorDark"];
  banner_media_id: string | null;
  layouts_enabled: string[];
  default_layout: string;
  lock_timezone: boolean;
  week_start: number | null;
  allow_guests: boolean;
  after_booking: string;
  success_message: string | null;
  hide_success_details: boolean;
  max_guests: number;
  contact_mode: string;
  verify_email: boolean;
  approval_rule: string;
  approval_notice_hours: number;
  requests_hold_slot: boolean;
  hide_location_until_confirmed: boolean;
  allow_customer_cancel: boolean;
  allow_customer_reschedule: boolean;
  cancel_cutoff_minutes: number;
  reschedule_cutoff_minutes: number;
  reschedule_same_person: boolean;
  reschedule_request_days: number;
  assignment: "customer_chooses" | "any_available" | "round_robin";
  kind: "appointment" | "class";
}

interface PractitionerRow extends Record<string, unknown> {
  id: string;
  name: string;
  title: string;
  initials: string;
  specialty: string;
  is_active: boolean;
  photo_data_url: string | null;
  bio: string | null;
  qualifications: string | null;
  experience_years: number | null;
  languages: string | null;
  phone?: string | null;
  registration_number?: string | null;
}

interface ResourceRow extends Record<string, unknown> {
  id: string;
  location_id: string;
  name: string;
  kind: Resource["kind"];
  is_active: boolean;
}

interface LinkRow extends Record<string, unknown> {
  owner_id: string;
  related_id: string;
}

function intakeFromRow(row: ServiceRow): IntakeSettings {
  return {
    contactMode: contactModes.find((mode) => mode === row.contact_mode) ?? "email_or_phone",
    allowGuests: row.allow_guests,
    maxGuests: Math.min(Math.max(row.max_guests, 1), 10),
    verifyEmail: row.verify_email,
  };
}

function afterBookingFromRow(row: ServiceRow): PublicAfterBooking {
  return {
    mode: afterBookingModes.find((mode) => mode === row.after_booking) ?? "kalendr_page",
    successMessage: row.success_message,
    hideDetails: row.hide_success_details,
  };
}

function approvalFromRow(row: ServiceRow): ApprovalSettings {
  return {
    rule: approvalRules.find((rule) => rule === row.approval_rule) ?? "never",
    noticeHours: Math.min(Math.max(row.approval_notice_hours, 1), 720),
    requestsHoldSlot: row.requests_hold_slot,
    hideLocationUntilConfirmed: row.hide_location_until_confirmed,
  };
}

function cancelPolicyFromRow(row: ServiceRow): CancelPolicy {
  return {
    allowCustomerCancel: row.allow_customer_cancel,
    allowCustomerReschedule: row.allow_customer_reschedule,
    cancelCutoffMinutes: row.cancel_cutoff_minutes,
    rescheduleCutoffMinutes: row.reschedule_cutoff_minutes,
    rescheduleSamePerson: row.reschedule_same_person,
    rescheduleRequestDays: row.reschedule_request_days,
  };
}

function bookingPageFromRow(row: ServiceRow): BookingPageSettings {
  const layoutsEnabled = bookingLayouts.filter((layout) => row.layouts_enabled.includes(layout));
  const enabled = layoutsEnabled.length > 0 ? layoutsEnabled : [...bookingLayouts];
  return {
    layoutsEnabled: enabled,
    defaultLayout: enabled.find((layout) => layout === row.default_layout) ?? enabled[0] ?? "month",
    lockTimezone: row.lock_timezone,
    weekStart: row.week_start === 7 ? 7 : row.week_start === 1 ? 1 : null,
  };
}

function indexRelationships(rows: LinkRow[], allowedIds: Set<string>): Map<string, string[]> {
  const relationships = new Map<string, string[]>();
  for (const row of rows) {
    if (!allowedIds.has(row.related_id)) continue;
    const relatedIds = relationships.get(row.owner_id);
    if (relatedIds) relatedIds.push(row.related_id);
    else relationships.set(row.owner_id, [row.related_id]);
  }
  return relationships;
}

/** The preview's sample description, in words that suit any business. */
function previewAbout(name: string): string {
  return `${name} is a friendly local team. Book online in a minute, get a reminder before your visit, and change or cancel from the link in your confirmation.`;
}

export async function getPublicClinicCatalog(
  slug: string,
  options?: {
    includeInactive?: boolean;
    /** The staff app reads the catalog too; only it receives the business's role names. */
    forStaff?: boolean;
    /** A hidden service is left out of the catalog unless this is its link name. */
    includeHiddenSlug?: string;
  },
): Promise<PublicClinicCatalog | null> {
  if (isPreviewMode()) {
    if (slug !== demoClinic.slug) return null;
    const clinic = await previewBusinessClinic();
    const previewClinic: Clinic = { ...clinic, about: clinic.about ?? previewAbout(clinic.name) };
    const previewServices = previewServicesFor(clinic);
    return { clinic: previewClinic, profile: resolveBusinessProfile(previewClinic), locations: demoLocations, services: previewServices, practitioners: previewTeamFor(clinic), resources: previewResourcesFor(clinic), initialSlots: demoSlots, preview: true, forms: previewPublicForms(), ...(options?.includeInactive ? {} : { ratings: previewRatingSummaries(), guide: publicGuide(previewGuide(clinic, previewServices), previewServices.map((service) => service.id)) }) };
  }
  const database = getDatabase();
  if (!database) throw new Error("DATABASE_URL is required for public booking");
  const resolved = await database.execute<TenantRow>(sql`select * from kalendr_resolve_tenant(${slug}, null)`);
  const tenant = resolved[0];
  if (!tenant) return null;
  const includeInactive = options?.includeInactive === true;
  const activeOnly = includeInactive ? sql`` : sql`and is_active`;

  // The business's own service order, read apart from the catalog so a database without the layout column still serves the page.
  const layout = await loadWorkspaceLayout({ tenantId: tenant.tenant_id, preview: false });

  return withTenant(tenant.tenant_id, async (transaction) => {
    const [profileRow] = await transaction.execute<BusinessProfileRow & { currency?: string; default_clock?: string; week_start?: number; paused_at?: Date | null; brand?: unknown }>(sql`
      select business_type, terminology, features, about, guide, currency, default_clock, week_start, paused_at, brand from tenants where id = ${tenant.tenant_id}
    `);
    // A paused business (feature 15) has no public page; staff reading their own catalog (includeInactive) still do.
    if (profileRow?.paused_at && !includeInactive) return null;
    const locationRows = await transaction.execute<LocationRow>(sql`
      select id, name, address, city, timezone, accessible_entrance, is_active
      from locations where tenant_id = ${tenant.tenant_id} ${activeOnly} order by name
    `);
    const serviceRows = await transaction.execute<ServiceRow>(sql`
      select id, name, description, duration_minutes, buffer_before_minutes,
        buffer_after_minutes, booking_mode, patient_types, required_resource_kind, price_label, category, is_active,
        price_minor, payment_mode, deposit_minor, slug, visibility, version, color_light, color_dark, banner_media_id,
        layouts_enabled, default_layout, lock_timezone, week_start, allow_guests, max_guests, contact_mode, verify_email, after_booking, success_message, hide_success_details,
        approval_rule, approval_notice_hours, requests_hold_slot, hide_location_until_confirmed,
        allow_customer_cancel, allow_customer_reschedule, cancel_cutoff_minutes, reschedule_cutoff_minutes, reschedule_same_person, reschedule_request_days, assignment, kind
      from services where tenant_id = ${tenant.tenant_id} ${activeOnly} order by name
    `);
    const practitionerRows = await transaction.execute<PractitionerRow>(sql`
      select id, name, title, initials, specialty, is_active, photo_data_url, bio, qualifications,
        experience_years, languages ${includeInactive ? sql`, phone, registration_number` : sql``}
      from practitioners where tenant_id = ${tenant.tenant_id} ${activeOnly} order by name
    `);
    const resourceRows = await transaction.execute<ResourceRow>(sql`
      select resource.id, resource.location_id, resource.name, resource.kind, (resource.is_active and location.is_active) as is_active
      from resources as resource
      join locations as location on location.tenant_id = resource.tenant_id and location.id = resource.location_id
      where resource.tenant_id = ${tenant.tenant_id}
        ${includeInactive ? sql`` : sql`and resource.is_active and location.is_active`}
      order by resource.name
    `);
    const serviceLocationRows = await transaction.execute<LinkRow>(sql`
      select service_id as owner_id, location_id as related_id from service_locations
      where tenant_id = ${tenant.tenant_id}
    `);
    const practitionerServiceRows = await transaction.execute<LinkRow>(sql`
      select service_id as owner_id, practitioner_id as related_id from practitioner_services
      where tenant_id = ${tenant.tenant_id}
    `);
    const practitionerLocationRows = await transaction.execute<LinkRow>(sql`
      select practitioner_id as owner_id, location_id as related_id from practitioner_locations
      where tenant_id = ${tenant.tenant_id}
    `);
    const lengthRows = await transaction.execute<{ service_id: string; minutes: number; price_minor: number | null; is_default: boolean }>(sql`
      select service_id, minutes, price_minor, is_default from service_durations
      where tenant_id = ${tenant.tenant_id} order by service_id, sort_order, minutes
    `);
    const optionRows = await transaction.execute<{ service_id: string; kind: ServiceLocationOption["kind"]; location_id: string | null; note: string | null }>(sql`
      select service_id, kind, location_id, note from service_location_options
      where tenant_id = ${tenant.tenant_id} order by service_id, sort_order
    `);
    const lengthsByService = new Map<string, ServiceLength[]>();
    for (const row of lengthRows) {
      const list = lengthsByService.get(row.service_id) ?? [];
      list.push({ minutes: row.minutes, priceMinor: row.price_minor, isDefault: row.is_default });
      lengthsByService.set(row.service_id, list);
    }
    const optionsByService = new Map<string, ServiceLocationOption[]>();
    for (const row of optionRows) {
      const list = optionsByService.get(row.service_id) ?? [];
      list.push({ kind: row.kind, locationId: row.location_id, note: row.note });
      optionsByService.set(row.service_id, list);
    }
    const activeLocationIds = new Set(locationRows.map((row) => row.id));
    const activePractitionerIds = new Set(practitionerRows.map((row) => row.id));
    const serviceLocations = indexRelationships(serviceLocationRows, activeLocationIds);
    const servicePractitioners = indexRelationships(practitionerServiceRows, activePractitionerIds);
    const practitionerLocations = indexRelationships(practitionerLocationRows, activeLocationIds);
    const media = await loadMediaUrlsIn(transaction, tenant.tenant_id, tenant.slug);
    const clinic: Clinic = { id: tenant.tenant_id, slug: tenant.slug, name: tenant.name, legalName: tenant.legal_name, phone: tenant.phone, email: tenant.email, timezone: tenant.timezone, locale: tenant.locale, ...clinicProfileFields(profileRow, options?.forStaff === true), logoUrl: media.logoUrl, coverUrl: media.coverUrl, about: typeof profileRow?.about === "string" ? profileRow.about : null, currency: profileRow?.currency ?? "INR", defaultClock: clockModes.find((mode) => mode === profileRow?.default_clock) ?? "auto", weekStart: profileRow?.week_start === 7 ? 7 : 1, brand: effectiveBrand(profileRow?.brand, (await loadEntitlements(tenant.tenant_id, transaction)).entitlements) };
    const paymentByService = await quoteCatalog(transaction, tenant.tenant_id);
    // Classes (feature 18) are booked seat by seat from the timetable, never through the one-to-one flow.
    const mappedServices = serviceRows.filter((row) => row.kind !== "class").map((row): Service => ({ id: row.id, clinicId: tenant.tenant_id, name: row.name, description: row.description, durationMinutes: row.duration_minutes, bufferBeforeMinutes: row.buffer_before_minutes, bufferAfterMinutes: row.buffer_after_minutes, bookingMode: row.booking_mode, patientTypes: row.patient_types, practitionerIds: servicePractitioners.get(row.id) ?? [], locationIds: serviceLocations.get(row.id) ?? [], isActive: row.is_active, ...(row.required_resource_kind ? { resourceKind: row.required_resource_kind } : {}), ...(row.price_label ? { priceLabel: row.price_label } : {}), priceMinor: row.price_minor, paymentMode: row.payment_mode, depositMinor: row.deposit_minor, payment: paymentByService.get(row.id) ?? null, ...(row.category ? { category: row.category } : {}), imageUrl: media.serviceImages.get(row.id) ?? null, slug: row.slug, visibility: row.visibility, afterBooking: afterBookingFromRow(row), assignment: row.assignment, version: row.version, colorLight: row.color_light, colorDark: row.color_dark, bannerUrl: row.banner_media_id ? mediaUrl(tenant.slug, row.banner_media_id) : null, bookingPage: bookingPageFromRow(row), intake: intakeFromRow(row), approval: approvalFromRow(row), cancelPolicy: cancelPolicyFromRow(row), lengths: lengthsByService.get(row.id) ?? [{ minutes: row.duration_minutes, priceMinor: row.price_minor, isDefault: true }], locationOptions: withoutVideoWhenOff(optionsByService.get(row.id) ?? (serviceLocations.get(row.id) ?? []).map((locationId) => ({ kind: "in_person" as const, locationId, note: null }))) }));
    const hiddenSlug = options?.includeHiddenSlug;
    const bookableServices = orderServices(mappedServices, layout).filter((service) => service.practitionerIds.length > 0 && service.locationIds.length > 0 && (service.visibility !== "hidden" || service.slug === hiddenSlug));
    // The guide and the business page list only services open to everyone, never the one reached by its own link.
    const listedServiceIds = bookableServices.filter((service) => service.visibility !== "hidden").map((service) => service.id);
    return {
      clinic,
      profile: resolveBusinessProfile(clinic),
      locations: locationRows.map((row): Location => ({ id: row.id, clinicId: tenant.tenant_id, name: row.name, address: row.address, city: row.city, timezone: row.timezone, accessibleEntrance: row.accessible_entrance, isActive: row.is_active })),
      services: includeInactive ? orderServices(mappedServices, layout) : bookableServices,
      practitioners: practitionerRows.map((row): Practitioner => ({ id: row.id, clinicId: tenant.tenant_id, name: row.name, title: row.title, initials: row.initials, specialty: row.specialty, isActive: row.is_active, locationIds: practitionerLocations.get(row.id) ?? [], photoUrl: media.practitionerPhotos.get(row.id) ?? row.photo_data_url, bio: row.bio, qualifications: row.qualifications, experienceYears: row.experience_years, languages: row.languages, ...(includeInactive ? { phone: row.phone ?? null, registrationNumber: row.registration_number ?? null } : {}) })),
      resources: resourceRows.map((row): Resource => ({ id: row.id, locationId: row.location_id, name: row.name, kind: row.kind, isActive: row.is_active })),
      initialSlots: [],
      preview: false,
      ...(includeInactive ? {} : { forms: await loadPublicFormsIn(transaction, tenant.tenant_id), ratings: await loadRatingSummariesIn(transaction, tenant.tenant_id), guide: publicGuide(parseStoredGuide(profileRow?.guide), listedServiceIds) }),
    };
  });
}

/** A video option is hidden when this server has no video provider; a service left with nothing keeps its list so the booking is refused clearly. */
function withoutVideoWhenOff(options: ServiceLocationOption[]): ServiceLocationOption[] {
  if (videoMode() !== "off") return options;
  const kept = options.filter((option) => option.kind !== "video");
  return kept.length > 0 ? kept : options;
}
