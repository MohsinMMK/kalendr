import type { Location, Practitioner, Service, TimeSlot } from "@/lib/domain";

/** One day's opening hours as "HH:MM" local times, or null when closed. */
export interface DayHours {
  opens: string;
  closes: string;
}

/** Monday first, the same order as ISO weekdays 1–7. */
export type WeekHours = (DayHours | null)[];

export interface OpeningRule {
  locationId: string;
  /** ISO weekday: 1 is Monday, 7 is Sunday. */
  dayOfWeek: number;
  startsAtLocal: string;
  endsAtLocal: string;
}

export const weekdayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"] as const;

/** How many days ahead the business page looks for free times. */
export const NEXT_FREE_DAYS_WINDOW = 7;
/** How many free days each team member shows. */
export const NEXT_FREE_DAYS_SHOWN = 3;

const hhmm = (value: string) => value.slice(0, 5);

/**
 * Opening hours per location from the team's working hours: a location is open from
 * the earliest start to the latest end of anyone working there that day.
 */
export function openingHoursFromRules(rules: readonly OpeningRule[]): Record<string, WeekHours> {
  const byLocation: Record<string, WeekHours> = {};
  for (const rule of rules) {
    if (rule.dayOfWeek < 1 || rule.dayOfWeek > 7) continue;
    const week = (byLocation[rule.locationId] ??= Array.from({ length: 7 }, () => null));
    const index = rule.dayOfWeek - 1;
    const opens = hhmm(rule.startsAtLocal);
    const closes = hhmm(rule.endsAtLocal);
    const current = week[index];
    week[index] = current
      ? { opens: opens < current.opens ? opens : current.opens, closes: closes > current.closes ? closes : current.closes }
      : { opens, closes };
  }
  return byLocation;
}

/** Monday-first index (0–6) of the day it is now in a time zone. */
export function weekdayIndexIn(timeZone: string, now: Date = new Date()): number {
  const name = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone }).format(now);
  const index = weekdayNames.indexOf(name as (typeof weekdayNames)[number]);
  return index === -1 ? 0 : index;
}

/** "9:00 AM" or "09:00", depending on the business's locale. */
export function formatHour(value: string, locale: string): string {
  const [hours, minutes] = value.split(":").map((part) => Number.parseInt(part, 10));
  const date = new Date(Date.UTC(2000, 0, 3, hours || 0, minutes || 0));
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(date);
}

export function formatDayHours(hours: DayHours | null, locale: string): string {
  return hours ? `${formatHour(hours.opens, locale)} – ${formatHour(hours.closes, locale)}` : "Closed";
}

/** "YYYY-MM-DD" of an instant in a time zone. */
export function dateKeyIn(value: string | Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(new Date(value));
}

/** The first few days each person has a free time, in order. */
export function nextFreeDaysByPerson(
  slots: readonly Pick<TimeSlot, "startsAt" | "practitionerId">[],
  timeZone: string,
  limit: number = NEXT_FREE_DAYS_SHOWN,
): Record<string, string[]> {
  const days: Record<string, Set<string>> = {};
  const sorted = [...slots].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  for (const slot of sorted) {
    const set = (days[slot.practitionerId] ??= new Set());
    if (set.size < limit) set.add(dateKeyIn(slot.startsAt, timeZone));
  }
  return Object.fromEntries(Object.entries(days).map(([id, set]) => [id, [...set].sort()]));
}

/** Merges free days found in several availability searches, keeping each person's earliest few. */
export function mergeFreeDays(parts: readonly Record<string, string[]>[], limit: number = NEXT_FREE_DAYS_SHOWN): Record<string, string[]> {
  const merged: Record<string, Set<string>> = {};
  for (const part of parts) {
    for (const [id, days] of Object.entries(part)) {
      const set = (merged[id] ??= new Set());
      for (const day of days) set.add(day);
    }
  }
  return Object.fromEntries(Object.entries(merged).map(([id, set]) => [id, [...set].sort().slice(0, limit)]));
}

/** How many free times each person has on each day: person id → "YYYY-MM-DD" → count. */
export type FreeTimes = Record<string, Record<string, number>>;

