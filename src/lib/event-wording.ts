/**
 * What a calendar entry says (feature 50). A template is plain text with `{placeholders}`; there is no template engine, no
 * conditions and no code. Pure: the customer's invite, the staff calendars and the editor's live preview all call this, so
 * what staff see in the preview is what is written.
 */

export const wordingPlaceholders = ["service", "customer", "customer_first_name", "person", "business", "branch", "location", "length"] as const;
export type WordingPlaceholder = (typeof wordingPlaceholders)[number];

export const placeholderHelp: Record<WordingPlaceholder, string> = {
  service: "The service booked",
  customer: "The customer’s full name",
  customer_first_name: "Their first name",
  person: "The person they are booked with",
  business: "The business name",
  branch: "The branch name",
  location: "Branch name and address",
  length: "How long it is, like 45 min",
};

export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 1_000;

export interface WordingValues {
  service: string;
  customer: string;
  customerFirstName: string;
  person: string;
  business: string;
  branch: string;
  location: string;
  length: string;
  /** Booking-question answers by key. Left out entirely when notes are hidden. */
  answers?: Readonly<Record<string, string>>;
}

const placeholderPattern = /\{([A-Za-z0-9_.-]{1,60})\}/g;

function valueFor(name: string, values: WordingValues): string | undefined {
  switch (name.toLowerCase()) {
    case "service": return values.service;
    case "customer": return values.customer;
    case "customer_first_name": return values.customerFirstName;
    case "person": return values.person;
    case "business": return values.business;
    case "branch": return values.branch;
    case "location": return values.location;
    case "length": return values.length;
    default: return values.answers?.[name.toLowerCase()];
  }
}

export interface RenderedWording {
  text: string;
  /** Placeholders that are not built in and not a question of the service. They stay as typed in the text. */
  unknown: string[];
}

/**
 * Fills the placeholders. A placeholder that names nothing known stays exactly as typed and is listed in `unknown` so
 * the editor can flag it. When `hideAnswers` is set, question placeholders become empty instead of the answer.
 */
export function renderWording(template: string, values: WordingValues, options: { questionKeys?: readonly string[]; hideAnswers?: boolean } = {}): RenderedWording {
  const known = new Set((options.questionKeys ?? []).map((key) => key.toLowerCase()));
  const unknown: string[] = [];
  const text = template.replace(placeholderPattern, (match, name: string) => {
    const lower = name.toLowerCase();
    if ((wordingPlaceholders as readonly string[]).includes(lower)) return valueFor(lower, values) ?? "";
    if (known.has(lower)) return options.hideAnswers ? "" : values.answers?.[lower] ?? "";
    // Without a list of the service's questions, an answer that is present still fills in.
    if (options.questionKeys === undefined && !options.hideAnswers) {
      const answer = values.answers?.[lower];
      if (answer !== undefined) return answer;
    }
    if (!unknown.includes(name)) unknown.push(name);
    return match;
  });
  return { text, unknown };
}

/** One line, no stray spaces, at most 200 characters (counted in characters, so an emoji is never cut in half). */
export function cleanTitle(text: string): string {
  const flat = text.replace(/[\r\n\u2028\u2029]+/g, " ").replace(/\s{2,}/g, " ").trim();
  const characters = Array.from(flat);
  return characters.length <= TITLE_MAX ? flat : `${characters.slice(0, TITLE_MAX - 1).join("").trimEnd()}…`;
}

/** Line breaks stay in a description; runs of blank lines are tidied and the length is capped. */
export function cleanDescription(text: string): string {
  const tidy = text.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const characters = Array.from(tidy);
  return characters.length <= DESCRIPTION_MAX ? tidy : `${characters.slice(0, DESCRIPTION_MAX - 1).join("").trimEnd()}…`;
}

/** The only place iCalendar text is escaped: backslashes first, then line breaks, commas and semicolons. */
export function escapeIcsText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\r\n", "\\n")
    .replaceAll("\r", "\\n")
    .replaceAll("\n", "\\n")
    .replaceAll(",", "\\,")
    .replaceAll(";", "\;");
}

/** How long, in the short form placeholders use. */
export function lengthText(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

export interface EntryWording {
  customerTitle: string | null;
  staffTitle: string | null;
  description: string | null;
  hideNotes: boolean;
  hideDetails: boolean;
}

export const emptyEntryWording: EntryWording = { customerTitle: null, staffTitle: null, description: null, hideNotes: false, hideDetails: false };

export interface Entry {
  title: string;
  description: string | null;
}

/** The customer's invite. Staff-only things (internal notes, hidden rooms) are never part of the values it gets. */
export function customerEntry(wording: EntryWording, values: WordingValues, fallbackTitle: string, fallbackDescription: string, questionKeys?: readonly string[]): Entry {
  const options = { ...(questionKeys ? { questionKeys } : {}), hideAnswers: wording.hideNotes };
  const title = wording.customerTitle?.trim() ? cleanTitle(renderWording(wording.customerTitle, values, options).text) : "";
  const description = wording.description?.trim() ? cleanDescription(renderWording(wording.description, values, options).text) : "";
  return { title: title || fallbackTitle, description: description || fallbackDescription || null };
}

/**
 * What goes into a staff member's calendar. "Hide details" writes only `Busy: {business}`, whatever else is set, so a
 * shared office calendar learns nothing. Otherwise the staff title and description apply, or the entry the business's
 * calendar privacy setting chose when no wording is set.
 */
export function staffEntry(wording: EntryWording, values: WordingValues, fallback: Entry & { location?: string }, questionKeys?: readonly string[]): Entry & { location?: string } {
  if (wording.hideDetails) return { title: cleanTitle(`Busy: ${values.business}`), description: null };
  const options = { ...(questionKeys ? { questionKeys } : {}), hideAnswers: wording.hideNotes };
  const title = wording.staffTitle?.trim() ? cleanTitle(renderWording(wording.staffTitle, values, options).text) : "";
  const description = wording.description?.trim() ? cleanDescription(renderWording(wording.description, values, options).text) : "";
  return { title: title || fallback.title, description: description || fallback.description, ...(fallback.location ? { location: fallback.location } : {}) };
}

/** Sample values for the editor's preview. No real customer data. */
export function sampleValues(business: string, branch: string, address: string, service: string, person: string, minutes: number): WordingValues {
  return {
    service, customer: "Priya Sharma", customerFirstName: "Priya", person, business, branch,
    location: [branch, address].filter(Boolean).join(", "), length: lengthText(minutes), answers: {},
  };
}
