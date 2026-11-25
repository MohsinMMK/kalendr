type DateFormat = "long" | "short" | "time" | "key";

const dateFormats: Record<DateFormat, Intl.DateTimeFormatOptions> = {
  long: { weekday: "long", day: "numeric", month: "long", year: "numeric" },
  short: { weekday: "short", day: "numeric", month: "short" },
  time: { hour: "numeric", minute: "2-digit" },
  key: { year: "numeric", month: "2-digit", day: "2-digit" },
};

// Formatters are expensive to construct. Cache configuration only, never patient data,
// and bound the cache for server processes serving multiple locales and timezones.
const formatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(format: DateFormat, locale: string, timeZone: string): Intl.DateTimeFormat {
  const key = JSON.stringify([format, locale, timeZone]);
  const existing = formatters.get(key);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat(locale, { ...dateFormats[format], timeZone });
  if (formatters.size >= 64) formatters.delete(formatters.keys().next().value!);
  formatters.set(key, formatter);
  return formatter;
}

export function formatLongDate(
  value: string,
  locale: string,
  timeZone: string,
): string {
  return dateFormatter("long", locale, timeZone).format(new Date(value));
}

export function formatShortDate(
  value: string,
  locale: string,
  timeZone: string,
): string {
  return dateFormatter("short", locale, timeZone).format(new Date(value));
}

export function formatTime(
  value: string,
  locale: string,
  timeZone: string,
): string {
  return dateFormatter("time", locale, timeZone).format(new Date(value));
}

export function formatDateTime(
  value: string,
  locale: string,
  timeZone: string,
): string {
  return `${formatLongDate(value, locale, timeZone)} at ${formatTime(
    value,
    locale,
    timeZone,
  )}`;
}

/** The zone in words a patient recognises, such as "India Standard Time" rather than "Asia/Kolkata". */
export function formatTimeZoneName(
  timeZone: string,
  locale: string,
  at: Date = new Date(),
): string {
  const parts = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: "long" }).formatToParts(at);
  return parts.find((part) => part.type === "timeZoneName")?.value ?? timeZone;
}

export function getDateKey(value: string, timeZone: string): string {
  const parts = dateFormatter("key", "en-CA", timeZone).formatToParts(new Date(value));
  const getPart = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";

  return `${getPart("year")}-${getPart("month")}-${getPart("day")}`;
}

export function getDurationLabel(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} min`;
  }

  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours} hr` : `${hours} hr ${remainder} min`;
}

export function withServiceDuration(
  startsAt: string,
  durationMinutes: number,
): string {
  return new Date(
    new Date(startsAt).getTime() + durationMinutes * 60_000,
  ).toISOString();
}

export function phoneHref(phone: string): string {
  return `tel:${phone.replace(/[^+\d]/g, "")}`;
}
