import {
  checkFormAnswers,
  effectiveRequired,
  isFieldVisible,
  readPrefill,
  type FormAnswers,
  type FormAnswerCheck,
  type FormField,
  type PublicFormDefinition,
} from "@/lib/booking-forms";
import { GUESTS_MAX, type IntakeSettings } from "@/lib/booking-intake";
import type { ContactChannel } from "@/lib/domain";

import { fullNameProblem, splitFullName } from "./full-name";

/**
 * Pure helpers for the booking questions and the contact details: what to show, what to send, and what the link
 * (`?email=…&campaign=…`) fills in. Nothing here reads the page or logs a value.
 */

/** The booking link's query, as plain strings. */
export type LinkParams = Record<string, string | undefined>;

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmailAddress(value: string): boolean {
  const email = value.trim();
  return email.length <= 254 && emailPattern.test(email);
}

/** Phones are kept as "+" and digits (the phone field's own format). */
export function isPhoneNumber(value: string): boolean {
  return value.replace(/\D/g, "").length >= 8;
}

export const sameEmail = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The message for a list of guest addresses, or null when it is fine. */
export function guestsProblem(guests: readonly string[], intake: Pick<IntakeSettings, "maxGuests">, ownEmail = ""): string | null {
  const list = guests.map((guest) => guest.trim()).filter(Boolean);
  if (list.length > intake.maxGuests) return `You can add up to ${intake.maxGuests} ${intake.maxGuests === 1 ? "guest" : "guests"}.`;
  if (!list.every(isEmailAddress)) return "Enter guest email addresses like name@example.com.";
  if (new Set(list.map((guest) => guest.toLowerCase())).size !== list.length) return "The same email address is listed twice.";
  if (ownEmail && list.some((guest) => sameEmail(guest, ownEmail))) return "Use a different email for each guest. Yours is already on the booking.";
  return null;
}

/** The questions the customer sees: no hidden ones and, when guests are added in the details step, no guest-email question. */
export function shownQuestions(form: Pick<PublicFormDefinition, "fields">, allowGuests: boolean): FormField[] {
  return form.fields.filter((field) => !field.hidden && !(allowGuests && field.type === "emails"));
}

/** Answers with those of questions that are now hidden by their conditions removed. Hidden (link-only) questions are kept. */
export function pruneAnswers(fields: readonly FormField[], answers: FormAnswers): FormAnswers {
  const next: FormAnswers = { ...answers };
  // Questions come in order and only look at earlier ones, so one pass against the pruned copy settles chains.
  for (const field of fields) {
    if (!field.hidden && !isFieldVisible(field, next, fields)) delete next[field.id];
  }
  return next;
}

/** What a link fills into one form: values to start from, values that stay fixed, and the fixed ones' ids. */
export interface FormPrefill {
  /** Every valid value from the link. */
  answers: FormAnswers;
  /** Questions shown read-only, and link-only questions: their value comes from the link every time. */
  forced: FormAnswers;
  locked: string[];
}

const emptyPrefill: FormPrefill = { answers: {}, forced: {}, locked: [] };

export function prefillForForm(form: PublicFormDefinition | undefined, params: LinkParams, allowGuests: boolean): FormPrefill {
  if (!form || Object.keys(params).length === 0) return emptyPrefill;
  const fields = form.fields.filter((field) => !(allowGuests && field.type === "emails"));
  const { answers, locked } = readPrefill(fields, params);
  const forcedIds = new Set([...locked, ...fields.filter((field) => field.hidden).map((field) => field.id)]);
  const forced = Object.fromEntries(Object.entries(answers).filter(([id]) => forcedIds.has(id)));
  return { answers, forced, locked };
}

/** Required marks and checks for this service: a per-service override wins; the guest-email question is never asked. */
export function requiredFor(form: PublicFormDefinition, serviceId: string, allowGuests: boolean): Record<string, boolean> {
  const overrides: Record<string, boolean> = { ...form.requiredOverrides?.[serviceId] };
  if (allowGuests) for (const field of form.fields) if (field.type === "emails") overrides[field.id] = false;
  return overrides;
}

export function isRequired(field: FormField, form: PublicFormDefinition, serviceId: string, allowGuests: boolean): boolean {
  return effectiveRequired(field, requiredFor(form, serviceId, allowGuests));
}

/** The answers to send: only this form's questions that are still shown, plus the link-only ones. */
export function answersToSend(form: PublicFormDefinition, answers: FormAnswers, allowGuests: boolean): FormAnswers {
  const pruned = pruneAnswers(form.fields, answers);
  const skipped = new Set(form.fields.filter((field) => allowGuests && field.type === "emails").map((field) => field.id));
  return Object.fromEntries(Object.entries(pruned).filter(([id]) => form.fields.some((field) => field.id === id) && !skipped.has(id)));
}

/** Checks the answers the way the server will. */
export function checkQuestions(form: PublicFormDefinition, serviceId: string, answers: FormAnswers, allowGuests: boolean): FormAnswerCheck {
  return checkFormAnswers(form.fields, answersToSend(form, answers, allowGuests), { requiredOverrides: requiredFor(form, serviceId, allowGuests) });
}

/** Link values for the built-in details. Anything that does not pass is left out. */
export interface LinkDetails {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  reasonForVisit?: string;
  guests: string[];
  locationId?: string;
}

function linkValue(params: LinkParams, key: string): string | undefined {
  const entry = Object.entries(params).find(([name]) => name.toLowerCase() === key);
  return entry?.[1];
}

export function readLinkDetails(params: LinkParams): LinkDetails {
  const details: LinkDetails = { guests: [] };

  const name = linkValue(params, "name")?.trim().replace(/\s+/g, " ").slice(0, 160);
  if (name) {
    const { firstName, lastName } = splitFullName(name);
    if (!fullNameProblem(firstName, lastName)) {
      details.firstName = firstName;
      details.lastName = lastName;
    }
  }

  const email = linkValue(params, "email")?.trim();
  if (email && isEmailAddress(email)) details.email = email;

  // A "+" in a link reads as a space, so a number that starts with one gets its plus back.
  const phoneRaw = linkValue(params, "phone");
  if (phoneRaw) {
    const plus = phoneRaw.startsWith("+") || phoneRaw.startsWith(" ");
    const digits = phoneRaw.replace(/\D/g, "");
    if (plus && digits.length >= 8 && digits.length <= 15) details.phone = `+${digits}`;
  }

  const notes = linkValue(params, "notes")?.trim();
  if (notes && notes.length <= 300) details.reasonForVisit = notes;

  const guests = linkValue(params, "guests")
    ?.split(",")
    .map((guest) => guest.trim())
    .filter(Boolean);
  if (guests) {
    const seen = new Set<string>();
    for (const guest of guests) {
      if (!isEmailAddress(guest) || seen.has(guest.toLowerCase())) continue;
      seen.add(guest.toLowerCase());
      details.guests.push(guest);
    }
    details.guests = details.guests.slice(0, GUESTS_MAX);
  }

  const location = linkValue(params, "location")?.trim();
  if (location && location.length <= 160) details.locationId = location;
  return details;
}

/**
 * How reminders can reach the customer. A phone-only service never uses email; without a number, only email works.
 * The customer's own pick is kept whenever it can work.
 */
export function usableChannel(channel: ContactChannel, contact: { phone: string; email: string }, phoneOnly: boolean): ContactChannel {
  if (phoneOnly) return channel === "email" ? "sms" : channel;
  if (!contact.phone.trim() && channel !== "email") return "email";
  return channel;
}
