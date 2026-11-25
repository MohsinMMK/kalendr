import { demoClinic } from "@/lib/demo-data";
import type { Clinic } from "@/lib/domain";
import { cleanFeatureOverrides, cleanStoredTerminology, type BusinessProfileSettings } from "@/lib/terminology";
import { getBusinessType, isBusinessTypeId } from "@/lib/business-types";

/**
 * Preview mode has no database, so the demo business's type and words live in a cookie. A cookie (not
 * localStorage) lets server-rendered booking and manage pages read the same choice as the staff screens.
 */
export const previewBusinessProfileCookie = "kalendr-preview-business";

export function parsePreviewBusinessProfile(value: string | undefined | null): BusinessProfileSettings | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(value));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (!isBusinessTypeId(record.businessType)) return null;
    return {
      businessType: record.businessType,
      terminology: cleanStoredTerminology(record.terminology),
      features: cleanFeatureOverrides(record.features),
    };
  } catch {
    return null;
  }
}

/** The sample business is a dental clinic; other types get a name in their own words, such as "Indiranagar Salon". */
function previewNameFor(businessType: string): Partial<Clinic> {
  if (businessType === "dental" || businessType === "healthcare") return {};
  const word = getBusinessType(businessType).terms.business.singular;
  const name = `Indiranagar ${word.charAt(0).toUpperCase()}${word.slice(1)}`;
  // The sample logo and cover are dental drawings, so other businesses show none.
  return {
    name,
    legalName: `${name} Private Limited`,
    email: "hello@indiranagar.example",
    logoUrl: null,
    coverUrl: null,
  };
}

/** The demo business with any preview choice applied. */
export function previewClinicWith(settings: BusinessProfileSettings | null): Clinic {
  if (!settings || !isBusinessTypeId(settings.businessType)) return demoClinic;
  return {
    ...demoClinic,
    ...previewNameFor(settings.businessType),
    businessType: settings.businessType,
    terminology: cleanStoredTerminology(settings.terminology),
    features: cleanFeatureOverrides(settings.features),
  };
}

function readCookie(): string | null {
  if (typeof document === "undefined") return null;
  const prefix = `${previewBusinessProfileCookie}=`;
  return document.cookie.split("; ").find((part) => part.startsWith(prefix))?.slice(prefix.length) ?? null;
}

const listeners = new Set<() => void>();
let cachedRaw: string | null | undefined;
let cachedClinic: Clinic = demoClinic;

export function getPreviewBusinessClinic(): Clinic {
  const raw = readCookie();
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedClinic = previewClinicWith(parsePreviewBusinessProfile(raw));
  }
  return cachedClinic;
}

export function getServerPreviewBusinessClinic(): Clinic {
  return demoClinic;
}

export function subscribePreviewBusiness(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function savePreviewBusinessProfile(settings: BusinessProfileSettings): void {
  const value = encodeURIComponent(JSON.stringify({
    businessType: settings.businessType,
    terminology: cleanStoredTerminology(settings.terminology),
    features: cleanFeatureOverrides(settings.features),
  }));
  document.cookie = `${previewBusinessProfileCookie}=${value}; path=/; max-age=31536000; samesite=lax`;
  for (const listener of listeners) listener();
}
