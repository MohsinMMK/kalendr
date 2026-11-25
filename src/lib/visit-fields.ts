import { z } from "zod";

/**
 * The properties shown on a visit, Notion style. A business can rename them, give them an icon, hide or
 * reorder them, and add its own (a category, a checkbox, a number…). Definitions live with the workspace
 * layout; the values of a business's own properties live on each appointment.
 */

/** Icons a property can wear. Names only, so stored settings never hold markup. */
export const fieldIconNames = [
  "circle-dot", "hash", "clock", "calendar", "user", "users", "stethoscope", "door-open", "layers", "inbox",
  "file-text", "wallet", "message-square", "sticky-note", "tag", "tags", "list", "check-square", "flag", "star",
  "heart", "alert", "pill", "baby", "shield", "map-pin", "phone", "mail", "link", "type",
  "bookmark", "folder", "activity", "thermometer", "smile", "sparkles", "zap", "briefcase", "scissors", "car",
  "home", "gift", "percent", "languages", "accessibility", "eye", "bell", "lock",
] as const;
export type FieldIconName = (typeof fieldIconNames)[number];
export const fieldIconSchema = z.enum(fieldIconNames);

/** What kind of value a business's own property holds. */
export const customFieldTypes = ["text", "select", "multi_select", "checkbox", "number", "date"] as const;
export type CustomFieldType = (typeof customFieldTypes)[number];

export const fieldColors = ["gray", "blue", "green", "yellow", "orange", "red", "purple", "pink"] as const;
export type FieldColor = (typeof fieldColors)[number];

const shortName = z.string().trim().min(1).max(40);
const builtInIdSchema = z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/i);
export const customFieldIdSchema = z.string().regex(/^cf_[a-z0-9]{4,20}$/);
const optionIdSchema = z.string().regex(/^o_[a-z0-9]{4,20}$/);

export const fieldOptionSchema = z.object({
  id: optionIdSchema,
  label: shortName,
  color: z.enum(fieldColors).default("gray"),
});
export type FieldOption = z.infer<typeof fieldOptionSchema>;

export const customFieldSchema = z.object({
  id: customFieldIdSchema,
  name: shortName,
  icon: fieldIconSchema.optional(),
  type: z.enum(customFieldTypes),
  /** The choices of a select or multi-select property, in order. */
  options: z.array(fieldOptionSchema).max(30).optional(),
});
export type CustomField = z.infer<typeof customFieldSchema>;

/** How one set of properties is arranged for the business. Only what differs from the defaults is stored. */
export const fieldSetSchema = z.object({
  order: z.array(builtInIdSchema).max(64).optional(),
  hidden: z.array(builtInIdSchema).max(64).optional(),
  labels: z.record(builtInIdSchema, shortName).optional(),
  icons: z.record(builtInIdSchema, fieldIconSchema).optional(),
  custom: z.array(customFieldSchema).max(24).optional(),
});
export type FieldSet = z.infer<typeof fieldSetSchema>;

/** One value of a business's own property: text, a number, a checkbox, a date or the chosen option ids. */
export const customFieldValueSchema = z.union([
  z.string().max(500),
  z.number().finite(),
  z.boolean(),
  z.array(optionIdSchema).max(30),
]);
export type CustomFieldValue = z.infer<typeof customFieldValueSchema>;

export const customFieldValuesSchema = z
  .record(customFieldIdSchema, customFieldValueSchema)
  .refine((values) => Object.keys(values).length <= 24, { message: "A visit can hold up to 24 of your own properties." });
export type CustomFieldValues = z.infer<typeof customFieldValuesSchema>;

/** Reads stored values, keeping only the well-formed ones. */
export function parseCustomFieldValues(value: unknown): CustomFieldValues {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const clean: CustomFieldValues = {};
  for (const [key, item] of Object.entries(value)) {
    if (!customFieldIdSchema.safeParse(key).success) continue;
    const parsed = customFieldValueSchema.safeParse(item);
    if (parsed.success) clean[key] = parsed.data;
  }
  return clean;
}

/** An empty value is removed rather than stored, so a cleared property goes away. */
export function isEmptyFieldValue(value: CustomFieldValue | undefined): boolean {
  return value === undefined || value === "" || value === false || (Array.isArray(value) && value.length === 0);
}

/** A short random id for a new property or option. */
export function newFieldId(prefix: "cf" | "o"): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `${prefix}_${Array.from(bytes, (byte) => (byte % 36).toString(36)).join("")}`;
}

/** The set of properties shown on a visit. */
export const visitFieldSet = "visit";
