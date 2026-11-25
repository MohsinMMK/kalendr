/**
 * Saved customer segments (feature 27): the filter an owner builds is stored as validated JSON and turned into one
 * parameterised query by `src/server/customers/segments.ts`. Nothing here touches a database, so the screen, the
 * campaigns and the tests read the same rules. A filter is a list of plain conditions joined by "and".
 *
 * No "server-only" import: the browser builds filters with this file.
 */
import { z } from "zod";

const idList = z.array(z.string().trim().min(1).max(80)).max(30);
const countOperator = z.enum(["gt", "gte", "lt", "lte", "eq"]);
const countValue = z.number().int().min(0).max(1_000_000);

export const segmentConditionSchema = z.discriminatedUnion("field", [
  z.strictObject({
    field: z.literal("lastVisit"),
    // Last visit means the latest completed visit. "never" is for customers who booked but have not had one yet.
    op: z.enum(["olderThanDays", "withinDays", "before", "after", "never"]),
    days: z.number().int().min(1).max(5_000).optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }).superRefine((value, context) => {
    if ((value.op === "olderThanDays" || value.op === "withinDays") && value.days === undefined) {
      context.addIssue({ code: "custom", path: ["days"], message: "Enter a number of days." });
    }
    if ((value.op === "before" || value.op === "after") && value.date === undefined) {
      context.addIssue({ code: "custom", path: ["date"], message: "Choose a date." });
    }
  }),
  z.strictObject({ field: z.literal("visits"), op: countOperator, value: countValue }),
  z.strictObject({ field: z.literal("service"), op: z.enum(["used", "notUsed"]), serviceIds: idList }),
  z.strictObject({ field: z.literal("tag"), op: z.enum(["has", "hasNot"]), tagIds: idList }),
  z.strictObject({ field: z.literal("spend"), op: countOperator, valueMinor: countValue }),
  z.strictObject({ field: z.literal("futureBooking"), value: z.boolean() }),
  z.strictObject({ field: z.literal("birthdayMonth"), month: z.number().int().min(1).max(12) }),
  z.strictObject({ field: z.literal("marketingConsent"), value: z.boolean() }),
]);

export type SegmentCondition = z.infer<typeof segmentConditionSchema>;

export const MAX_SEGMENT_CONDITIONS = 12;

/** A service or tag condition with nothing chosen is a draft on the screen; it cannot be counted or saved. */
export function isConditionComplete(condition: SegmentCondition): boolean {
  if (condition.field === "service") return condition.serviceIds.length > 0;
  if (condition.field === "tag") return condition.tagIds.length > 0;
  return true;
}

export const segmentFilterSchema = z.strictObject({
  all: z.array(segmentConditionSchema).max(MAX_SEGMENT_CONDITIONS),
}).superRefine((value, context) => {
  value.all.forEach((condition, index) => {
    if (!isConditionComplete(condition)) context.addIssue({ code: "custom", path: ["all", index], message: "Choose at least one." });
  });
});

export type SegmentFilter = z.infer<typeof segmentFilterSchema>;

export const emptySegmentFilter: SegmentFilter = { all: [] };

export const segmentInputSchema = z.strictObject({
  name: z.string().trim().min(1, "Give the segment a name.").max(80),
  filter: segmentFilterSchema,
});
export type SegmentInput = z.infer<typeof segmentInputSchema>;

export const segmentUpdateSchema = segmentInputSchema.extend({ version: z.number().int().min(1) });
export type SegmentUpdate = z.infer<typeof segmentUpdateSchema>;

export const segmentMembersQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().trim().max(120).optional(),
});

export interface SegmentSummary {
  id: string;
  name: string;
  filter: SegmentFilter;
  version: number;
  /** How many customers match right now. Counted when the list is read, never stored. */
  count: number;
  updatedAt: string;
}

export interface SegmentMember {
  id: string;
  name: string;
  email: string;
  phone: string;
}

