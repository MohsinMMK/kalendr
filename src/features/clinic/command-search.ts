import { addClinicDays, isClinicDateKey } from "./schedule-availability";

const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const pad = (value: number) => String(value).padStart(2, "0");

function weekdayOf(dateKey: string): number {
  return new Date(`${dateKey}T12:00:00Z`).getUTCDay();
}

/** A real calendar date, or null for something like 31 Feb. */
function validDate(year: number, month: number, day: number): string | null {
  const key = `${year}-${pad(month)}-${pad(day)}`;
  return isClinicDateKey(key) ? key : null;
}

/**
 * Turns what someone typed into a date to jump to: "tomorrow", "mon", "16 nov", "nov 16 2026", "2026-11-16",
 * "in 3 days". Returns null when the text is not a date, so the palette shows nothing for it.
 * `todayKey` is the business's today, so the answer never depends on the browser's time zone.
 */
export function parseDateQuery(text: string, todayKey: string): string | null {
  const query = text.trim().toLowerCase().replace(/\s+/g, " ").replace(/,/g, "");
  if (!query) return null;
  if (query === "today") return todayKey;
  if (query === "tomorrow") return addClinicDays(todayKey, 1);
  if (query === "yesterday") return addClinicDays(todayKey, -1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(query)) return isClinicDateKey(query) ? query : null;

  const relative = /^(?:in )?(\d{1,3}) ?(day|days|d|week|weeks|w)$/.exec(query);
  if (relative) return addClinicDays(todayKey, Number(relative[1]) * (relative[2].startsWith("w") ? 7 : 1));

  const weekday = /^(?:next |on )?([a-z]{3,9})$/.exec(query);
  if (weekday) {
    const index = weekdays.findIndex((name) => name === weekday[1] || (weekday[1].length >= 3 && name.startsWith(weekday[1])));
    if (index >= 0) {
      const ahead = (index - weekdayOf(todayKey) + 7) % 7 || 7;
      return addClinicDays(todayKey, ahead);
    }
  }

  const dayFirst = /^(\d{1,2})(?:st|nd|rd|th)? ([a-z]{3,9})(?: (\d{4}))?$/.exec(query);
  const monthFirst = /^([a-z]{3,9}) (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/.exec(query);
  const parts = dayFirst ? { day: dayFirst[1], month: dayFirst[2], year: dayFirst[3] } : monthFirst ? { day: monthFirst[2], month: monthFirst[1], year: monthFirst[3] } : null;
  if (!parts) return null;
  const month = months.findIndex((name) => parts.month.startsWith(name)) + 1;
  if (month === 0) return null;
  const thisYear = Number(todayKey.slice(0, 4));
  if (parts.year) return validDate(Number(parts.year), month, Number(parts.day));
  const sameYear = validDate(thisYear, month, Number(parts.day));
  if (!sameYear) return null;
  // "5 jan" typed in November means next January. A date a few weeks back is still this year's.
  const daysBack = (Date.parse(`${todayKey}T12:00:00Z`) - Date.parse(`${sameYear}T12:00:00Z`)) / 86_400_000;
  return daysBack > 60 ? validDate(thisYear + 1, month, Number(parts.day)) : sameYear;
}

/** Entries whose label has every word of the query, for the palette's own actions and pages. */
export function matchesQuery(label: string, query: string): boolean {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = label.toLowerCase();
  return words.every((word) => haystack.includes(word));
}
