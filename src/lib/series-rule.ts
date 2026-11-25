/**
 * Repeating appointments (feature 17): the rule a series follows and how it becomes a list of calendar dates.
 * Pure, with no "server-only": the screen shows the summary line and the server expands the dates.
 *
 * The rule is expanded as WALL-CLOCK dates ("every Tuesday"), not instants. rrule only ever sees midnight UTC dates, so
 * a clock change cannot move a day; the caller then turns each date plus the clock time into an instant in the place's
 * time zone, which is what keeps 10:00 at 10:00 across a clock change.
 */
import { RRule, type Weekday } from "rrule";
import { z } from "zod";

/** The longest a series may be: 52 visits, or 12 months from the first day, whichever comes first. */
export const MAX_SERIES_VISITS = 52;
export const MAX_SERIES_MONTHS = 12;

export const repeatFrequencies = ["daily", "weekly", "monthly_date", "monthly_weekday"] as const;
export type RepeatFrequency = (typeof repeatFrequencies)[number];

const dateText = z.iso.date();

export const repeatEndSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("count"), count: z.number().int().min(1).max(MAX_SERIES_VISITS) }),
  z.strictObject({ kind: z.literal("until"), date: dateText }),
]);

/** What the "Repeat" control produces. Weekdays are ISO numbers, 1 for Monday to 7 for Sunday. */
export const repeatRuleSchema = z.strictObject({
  frequency: z.enum(repeatFrequencies),
  /** Every N days, weeks or months. */
  interval: z.number().int().min(1).max(30),
  /** Weekly only. Empty means the weekday of the first day. */
  weekdays: z.array(z.number().int().min(1).max(7)).max(7).default([]),
  end: repeatEndSchema,
}).refine((rule) => rule.frequency === "daily" || rule.interval <= 12, { path: ["interval"], message: "Choose 12 or fewer." });

export type RepeatRule = z.infer<typeof repeatRuleSchema>;
export type RepeatEnd = z.infer<typeof repeatEndSchema>;

const weekdayCodes: Weekday[] = [RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR, RRule.SA, RRule.SU];
const weekdayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const shortWeekdayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const ordinalWords = ["first", "second", "third", "fourth", "last"];

function parts(date: string): { year: number; month: number; day: number } {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  return { year, month, day };
}

function utc(date: string): Date {
  const { year, month, day } = parts(date);
  return new Date(Date.UTC(year, month - 1, day));
}

