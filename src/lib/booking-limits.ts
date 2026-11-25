import { z } from "zod";

/**
 * Booking limits (feature 38): contracts shared by the server, the engine and the screens.
 * A limit caps how much work one thing takes in a day, week, month or year, counted either
 * as bookings or as booked minutes.
 */

const identifierSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

export const limitScopes = ["service", "practitioner", "location", "resource", "team"] as const;
export type LimitScope = (typeof limitScopes)[number];
export const limitMeasures = ["count", "minutes"] as const;
export type LimitMeasure = (typeof limitMeasures)[number];
export const limitPeriods = ["day", "week", "month", "year"] as const;
export type LimitPeriod = (typeof limitPeriods)[number];

/** Statuses that take up a place. Cancelled and entered-in-error ones do not. */
// A booking held while the customer pays (feature 23) takes its place from the moment it is held.
export const countedStatuses = ["requested", "booked", "checked_in", "completed", "no_show", "pending_payment"] as const;
/** Feature 41 turns this off when "unconfirmed holds the slot" is switched off. */
export function countedStatusesFor(options: { requestedHoldsSlot: boolean }): readonly string[] {
  return options.requestedHoldsSlot ? countedStatuses : countedStatuses.filter((status) => status !== "requested");
}

export const limitValueMax = { count: 500, minutes: 24 * 60 * 366 } as const;

export const bookingLimitInputSchema = z.object({
  measure: z.enum(limitMeasures),
  period: z.enum(limitPeriods),
  maxValue: z.number().int().min(1).max(limitValueMax.minutes),
  /** 1 is Monday and 7 is Sunday. Only matters for weekly limits. */
  weekStart: z.union([z.literal(1), z.literal(7)]).default(1),
}).refine((limit) => limit.measure !== "count" || limit.maxValue <= limitValueMax.count, {
  message: "That is more bookings than one period can hold.",
  path: ["maxValue"],
});
export type BookingLimitInput = z.infer<typeof bookingLimitInputSchema>;

export const bookingLimitSchema = bookingLimitInputSchema.safeExtend({
  id: identifierSchema,
  scope: z.enum(limitScopes),
  scopeId: identifierSchema,
});
export type BookingLimit = z.infer<typeof bookingLimitSchema>;

export const serviceCustomerRulesSchema = z.object({
  /** At most this many future bookings of the service for one customer. Null is no cap. */
  maxActivePerCustomer: z.number().int().min(1).max(50).nullable(),
  offerRescheduleWhenCapped: z.boolean(),
  firstSlotOnly: z.boolean(),
});
export type ServiceCustomerRules = z.infer<typeof serviceCustomerRulesSchema>;

export const limitTargetSchema = z.object({
  scope: z.enum(limitScopes),
  /** The service, person, branch, room or team. A new team has no id yet. */
  scopeId: identifierSchema.nullable(),
}).refine((target) => target.scope === "team" || target.scopeId !== null, {
  message: "Choose what this limit is for.",
  path: ["scopeId"],
});
export type LimitTarget = z.infer<typeof limitTargetSchema>;

/** A hand-picked pool of people whose bookings are counted together, until teams arrive in feature 53. */
export const limitTeamSchema = z.object({
  name: z.string().trim().min(1, "Give the team a name.").max(80),
  memberIds: z.array(identifierSchema).min(2, "Pick at least two people for a team limit.").max(100),
});
export type LimitTeam = z.infer<typeof limitTeamSchema>;

/** Replaces the limits of one target in one go, so the screen saves its whole list at once. */
export const bookingLimitsReplaceSchema = z.object({
  target: limitTargetSchema,
  /** The team's name and people. Required for a team and ignored otherwise. */
  team: limitTeamSchema.optional(),
  limits: z.array(bookingLimitInputSchema).max(12),
  /** Present for a service: its customer cap and first-slot switch save with its limits. */
  serviceRules: serviceCustomerRulesSchema.optional(),
}).superRefine((value, context) => {
  if (value.target.scope === "team" && !value.team) {
    context.addIssue({ code: "custom", path: ["team"], message: "Pick the people in this team." });
  }
  const seen = new Set<string>();
  value.limits.forEach((limit, index) => {
    const key = `${limit.measure}:${limit.period}`;
    if (seen.has(key)) context.addIssue({ code: "custom", path: ["limits", index, "period"], message: "There is already a limit like this. Change that one instead." });
    seen.add(key);
  });
});
export type BookingLimitsReplace = z.infer<typeof bookingLimitsReplaceSchema>;

export const bookingLimitsQuerySchema = z.object({
  scope: z.enum(limitScopes),
  scopeId: identifierSchema.optional(),
});

export interface BookingLimitsView {
  target: LimitTarget;
  team: (LimitTeam & { id: string }) | null;
  limits: BookingLimit[];
  serviceRules: ServiceCustomerRules | null;
}

/** Why staff may go past a limit. A fixed list, so no free text reaches the audit trail. */
export const limitOverrideReasons = ["customer_request", "emergency", "owner_decision", "other"] as const;
export type LimitOverrideReason = (typeof limitOverrideReasons)[number];
export const limitOverrideLabels: Record<LimitOverrideReason, string> = {
  customer_request: "The customer asked and we agreed",
  emergency: "It is urgent",
  owner_decision: "The owner decided",
  other: "Another reason",
};

export function describeLimit(limit: Pick<BookingLimitInput, "measure" | "period" | "maxValue">): string {
  const per = { day: "a day", week: "a week", month: "a month", year: "a year" }[limit.period];
  if (limit.measure === "count") return `${limit.maxValue} ${limit.maxValue === 1 ? "booking" : "bookings"} ${per}`;
  const hours = limit.maxValue / 60;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} ${hours === 1 ? "hour" : "hours"} booked ${per}`;
}
