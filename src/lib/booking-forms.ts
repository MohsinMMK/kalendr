import { z } from "zod";

import type { BusinessTypeId } from "./business-types";

/**
 * Booking forms: questions a business asks when someone books. Definitions are plain data, so the same checks
 * run in the builder, in the booking flow and on the server. The server always re-checks answers against the
 * stored definition; nothing the browser sends about a form is trusted.
 */

export const formFieldTypes = [
  "short_text",
  "long_text",
  "email",
  "phone",
  "number",
  "date",
  "single_choice",
  "multiple_choice",
  "yes_no",
  "consent",
  "radio",
  "checkbox_group",
  "multi_select",
  "url",
  "address",
  "emails",
  "name_split",
] as const;

export type FormFieldType = (typeof formFieldTypes)[number];

export const formFieldTypeLabels: Record<FormFieldType, string> = {
  short_text: "Short answer",
  long_text: "Long answer",
  email: "Email",
  phone: "Phone number",
  number: "Number",
  date: "Date",
  single_choice: "Pick one",
  multiple_choice: "Pick any",
  yes_no: "Yes or no",
  consent: "Agreement checkbox",
  radio: "Pick one (cards)",
  checkbox_group: "Pick any (checkboxes)",
  multi_select: "Pick any (searchable list)",
  url: "Web address",
  address: "Address",
  emails: "Guest emails",
  name_split: "First and last name",
};

export const choiceFieldTypes: readonly FormFieldType[] = ["single_choice", "multiple_choice", "radio", "checkbox_group", "multi_select"];

/** Choice fields that take one answer, and the ones that take several. */
export const singleChoiceTypes: readonly FormFieldType[] = ["single_choice", "radio"];
export const multiChoiceTypes: readonly FormFieldType[] = ["multiple_choice", "checkbox_group", "multi_select"];

export function hasOptions(type: FormFieldType): boolean {
  return choiceFieldTypes.includes(type);
}

export const conditionOperators = ["equals", "not_equals", "contains", "one_of"] as const;
export type ConditionOperator = (typeof conditionOperators)[number];
export const conditionOperatorLabels: Record<ConditionOperator, string> = {
  equals: "is",
  not_equals: "is not",
  contains: "includes",
  one_of: "is one of",
};

/** "Show this question only when the answer to an earlier one is …". Several conditions must all hold. */
export interface FieldCondition {
  fieldId: string;
  operator: ConditionOperator;
  /** One value, or the list for `one_of`. */
  value: string | string[];
}

export interface FormField {
  id: string;
  type: FormFieldType;
  label: string;
  help?: string;
  required: boolean;
  options?: string[];
  /** Shown only when every condition holds. Only earlier questions can be named. */
  showWhen?: FieldCondition[];
  /** Never shown. Filled only from the booking link (for example a campaign tag) and stored with the answers. */
  hidden?: boolean;
  /** `?key=value` in the booking link fills this question. */
  prefillKey?: string;
  /** Shows a prefilled value read-only. */
  lockWhenPrefilled?: boolean;
}

/** Guests and the name and address questions give more than one piece, so their answers are not a single string. */
export type NameAnswer = { first: string; last: string };
export type AddressAnswer = { line1: string; line2?: string; city: string; state: string; pin: string };

/** What an owner edits. The server adds the key, version and dates. */
export interface FormDefinitionDraft {
  name: string;
  description: string;
  fields: FormField[];
  isActive: boolean;
  /** True: every service. False: only `serviceIds`. */
  appliesToAll: boolean;
  serviceIds: string[];
  /**
   * Per attached service, a question's required switch for that service only: `{ serviceId: { fieldId: true } }`.
   * The same form can be required on one service and optional on another. Only for forms attached to chosen services.
   */
  requiredOverrides?: Record<string, Record<string, boolean>>;
}

export interface FormDefinition extends FormDefinitionDraft {
  /** The row id of this version. */
  id: string;
  /** Stays the same across versions. */
  key: string;
  version: number;
  updatedAt: string;
}

/** What the public booking page needs; no dates or internal flags. */
export type PublicFormDefinition = Pick<FormDefinition, "id" | "key" | "version" | "name" | "description" | "fields" | "appliesToAll" | "serviceIds" | "requiredOverrides">;

export type FormAnswer = string | string[] | boolean | NameAnswer | AddressAnswer;
export type FormAnswers = Record<string, FormAnswer>;

