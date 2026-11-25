import Holidays from "date-holidays";

import type { HolidayItem, HolidaySettings } from "@/lib/availability-setup";

import { datesBetween } from "./time";

/**
 * Public holidays, worked out on the fly from the `date-holidays` data (ISC code, CC BY-SA 4.0
 * data: the holiday list on screen credits it). Nothing is stored except what the owner turned
 * off and the extra closed days they added. The library can throw for a few countries on this
 * Node version (the ones with Chinese-calendar holidays), so every call here is guarded and
 * reports `ok: false` instead of failing the page.
 */

export interface HolidayQuerySettings {
  country: string;
  region: string | null;
  optedOut: HolidaySettings["optedOut"];
  customDays: HolidaySettings["customDays"];
}

function build(country: string, region: string | null): Holidays | null {
  try {
    const holidays = region ? new Holidays(country, region) : new Holidays(country);
    holidays.setLanguages("en");
    return holidays;
  } catch {
    return null;
  }
}

export function holidayCountries(): Array<{ code: string; name: string }> {
  const countries = new Holidays().getCountries("en") as Record<string, string> | undefined;
  return Object.entries(countries ?? {}).map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name));
}

export function holidayRegions(country: string): Array<{ code: string; name: string }> {
  try {
    const states = new Holidays().getStates(country, "en") as Record<string, string> | undefined;
    return Object.entries(states ?? {}).map(([code, name]) => ({ code, name })).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

let zoneToCountry: Map<string, string> | null = null;

/** The country a timezone belongs to, for suggesting a starting point. `null` when it is shared or unknown. */
export function suggestCountry(timezone: string): string | null {
  if (!zoneToCountry) {
    zoneToCountry = new Map();
    const seen = new Map<string, number>();
    for (const { code } of holidayCountries()) {
      try {
        for (const zone of new Holidays(code).getTimezones() as string[]) {
          seen.set(zone, (seen.get(zone) ?? 0) + 1);
          zoneToCountry.set(zone, code);
        }
      } catch {
        // A country whose data cannot be read is skipped.
      }
    }
    for (const [zone, count] of seen) if (count > 1) zoneToCountry.delete(zone);
  }
  return zoneToCountry.get(timezone) ?? null;
}

/**
 * The days between `from` and `to` (both `YYYY-MM-DD`, inclusive) on which the business may close,
 * with `closed` telling whether it does. Only public and bank holidays count.
 */
export function listHolidays(settings: HolidayQuerySettings, from: string, to: string): { items: HolidayItem[]; ok: boolean } {
  const items: HolidayItem[] = [];
  let ok = true;
  const holidays = build(settings.country, settings.region);
  if (!holidays) ok = false;
  const years = new Set(datesBetween(from, to).map((date) => date.slice(0, 4)));
  if (holidays) {
    for (const year of years) {
      try {
        for (const holiday of holidays.getHolidays(Number(year))) {
          if (holiday.type !== "public" && holiday.type !== "bank") continue;
          const date = holiday.date.slice(0, 10);
          if (date < from || date > to) continue;
          const id = holiday.rule || date;
          items.push({ id, date, name: holiday.name, type: holiday.type, closed: !(settings.optedOut[year] ?? []).includes(id) });
        }
      } catch {
        ok = false;
      }
    }
  }
  for (const custom of settings.customDays) {
    if (custom.date >= from && custom.date <= to) items.push({ id: `custom:${custom.date}`, date: custom.date, name: custom.name, type: "custom", closed: true });
  }
  return { items: items.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name)), ok };
}

/** The closed holiday dates the engine applies. */
export function closedHolidayDates(settings: HolidayQuerySettings | null, from: string, to: string): Array<{ date: string; name: string }> {
  if (!settings) return [];
  return listHolidays(settings, from, to).items.filter((item) => item.closed).map((item) => ({ date: item.date, name: item.name }));
}
