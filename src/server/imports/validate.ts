import { isSupportedCountry, parsePhoneNumberFromString } from "libphonenumber-js";
import { z } from "zod";

import { formatMoney, priceFromLabel } from "@/lib/money";
import { normalizePhone } from "@/lib/patient-contact";
import { staffBookingSchema, staffCreateServiceSchema } from "@/server/contracts";

import type { DateFormat, ImportErrorCode } from "./contracts";
import { parseDate, parseDateAndTime, parseTime } from "./dates";

/**
 * Turns one row of text into the values the app would save, using the same zod schemas the staff desk and settings use:
 * a customer is checked as a new customer on the booking form, a service as a service made in settings. Nothing here
 * reads the database; duplicates and name matching are decided by the check, which knows what already exists.
 */

export interface RowIssue {
  code: ImportErrorCode;
  /** The field at fault, by its field key. */
  field: string;
}

export type Normalised<T> = { ok: true; value: T } | { ok: false; issue: RowIssue };

export interface RowSettings {
  dateFormat: DateFormat;
  /** Two-letter country for numbers with no +code. */
  region: string;
  /** Today, "yyyy-mm-dd", for the future-date-of-birth rule. */
  today: string;
}

const fail = (code: ImportErrorCode, field: string): { ok: false; issue: RowIssue } => ({ ok: false, issue: { code, field } });

/** The same fields the booking form takes for a customer made on the spot (staffBookingSchema.newPatient). */
const newCustomerSchema = staffBookingSchema.shape.newPatient.unwrap();

export type CustomerFields = z.infer<typeof newCustomerSchema>;

export interface CustomerValue extends CustomerFields {
  /** What the phone matches on: the digits, the way kalendr_normalize_phone() reads a stored number. */
  phoneKey: string;
  /** Lower-case email, or "" when there is none. */
  emailKey: string;
}

const channelWords: Record<string, "sms" | "email" | "whatsapp" | "phone"> = {
  sms: "sms", text: "sms", texts: "sms", message: "sms", messages: "sms", msg: "sms",
  whatsapp: "whatsapp", wa: "whatsapp", whatsap: "whatsapp",
  email: "email", mail: "email", emails: "email",
  phone: "phone", call: "phone", calls: "phone", voice: "phone", telephone: "phone",
};

const yesWords = new Set(["yes", "y", "true", "1", "agreed", "consent", "consented", "opted in", "optin", "ok", "accepted"]);
const noWords = new Set(["no", "n", "false", "0", "declined", "none", "opted out", "optout", ""]);

export function parseYesNo(text: string): boolean | null {
  const value = text.trim().toLowerCase();
  if (yesWords.has(value)) return true;
  if (noWords.has(value)) return false;
  return null;
}

/** A phone as E.164 ("+919845012345"), or null. Spreadsheet leftovers such as "9845012345.0" are cleaned first. */
export function normalisePhoneNumber(text: string, region: string): string | null {
  const cleaned = text.trim().replace(/^(\d+)\.0+$/, "$1");
  if (!cleaned) return null;
  // An unknown country code reads only numbers that carry their own +code, rather than failing every row.
  const parsed = isSupportedCountry(region) ? parsePhoneNumberFromString(cleaned, region) : parsePhoneNumberFromString(cleaned);
  return parsed?.isValid() ? parsed.number : null;
}

export function phoneKeyOf(e164: string): string {
  return normalizePhone(e164);
}

function issueFor(error: z.ZodError, fallbackField: string): RowIssue {
  const issue = error.issues[0];
  const field = typeof issue?.path[0] === "string" ? issue.path[0] : fallbackField;
  if (!issue) return { code: "invalid_value", field };
  // The app's own date-of-birth rule (a real date, not before 1900, not in the future) lives in the schema.
  if (field === "dateOfBirth") return { code: "invalid_date", field };
  // A length outside 5 to 480 minutes is a wrong value, not an empty or a too-long text.
  if (field === "durationMinutes") return { code: "invalid_value", field };
  if (issue.code === "too_big") return { code: "too_long", field };
  if (issue.code === "too_small") return { code: "required_missing", field };
  if (issue.code === "invalid_format" && "format" in issue && issue.format === "email") return { code: "invalid_email", field };
  return { code: "invalid_value", field };
}

