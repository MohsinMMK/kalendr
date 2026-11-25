import { z } from "zod";

/** How long after a finished appointment the customer may write or change a review. */
export const REVIEW_WINDOW_DAYS = 60;
/** How long after a visit is finished the customer is asked for a review. */
export const REVIEW_REQUEST_DELAY_MS = 2 * 60 * 60 * 1000;

/** Who may see a review: `public` can show on the business page, `private` is feedback for the business alone (feature 51). */
export const reviewVisibilitySchema = z.enum(["public", "private"]);
export type ReviewVisibility = z.infer<typeof reviewVisibilitySchema>;
/** Where a review came from: the manage page, the one-tap rating link, or staff. */
export type ReviewSource = "manage_link" | "rating_link" | "staff";
/** One or two stars alert the business and start out private. */
export const LOW_RATING_MAX = 2;
/** After answering, the customer can still change the comment and who sees it for this long. */
export const RATING_EDIT_WINDOW_DAYS = 7;
/** A customer is asked at most once in this many days, however many visits they have. */
export const RATING_REPEAT_DAYS = 30;
/** What a score starts as: low scores are private until the customer chooses to share them. */
export function defaultVisibility(rating: number): ReviewVisibility {
  return rating <= LOW_RATING_MAX ? "private" : "public";
}
/** Satisfied means four or five stars. */
export const SATISFIED_MIN = 4;

export const reviewInputSchema = z.object({
  rating: z.number().int().min(1).max(5),
  visibility: reviewVisibilitySchema.optional(),
  comment: z
    .string()
    .trim()
    .max(1000)
    .optional()
    .transform((value) => (value ? value : null)),
});

export type ReviewInput = z.input<typeof reviewInputSchema>;

/** A review as anyone on the public page may see it. Hidden reviews never become one. */
export interface PublicReview {
  id: string;
  rating: number;
  comment: string | null;
  displayName: string;
  practitionerId: string;
  serviceId: string;
  createdAt: string;
}

/** A review as the business's staff see it in Settings. */
export interface StaffReview extends PublicReview {
  isHidden: boolean;
  appointmentId: string;
  visibility: ReviewVisibility;
  source: ReviewSource;
}

/** A review beside the appointment or customer it is about, for staff. The comment is the customer's own words. */
export interface AppointmentRating {
  id: string;
  appointmentId: string;
  rating: number;
  comment: string | null;
  visibility: ReviewVisibility;
  source: ReviewSource;
  isHidden: boolean;
  createdAt: string;
}

export interface RatingSummary {
  count: number;
  /** Rounded to one decimal, or null when there are no reviews. */
  average: number | null;
}

/** Ratings for the business and for each team member, by id. */
export interface RatingSummaries {
  business: RatingSummary;
  byPractitioner: Record<string, RatingSummary>;
}

/** The customer's own review of one appointment, as the manage page shows it. */
export interface ReviewState {
  /** Whether the customer can write or change a review now. */
  open: boolean;
  /** When the window closes, so the page can say so. Null when the appointment is not finished. */
  closesAt: string | null;
  review: { rating: number; comment: string | null; visibility?: ReviewVisibility } | null;
}

export const emptyRatingSummary: RatingSummary = { count: 0, average: null };

/** "Sam K." from a first and last name. Fixed when the review is written. */
export function reviewDisplayName(firstName: string, lastName: string): string {
  const first = firstName.trim().split(/\s+/)[0] ?? "";
  const initial = lastName.trim().charAt(0).toUpperCase();
  const name = [first, initial ? `${initial}.` : ""].filter(Boolean).join(" ");
  return (name || "Customer").slice(0, 60);
}

export function summarizeRatings(ratings: readonly number[]): RatingSummary {
  const count = ratings.length;
  if (count === 0) return { count, average: null };
  const total = ratings.reduce((sum, rating) => sum + rating, 0);
  return { count, average: Math.round((total / count) * 10) / 10 };
}

/** When the review window for a finished appointment closes. */
export function reviewClosesAt(endsAt: Date): Date {
  return new Date(endsAt.getTime() + REVIEW_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

/** Reviews are only for appointments that really happened, and only for a while afterwards. */
export function isReviewWindowOpen(status: string, endsAt: Date, now: Date = new Date()): boolean {
  if (status !== "completed") return false;
  return now.getTime() <= reviewClosesAt(endsAt).getTime();
}