export const formLimits = {
  name: 120,
  description: 500,
  fields: 40,
  label: 200,
  help: 300,
  options: 20,
  option: 120,
  shortText: 300,
  longText: 3000,
} as const;

/** Link keys the booking page already reads itself. A question cannot take one of these as its own. */
export const builtInPrefillKeys = ["name", "email", "phone", "notes", "guests", "location"] as const;

export const conditionSchema = z.object({
  fieldId: z.string().trim().min(1).max(40),
  operator: z.enum(conditionOperators),
  value: z.union([z.string().trim().max(120), z.array(z.string().trim().max(120)).max(20)]),
}).refine((condition) => condition.operator === "one_of" ? Array.isArray(condition.value) && condition.value.length > 0 : typeof condition.value === "string", {
  message: "Choose the answer this depends on.",
  path: ["value"],
});

const fieldIdSchema = z.string().trim().regex(/^[a-z0-9_-]{1,40}$/i, "Use letters, numbers, dashes or underscores.");

export const formFieldSchema = z
  .object({
    id: fieldIdSchema,
    type: z.enum(formFieldTypes),
    label: z.string().trim().min(1, "Write the question.").max(formLimits.label),
    help: z.string().trim().max(formLimits.help).optional(),
    required: z.boolean(),
    options: z.array(z.string().trim().min(1, "Options cannot be blank.").max(formLimits.option)).max(formLimits.options).optional(),
    showWhen: z.array(conditionSchema).max(3).optional(),
    hidden: z.boolean().optional(),
    prefillKey: z.string().trim().regex(/^[a-z][a-z0-9_]{0,29}$/i, "Use letters, numbers and underscores, starting with a letter.").optional(),
    lockWhenPrefilled: z.boolean().optional(),
  })
  .superRefine((field, context) => {
    if (hasOptions(field.type)) {
      const options = field.options ?? [];
      if (options.length < 2) {
        context.addIssue({ code: "custom", path: ["options"], message: `“${field.label}” needs at least two options.` });
      }
      const seen = new Set(options.map((option) => option.toLowerCase()));
      if (seen.size !== options.length) {
        context.addIssue({ code: "custom", path: ["options"], message: `“${field.label}” has the same option twice.` });
      }
    } else if (field.options && field.options.length > 0) {
      context.addIssue({ code: "custom", path: ["options"], message: `“${field.label}” cannot have options.` });
    }
    if (field.prefillKey && (builtInPrefillKeys as readonly string[]).includes(field.prefillKey.toLowerCase())) {
      context.addIssue({ code: "custom", path: ["prefillKey"], message: `“${field.prefillKey}” is already used by the booking page. Pick another name.` });
    }
    if (field.hidden && (field.type === "consent" || field.type === "emails" || field.type === "address" || field.type === "name_split" || hasOptions(field.type))) {
      context.addIssue({ code: "custom", path: ["hidden"], message: "A hidden question must be a plain text, number, date, email, phone or web address question." });
    }
    if (field.hidden && !field.prefillKey) {
      context.addIssue({ code: "custom", path: ["prefillKey"], message: "A hidden question is filled from the booking link, so give it a link name." });
    }
  })
  .transform((field): FormField => ({
    id: field.id,
    type: field.type,
    label: field.label,
    ...(field.help ? { help: field.help } : {}),
    required: field.type === "consent" ? true : field.hidden ? false : field.required,
    ...(hasOptions(field.type) ? { options: field.options ?? [] } : {}),
    ...(field.showWhen && field.showWhen.length > 0 && !field.hidden ? { showWhen: field.showWhen.map((condition) => ({ fieldId: condition.fieldId, operator: condition.operator, value: condition.value })) } : {}),
    ...(field.hidden ? { hidden: true } : {}),
    ...(field.prefillKey ? { prefillKey: field.prefillKey } : {}),
    ...(field.lockWhenPrefilled && field.prefillKey && !field.hidden ? { lockWhenPrefilled: true } : {}),
  }));