export function normaliseCustomer(raw: Record<string, string>, settings: RowSettings): Normalised<CustomerValue> {
  const firstName = (raw.firstName ?? "").trim();
  if (!firstName) return fail("required_missing", "firstName");
  const phoneText = (raw.phone ?? "").trim();
  if (!phoneText) return fail("required_missing", "phone");
  const phone = normalisePhoneNumber(phoneText, settings.region);
  if (!phone) return fail("invalid_phone", "phone");

  const email = (raw.email ?? "").trim().toLowerCase();
  const dobText = (raw.dateOfBirth ?? "").trim();
  let dateOfBirth: string | undefined;
  if (dobText) {
    const parsed = parseDate(dobText, settings.dateFormat);
    if (!parsed || parsed > settings.today) return fail("invalid_date", "dateOfBirth");
    dateOfBirth = parsed;
  }

  const channelText = (raw.preferredChannel ?? "").trim().toLowerCase();
  let preferredChannel: "sms" | "email" | "whatsapp" | "phone";
  if (channelText) {
    const word = channelWords[channelText];
    if (!word) return fail("invalid_value", "preferredChannel");
    preferredChannel = word;
  } else {
    preferredChannel = email ? "email" : "phone";
  }
  // The booking form's own rule: a customer who is reached by email needs an email address.
  if (preferredChannel === "email" && !email) return fail("invalid_value", "preferredChannel");

  const consentText = raw.messagingConsent;
  const consent = consentText === undefined ? false : parseYesNo(consentText);
  if (consent === null) return fail("invalid_value", "messagingConsent");

  const parsed = newCustomerSchema.safeParse({
    firstName,
    lastName: (raw.lastName ?? "").trim(),
    phone,
    email,
    dateOfBirth,
    preferredChannel,
    accessibilityNeed: (raw.accessibilityNeed ?? "").trim() || undefined,
    isDependent: false,
    messagingConsent: consent,
  });
  if (!parsed.success) return { ok: false, issue: issueFor(parsed.error, "firstName") };
  return { ok: true, value: { ...parsed.data, phoneKey: phoneKeyOf(parsed.data.phone), emailKey: parsed.data.email } };
}

const serviceFieldsSchema = staffCreateServiceSchema.pick({ name: true, description: true, durationMinutes: true, bookingMode: true, priceLabel: true, category: true });

export interface ServiceValue {
  name: string;
  description: string;
  durationMinutes: number;
  bookingMode: "instant" | "request";
  priceLabel: string | null;
  priceMinor: number | null;
  category: string | null;
  /** The comparison key for duplicates: the name in lower case with spaces collapsed. */
  nameKey: string;
}

