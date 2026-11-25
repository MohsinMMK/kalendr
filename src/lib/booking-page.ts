import { z } from "zod";

/**
 * Booking page 2.0 (feature 39): the shapes the server, the page and the tests share, and the small
 * pure rules for layouts, time zones and the clock. The API always speaks UTC; everything here is about
 * how a visitor sees it.
 */

const identifierSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

export const bookingLayouts = ["month", "week", "column"] as const;
export type BookingLayout = (typeof bookingLayouts)[number];
export const layoutLabels: Record<BookingLayout, string> = { month: "Month", week: "Week", column: "Columns" };

export const clockModes = ["auto", "12h", "24h"] as const;
export type ClockMode = (typeof clockModes)[number];

/** How long a picked time is kept for the customer while they fill in the form. */
export const HOLD_MINUTES = 5;

export const bookingPageSettingsSchema = z.object({
  layoutsEnabled: z.array(z.enum(bookingLayouts)).min(1, "Allow at least one layout.").max(3),
  defaultLayout: z.enum(bookingLayouts),
  /** Show every visitor the branch's time. For visits that only make sense in local time. */
  lockTimezone: z.boolean(),
  /** 1 is Monday, 7 is Sunday. Null follows the business's setting. */
  weekStart: z.union([z.literal(1), z.literal(7)]).nullable(),
}).refine((value) => value.layoutsEnabled.includes(value.defaultLayout), {
  message: "The first layout shown must be one you allow.",
  path: ["defaultLayout"],
});
export type BookingPageSettings = z.infer<typeof bookingPageSettingsSchema>;

export const defaultBookingPageSettings: BookingPageSettings = {
  layoutsEnabled: ["month", "week", "column"],
  defaultLayout: "month",
  lockTimezone: false,
  weekStart: null,
};

export const holdRequestSchema = z.object({
  clinicSlug: z.string().trim().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  locationId: identifierSchema,
  serviceId: identifierSchema,
  practitionerId: identifierSchema,
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  /** The hold this browser already has. Picking another time lets it go. */
  replaceToken: z.string().trim().min(20).max(200).optional(),
  /** A routing form's token (feature 46): the person held must be one the form picked. */
  routingToken: z.string().trim().regex(/^[A-Za-z0-9_-]{20,200}$/).optional(),
});
export type HoldRequest = z.infer<typeof holdRequestSchema>;

export const holdReleaseSchema = z.object({
  clinicSlug: z.string().trim().min(2).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  holdToken: z.string().trim().min(20).max(200),
});

export interface HoldResult {
  holdToken: string;
  expiresAt: string;
}

export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The zone names the browser knows, for the picker. Falls back to a short list when the browser has no list. */
export function allTimeZones(): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  const list = typeof supported === "function" ? supported("timeZone") : [];
  return list.length > 0 ? list : ["UTC", "Asia/Kolkata", "Asia/Dubai", "Europe/London", "America/New_York", "Australia/Sydney"];
}

/** Minutes the zone is ahead of UTC at one instant. */
export function zoneOffsetMinutes(zone: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"), value("second"));
  return Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60_000);
}

/** "1 h 30 m", "2 h" or "45 m". */
function durationWords(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return [hours > 0 ? `${hours} h` : "", rest > 0 ? `${rest} m` : ""].filter(Boolean).join(" ");
}

/** A friendly name for a zone: "Dubai" for Asia/Dubai. */
export function zoneCity(zone: string): string {
  return (zone.split("/").pop() ?? zone).replaceAll("_", " ");
}

/**
 * The line shown when the visitor's zone differs from the business's:
 * "Times shown in Dubai time (1 h 30 m behind the clinic)". Null when both clocks agree right now.
 */
export function timeZoneNotice(visitorZone: string, businessZone: string, businessWord: string, at: Date = new Date()): string | null {
  if (visitorZone === businessZone) return null;
  const difference = zoneOffsetMinutes(visitorZone, at) - zoneOffsetMinutes(businessZone, at);
  // Same clock under another name (Asia/Calcutta and Asia/Kolkata): the zone picker already says it.
  if (difference === 0) return null;
  const way = difference > 0 ? "ahead of" : "behind";
  return `Times shown in ${zoneCity(visitorZone)} time (${durationWords(Math.abs(difference))} ${way} the ${businessWord}).`;
}

/** Does this locale write times on a 12-hour clock by default? */
export function localeUses12Hour(locale: string): boolean {
  try {
    return new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hourCycle?.startsWith("h1") ?? false;
  } catch {
    return false;
  }
}

/** `auto` follows the visitor's own locale. */
export function resolveHour12(mode: ClockMode, locale: string): boolean {
  if (mode === "12h") return true;
  if (mode === "24h") return false;
  return localeUses12Hour(locale);
}

/** First day of the week as the date picker wants it: 0 is Sunday, 1 is Monday. */
export function weekStartsOn(weekStart: 1 | 7 | null | undefined, businessDefault: 1 | 7 = 1): 0 | 1 {
  return (weekStart ?? businessDefault) === 7 ? 0 : 1;
}

/** Layouts that work on a phone: the wide ones fall back to month. */
export function layoutForWidth(layout: BookingLayout, narrow: boolean): BookingLayout {
  return narrow ? "month" : layout;
}

/** The layout to show: the one asked for in the link when the service allows it, else the service's default. */
export function chooseLayout(asked: string | null | undefined, settings: Pick<BookingPageSettings, "layoutsEnabled" | "defaultLayout">): BookingLayout {
  const wanted = bookingLayouts.find((layout) => layout === asked);
  return wanted && settings.layoutsEnabled.includes(wanted) ? wanted : settings.defaultLayout;
}