/** Checks a form an owner built. Used by the staff API and the builder. */
export const formDefinitionDraftSchema = z
  .object({
    name: z.string().trim().min(1, "Give the form a name.").max(formLimits.name),
    description: z.string().trim().max(formLimits.description).default(""),
    fields: z.array(formFieldSchema).min(1, "Add at least one question.").max(formLimits.fields, `A form can have up to ${formLimits.fields} questions.`),
    isActive: z.boolean().default(true),
    appliesToAll: z.boolean().default(true),
    serviceIds: z.array(z.string().min(1).max(80)).max(200).default([]),
    requiredOverrides: z.record(z.string().min(1).max(80), z.record(fieldIdSchema, z.boolean())).optional(),
  })
  .superRefine((draft, context) => {
    const ids = new Set<string>();
    const keys = new Set<string>();
    draft.fields.forEach((field, index) => {
      if (ids.has(field.id)) context.addIssue({ code: "custom", path: ["fields", index, "id"], message: "Two questions share the same id." });
      // A condition may only look at an earlier question, so conditions can never loop.
      for (const [conditionIndex, condition] of (field.showWhen ?? []).entries()) {
        if (!ids.has(condition.fieldId)) {
          context.addIssue({ code: "custom", path: ["fields", index, "showWhen", conditionIndex, "fieldId"], message: "A question can only depend on one that comes before it." });
        }
      }
      if (field.prefillKey) {
        const key = field.prefillKey.toLowerCase();
        if (keys.has(key)) context.addIssue({ code: "custom", path: ["fields", index, "prefillKey"], message: "Two questions use the same link name." });
        keys.add(key);
      }
      ids.add(field.id);
    });
    for (const [serviceId, overrides] of Object.entries(draft.requiredOverrides ?? {})) {
      if (draft.appliesToAll || !draft.serviceIds.includes(serviceId)) {
        context.addIssue({ code: "custom", path: ["requiredOverrides", serviceId], message: "Choose which services this form is for before changing what is required on one of them." });
      }
      for (const fieldId of Object.keys(overrides)) {
        if (!ids.has(fieldId)) context.addIssue({ code: "custom", path: ["requiredOverrides", serviceId, fieldId], message: "That question is not on the form." });
      }
    }
    if (!draft.appliesToAll && draft.serviceIds.length === 0) {
      context.addIssue({ code: "custom", path: ["serviceIds"], message: "Choose at least one service, or use the form for every service." });
    }
  })
  .transform((draft): FormDefinitionDraft => ({
    ...draft,
    serviceIds: draft.appliesToAll ? [] : [...new Set(draft.serviceIds)],
    ...(!draft.appliesToAll && draft.requiredOverrides && Object.keys(draft.requiredOverrides).length > 0 ? { requiredOverrides: draft.requiredOverrides } : { requiredOverrides: undefined }),
  }));

export type FormDefinitionDraftInput = z.input<typeof formDefinitionDraftSchema>;

const nameAnswerSchema = z.object({ first: z.string().max(formLimits.shortText), last: z.string().max(formLimits.shortText) }).strict();
const addressAnswerSchema = z.object({
  line1: z.string().max(formLimits.shortText),
  line2: z.string().max(formLimits.shortText).optional(),
  city: z.string().max(formLimits.shortText),
  state: z.string().max(formLimits.shortText),
  pin: z.string().max(20),
}).strict();

/** The answers part of a booking request. Shape only; `checkFormAnswers` checks them against the form. */
export const formAnswersSchema = z
  .record(
    fieldIdSchema,
    z.union([
      z.string().max(formLimits.longText),
      z.array(z.string().max(formLimits.option)).max(formLimits.options),
      z.boolean(),
      nameAnswerSchema,
      addressAnswerSchema,
    ]),
  )
  .refine((answers) => Object.keys(answers).length <= formLimits.fields, "Too many answers.");

