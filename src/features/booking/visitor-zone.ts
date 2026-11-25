import { isValidTimeZone } from "@/lib/booking-page";

/** The time zone this browser is set to, or null when it cannot say. Kept apart so tests can stand in for a visitor abroad. */
export function detectVisitorZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone && isValidTimeZone(zone) ? zone : null;
  } catch {
    return null;
  }
}

/** The visitor's language, used to pick a 12 or 24 hour clock when the business has no preference. */
export function detectVisitorLocale(fallback: string): string {
  if (typeof navigator === "undefined") return fallback;
  return navigator.language || fallback;
}
