export interface WorkingHourWindow {
  dayOfWeek: number;
  startsAtLocal: string;
  endsAtLocal: string;
  breakStartsAtLocal?: string;
  breakEndsAtLocal?: string;
}

export interface WorkingHoursValue {
  days?: number[];
  startsAtLocal?: string;
  endsAtLocal?: string;
  breakStartsAtLocal?: string;
  breakEndsAtLocal?: string;
  windows?: WorkingHourWindow[];
}

export interface AvailabilityRuleSlice {
  practitionerId: string;
  dayOfWeek: number;
  startsAtLocal: string;
  endsAtLocal: string;
}

const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function splitBreak(window: WorkingHourWindow): Array<{ dayOfWeek: number; startsAtLocal: string; endsAtLocal: string }> {
  const { dayOfWeek, startsAtLocal, endsAtLocal, breakStartsAtLocal, breakEndsAtLocal } = window;
  if (!breakStartsAtLocal || !breakEndsAtLocal) {
    return [{ dayOfWeek, startsAtLocal, endsAtLocal }];
  }
  if (breakStartsAtLocal >= breakEndsAtLocal) return [{ dayOfWeek, startsAtLocal, endsAtLocal }];
  if (breakStartsAtLocal <= startsAtLocal || breakEndsAtLocal >= endsAtLocal) {
    return [{ dayOfWeek, startsAtLocal, endsAtLocal }];
  }
  return [
    { dayOfWeek, startsAtLocal, endsAtLocal: breakStartsAtLocal },
    { dayOfWeek, startsAtLocal: breakEndsAtLocal, endsAtLocal },
  ];
}

export function expandWorkingHourWindows(
  hours: WorkingHoursValue,
): Array<{ dayOfWeek: number; startsAtLocal: string; endsAtLocal: string }> {
  const source = hours.windows?.length
    ? hours.windows
    : (hours.days ?? []).map((dayOfWeek) => ({
        dayOfWeek,
        startsAtLocal: hours.startsAtLocal ?? "09:00",
        endsAtLocal: hours.endsAtLocal ?? "17:00",
        ...(hours.breakStartsAtLocal ? { breakStartsAtLocal: hours.breakStartsAtLocal } : {}),
        ...(hours.breakEndsAtLocal ? { breakEndsAtLocal: hours.breakEndsAtLocal } : {}),
      }));
  return source.flatMap(splitBreak);
}

export function groupRulesIntoWindows(rules: AvailabilityRuleSlice[]): WorkingHourWindow[] {
  const byDay = new Map<number, Array<{ startsAtLocal: string; endsAtLocal: string }>>();
  for (const rule of [...rules].sort((first, second) => (
    first.dayOfWeek - second.dayOfWeek || first.startsAtLocal.localeCompare(second.startsAtLocal)
  ))) {
    const current = byDay.get(rule.dayOfWeek) ?? [];
    const previous = current[current.length - 1];
    // Multiple practitioners can cover the same hours. Overlapping or adjacent
    // coverage is continuous availability, not a backwards or zero-length lunch.
    if (previous && rule.startsAtLocal <= previous.endsAtLocal) {
      if (rule.endsAtLocal > previous.endsAtLocal) previous.endsAtLocal = rule.endsAtLocal;
    } else {
      current.push({ startsAtLocal: rule.startsAtLocal, endsAtLocal: rule.endsAtLocal });
    }
    byDay.set(rule.dayOfWeek, current);
  }
  return [...byDay.entries()].map(([dayOfWeek, windows]) => {
    const first = windows[0]!;
    const last = windows[windows.length - 1]!;
    if (windows.length === 1) {
      return { dayOfWeek, startsAtLocal: first.startsAtLocal, endsAtLocal: first.endsAtLocal };
    }
    return {
      dayOfWeek,
      startsAtLocal: first.startsAtLocal,
      endsAtLocal: last.endsAtLocal,
      breakStartsAtLocal: first.endsAtLocal,
      breakEndsAtLocal: windows[1]!.startsAtLocal,
    };
  });
}