/** The one form a service uses: a form chosen for that service wins over one for every service; newest first. */
export function formForService<T extends Pick<PublicFormDefinition, "appliesToAll" | "serviceIds">>(
  forms: readonly T[],
  serviceId: string | undefined,
): T | undefined {
  if (!serviceId) return undefined;
  return forms.find((form) => !form.appliesToAll && form.serviceIds.includes(serviceId)) ?? forms.find((form) => form.appliesToAll);
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const phonePattern = /^\+?[0-9 ()-]{6,24}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const maxGuests = 10;

function isRealDate(value: string): boolean {
  if (!datePattern.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBlank(value: FormAnswer | undefined): boolean {
  if (value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) return Object.values(value).every((part) => typeof part !== "string" || part.trim() === "");
  return false;
}

function isWebAddress(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (url.protocol === "https:" || url.protocol === "http:") && value.trim().length <= 300;
  } catch {
    return false;
  }
}

/** The answer as a list of words, for comparing against a condition. */
export function answerWords(value: FormAnswer | undefined): string[] {
  if (value === undefined) return [];
  if (typeof value === "string") return value.trim() === "" ? [] : [value.trim()];
  if (typeof value === "boolean") return [value ? "yes" : "no"];
  if (Array.isArray(value)) return value;
  return Object.values(value).flatMap((part) => (typeof part === "string" && part.trim() ? [part.trim()] : []));
}

const sameWord = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

export function conditionHolds(condition: FieldCondition, answers: FormAnswers): boolean {
  const words = answerWords(answers[condition.fieldId]);
  const wanted = Array.isArray(condition.value) ? condition.value : [condition.value];
  switch (condition.operator) {
    case "equals": return words.length === 1 && wanted.some((word) => sameWord(words[0]!, word));
    case "not_equals": return !(words.length === 1 && wanted.some((word) => sameWord(words[0]!, word)));
    case "contains": return words.some((word) => wanted.some((target) => sameWord(word, target) || (typeof answers[condition.fieldId] === "string" && word.toLowerCase().includes(target.trim().toLowerCase()))));
    case "one_of": return words.some((word) => wanted.some((target) => sameWord(word, target)));
  }
}

/**
 * Is this question shown, given the answers so far? The booking page and the server both call this one function.
 * A question hidden by its conditions is never required and its answer is dropped on save. A condition that names
 * a question that is itself hidden counts as not holding, so a hidden answer cannot reveal anything.
 */
export function isFieldVisible(field: FormField, answers: FormAnswers, fields: readonly FormField[]): boolean {
  if (field.hidden) return false;
  for (const condition of field.showWhen ?? []) {
    const source = fields.find((entry) => entry.id === condition.fieldId);
    if (!source || !isFieldVisible(source, answers, fields)) return false;
    if (!conditionHolds(condition, answers)) return false;
  }
  return true;
}

/** Is the question required for this service? A per-service override wins over the form's own setting. */
export function effectiveRequired(field: FormField, overrides?: Record<string, boolean>): boolean {
  if (field.type === "consent") return true;
  // Guests are never required: a customer may come alone, and the booking page takes guests in their own row.
  if (field.hidden || field.type === "emails") return false;
  return overrides?.[field.id] ?? field.required;
}

/** Checks one answer. Returns an error message, or null when the answer is fine. */
export function checkFormAnswer(field: FormField, value: FormAnswer | undefined, required: boolean = field.required): string | null {
  if (field.type === "consent") return value === true ? null : "Tick this box to continue.";
  if (isBlank(value)) return required ? (field.type === "yes_no" ? "Choose yes or no." : field.type === "emails" ? "Add at least one email address." : "Answer this question.") : null;
  switch (field.type) {
    case "short_text":
    case "long_text": {
      if (typeof value !== "string") return "Answer this question.";
      const limit = field.type === "short_text" ? formLimits.shortText : formLimits.longText;
      return value.trim().length > limit ? `Keep this under ${limit} characters.` : null;
    }
    case "email":
      return typeof value === "string" && emailPattern.test(value.trim()) ? null : "Enter an email address like name@example.com.";
    case "phone":
      return typeof value === "string" && phonePattern.test(value.trim()) ? null : "Enter a phone number using digits.";
    case "number":
      return typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim()) && value.trim().length <= 20 ? null : "Enter a number.";
    case "date":
      return typeof value === "string" && isRealDate(value.trim()) ? null : "Enter a date.";
    case "url":
      return typeof value === "string" && isWebAddress(value) ? null : "Enter a web address starting with https://.";
    case "single_choice":
    case "radio":
      return typeof value === "string" && (field.options ?? []).includes(value) ? null : "Choose one of the options.";
    case "multiple_choice":
    case "checkbox_group":
    case "multi_select":
      return Array.isArray(value) && value.every((item) => (field.options ?? []).includes(item)) && new Set(value).size === value.length
        ? null
        : "Choose from the options shown.";
    case "yes_no":
      return typeof value === "boolean" ? null : "Choose yes or no.";
    case "emails": {
      if (!Array.isArray(value)) return "Enter email addresses like name@example.com.";
      if (value.length > maxGuests) return `Add up to ${maxGuests} email addresses.`;
      if (!value.every((item) => emailPattern.test(item.trim()))) return "Enter email addresses like name@example.com.";
      return new Set(value.map((item) => item.trim().toLowerCase())).size === value.length ? null : "The same email address is listed twice.";
    }
    case "name_split": {
      const name: Record<string, unknown> = isRecord(value) ? value : {};
      if (typeof name.first !== "string" || typeof name.last !== "string") return "Enter a first and last name.";
      return name.first.trim() && (name.last.trim() || !required) ? null : required ? "Enter a first and last name." : "Enter a first name.";
    }
    case "address": {
      if (!isRecord(value)) return "Enter the address.";
      const { line1, city, state, pin } = value as Record<string, unknown>;
      const text = (part: unknown) => (typeof part === "string" ? part.trim() : "");
      if (!text(line1) || !text(city) || !text(state)) return "Fill in the street, city and state.";
      return /^[0-9A-Za-z -]{3,10}$/.test(text(pin)) ? null : "Enter the PIN or postal code.";
    }
  }
}

export type FormAnswerCheck =
  | { ok: true; answers: FormAnswers }
  | { ok: false; errors: Record<string, string> };

function cleanAnswer(value: FormAnswer): FormAnswer {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map((item) => item.trim());
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, part]) => [key, typeof part === "string" ? part.trim() : part])) as FormAnswer;
  return value;
}