const operatorWords: Record<z.infer<typeof countOperator>, string> = {
  gt: "more than",
  gte: "at least",
  lt: "fewer than",
  lte: "at most",
  eq: "exactly",
};

const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export interface DescribeContext {
  serviceName?: (id: string) => string;
  tagName?: (id: string) => string;
  /** Formats a spend in the smallest unit, so the sentence reads "₹2,000" in the business's own currency. */
  money?: (minor: number) => string;
}

function listOf(ids: readonly string[], name: ((id: string) => string) | undefined, fallback: string): string {
  const names = ids.map((id) => name?.(id) ?? "").filter(Boolean);
  if (names.length === 0) return fallback;
  return names.length <= 2 ? names.join(" or ") : `${names.slice(0, 2).join(", ")} or ${names.length - 2} more`;
}

/** One condition as a short sentence fragment: "no visit in 90 days", "more than 3 visits". */
export function describeCondition(condition: SegmentCondition, context: DescribeContext = {}): string {
  switch (condition.field) {
    case "lastVisit":
      switch (condition.op) {
        case "olderThanDays": return `no visit in ${condition.days} days`;
        case "withinDays": return `visited in the last ${condition.days} days`;
        case "before": return `last visit before ${condition.date}`;
        case "after": return `last visit after ${condition.date}`;
        case "never": return "has never had a visit";
      }
      break;
    case "visits":
      return `${operatorWords[condition.op]} ${condition.value} ${condition.value === 1 ? "visit" : "visits"}`;
    case "service":
      return `${condition.op === "used" ? "has had" : "has not had"} ${listOf(condition.serviceIds, context.serviceName, "a chosen service")}`;
    case "tag":
      return `${condition.op === "has" ? "tagged" : "not tagged"} ${listOf(condition.tagIds, context.tagName, "a chosen tag")}`;
    case "spend": {
      const amount = context.money ? context.money(condition.valueMinor) : String(condition.valueMinor / 100);
      return `has spent ${operatorWords[condition.op]} ${amount}`;
    }
    case "futureBooking":
      return condition.value ? "has a booking coming up" : "has no booking coming up";
    case "birthdayMonth":
      return `birthday in ${monthNames[condition.month - 1]}`;
    case "marketingConsent":
      return condition.value ? "agreed to marketing messages" : "has not agreed to marketing messages";
  }
  return "";
}

export function describeFilter(filter: SegmentFilter, context: DescribeContext = {}): string {
  if (filter.all.length === 0) return "Everyone";
  const parts = filter.all.map((condition) => describeCondition(condition, context));
  const sentence = parts.join(", and ");
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/** A starting condition for each field, so "Add a condition" always produces something valid. */
export function defaultCondition(field: SegmentCondition["field"]): SegmentCondition {
  switch (field) {
    case "lastVisit": return { field, op: "olderThanDays", days: 90 };
    case "visits": return { field, op: "gt", value: 3 };
    case "service": return { field, op: "used", serviceIds: [] };
    case "tag": return { field, op: "has", tagIds: [] };
    case "spend": return { field, op: "gte", valueMinor: 100_000 };
    case "futureBooking": return { field, value: false };
    case "birthdayMonth": return { field, month: new Date().getUTCMonth() + 1 };
    case "marketingConsent": return { field, value: true };
  }
}

export const segmentFieldLabels: Record<SegmentCondition["field"], string> = {
  lastVisit: "Last visit",
  visits: "Number of visits",
  service: "Service used",
  tag: "Tag",
  spend: "Total spent",
  futureBooking: "Booking coming up",
  birthdayMonth: "Birthday month",
  marketingConsent: "Agreed to marketing",
};

export const segmentFieldOrder = ["lastVisit", "visits", "service", "tag", "spend", "futureBooking", "birthdayMonth", "marketingConsent"] as const satisfies readonly SegmentCondition["field"][];
