"use client";

import { createParser, parseAsString, parseAsStringLiteral, useQueryStates } from "nuqs";

import { isClinicDateKey } from "./schedule-availability";
import { listRanges, type ScheduleView, scheduleViewParam } from "./schedule-view";

const statusValues = ["requested", "booked", "checked_in", "completed", "cancelled", "no_show"] as const;

const dateParser = createParser<string>({
  parse: (value) => (isClinicDateKey(value) ? value : null),
  serialize: (value) => value,
});

// Older links say `day` or `timeline`; reading them through scheduleViewParam keeps those links working.
const viewParser = createParser<ScheduleView>({
  parse: (value) => scheduleViewParam(value),
  serialize: (value) => value,
});

/**
 * Everything about what the schedule shows lives in the address bar: view, date, filters and the open
 * appointment. A link opens the same screen, Back steps through what was looked at, and a reload changes nothing.
 */
export const scheduleParsers = {
  view: viewParser,
  date: dateParser,
  range: parseAsStringLiteral(listRanges),
  location: parseAsString,
  staff: parseAsString,
  room: parseAsString,
  status: parseAsStringLiteral(statusValues),
  q: parseAsString,
  open: parseAsString,
};

export function useScheduleUrl() {
  // `shallow` (the default) keeps changes in the browser: no round trip to the server for a new view.
  return useQueryStates(scheduleParsers, { history: "push", clearOnDefault: true });
}
