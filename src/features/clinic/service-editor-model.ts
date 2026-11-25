import { amountInputValue, parseAmountInput } from "@/lib/money";
import { serviceSetupSchema, type ServiceSetup, type ServiceSetupUpdate } from "@/lib/service-setup";

/** What the editor's form holds: the service as the server returns it, minus the ids it never edits. */
export const serviceFormSchema = serviceSetupSchema.omit({ id: true, version: true });
export type ServiceFormValues = Omit<ServiceSetup, "id" | "version">;

export function formValuesFrom(setup: ServiceSetup): ServiceFormValues {
  return { basics: setup.basics, timing: setup.timing, lengths: setup.lengths, locationOptions: setup.locationOptions, look: setup.look, bookingPage: setup.bookingPage, intake: setup.intake, approval: setup.approval, cancelPolicy: setup.cancelPolicy, calendarEntry: setup.calendarEntry, afterBooking: setup.afterBooking };
}

/** Everything the editor saves; the server replaces each group whole and checks the version. */
export function updateFrom(values: ServiceFormValues, expectedVersion: number): ServiceSetupUpdate {
  return {
    expectedVersion,
    basics: values.basics,
    timing: values.timing,
    lengths: values.lengths,
    locationOptions: values.locationOptions,
    look: values.look,
    bookingPage: values.bookingPage,
    intake: values.intake,
    approval: values.approval,
    cancelPolicy: values.cancelPolicy,
    afterBooking: values.afterBooking,
    ...(values.calendarEntry ? { calendarEntry: values.calendarEntry } : {}),
  };
}

export type NoticeUnit = "minutes" | "hours" | "days";

/** The largest unit that shows the notice as a whole number: 1440 → 1 day, 90 → 90 minutes. */
export function noticeParts(minutes: number): { amount: number; unit: NoticeUnit } {
  if (minutes > 0 && minutes % 1440 === 0) return { amount: minutes / 1440, unit: "days" };
  if (minutes > 0 && minutes % 60 === 0) return { amount: minutes / 60, unit: "hours" };
  return { amount: minutes, unit: "minutes" };
}

export function noticeMinutes(amount: number, unit: NoticeUnit): number {
  return amount * (unit === "days" ? 1440 : unit === "hours" ? 60 : 1);
}

/** The price field shows rupees; empty means the price varies. */
export function priceText(priceMinor: number | null): string {
  return priceMinor === null ? "" : amountInputValue(priceMinor);
}

export function priceFromText(text: string): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (/^0(?:\.0{1,2})?$/.test(trimmed)) return 0;
  return parseAmountInput(trimmed) ?? undefined;
}

/** The first error message under a dotted path such as `timing.window.days`, or undefined. */
export function errorAt(errors: unknown, path: string): string | undefined {
  let node: unknown = errors;
  for (const part of path.split(".")) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node !== "object" || node === null) return undefined;
  const message = (node as { message?: unknown }).message;
  if (typeof message === "string") return message;
  const root = (node as { root?: { message?: unknown } }).root?.message;
  return typeof root === "string" ? root : undefined;
}

export function serviceLink(origin: string, businessSlug: string, serviceSlug: string): string {
  return `${origin}/book/${businessSlug}/${serviceSlug}`;
}