function compactDayLabel(days: number[]): string {
  const unique = [...new Set(days)].sort((first, second) => first - second);
  if (unique.length === 0) return "";
  const sequential = unique.every((day, index) => index === 0 || day === unique[index - 1]! + 1);
  if (sequential && unique.length > 1) {
    return `${dayNames[unique[0]! - 1]}–${dayNames[unique[unique.length - 1]! - 1]}`;
  }
  return unique.map((day) => dayNames[day - 1]).join(", ");
}

function windowSignature(window: WorkingHourWindow): string {
  return [
    window.startsAtLocal,
    window.endsAtLocal,
    window.breakStartsAtLocal ?? "",
    window.breakEndsAtLocal ?? "",
  ].join("|");
}

export function formatClock(value: string): string {
  const [hourText, minuteText] = value.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return value;
  const suffix = hour >= 12 ? "pm" : "am";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return minute === 0 ? `${twelve} ${suffix}` : `${twelve}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function formatWindowTimes(window: WorkingHourWindow): string {
  const span = `${formatClock(window.startsAtLocal)}–${formatClock(window.endsAtLocal)}`;
  if (window.breakStartsAtLocal && window.breakEndsAtLocal) {
    return `${span}, lunch ${formatClock(window.breakStartsAtLocal)}–${formatClock(window.breakEndsAtLocal)}`;
  }
  return span;
}

export function formatHoursSummary(rules: AvailabilityRuleSlice[]): string {
  if (rules.length === 0) return "";
  const windows = groupRulesIntoWindows(rules);
  const grouped = new Map<string, number[]>();
  for (const window of windows) {
    const key = windowSignature(window);
    const days = grouped.get(key) ?? [];
    days.push(window.dayOfWeek);
    grouped.set(key, days);
  }
  return [...grouped.entries()].map(([signature, days]) => {
    const sample = windows.find((window) => windowSignature(window) === signature)!;
    return `${compactDayLabel(days)} ${formatWindowTimes(sample)}`;
  }).join(" · ");
}

export function windowsShareHours(windows: WorkingHourWindow[]): boolean {
  if (windows.length <= 1) return true;
  const [first, ...rest] = windows;
  const signature = windowSignature(first!);
  return rest.every((window) => windowSignature(window) === signature);
}

/** One set of hours for a doctor's whole working week. Days are ISO, 1 for Monday through 7 for Sunday. */
export interface HoursDraft {
  days: number[];
  start: string;
  end: string;
  breakStart: string | null;
  breakEnd: string | null;
}

export const defaultHoursDraft: HoursDraft = { days: [1, 2, 3, 4, 5, 6], start: "09:00", end: "17:00", breakStart: null, breakEnd: null };

/** Reads saved rules as one draft. `uniform` is false when days differ, because saving a draft replaces them all. */
export function draftFromRules(rules: AvailabilityRuleSlice[]): { draft: HoursDraft; uniform: boolean } {
  const windows = groupRulesIntoWindows(rules.map((rule) => ({
    ...rule,
    startsAtLocal: rule.startsAtLocal.slice(0, 5),
    endsAtLocal: rule.endsAtLocal.slice(0, 5),
  })));
  const first = windows[0];
  if (!first) return { draft: defaultHoursDraft, uniform: true };
  return {
    draft: {
      days: windows.map((window) => window.dayOfWeek),
      start: first.startsAtLocal,
      end: first.endsAtLocal,
      breakStart: first.breakStartsAtLocal ?? null,
      breakEnd: first.breakEndsAtLocal ?? null,
    },
    uniform: windowsShareHours(windows),
  };
}

export function draftToHoursBody(draft: HoursDraft): WorkingHoursValue {
  return {
    days: [...draft.days].sort((first, second) => first - second),
    startsAtLocal: draft.start,
    endsAtLocal: draft.end,
    ...(draft.breakStart && draft.breakEnd ? { breakStartsAtLocal: draft.breakStart, breakEndsAtLocal: draft.breakEnd } : {}),
  };
}

export function draftToRules(practitionerId: string, draft: HoursDraft): AvailabilityRuleSlice[] {
  return expandWorkingHourWindows(draftToHoursBody(draft)).map((window) => ({ practitionerId, ...window }));
}