export function freeTimesByPerson(slots: readonly Pick<TimeSlot, "startsAt" | "practitionerId">[], timeZone: string): FreeTimes {
  const counts: FreeTimes = {};
  for (const slot of slots) {
    const days = (counts[slot.practitionerId] ??= {});
    const key = dateKeyIn(slot.startsAt, timeZone);
    days[key] = (days[key] ?? 0) + 1;
  }
  return counts;
}

/** Merges counts from several availability searches. A day found twice keeps the larger count, never the sum. */
export function mergeFreeTimes(parts: readonly FreeTimes[]): FreeTimes {
  const merged: FreeTimes = {};
  for (const part of parts) {
    for (const [id, days] of Object.entries(part)) {
      const target = (merged[id] ??= {});
      for (const [key, count] of Object.entries(days)) target[key] = Math.max(target[key] ?? 0, count);
    }
  }
  return merged;
}

/** Each person's earliest few free days, from their counts. */
export function freeDaysFromTimes(times: FreeTimes, limit: number = NEXT_FREE_DAYS_SHOWN): Record<string, string[]> {
  return Object.fromEntries(Object.entries(times).map(([id, days]) => [id, Object.keys(days).sort().slice(0, limit)]));
}

/** All of one person's free times in the window. */
export function countFreeTimes(days: Record<string, number> | undefined): number {
  return Object.values(days ?? {}).reduce((total, count) => total + count, 0);
}

/**
 * The fewest availability searches (a service at a location) that cover every team member
 * there. Each search asks for anyone free, so one search usually covers a whole location.
 */
export function freeDayQueries(
  services: readonly Pick<Service, "id" | "locationIds" | "practitionerIds">[],
  locations: readonly Pick<Location, "id">[],
): { locationId: string; serviceId: string }[] {
  const queries: { locationId: string; serviceId: string }[] = [];
  for (const location of locations) {
    const offered = services.filter((service) => service.locationIds.includes(location.id) && service.practitionerIds.length > 0);
    const uncovered = new Set(offered.flatMap((service) => service.practitionerIds));
    while (uncovered.size > 0) {
      let best: (typeof offered)[number] | undefined;
      let bestCount = 0;
      for (const service of offered) {
        const count = service.practitionerIds.filter((id) => uncovered.has(id)).length;
        if (count > bestCount) {
          best = service;
          bestCount = count;
        }
      }
      if (!best) break;
      queries.push({ locationId: location.id, serviceId: best.id });
      for (const id of best.practitionerIds) uncovered.delete(id);
    }
  }
  return queries;
}

/** Service categories in the order they first appear. Empty when no service has one. */
export function serviceCategories(services: readonly Pick<Service, "category">[]): string[] {
  const seen = new Set<string>();
  for (const service of services) {
    const category = service.category?.trim();
    if (category) seen.add(category);
  }
  return [...seen];
}

const normalize = (value: string) => value.toLocaleLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

/** Whether every word the customer typed appears somewhere in the given text. */
export function matchesSearch(query: string, ...fields: (string | null | undefined)[]): boolean {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = normalize(fields.filter(Boolean).join(" "));
  return words.every((word) => text.includes(word));
}

/** The cheapest of a person's services that states a price. Only labels that hold a number count. */
export function lowestPrice(services: readonly Pick<Service, "priceLabel">[]): { value: number; label: string; priced: number } | undefined {
  let best: { value: number; label: string } | undefined;
  let priced = 0;
  for (const service of services) {
    const label = service.priceLabel?.trim();
    if (!label) continue;
    const match = /(\d[\d,]*(?:\.\d+)?)/.exec(label);
    if (!match) continue;
    const value = Number.parseFloat(match[1].replaceAll(",", ""));
    if (!Number.isFinite(value)) continue;
    priced += 1;
    if (!best || value < best.value) best = { value, label };
  }
  return best ? { ...best, priced } : undefined;
}

/** Lowest price label among a person's services, as the business wrote it. */
export function startingPrice(services: readonly Pick<Service, "priceLabel">[]): string | undefined {
  return lowestPrice(services)?.label;
}

/**
 * The words for a price pill: the price itself when only one service states one, "From ₹800" when
 * several do. A label that already starts with "From" is never given a second one.
 */
