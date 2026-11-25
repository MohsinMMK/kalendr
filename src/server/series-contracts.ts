import { z } from "zod";

import { repeatRuleSchema } from "@/lib/series-rule";
import { staffBookingSchema } from "@/server/contracts";

/** The request bodies of the repeating-appointment routes (feature 17). Checked again on the server. */

const identifier = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

export const seriesResolutionSchema = z.strictObject({
  index: z.number().int().min(1).max(52),
  action: z.enum(["skip", "move"]),
  /** For `move`: another start on the same day, one of the times the preview offered. */
  startsAt: z.iso.datetime({ offset: true }).optional(),
}).refine((value) => value.action === "skip" || Boolean(value.startsAt), { path: ["startsAt"], message: "Choose another time." });

/** The booking the first visit is made from, and the rule that repeats it. `booking.startsAt` is the first visit. */
export const seriesPreviewSchema = z.strictObject({
  booking: staffBookingSchema,
  rule: repeatRuleSchema,
});

export const seriesSaveSchema = z.strictObject({
  booking: staffBookingSchema,
  rule: repeatRuleSchema,
  resolutions: z.array(seriesResolutionSchema).max(52).default([]),
});

const scope = z.enum(["following", "all"]);

/** What "this and following" or "all" can change: the day and time (from the new first start), the person, the length. */
const changeFields = {
  scope,
  /** The visit the person was looking at. `following` starts here; `all` starts at the first visit still open to change. */
  fromAppointmentId: identifier,
  expectedVersion: z.number().int().positive(),
  startsAt: z.iso.datetime({ offset: true }),
  practitionerId: identifier.optional(),
  durationMinutes: z.number().int().min(5).max(480).optional(),
};

export const seriesChangePreviewSchema = z.strictObject(changeFields);

export const seriesChangeSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("cancel"),
    scope,
    fromAppointmentId: identifier,
    expectedVersion: z.number().int().positive(),
  }),
  z.strictObject({
    action: z.literal("change"),
    ...changeFields,
    resolutions: z.array(seriesResolutionSchema).max(52).default([]),
  }),
]);

export type SeriesPreviewInput = z.infer<typeof seriesPreviewSchema>;
export type SeriesSaveInput = z.infer<typeof seriesSaveSchema>;
export type SeriesChangePreviewInput = z.infer<typeof seriesChangePreviewSchema>;
export type SeriesChangeInput = z.infer<typeof seriesChangeSchema>;
