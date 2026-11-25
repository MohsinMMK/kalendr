import type { BookingMode } from "@/lib/domain";
import { defaultBusinessProfile, profileWords, type TermWords } from "@/lib/terminology";

/** The words the fallback description needs. Leaving them out keeps the healthcare wording. */
export type VisitTypeWords = Pick<TermWords, "business" | "visit">;

const defaultWords: VisitTypeWords = profileWords(defaultBusinessProfile);

export interface VisitTypeWriteInput {
  name: string;
  description: string;
  durationMinutes: number;
  bookingMode: BookingMode;
  priceLabel: string;
  /** Groups services into chips on the business page. Empty means no group. */
  category?: string;
  resourceKind: string;
  practitionerIds: string[];
  /** Where it is offered. Left out, a new service is offered everywhere and an existing one keeps its locations. */
  locationIds?: string[];
}

function trimmedName(type: VisitTypeWriteInput): string {
  return type.name.trim();
}

function trimmedDescription(type: VisitTypeWriteInput, words: VisitTypeWords): string {
  return type.description.trim() || `A scheduled ${words.business} ${words.visit}.`;
}

function durationMinutes(type: VisitTypeWriteInput): number {
  const minutes = Math.round(Number(type.durationMinutes));
  return Number.isFinite(minutes) ? minutes : 30;
}

function trimmedPrice(type: VisitTypeWriteInput): string {
  return type.priceLabel.trim();
}

export function visitTypeCreateBody(type: VisitTypeWriteInput, words: VisitTypeWords = defaultWords) {
  const priceLabel = trimmedPrice(type);
  const requiredResourceKind = type.resourceKind || undefined;
  return {
    name: trimmedName(type),
    description: trimmedDescription(type, words),
    durationMinutes: durationMinutes(type),
    bookingMode: type.bookingMode,
    practitionerIds: type.practitionerIds,
    ...(type.locationIds?.length ? { locationIds: type.locationIds } : {}),
    ...(priceLabel ? { priceLabel } : {}),
    ...(type.category?.trim() ? { category: type.category.trim() } : {}),
    ...(requiredResourceKind ? { requiredResourceKind } : {}),
  };
}

export function visitTypeUpdateBody(type: VisitTypeWriteInput, words: VisitTypeWords = defaultWords) {
  return {
    name: trimmedName(type),
    description: trimmedDescription(type, words),
    durationMinutes: durationMinutes(type),
    bookingMode: type.bookingMode,
    isActive: true,
    priceLabel: trimmedPrice(type) || null,
    category: type.category?.trim() || null,
    requiredResourceKind: type.resourceKind || null,
    practitionerIds: type.practitionerIds,
    ...(type.locationIds?.length ? { locationIds: type.locationIds } : {}),
  };
}
