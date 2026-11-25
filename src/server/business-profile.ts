import "server-only";

import { eq, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { cache } from "react";

import { getDatabase, withTenant, type KalendrTransaction } from "@/db/client";
import { auditEvents, tenants } from "@/db/schema";
import { clockModes, type ClockMode } from "@/lib/booking-page";
import { featureLabels, type FeatureKey } from "@/lib/business-types";
import { limitToFeatures } from "@/lib/feature-limits";
import { demoClinic } from "@/lib/demo-data";
import type { Clinic } from "@/lib/domain";
import { parsePreviewBusinessProfile, previewBusinessProfileCookie, previewClinicWith } from "@/lib/preview-business-profile";
import { cleanTerminologyOverrides, defaultBusinessProfile, profileWords, resolveBusinessProfile, storedTerminologyOf, type BusinessProfile, type TermWords } from "@/lib/terminology";

import { ApiError } from "./api-error";
import { isPreviewMode } from "./preview-repository";
import { currentStaffContext, requirePermission, type StaffContext } from "./staff-context";

export interface BusinessProfileRow extends Record<string, unknown> {
  business_type: string;
  terminology: unknown;
  features: unknown;
}

export function profileFromRow(row: BusinessProfileRow | undefined): BusinessProfile {
  if (!row) return defaultBusinessProfile;
  return resolveBusinessProfile({ businessType: row.business_type, terminology: row.terminology, features: row.features });
}

/** The cleaned type and overrides to carry on a `Clinic`, so the browser can resolve the same words. */
export function storedProfileFields(profile: BusinessProfile): Pick<Clinic, "businessType" | "terminology" | "features"> {
  return { businessType: profile.businessType, terminology: storedTerminologyOf(profile), features: profile.featureOverrides };
}

/**
 * The same fields for pages customers see (booking pages, the manage link, the public tools): the business's words, but
 * not its staff role names, which only the team needs.
 */
export function publicProfileFields(profile: BusinessProfile): Pick<Clinic, "businessType" | "terminology" | "features"> {
  const fields = storedProfileFields(profile);
  if (!fields.terminology || !("roles" in fields.terminology)) return fields;
  const terminology = { ...fields.terminology };
  delete terminology.roles;
  return { ...fields, terminology };
}

/** A business profile for a page customers see: the same words, without the staff role names. */
export function customerProfile(profile: BusinessProfile): BusinessProfile {
  return Object.keys(profile.roleNameOverrides).length === 0 ? profile : { ...profile, roleNameOverrides: {} };
}

/** Reads one business's type and overrides inside a tenant transaction. */
export async function loadBusinessProfileIn(transaction: KalendrTransaction, tenantId: string): Promise<BusinessProfile> {
  const [row] = await transaction.execute<BusinessProfileRow>(sql`
    select business_type, terminology, features from tenants where id = ${tenantId}
  `);
  return profileFromRow(row);
}

/** In preview mode the demo business's type comes from a cookie the preview Settings screen writes. */
export async function previewBusinessClinic(): Promise<Clinic> {
  try {
    const store = await cookies();
    return previewClinicWith(parsePreviewBusinessProfile(store.get(previewBusinessProfileCookie)?.value));
  } catch {
    // Outside a request (tests, scripts) there are no cookies.
    return demoClinic;
  }
}

/** The words and features for emails, notifications, calendar files and API errors of one business. */
export async function loadBusinessProfile(tenantId: string): Promise<BusinessProfile> {
  if (isPreviewMode()) return resolveBusinessProfile(await previewBusinessClinic());
  return withTenant(tenantId, (transaction) => loadBusinessProfileIn(transaction, tenantId));
}

/** The profile for a public booking page, found by its slug, without the staff role names. Unknown slugs get the default words. */
export async function loadBusinessProfileBySlug(slug: string): Promise<BusinessProfile> {
  if (isPreviewMode()) return customerProfile(resolveBusinessProfile(await previewBusinessClinic()));
  const database = getDatabase();
  if (!database) return defaultBusinessProfile;
  const [tenant] = await database.execute<{ tenant_id: string }>(sql`select tenant_id from kalendr_resolve_tenant(${slug}, null)`);
  return tenant ? customerProfile(await loadBusinessProfile(tenant.tenant_id)) : defaultBusinessProfile;
}

const featureNames = Object.fromEntries(
  Object.entries(featureLabels).map(([key, value]) => [key, value.label]),
) as Record<FeatureKey, string>;

export function featureOffError(feature: FeatureKey): ApiError {
  return new ApiError(404, "feature_off", `${featureNames[feature]} is turned off for this business.`);
}

/** Refuses a request for a feature the business has switched off. Answers 404 so the route looks absent. */
export async function requireFeature(context: { tenantId: string; preview?: boolean }, feature: FeatureKey): Promise<BusinessProfile> {
  const profile = await loadStaffBusinessProfile(context);
  if (!profile.features[feature]) throw featureOffError(feature);
  return profile;
}

/** Drops fields for switched-off features from a request body, or refuses it. */
export function applyFeatureLimits<T>(input: T, profile: BusinessProfile): T {
  const { value, refused } = limitToFeatures(input, profile.features);
  if (refused) throw new ApiError(422, "feature_off", `${featureNames[refused]} is turned off for this business.`);
  return value;
}

/** The staff member's business profile, from the database or the preview choice. */
export async function loadStaffBusinessProfile(context: { tenantId: string; preview?: boolean }): Promise<BusinessProfile> {
  return context.preview ? resolveBusinessProfile(await previewBusinessClinic()) : loadBusinessProfile(context.tenantId);
}

export interface BusinessProfileInput {
  businessType: string;
  terminology: unknown;
  features: unknown;
  /** The roles this business renamed. Left out keeps the names stored. */
  roleNames?: unknown;
  /** How the booking page writes times. Left out keeps what is stored. */
  defaultClock?: ClockMode;
  /** First day of the week on the booking page. Left out keeps what is stored. */
  weekStart?: 1 | 7;
}

/** The business-wide booking page choices: the clock and the first day of the week. */
export interface BookingPageDefaults {
  defaultClock: ClockMode;
  weekStart: 1 | 7;
}

export const standardBookingPageDefaults: BookingPageDefaults = { defaultClock: "auto", weekStart: 1 };

export function bookingDefaultsFromRow(row: { default_clock?: unknown; week_start?: unknown } | undefined): BookingPageDefaults {
  return {
    defaultClock: clockModes.find((mode) => mode === row?.default_clock) ?? "auto",
    weekStart: row?.week_start === 7 ? 7 : 1,
  };
}

/** The business's clock and week start for the staff settings screen. Preview mode has no stored choice. */
export async function loadBookingPageDefaults(context: StaffContext): Promise<BookingPageDefaults> {
  requirePermission(context, "settings.manage");
  if (context.preview) return standardBookingPageDefaults;
  return withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction.execute<{ default_clock: string; week_start: number }>(sql`
      select default_clock, week_start from tenants where id = ${context.tenantId}
    `);
    return bookingDefaultsFromRow(row);
  });
}

