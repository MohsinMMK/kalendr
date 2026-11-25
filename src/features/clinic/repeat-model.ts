/**
 * The state behind the "Repeat" control (feature 17), kept apart from the screens so the rule it makes, the summary line
 * and the answers to clashes can be tested without rendering anything.
 */
import type { SeriesPreview, SeriesResolution } from "@/lib/series-contracts";
import { isoWeekdayOf, MAX_SERIES_VISITS, ruleSummary, type RepeatFrequency, type RepeatRule } from "@/lib/series-rule";

export type RepeatMode = "none" | RepeatFrequency;

export interface RepeatDraft {
  mode: RepeatMode;
  /** Every N days, weeks or months. */
  interval: number;
  /** Weekly only, ISO numbers (1 Monday to 7 Sunday). Empty means the weekday of the first visit. */
  weekdays: number[];
  endKind: "count" | "until";
  count: number;
  /** `YYYY-MM-DD`, for `endKind: "until"`. */
  until: string;
}

export const noRepeat: RepeatDraft = { mode: "none", interval: 1, weekdays: [], endKind: "count", count: 8, until: "" };

export const repeatModes: Array<{ value: RepeatMode; label: string }> = [
  { value: "none", label: "Does not repeat" },
  { value: "daily", label: "Every day" },
  { value: "weekly", label: "Every week, on chosen days" },
  { value: "monthly_date", label: "Every month, on the same date" },
  { value: "monthly_weekday", label: "Every month, on the same weekday" },
];

export const weekdayChoices = [
  { value: 1, label: "Mon", name: "Monday" }, { value: 2, label: "Tue", name: "Tuesday" }, { value: 3, label: "Wed", name: "Wednesday" },
  { value: 4, label: "Thu", name: "Thursday" }, { value: 5, label: "Fri", name: "Friday" }, { value: 6, label: "Sat", name: "Saturday" },
  { value: 7, label: "Sun", name: "Sunday" },
];

/** What "every N" counts for each way of repeating. */
export const intervalUnit: Record<RepeatFrequency, { one: string; many: string; max: number }> = {
  daily: { one: "day", many: "days", max: 30 },
  weekly: { one: "week", many: "weeks", max: 12 },
  monthly_date: { one: "month", many: "months", max: 12 },
  monthly_weekday: { one: "month", many: "months", max: 12 },
};

export type RuleResult = { rule: RepeatRule } | { error: string } | null;

/** The rule the draft stands for, or the plain-words reason it is not ready, or null when it does not repeat. */
export function draftToRule(draft: RepeatDraft, startsOn: string): RuleResult {
  if (draft.mode === "none") return null;
  const unit = intervalUnit[draft.mode];
  if (!Number.isInteger(draft.interval) || draft.interval < 1 || draft.interval > unit.max) return { error: `Choose between 1 and ${unit.max} ${unit.many}.` };
  if (draft.endKind === "count") {
    if (!Number.isInteger(draft.count) || draft.count < 2 || draft.count > MAX_SERIES_VISITS) return { error: `Choose between 2 and ${MAX_SERIES_VISITS} times.` };
  } else if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.until) || draft.until <= startsOn) {
    return { error: "Choose an end date after the first day." };
  }
  const weekdays = draft.mode === "weekly" ? [...new Set(draft.weekdays.length > 0 ? draft.weekdays : [isoWeekdayOf(startsOn)])].sort((a, b) => a - b) : [];
  return {
    rule: {
      frequency: draft.mode, interval: draft.interval, weekdays,
      end: draft.endKind === "count" ? { kind: "count", count: draft.count } : { kind: "until", date: draft.until },
    },
  };
}

/** "Every Tuesday at 10:00 am for 8 weeks", or empty while the draft is not ready. */
export function draftSummary(draft: RepeatDraft, startsOn: string, time: string, words?: { visit: string; visits: string }): string {
  const result = draftToRule(draft, startsOn);
  return result && "rule" in result ? ruleSummary(result.rule, startsOn, time, words) : "";
}

/** The draft's weekdays as shown: the chosen ones, or the first visit's own weekday when none is chosen. */
export function shownWeekdays(draft: RepeatDraft, startsOn: string): number[] {
  return draft.weekdays.length > 0 ? draft.weekdays : [isoWeekdayOf(startsOn)];
}

/** Staff's answer to one clashing visit. */
export type Answer = { action: "skip" } | { action: "move"; startsAt: string };
export type Answers = Record<number, Answer>;

export function resolutionsFrom(answers: Answers, preview: SeriesPreview): SeriesResolution[] {
  const clashing = new Set(preview.visits.filter((visit) => visit.state === "clash").map((visit) => visit.index));
  return Object.entries(answers)
    .filter(([index]) => clashing.has(Number(index)))
    .map(([index, answer]) => answer.action === "skip" ? { index: Number(index), action: "skip" as const } : { index: Number(index), action: "move" as const, startsAt: answer.startsAt });
}

/** How many clashing visits still have no answer. */
export function unresolvedCount(answers: Answers, preview: SeriesPreview): number {
  return preview.visits.filter((visit) => visit.state === "clash" && !answers[visit.index]).length;
}

/** How many visits would be booked once the answers are applied. */
export function bookedCount(answers: Answers, preview: SeriesPreview): number {
  return preview.visits.filter((visit) => visit.state === "free" || (answers[visit.index] && answers[visit.index]!.action === "move")).length;
}

/** Keeps the answers that still make sense after the list is checked again (the visit still clashes and the chosen time is still offered). */
export function keepValidAnswers(answers: Answers, preview: SeriesPreview): Answers {
  const kept: Answers = {};
  for (const visit of preview.visits) {
    const answer = answers[visit.index];
    if (!answer || visit.state !== "clash") continue;
    if (answer.action === "skip" || visit.alternatives.some((slot) => slot.startsAt === answer.startsAt)) kept[visit.index] = answer;
  }
  return kept;
}

/** The clock time (`HH:mm`) of an instant on the schedule's wall clock. The screens read the schedule in this one zone. */
export function clockIn(iso: string, timeZone = "Asia/Kolkata"): string {
  const parts = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).formatToParts(new Date(iso));
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "00";
  return `${part("hour")}:${part("minute")}`;
}
