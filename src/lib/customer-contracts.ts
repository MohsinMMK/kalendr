/**
 * Customer profiles (feature 27): the shapes shared by the routes, the server and the screens.
 * No "server-only" import: the browser uses this file.
 */
import { z } from "zod";

export const tagColors = ["gray", "red", "orange", "amber", "green", "teal", "blue", "violet", "pink"] as const;
export type TagColor = (typeof tagColors)[number];

/** Reads a stored colour back as one of the palette, so a screen never meets a colour it has no style for. */
export function tagColorOf(value: string): TagColor {
  return tagColors.find((color) => color === value) ?? "gray";
}

const idParam = z.string().trim().regex(/^[A-Za-z0-9_-]{1,160}$/, "That link is not valid.");
export { idParam as customerIdSchema };

export const MAX_TAGS_PER_CUSTOMER = 20;
export const MAX_TAGS_PER_BUSINESS = 100;
export const MAX_FIELDS_PER_BUSINESS = 20;

export const tagInputSchema = z.strictObject({
  name: z.string().trim().min(1, "Give the tag a name.").max(40, "Keep tag names to 40 characters."),
  color: z.enum(tagColors).default("gray"),
});
export type TagInput = z.infer<typeof tagInputSchema>;

export const tagUpdateSchema = tagInputSchema.partial().refine((value) => value.name !== undefined || value.color !== undefined, "Change the name or the colour.");

export const customerTagsInputSchema = z.strictObject({
  tagIds: z.array(idParam).max(MAX_TAGS_PER_CUSTOMER, `A customer can have up to ${MAX_TAGS_PER_CUSTOMER} tags.`),
});

export interface CustomerTag {
  id: string;
  name: string;
  color: TagColor;
  /** How many customers carry it. */
  count: number;
}

export const noteInputSchema = z.strictObject({
  body: z.string().trim().min(1, "Write a note first.").max(4_000, "Keep a note under 4,000 characters."),
  pinned: z.boolean().default(false),
});

export const noteUpdateSchema = z.strictObject({
  body: z.string().trim().min(1, "Write a note first.").max(4_000, "Keep a note under 4,000 characters.").optional(),
  pinned: z.boolean().optional(),
  version: z.number().int().min(1),
}).refine((value) => value.body !== undefined || value.pinned !== undefined, "Change the text or pin it.");

export interface CustomerNote {
  id: string;
  body: string;
  pinned: boolean;
  authorName: string;
  /** The staff member who wrote it, so only they (or a manager) edit it. Null once their account is gone. */
  authorUserId: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * What a business's own customer field can hold. Every value is stored as text (`customer-field-values.ts` says how each kind
 * reads and checks it), so adding a kind never changes the values table.
 */
export const fieldKinds = ["text", "number", "date", "choice", "multichoice", "boolean", "phone", "email", "link"] as const;
export type FieldKind = (typeof fieldKinds)[number];
/** The kinds that pick from the field's own list of choices. */
export function isChoiceKind(kind: FieldKind): boolean {
  return kind === "choice" || kind === "multichoice";
}
export const MAX_FIELD_VALUE_LENGTH = 2_500;

const choiceText = z.string().trim().min(1).max(60);
const choiceList = z.array(choiceText).max(30);
const fieldLabel = z.string().trim().min(1, "Give the field a name.").max(60, "Keep the name to 60 characters.");

function checkChoices(value: { kind?: FieldKind; choices?: string[] }, context: z.RefinementCtx): void {
  const choices = value.choices ?? [];
  if (value.kind && isChoiceKind(value.kind) && choices.length < 2) context.addIssue({ code: "custom", path: ["choices"], message: "Add at least two choices." });
  if (new Set(choices.map((choice) => choice.toLowerCase())).size !== choices.length) {
    context.addIssue({ code: "custom", path: ["choices"], message: "Each choice must be different." });
  }
}

export const fieldDefinitionInputSchema = z.strictObject({
  label: fieldLabel,
  kind: z.enum(fieldKinds),
  choices: choiceList.default([]),
}).superRefine(checkChoices);

/**
 * Changing a field. `kind` converts the stored values (the ones that do not fit are cleared). `choices` replaces the list and
 * `renames` says which old choice became which new one, so values follow a rename instead of being cleared.
 */
