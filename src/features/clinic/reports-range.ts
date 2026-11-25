import { addDays } from "@/lib/reports";

export const rangePresets = [
  { id: "last7", label: "Last 7 days" },
  { id: "last30", label: "Last 30 days" },
  { id: "thisMonth", label: "This month" },
  { id: "lastMonth", label: "Last month" },
  { id: "last90", label: "Last 90 days" },
  { id: "thisYear", label: "This year" },
  { id: "custom", label: "Pick dates" },
] as const;
export type RangePreset = (typeof rangePresets)[number]["id"];

/** Today's date in the business's own timezone, as YYYY-MM-DD. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

const monthStart = (day: string) => `${day.slice(0, 7)}-01`;

/** The first and last day a preset covers, ending today (or at the end of last month). */
export function presetRange(preset: Exclude<RangePreset, "custom">, today: string): { from: string; to: string } {
  switch (preset) {
    case "last7": return { from: addDays(today, -6), to: today };
    case "last30": return { from: addDays(today, -29), to: today };
    case "last90": return { from: addDays(today, -89), to: today };
    case "thisMonth": return { from: monthStart(today), to: today };
    case "thisYear": return { from: `${today.slice(0, 4)}-01-01`, to: today };
    case "lastMonth": {
      const end = addDays(monthStart(today), -1);
      return { from: monthStart(end), to: end };
    }
  }
}
