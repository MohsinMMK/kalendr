/**
 * How a business's own customer field reads, checks, shows and sorts its values. Every value is stored as text; the field's
 * kind decides what that text means. Shared by the server (which refuses a bad value) and the screens (cell editors, the profile),
 * so both say the same thing. No "server-only" import: the browser uses this file.
 */
import { fieldKinds, MAX_FIELD_VALUE_LENGTH, type CustomerFieldDefinition, type FieldKind } from "./customer-contracts";

export type FieldShape = Pick<CustomerFieldDefinition, "kind" | "choices" | "label">;

export const fieldKindLabels: Record<FieldKind, string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  choice: "Choice",
  multichoice: "Multiple choice",
  boolean: "Yes or no",
  phone: "Phone",
  email: "Email",
  link: "Link",
};

export const fieldKindHints: Record<FieldKind, string> = {
  text: "Any words",
  number: "Digits, with a decimal if needed",
  date: "A day on the calendar",
  choice: "Pick one from your list",
  multichoice: "Pick any from your list",
  boolean: "A checkbox",
  phone: "A phone number",
  email: "An email address",
  link: "A web address",
};

export function kindOf(value: string): FieldKind {
  return fieldKinds.find((kind) => kind === value) ?? "text";
}

/** The picked options of a multiple-choice value. Anything that is not a list of text reads as nothing picked. */
export function parseMultiValue(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

export function encodeMultiValue(picked: readonly string[]): string {
  return JSON.stringify(picked);
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function normaliseLink(value: string): string | null {
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.hostname.includes(".")) return null;
    return withScheme;
  } catch {
    return null;
  }
}

/** A value in the form its field's kind stores, or a sentence saying what is wrong with it. */
export function normaliseFieldValue(definition: FieldShape, raw: string): { value: string } | { error: string } {
  const value = raw.trim();
  if (value.length > MAX_FIELD_VALUE_LENGTH) return { error: `${definition.label} is too long.` };
  switch (definition.kind) {
    case "text":
      return { value };
    case "number": {
      const number = Number(value);
      if (value === "" || !Number.isFinite(number) || Math.abs(number) > 1e12) return { error: `${definition.label} must be a number.` };
      return { value: String(number) };
    }
    case "date": {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return { error: `${definition.label} must be a date.` };
      const parsed = new Date(`${value}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) return { error: `${definition.label} must be a real date.` };
      return { value };
    }
    case "choice":
      return definition.choices.includes(value) ? { value } : { error: `Choose one of the options for ${definition.label}.` };
    case "multichoice": {
      const picked = parseMultiValue(value);
      const kept = definition.choices.filter((choice) => picked.includes(choice));
      if (kept.length === 0 || kept.length !== new Set(picked).size) return { error: `Choose from the options for ${definition.label}.` };
      return { value: encodeMultiValue(kept) };
    }
    case "boolean": {
      const lower = value.toLowerCase();
      if (lower === "true" || lower === "yes") return { value: "true" };
      if (lower === "false" || lower === "no") return { value: "false" };
      return { error: `${definition.label} must be yes or no.` };
    }
    case "phone": {
      const digits = value.replace(/\D/g, "");
      if (!/^\+?[\d\s().-]+$/.test(value) || digits.length < 6 || digits.length > 15) return { error: `${definition.label} must be a phone number.` };
      return { value };
    }
    case "email": {
      const lower = value.toLowerCase();
      if (lower.length > 254 || !emailPattern.test(lower)) return { error: `${definition.label} must be an email address.` };
      return { value: lower };
    }
    case "link": {
      const link = normaliseLink(value);
      return link ? { value: link } : { error: `${definition.label} must be a web address.` };
    }
  }
}

/**
 * What a stored value becomes when its field changes kind, or `null` when it does not fit the new kind and is cleared.
 * Nothing is guessed: a choice only turns into a multiple choice, and back only when exactly one is picked.
 */
export function convertFieldValue(from: FieldShape, to: FieldShape, stored: string): string | null {
  const accept = (result: ReturnType<typeof normaliseFieldValue>) => ("value" in result ? result.value : null);
  if (to.kind === "multichoice") {
    // The same kind keeps what still exists in the list; a single choice becomes a list of one.
    const picked = from.kind === "multichoice" ? parseMultiValue(stored) : from.kind === "choice" ? [stored] : [];
    const kept = to.choices.filter((choice) => picked.includes(choice));
    return kept.length > 0 ? encodeMultiValue(kept) : null;
  }
  if (from.kind === "multichoice") {
    const picked = parseMultiValue(stored);
    if (to.kind === "choice") return picked.length === 1 ? accept(normaliseFieldValue(to, picked[0] ?? "")) : null;
    return accept(normaliseFieldValue(to, picked.join(", ")));
  }
  if (from.kind === "boolean") return accept(normaliseFieldValue(to, formatFieldValue(from, stored)));
  return accept(normaliseFieldValue(to, stored));
}

/** A value as people read it: "Yes", "A, B", "14 Mar 2026". The raw text when the kind has no better form. */
export function formatFieldValue(definition: FieldShape, value: string): string {
  switch (definition.kind) {
    case "boolean":
      return value === "true" ? "Yes" : value === "false" ? "No" : "";
    case "multichoice":
      return parseMultiValue(value).join(", ");
    case "date": {
      const parsed = new Date(`${value}T00:00:00Z`);
      return Number.isNaN(parsed.getTime()) ? value : new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(parsed);
    }
    default:
      return value;
  }
}

/** Orders two stored values of one field: numbers by size, dates by day, the rest alphabetically. Empty values go last. */
export function compareFieldValues(definition: FieldShape, a: string | undefined, b: string | undefined): number {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  if (definition.kind === "number") return Number(a) - Number(b);
  if (definition.kind === "date") return a < b ? -1 : a > b ? 1 : 0;
  return formatFieldValue(definition, a).localeCompare(formatFieldValue(definition, b), undefined, { sensitivity: "base" });
}