/**
 * Checks every answer against the form. Unknown answers are refused, blank optional answers are dropped and text
 * is trimmed. A question hidden by its conditions is not required and its answer is silently dropped, so a crafted
 * request cannot store an answer to a question the customer was never shown. A `hidden` question (filled from the
 * link) is accepted only when its value is valid for its type; an invalid value is dropped, not refused.
 */
export function checkFormAnswers(
  fields: readonly FormField[],
  answers: FormAnswers | undefined,
  options: { requiredOverrides?: Record<string, boolean> } = {},
): FormAnswerCheck {
  const given = answers ?? {};
  const errors: Record<string, string> = {};
  const known = new Set(fields.map((field) => field.id));
  for (const id of Object.keys(given)) {
    if (!known.has(id)) errors[id] = "This question is not on the form.";
  }
  const cleaned: FormAnswers = {};
  for (const field of fields) {
    const value = given[field.id];
    if (field.hidden) {
      // Filled only from the link. A bad value is ignored; the booking goes ahead without it.
      if (value !== undefined && !isBlank(value) && checkFormAnswer(field, value, false) === null) cleaned[field.id] = cleanAnswer(value);
      continue;
    }
    // Visibility reads the answers as the customer gave them, so the same question list shows the same way on both sides.
    if (!isFieldVisible(field, given, fields)) continue;
    const error = checkFormAnswer(field, value, effectiveRequired(field, options.requiredOverrides));
    if (error) {
      errors[field.id] = error;
      continue;
    }
    if (value === undefined || isBlank(value)) continue;
    cleaned[field.id] = cleanAnswer(value);
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, answers: cleaned };
}

/**
 * Reads `?key=value` from the booking link into answers. Only questions with a link name take part, each value is
 * checked against its type and length, and an invalid one is ignored without a word.
 */
export function readPrefill(fields: readonly FormField[], params: URLSearchParams | Record<string, string | undefined>): { answers: FormAnswers; locked: string[] } {
  const get = (key: string): string | undefined => {
    if (params instanceof URLSearchParams) {
      for (const [name, value] of params.entries()) if (name.toLowerCase() === key.toLowerCase()) return value;
      return undefined;
    }
    const entry = Object.entries(params).find(([name]) => name.toLowerCase() === key.toLowerCase());
    return entry?.[1];
  };
  const answers: FormAnswers = {};
  const locked: string[] = [];
  for (const field of fields) {
    if (!field.prefillKey) continue;
    const raw = get(field.prefillKey)?.slice(0, formLimits.longText);
    if (raw === undefined || raw.trim() === "") continue;
    let value: FormAnswer;
    switch (field.type) {
      case "yes_no": value = ["yes", "true", "1"].includes(raw.toLowerCase()) ? true : ["no", "false", "0"].includes(raw.toLowerCase()) ? false : (undefined as never); break;
      case "multiple_choice":
      case "checkbox_group":
      case "multi_select":
      case "emails": value = raw.split(",").map((part) => part.trim()).filter(Boolean); break;
      case "consent":
      case "address":
      case "name_split": continue;
      default: value = raw.trim();
    }
    if (value === undefined) continue;
    if (checkFormAnswer(field, value, false) !== null) continue;
    answers[field.id] = value;
    if (field.lockWhenPrefilled && !field.hidden) locked.push(field.id);
  }
  return { answers, locked };
}