function isoDate(value: Date): string {
  return `${String(value.getUTCFullYear()).padStart(4, "0")}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
}

/** 1 for Monday to 7 for Sunday. */
export function isoWeekdayOf(date: string): number {
  const day = utc(date).getUTCDay();
  return day === 0 ? 7 : day;
}

/** The same calendar day `months` later, or the month's last day when it has no such day. */
export function addMonthsTo(date: string, months: number): string {
  const { year, month, day } = parts(date);
  const first = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  return isoDate(new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), Math.min(day, lastDay))));
}

/** The last day a series that starts on `startsOn` may have a visit on. */
export function lastAllowedDate(startsOn: string): string {
  const limit = utc(addMonthsTo(startsOn, MAX_SERIES_MONTHS));
  limit.setUTCDate(limit.getUTCDate() - 1);
  return isoDate(limit);
}

/** Which one of the month's weekdays a date is: 1 to 4, or -1 for the last (which includes a fifth). */
function nthWeekdayOfMonth(date: string): number {
  const nth = Math.ceil(parts(date).day / 7);
  return nth >= 5 ? -1 : nth;
}

function normalise(rule: RepeatRule, startsOn: string): RepeatRule {
  if (rule.frequency !== "weekly") return { ...rule, weekdays: [] };
  const weekdays = [...new Set(rule.weekdays.length > 0 ? rule.weekdays : [isoWeekdayOf(startsOn)])].sort((a, b) => a - b);
  return { ...rule, weekdays };
}

function optionsFor(rule: RepeatRule, startsOn: string): ConstructorParameters<typeof RRule>[0] {
  const cleaned = normalise(rule, startsOn);
  const end = cleaned.end.kind === "count" ? { count: cleaned.end.count } : { until: utc(cleaned.end.date) };
  switch (cleaned.frequency) {
    case "daily":
      return { freq: RRule.DAILY, interval: cleaned.interval, ...end };
    case "weekly":
      return { freq: RRule.WEEKLY, interval: cleaned.interval, byweekday: cleaned.weekdays.map((day) => weekdayCodes[day - 1]!), wkst: RRule.MO, ...end };
    case "monthly_date":
      return { freq: RRule.MONTHLY, interval: cleaned.interval, bymonthday: [parts(startsOn).day], ...end };
    case "monthly_weekday":
      return { freq: RRule.MONTHLY, interval: cleaned.interval, byweekday: [weekdayCodes[isoWeekdayOf(startsOn) - 1]!.nth(nthWeekdayOfMonth(startsOn))], ...end };
  }
}

/** The RRULE line stored with a series, for example `RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=8`. */
export function ruleText(rule: RepeatRule, startsOn: string): string {
  return new RRule(optionsFor(rule, startsOn)).toString();
}

export interface ExpandedDates {
  /** Each date with its place in the rule, counting from 1. */
  dates: Array<{ index: number; date: string }>;
  /** True when the rule asked for more than the caps allow and the list was cut short. */
  capped: boolean;
}

/**
 * Every calendar date the rule produces from `startsOn`, in order, within the caps. The rule's own count never goes past
 * 52, and a rule that runs to a date is cut at 12 months, so `capped` says the list is shorter than the rule asked for.
 */
export function expandRuleDates(rule: RepeatRule, startsOn: string): ExpandedDates {
  const limit = lastAllowedDate(startsOn);
  const recurrence = new RRule({ ...optionsFor(rule, startsOn), dtstart: utc(startsOn) });
  const dates: Array<{ index: number; date: string }> = [];
  let capped = false;
  recurrence.all((value, position) => {
    if (position >= MAX_SERIES_VISITS) { capped = true; return false; }
    const date = isoDate(value);
    if (date > limit) { capped = true; return false; }
    dates.push({ index: position + 1, date });
    return true;
  });
  return { dates, capped };
}

/** A start time as "10:00 am". */
export function clockText(time: string): string {
  const [hours = 0, minutes = 0] = time.split(":").map(Number);
  const suffix = hours >= 12 ? "pm" : "am";
  return `${hours % 12 === 0 ? 12 : hours % 12}:${String(minutes).padStart(2, "0")} ${suffix}`;
}

function dayText(date: string): string {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(utc(date));
}

function plural(count: number, one: string, other = `${one}s`): string {
  return count === 1 ? `1 ${one}` : `${count} ${other}`;
}

function ordinalDay(day: number): string {
  const tail = day % 100;
  const suffix = tail >= 11 && tail <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[day % 10] ?? "th";
  return `${day}${suffix}`;
}

/** A plain sentence for the rule, such as "Every Tuesday at 10:00 am for 8 weeks". `words` are the business's own terms. */
export function ruleSummary(rule: RepeatRule, startsOn: string, time: string, words: { visit: string; visits: string } = { visit: "visit", visits: "visits" }): string {
  const cleaned = normalise(rule, startsOn);
  const every = cleaned.interval === 1;
  let pattern: string;
  let unit: { one: string; other: string } | null = null;
  switch (cleaned.frequency) {
    case "daily":
      pattern = every ? "Every day" : `Every ${cleaned.interval} days`;
      unit = every ? { one: "day", other: "days" } : null;
      break;
    case "weekly": {
      const names = cleaned.weekdays.map((day) => (cleaned.weekdays.length > 2 || !every ? shortWeekdayNames : weekdayNames)[day - 1]!);
      const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0]!;
      pattern = every ? `Every ${list}` : `Every ${cleaned.interval} weeks on ${list}`;
      if (every && cleaned.weekdays.length === 1) unit = { one: "week", other: "weeks" };
      break;
    }
    case "monthly_date":
      pattern = `${every ? "Every month" : `Every ${cleaned.interval} months`} on the ${ordinalDay(parts(startsOn).day)}`;
      unit = every ? { one: "month", other: "months" } : null;
      break;
    case "monthly_weekday": {
      const nth = nthWeekdayOfMonth(startsOn);
      const where = `${ordinalWords[nth === -1 ? 4 : nth - 1]} ${weekdayNames[isoWeekdayOf(startsOn) - 1]}`;
      pattern = `${every ? "Every month" : `Every ${cleaned.interval} months`} on the ${where}`;
      unit = every ? { one: "month", other: "months" } : null;
      break;
    }
  }
  const at = `${pattern} at ${clockText(time)}`;
  if (cleaned.end.kind === "until") return `${at}, until ${dayText(cleaned.end.date)}`;
  if (unit) return `${at} for ${plural(cleaned.end.count, unit.one, unit.other)}`;
  return `${at} for ${plural(cleaned.end.count, words.visit, words.visits)}`;
}

/** The stored rule, read back safely. Null when it is not a rule this version understands. */
export function parseStoredRule(value: unknown): RepeatRule | null {
  const parsed = repeatRuleSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
