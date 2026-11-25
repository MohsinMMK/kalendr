/**
 * Quiet hours: a window each business sets (default 9 pm to 8 am, local time) when messages wait.
 * Pure functions on a clock and a time zone, so tests pin the time. No "server-only": the worker uses this.
 */

/** Minutes after local midnight in `timeZone`, 0 to 1439. */
export function localMinuteOfDay(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

/** Whether `minute` is inside the window. A window that crosses midnight (21:00 to 08:00) is handled. Start equal to end means no quiet hours. */
export function isQuietMinute(minute: number, startMinute: number, endMinute: number): boolean {
  if (startMinute === endMinute) return false;
  return startMinute < endMinute
    ? minute >= startMinute && minute < endMinute
    : minute >= startMinute || minute < endMinute;
}

/**
 * When a message due at `at` may actually go: `at` itself outside quiet hours, otherwise the moment they end
 * in the location's own time zone. Always lands on the end minute exactly, even across a clock change.
 */
export function afterQuietHours(at: Date, timeZone: string, startMinute: number, endMinute: number): Date {
  const minute = localMinuteOfDay(at, timeZone);
  if (!isQuietMinute(minute, startMinute, endMinute)) return at;
  const wait = (endMinute - minute + 1440) % 1440;
  let candidate = new Date(Math.floor(at.getTime() / 60_000) * 60_000 + wait * 60_000);
  // A clock change inside the wait shifts the local result by an hour; nudge it onto the end minute.
  const drift = (localMinuteOfDay(candidate, timeZone) - endMinute + 1440) % 1440;
  if (drift !== 0) {
    const back = drift <= 720 ? -drift : 1440 - drift;
    candidate = new Date(candidate.getTime() + back * 60_000);
  }
  return candidate;
}