/** An answer as staff read it. */
export function formatFormAnswer(field: FormField, value: FormAnswer | undefined): string {
  if (value === undefined || isBlank(value)) return "No answer";
  if (field.type === "consent") return value === true ? "Agreed" : "Not agreed";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "string") return value;
  if ("first" in value) return [value.first, value.last].filter(Boolean).join(" ");
  return [value.line1, value.line2, value.city, value.state, value.pin].filter(Boolean).join(", ");
}

/** A short, stable id for a new question. */
export function newFieldId(existing: readonly Pick<FormField, "id">[]): string {
  const taken = new Set(existing.map((field) => field.id));
  for (let index = existing.length + 1; ; index += 1) {
    const id = `q${index}`;
    if (!taken.has(id)) return id;
  }
}

function field(id: string, type: FormFieldType, label: string, extra: Partial<Omit<FormField, "id" | "type" | "label">> = {}): FormField {
  return { id, type, label, required: false, ...extra };
}

const consentField = (label: string) => field("consent", "consent", label, { required: true });

/** A ready-made form for each business type, offered in the builder. Owners can change every part of it. */
export const starterForms: Record<BusinessTypeId, Omit<FormDefinitionDraft, "isActive" | "appliesToAll" | "serviceIds">> = {
  healthcare: {
    name: "New patient intake",
    description: "A few questions before your first visit.",
    fields: [
      field("reason", "long_text", "What would you like help with?"),
      field("medications", "long_text", "Medicines you take now", { help: "Include the dose if you know it." }),
      field("allergies", "short_text", "Allergies"),
      field("first_visit", "yes_no", "Is this your first visit to us?", { required: true }),
      consentField("I confirm these answers are correct to the best of my knowledge."),
    ],
  },
  dental: {
    name: "Dental intake",
    description: "Helps the dentist prepare for your visit.",
    fields: [
      field("concern", "long_text", "What brings you in?"),
      field("pain", "single_choice", "Are you in pain?", { required: true, options: ["No", "A little", "A lot"] }),
      field("last_checkup", "date", "Date of your last check-up"),
      field("medications", "long_text", "Medicines you take now"),
      consentField("I confirm these answers are correct to the best of my knowledge."),
    ],
  },
  wellness: {
    name: "Before your appointment",
    description: "So we can get everything ready for you.",
    fields: [
      field("first_time", "yes_no", "Is this your first time with us?", { required: true }),
      field("sensitivities", "short_text", "Anything we should know about, such as allergies or sensitive skin?"),
      field("reference", "long_text", "Describe a look or result you like"),
    ],
  },
  real_estate: {
    name: "Property preferences",
    description: "Tell us what you are looking for so we can plan the viewing.",
    fields: [
      field("looking_to", "single_choice", "Are you looking to", { required: true, options: ["Buy", "Rent", "Sell", "Let out"] }),
      field("budget", "short_text", "Budget"),
      field("areas", "short_text", "Areas you prefer"),
      field("bedrooms", "single_choice", "Bedrooms", { options: ["Studio", "1", "2", "3", "4 or more"] }),
      field("move_by", "date", "When would you like to move?"),
    ],
  },
  professional_services: {
    name: "Project brief",
    description: "A short brief so the meeting starts with the right questions.",
    fields: [
      field("company", "short_text", "Company or organisation"),
      field("goal", "long_text", "What do you need help with?"),
      field("budget", "single_choice", "Rough budget", { options: ["Under 50,000", "50,000 to 2,00,000", "Over 2,00,000", "Not sure yet"] }),
      field("deadline", "date", "Is there a deadline?"),
    ],
  },
  retail: {
    name: "Shopping appointment",
    description: "Tell us what you are shopping for.",
    fields: [
      field("looking_for", "short_text", "What are you looking for?"),
      field("occasion", "short_text", "Is it for an occasion?"),
      field("sizes", "short_text", "Sizes or measurements, if you know them"),
    ],
  },
  education: {
    name: "Student details",
    description: "Helps us plan the right first lesson.",
    fields: [
      field("student_name", "short_text", "Student's name", { required: true }),
      field("level", "single_choice", "Current level", { required: true, options: ["Beginner", "Intermediate", "Advanced"] }),
      field("goals", "long_text", "What would the student like to achieve?"),
      field("guardian_phone", "phone", "Parent or guardian phone number", { help: "For students under 18." }),
    ],
  },
  other: {
    name: "Booking questions",
    description: "A few details before your appointment.",
    fields: [
      field("details", "long_text", "Tell us what you need"),
      field("how_heard", "single_choice", "How did you hear about us?", { options: ["Friend or family", "Search", "Social media", "Other"] }),
    ],
  },
};
