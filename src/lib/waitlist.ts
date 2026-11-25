/**
 * The smart waitlist's rules in one place (feature 21), as pure functions on a clock. No "server-only": the web server,
 * the worker and the screens all read these.
 */

export type TimePreference = "morning" | "afternoon" | "evening" | "any";
export const timePreferences: readonly TimePreference[] = ["any", "morning", "afternoon", "evening"];

/** Who is asked first when a time opens. */
export type WaitlistOrderRule = "longest_waiting" | "soonest_existing";
export const waitlistOrderRules: readonly WaitlistOrderRule[] = ["longest_waiting", "soonest_existing"];

/** How long a person has to answer. 15 minutes, or 5 when the time is under 3 hours away. */
export const OFFER_MINUTES = 15;
export const SHORT_OFFER_MINUTES = 5;
export const SHORT_OFFER_WITHIN_MS = 3 * 60 * 60_000;
/** Under this long to go, a time is not offered any more and goes to public booking. */
export const RELEASE_WITHIN_MS = 2 * 60 * 60_000;
/** After this many people have been asked about one time, it goes to public booking. */
export const MAX_PEOPLE_PER_TIME = 3;
/**
 * The hold outlives the answer time by this long, so the worker always moves the time to the next person (or lets it
 * go) before the hold lapses. Without it a time would show on the public page between two people.
 */
export const HOLD_GRACE_MS = 3 * 60_000;

/** Minutes the person has to answer, counted from when the message goes out. */
export function offerMinutes(startsAt: Date, sendAt: Date): number {
  return startsAt.getTime() - sendAt.getTime() < SHORT_OFFER_WITHIN_MS ? SHORT_OFFER_MINUTES : OFFER_MINUTES;
}

/** True when a time starting at `startsAt` is too close, at `sendAt`, to offer to anyone. */
export function mustReleaseToPublic(startsAt: Date, sendAt: Date): boolean {
  return startsAt.getTime() - sendAt.getTime() < RELEASE_WITHIN_MS;
}

/**
 * Whether a start time fits what the person asked for, by the hour on the location's wall clock. The same boundaries
 * the staff screen's compatible openings use: morning before 12, afternoon from 12 to before 17, evening from 17.
 */
export function timeOfDayFits(preference: string, localHour: number): boolean {
  if (preference === "morning") return localHour < 12;
  if (preference === "afternoon") return localHour >= 12 && localHour < 17;
  if (preference === "evening") return localHour >= 17;
  return true;
}

/** The hour (0 to 23) a moment reads on a wall clock in `timeZone`. */
export function localHourOf(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).formatToParts(at);
  return Number(parts.find((part) => part.type === "hour")?.value ?? 0);
}

export interface OrderableEntry {
  id: string;
  /** When the person joined the waitlist. */
  createdAt: Date;
  /** Start of the person's next booking for the same service after the freed time, if they have one. */
  nextAppointmentAt: Date | null;
}

/**
 * Puts waiting people in the order they are asked. `longest_waiting` is first come first served. `soonest_existing`
 * asks first the people whose current booking is soonest (they gain the most by moving earlier), then everyone with no
 * booking by how long they have waited. Ties always fall back to the waiting time, then the id, so the order is stable.
 */
export function orderCandidates<T extends OrderableEntry>(entries: readonly T[], rule: WaitlistOrderRule): T[] {
  const byWaiting = (a: T, b: T) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);
  const copy = [...entries];
  if (rule === "longest_waiting") return copy.sort(byWaiting);
  return copy.sort((a, b) => {
    const left = a.nextAppointmentAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const right = b.nextAppointmentAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (left !== right) return left < right ? -1 : 1;
    return byWaiting(a, b);
  });
}

/** Why an offer ended before the person answered. Short codes only, never free text. */
export type OfferEndReason = "staff" | "slot_gone" | "undeliverable" | "too_close" | "booked_elsewhere" | "unavailable";