/**
 * Changes the business type, renamed words and switched features. Owners and admins only, and audited.
 * Only the differences from the type's preset are stored, so a later preset change still reaches this business.
 */
export async function updateBusinessProfile(context: StaffContext, input: BusinessProfileInput): Promise<BusinessProfile> {
  requirePermission(context, "settings.manage");
  if (context.role !== "owner" && context.role !== "admin") {
    throw new ApiError(403, "forbidden", "Only the owner or an admin can change the business type and words.");
  }
  const withRoles = (stored: unknown) => resolveBusinessProfile({
    businessType: input.businessType,
    terminology: { ...cleanTerminologyOverrides(input.terminology), roles: input.roleNames ?? stored },
    features: input.features,
  });
  if (context.preview) return withRoles(undefined);
  return withTenant(context.tenantId, async (transaction) => {
    const before = await loadBusinessProfileIn(transaction, context.tenantId);
    const profile = withRoles(before.roleNameOverrides);
    await transaction.update(tenants).set({
      businessType: profile.businessType,
      terminology: storedTerminologyOf(profile),
      features: profile.featureOverrides,
      ...(input.defaultClock ? { defaultClock: input.defaultClock } : {}),
      ...(input.weekStart ? { weekStart: input.weekStart } : {}),
      updatedAt: new Date(),
    }).where(eq(tenants.id, context.tenantId));
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff",
      action: "settings.business_profile", outcome: "success",
      metadata: {
        businessTypeBefore: before.businessType,
        businessType: profile.businessType,
        renamedTerms: Object.keys(profile.terminologyOverrides),
        // Which roles were renamed, never the names.
        renamedRoles: Object.keys(profile.roleNameOverrides),
        featureOverrides: profile.featureOverrides,
        // Field names only: which booking page choices this save carried.
        bookingPageFields: [input.defaultClock ? "defaultClock" : null, input.weekStart ? "weekStart" : null].filter(Boolean),
      },
    });
    return profile;
  });
}

/**
 * The signed-in staff member's business profile for a server page, such as a page title. Falls back to the
 * default words when nobody is signed in, so it never throws from `generateMetadata`.
 */
/** The signed-in staff member's business profile, read once per request (metadata and layout both ask). */
export const currentStaffBusinessProfile = cache(async (): Promise<BusinessProfile> => {
  try {
    return await loadStaffBusinessProfile(await currentStaffContext());
  } catch {
    return defaultBusinessProfile;
  }
});

/** `profileWords` for the signed-in staff member's business. */
export async function currentStaffWords(): Promise<TermWords> {
  return profileWords(await currentStaffBusinessProfile());
}
