import { z } from "zod";

import { RATING_EDIT_WINDOW_DAYS, reviewVisibilitySchema, type ReviewVisibility } from "./reviews";

export { RATING_EDIT_WINDOW_DAYS };

/**
 * What the one-tap rating page sends: the stars (on the first tap), then optionally a comment and who may see it. After the first
 * answer only the comment and visibility can change, so `rating` is optional and must match the saved one.
 */
export const ratingPageInputSchema = z.object({
  rating: z.number().int().min(1).max(5).optional(),
  comment: z.string().trim().max(1000).transform((value) => (value ? value : null)).optional(),
  visibility: reviewVisibilitySchema.optional(),
});
export type RatingPageInput = z.input<typeof ratingPageInputSchema>;
/** The same, after the schema has trimmed the comment: what the server works with. */
export type RatingPageParsed = z.output<typeof ratingPageInputSchema>;

export interface RatingPageState {
  business: string;
  service: string;
  /** open: waiting for stars. answered: thanks, and the comment can change for a week. closed: answered, can't change. expired: the link ran out. */
  phase: "open" | "answered" | "closed" | "expired";
  review: { rating: number; comment: string | null; visibility: ReviewVisibility } | null;
  editableUntil: string | null;
}