/** "45", "45 min", "1h", "1h 30m", "1.5 hours" as whole minutes, or null. */
export function parseDurationMinutes(text: string): number | null {
  const value = text.trim().toLowerCase();
  if (/^\d+(?:\.0+)?$/.test(value)) return Number(value.replace(/\.0+$/, ""));
  const hours = /(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/.exec(value);
  const minutes = /(\d+)\s*(?:m|min|mins|minute|minutes)\b/.exec(value);
  if (!hours && !minutes) return null;
  const total = Math.round((hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0));
  return Number.isFinite(total) ? total : null;
}

export const nameKeyOf = (name: string): string => name.trim().replace(/\s+/g, " ").toLowerCase();

export function normaliseService(raw: Record<string, string>): Normalised<ServiceValue> {
  const name = (raw.name ?? "").trim();
  if (!name) return fail("required_missing", "name");
  const durationText = (raw.durationMinutes ?? "").trim();
  if (!durationText) return fail("required_missing", "durationMinutes");
  const durationMinutes = parseDurationMinutes(durationText);
  if (durationMinutes === null) return fail("invalid_value", "durationMinutes");

  const modeText = (raw.mode ?? "").trim().toLowerCase();
  let bookingMode: "instant" | "request" = "instant";
  if (modeText) {
    if (["request", "approval", "approve", "manual", "requested", "on request"].includes(modeText)) bookingMode = "request";
    else if (["instant", "online", "auto", "automatic", "direct", "immediate"].includes(modeText)) bookingMode = "instant";
    else return fail("invalid_value", "mode");
  }
  const priceText = (raw.price ?? "").trim();
  const exact = priceText ? priceFromLabel(priceText) : null;
  // An exact price is shown the way the app shows prices; anything else ("From 500") stays as the owner wrote it.
  const priceLabel = priceText ? (exact !== null ? formatMoney(exact) : priceText) : null;
  const description = (raw.description ?? "").trim() || name;

  const parsed = serviceFieldsSchema.safeParse({
    name, description, durationMinutes, bookingMode, priceLabel, category: (raw.category ?? "").trim() || null,
  });
  if (!parsed.success) return { ok: false, issue: issueFor(parsed.error, "name") };
  return {
    ok: true,
    value: {
      name: parsed.data.name,
      description: parsed.data.description,
      durationMinutes: parsed.data.durationMinutes,
      bookingMode: parsed.data.bookingMode,
      priceLabel: parsed.data.priceLabel ?? null,
      priceMinor: priceFromLabel(parsed.data.priceLabel),
      category: parsed.data.category ?? null,
      nameKey: nameKeyOf(parsed.data.name),
    },
  };
}

export interface AppointmentValue {
  customerPhoneKey: string;
  customerEmail: string;
  serviceKey: string;
  staffKey: string;
  /** "yyyy-mm-dd" and "HH:mm" as written in the business's own clock. */
  date: string;
  time: string;
  durationMinutes: number | null;
}

/** Name matching for staff and services: case, spacing and a leading "Dr." do not matter. */
export const personKeyOf = (name: string): string => nameKeyOf(name.replace(/\./g, " ")).replace(/^(dr|mr|mrs|ms|prof)\s+/, "");

export function normaliseAppointment(raw: Record<string, string>, settings: RowSettings): Normalised<AppointmentValue> {
  const phoneText = (raw.customerPhone ?? "").trim();
  const email = (raw.customerEmail ?? "").trim().toLowerCase();
  if (!phoneText && !email) return fail("required_missing", "customerPhone");
  let customerPhoneKey = "";
  if (phoneText) {
    const phone = normalisePhoneNumber(phoneText, settings.region);
    if (!phone) return fail("invalid_phone", "customerPhone");
    customerPhoneKey = phoneKeyOf(phone);
  }
  if (email && !z.email().max(254).safeParse(email).success) return fail("invalid_email", "customerEmail");
  const service = (raw.service ?? "").trim();
  if (!service) return fail("required_missing", "service");
  const staff = (raw.staff ?? "").trim();
  if (!staff) return fail("required_missing", "staff");
  const when = (raw.startsAt ?? "").trim();
  if (!when) return fail("required_missing", "startsAt");
  const parsedWhen = parseDateAndTime(when, settings.dateFormat);
  if (!parsedWhen) return fail("invalid_date", "startsAt");
  let time = parsedWhen.time;
  const timeText = (raw.startTime ?? "").trim();
  if (!time && timeText) {
    time = parseTime(timeText);
    if (!time) return fail("invalid_date", "startTime");
  }
  if (!time) return fail("required_missing", "startTime");
  let durationMinutes: number | null = null;
  const durationText = (raw.durationMinutes ?? "").trim();
  if (durationText) {
    durationMinutes = parseDurationMinutes(durationText);
    if (durationMinutes === null || durationMinutes < 5 || durationMinutes > 480) return fail("invalid_value", "durationMinutes");
  }
  return { ok: true, value: { customerPhoneKey, customerEmail: email, serviceKey: nameKeyOf(service), staffKey: personKeyOf(staff), date: parsedWhen.date, time, durationMinutes } };
}