export const fieldDefinitionUpdateSchema = z.strictObject({
  label: fieldLabel.optional(),
  kind: z.enum(fieldKinds).optional(),
  choices: choiceList.optional(),
  renames: z.record(choiceText, choiceText).optional(),
  position: z.number().int().min(0).max(100).optional(),
  archived: z.boolean().optional(),
  version: z.number().int().min(1),
});

export interface CustomerFieldDefinition {
  id: string;
  label: string;
  kind: FieldKind;
  choices: string[];
  position: number;
  archived: boolean;
  version: number;
}

/** A field's answers for one customer. `null` clears one. */
export const customerFieldValuesInputSchema = z.strictObject({
  values: z.record(idParam, z.string().trim().max(MAX_FIELD_VALUE_LENGTH).nullable()),
});

export interface CustomerFieldValue {
  fieldId: string;
  value: string;
}

export const timelineKinds = ["visit", "message", "payment", "form", "note", "change"] as const;
export type TimelineKind = (typeof timelineKinds)[number];

export const timelineKindLabels: Record<TimelineKind, string> = {
  visit: "Visits",
  message: "Messages",
  payment: "Payments",
  form: "Forms",
  note: "Notes",
  change: "Changes",
};

export const timelineQuerySchema = z.object({
  kinds: z.string().trim().max(120).optional().transform((value) => (value ? value.split(",").filter((kind): kind is TimelineKind => (timelineKinds as readonly string[]).includes(kind)) : [])),
  cursor: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type TimelineQuery = z.input<typeof timelineQuerySchema>;

/** One line of a customer's history. Every source is mapped to this one shape so they sort and page together. */
export interface TimelineEntry {
  /** Kind plus the source row's id: stable, and the cursor sorts by it. */
  key: string;
  kind: TimelineKind;
  at: string;
  title: string;
  detail: string | null;
  /** The state the source row is in ("completed", "sent", "failed"), for a badge. */
  status: string | null;
  amountMinor: number | null;
  currency: string | null;
  /** The row to open: an appointment id for a visit. */
  refId: string | null;
  /** Who did it, for notes and changes. */
  by: string | null;
}

export interface TimelinePage {
  entries: TimelineEntry[];
  nextCursor: string | null;
}

export interface CustomerSummary {
  id: string;
  name: string;
  phone: string;
  email: string;
  nextVisit: { id: string; startsAt: string; serviceName: string } | null;
  lastVisit: { id: string; startsAt: string; serviceName: string } | null;
  visits: number;
  noShows: number;
  /** Money still owed on issued invoices; null when the viewer cannot see payments. */
  balanceOwedMinor: number | null;
  /** Net of refunds. Null when the viewer cannot see payments. */
  lifetimeValueMinor: number | null;
  currency: string;
  /** Average days between completed visits; null with fewer than two. */
  averageGapDays: number | null;
  packageCredits: number;
  tags: Omit<CustomerTag, "count">[];
  pinnedNote: Pick<CustomerNote, "id" | "body" | "authorName" | "updatedAt"> | null;
  blocked: { at: string; reason: string; byName: string | null } | null;
  marketingConsent: boolean;
  /** The merge that can still be undone, when this profile took another one in. */
  recentMerge: { id: string; undoUntil: string } | null;
}

export const blockInputSchema = z.strictObject({
  reason: z.string().trim().min(3, "Say why, so the team knows.").max(200, "Keep the reason under 200 characters."),
});

export const mergeInputSchema = z.strictObject({
  keepId: idParam,
  mergeId: idParam,
}).refine((value) => value.keepId !== value.mergeId, "Choose two different customers.");

export interface DuplicatePair {
  /** Why they look alike, in words the desk can check: "Same phone number". */
  reasons: string[];
  a: DuplicateSide;
  b: DuplicateSide;
}

export interface DuplicateSide {
  id: string;
  name: string;
  phone: string;
  email: string;
  dateOfBirth: string | null;
  visits: number;
  lastVisitAt: string | null;
}

export interface MergeResult {
  mergeId: string;
  keptId: string;
  undoUntil: string;
  moved: { appointments: number; payments: number; invoices: number; other: number };
}

export const UNDO_WINDOW_DAYS = 30;

export const customerListFilterSchema = z.object({
  tagId: idParam.optional(),
  segmentId: idParam.optional(),
});
