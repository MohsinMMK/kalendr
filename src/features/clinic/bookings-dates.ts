import { TZDate } from "@date-fns/tz";

const pad = (value: number) => String(value).padStart(2, "0");

/** The instant the business's own day begins, for a picked day like 2026-08-31. */
export function dayStartInstant(day: string, timeZone: string, addDays = 0): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(new TZDate(year, month - 1, date + addDays, 0, 0, 0, 0, timeZone).getTime()).toISOString();
}

/** The business's calendar day (yyyy-mm-dd) an instant falls on, optionally just before it. */
export function dayOfInstant(instant: string, timeZone: string, minusMs = 0): string {
  const local = new TZDate(Date.parse(instant) - minusMs, timeZone);
  return `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`;
}

/** `from` is the start of the first day; `to` is the start of the day after the last (the API reads it as exclusive). */
export function rangeInstants(fromDay: string, toDay: string, timeZone: string): { from?: string; to?: string } {
  return {
    ...(fromDay ? { from: dayStartInstant(fromDay, timeZone) } : {}),
    ...(toDay ? { to: dayStartInstant(toDay, timeZone, 1) } : {}),
  };
}