export function pricePillLabel(services: readonly Pick<Service, "priceLabel">[]): string | undefined {
  const lowest = lowestPrice(services);
  if (!lowest) return undefined;
  if (lowest.priced < 2 || /^from\b/i.test(lowest.label)) return lowest.label;
  return `From ${lowest.label}`;
}

/** A person's first name for "Book with Asha", without a title like "Dr.". */
export function firstName(person: Pick<Practitioner, "name">): string {
  const parts = person.name.replace(/^(dr|mr|mrs|ms|mx|prof)\.?\s+/i, "").trim().split(/\s+/);
  return parts[0] || person.name;
}

/** The booking link with whatever the customer already chose on the business page. */
export function bookingHref(slug: string, choice: { service?: string; person?: string; date?: string; time?: string } = {}): string {
  const query = new URLSearchParams();
  if (choice.service) query.set("service", choice.service);
  if (choice.person) query.set("person", choice.person);
  if (choice.date) query.set("date", choice.date);
  if (choice.time) query.set("time", choice.time);
  const search = query.toString();
  return `/book/${slug}${search ? `?${search}` : ""}`;
}

/** A map search link for an address; opens the customer's own maps app on phones. */
export function mapHref(location: Pick<Location, "address" | "city">, businessName: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([businessName, location.address, location.city].filter(Boolean).join(", "))}`;
}

/** "Today", "Tomorrow" or "Thu 12 Nov" for a "YYYY-MM-DD" day, measured from `todayKey`. */
export function dayChipLabel(key: string, todayKey: string, locale: string): string {
  const toUtc = (value: string) => {
    const [year, month, date] = value.split("-").map((part) => Number.parseInt(part, 10));
    return Date.UTC(year, (month || 1) - 1, date || 1);
  };
  const difference = Math.round((toUtc(key) - toUtc(todayKey)) / (24 * 60 * 60 * 1000));
  if (difference === 0) return "Today";
  if (difference === 1) return "Tomorrow";
  return new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(toUtc(key)));
}

/** A day as a two-line chip: "Thu" (or "Today") over "12", with the whole date for screen readers. */
export function dayChipParts(key: string, todayKey: string, locale: string): { top: string; day: string; full: string } {
  const [year, month, date] = key.split("-").map((part) => Number.parseInt(part, 10));
  const day = new Date(Date.UTC(year, (month || 1) - 1, date || 1));
  const format = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(day);
  return {
    top: key === todayKey ? "Today" : format({ weekday: "short" }),
    day: format({ day: "numeric" }),
    full: format({ weekday: "long", day: "numeric", month: "long" }),
  };
}

/** How many team members the business page shows before "See all". */
export const TEAM_SHOWN = 6;

/**
 * Team members, most popular first: the higher average, then the more reviews. People without
 * reviews come after rated ones, and ties keep the business's own order.
 */
export function sortByPopularity<T extends { id: string }>(
  people: readonly T[],
  ratings: Record<string, { count: number; average: number | null } | undefined> | undefined,
): T[] {
  const score = (person: T) => {
    const summary = ratings?.[person.id];
    return summary && summary.count > 0 ? { average: summary.average ?? 0, count: summary.count } : { average: -1, count: 0 };
  };
  return people
    .map((person, index) => ({ person, index, ...score(person) }))
    .sort((a, b) => b.average - a.average || b.count - a.count || a.index - b.index)
    .map((entry) => entry.person);
}

/** The text a person's Today status button shows: "Open today · 9:00 AM – 5:00 PM" or "Closed today · Opens Mon 9:00 AM". */
export function todayStatus(week: WeekHours | undefined, todayIndex: number, locale: string): { open: boolean; label: string } | undefined {
  if (!week) return undefined;
  const today = week[todayIndex];
  if (today) return { open: true, label: `Open today · ${formatDayHours(today, locale)}` };
  for (let step = 1; step <= 7; step += 1) {
    const day = (todayIndex + step) % 7;
    const hours = week[day];
    if (hours) return { open: false, label: `Closed today · Opens ${weekdayNames[day].slice(0, 3)} ${formatHour(hours.opens, locale)}` };
  }
  return { open: false, label: "Closed today" };
}
