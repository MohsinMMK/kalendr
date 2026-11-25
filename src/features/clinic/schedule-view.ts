/** The four ways to look at the diary. `staff` and `rooms` are one day as rows; `week` is seven days; `list` is a plain list. */
export const scheduleViews = ["staff", "rooms", "week", "list"] as const;
export type ScheduleView = (typeof scheduleViews)[number];

/**
 * Reads `?view=`. Links made before the four views existed keep working: `timeline` and `day` were the
 * staff timeline, `agenda` was the list, and `month` and `year` open the week.
 */
export function scheduleViewParam(value: string | null | undefined): ScheduleView {
  switch (value) {
    case "rooms":
    case "week":
    case "list":
    case "staff":
      return value;
    case "agenda":
      return "list";
    case "month":
    case "year":
      return "week";
    default:
      return "staff";
  }
}

/** The list shows one day or one week at a time. */
export const listRanges = ["day", "week"] as const;
export type ListRange = (typeof listRanges)[number];
