import "server-only";

import { and, desc, eq, sql } from "drizzle-orm";

import { withTenant, type KalendrTransaction } from "@/db/client";
import { appointments, auditEvents, patients, reviews } from "@/db/schema";
import { previewReviews } from "@/lib/preview-reviews";
import {
  defaultVisibility,
  emptyRatingSummary,
  LOW_RATING_MAX,
  isReviewWindowOpen,
  reviewClosesAt,
  reviewDisplayName,
  reviewInputSchema,
  summarizeRatings,
  type AppointmentRating,
  type PublicReview,
  type RatingSummaries,
  type RatingSummary,
  type ReviewSource,
  type ReviewVisibility,
  type ReviewInput,
  type ReviewState,
  type StaffReview,
} from "@/lib/reviews";
import { notifyStaff } from "./staff-notifications";
import { ApiError } from "@/server/api-error";
import { resolveManageToken } from "@/server/appointment-repository";
import { getPreviewAppointmentForReview, isPreviewMode } from "@/server/preview-repository";
import { can, requirePermission, type StaffContext } from "@/server/staff-context";

const notFound = () => new ApiError(404, "appointment_not_found", "Appointment not found.");
const windowClosed = () =>
  new ApiError(409, "review_not_open", "Reviews open once your appointment is finished, for 60 days.");

interface PreviewReviewGlobals {
  kalendrPreviewReviews?: Map<string, PublicReview>;
}

/** Reviews written in preview, keyed by manage token. Gone when the process restarts. */
function previewWrittenReviews(): Map<string, PublicReview> {
  const globals = globalThis as typeof globalThis & PreviewReviewGlobals;
  globals.kalendrPreviewReviews ??= new Map();
  return globals.kalendrPreviewReviews;
}

function allPreviewReviews(): PublicReview[] {
  return [...previewWrittenReviews().values(), ...previewReviews].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const toVisibility = (value: string): ReviewVisibility => (value === "private" ? "private" : "public");
const toSource = (value: string): ReviewSource => (value === "rating_link" || value === "staff" ? value : "manage_link");

function toPublicReview(row: typeof reviews.$inferSelect): PublicReview {
  return {
    id: row.id,
    rating: row.rating,
    comment: row.comment,
    displayName: row.displayName,
    practitionerId: row.practitionerId,
    serviceId: row.serviceId,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The customer's review of the appointment behind a manage link, and whether they may write one now. */
export async function getReviewStateByToken(token: string, now: Date = new Date()): Promise<ReviewState> {
  if (isPreviewMode()) {
    const appointment = getPreviewAppointmentForReview(token);
    const endsAt = new Date(appointment.endsAt);
    const written = previewWrittenReviews().get(token);
    return {
      open: isReviewWindowOpen(appointment.status, endsAt, now),
      closesAt: appointment.status === "completed" ? reviewClosesAt(endsAt).toISOString() : null,
      review: written ? { rating: written.rating, comment: written.comment } : null,
    };
  }
  const resolved = await resolveManageToken(token);
  if (!resolved) throw notFound();
  return withTenant(resolved.tenant_id, async (transaction) => {
    const [appointment] = await transaction
      .select({ status: appointments.status, endsAt: appointments.endsAt })
      .from(appointments)
      .where(and(eq(appointments.tenantId, resolved.tenant_id), eq(appointments.id, resolved.appointment_id)))
      .limit(1);
    if (!appointment) throw notFound();
    const [review] = await transaction
      .select({ rating: reviews.rating, comment: reviews.comment, visibility: reviews.visibility })
      .from(reviews)
      .where(and(eq(reviews.tenantId, resolved.tenant_id), eq(reviews.appointmentId, resolved.appointment_id)))
      .limit(1);
    return {
      open: isReviewWindowOpen(appointment.status, appointment.endsAt, now),
      closesAt: appointment.status === "completed" ? reviewClosesAt(appointment.endsAt).toISOString() : null,
      review: review ? { ...review, visibility: review.visibility === "private" ? "private" : "public" } : null,
    };
  });
}

/** Writes or changes the customer's review. Published at once; staff can hide it later. */
export async function saveReviewByToken(token: string, input: ReviewInput, now: Date = new Date()): Promise<ReviewState> {
  const parsed = reviewInputSchema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, "invalid_review", "Choose a rating from 1 to 5. Comments can be up to 1000 characters.");
  const { rating, comment } = parsed.data;

  if (isPreviewMode()) {
    const appointment = getPreviewAppointmentForReview(token);
    if (!isReviewWindowOpen(appointment.status, new Date(appointment.endsAt), now)) throw windowClosed();
    const existing = previewWrittenReviews().get(token);
    previewWrittenReviews().set(token, {
      id: existing?.id ?? `preview_review_${appointment.id}`,
      rating,
      comment,
      displayName: reviewDisplayName("Preview", "Customer"),
      practitionerId: appointment.practitionerId,
      serviceId: appointment.serviceId,
      createdAt: existing?.createdAt ?? now.toISOString(),
    });
    return getReviewStateByToken(token, now);
  }

  const resolved = await resolveManageToken(token);
  if (!resolved) throw notFound();
  await withTenant(resolved.tenant_id, (transaction) => writeReview(transaction, {
    tenantId: resolved.tenant_id, appointmentId: resolved.appointment_id, rating, comment, visibility: parsed.data.visibility, source: "manage_link", now,
  }));
  return getReviewStateByToken(token, now);
}

export interface WriteReviewInput {
  tenantId: string;
  appointmentId: string;
  rating: number;
  comment: string | null;
  /** Left out, a new review starts as `defaultVisibility(rating)` and an edited one keeps what it had (unless the score fell to 2 or less). */
  visibility?: ReviewVisibility;
  source: ReviewSource;
  now: Date;
}

/**
 * The one place a customer's review is written, whichever link it came through (feature 51): the manage page and the rating
 * link share it, so the audit row and the low-score alert exist once per visit. The words of a review never go into the audit
 * row or the alert.
 */
export async function writeReview(transaction: KalendrTransaction, input: WriteReviewInput): Promise<{ visibility: ReviewVisibility; created: boolean }> {
  const [appointment] = await transaction
    .select({
      status: appointments.status,
      endsAt: appointments.endsAt,
      practitionerId: appointments.practitionerId,
      serviceId: appointments.serviceId,
      firstName: patients.firstName,
      lastName: patients.lastName,
    })
    .from(appointments)
    .innerJoin(patients, and(eq(patients.tenantId, appointments.tenantId), eq(patients.id, appointments.patientId)))
    .where(and(eq(appointments.tenantId, input.tenantId), eq(appointments.id, input.appointmentId)))
    .limit(1);
  if (!appointment) throw notFound();
  if (!isReviewWindowOpen(appointment.status, appointment.endsAt, input.now)) throw windowClosed();
  const [existing] = await transaction
    .select({ visibility: reviews.visibility })
    .from(reviews)
    .where(and(eq(reviews.tenantId, input.tenantId), eq(reviews.appointmentId, input.appointmentId)))
    .limit(1);
  const visibility: ReviewVisibility = input.visibility
    ?? (existing && input.rating > LOW_RATING_MAX ? (existing.visibility === "private" ? "private" : "public") : defaultVisibility(input.rating));

  await transaction
    .insert(reviews)
    .values({
      tenantId: input.tenantId,
      appointmentId: input.appointmentId,
      practitionerId: appointment.practitionerId,
      serviceId: appointment.serviceId,
      rating: input.rating,
      comment: input.comment,
      visibility,
      source: input.source,
      displayName: reviewDisplayName(appointment.firstName, appointment.lastName),
    })
    .onConflictDoUpdate({
      target: [reviews.tenantId, reviews.appointmentId],
      set: { rating: input.rating, comment: input.comment, visibility, updatedAt: input.now },
    });
  await transaction.insert(auditEvents).values({
    tenantId: input.tenantId,
    appointmentId: input.appointmentId,
    actorType: "patient",
    action: "review.saved",
    outcome: "success",
    metadata: { rating: input.rating, visibility, source: input.source },
  });
  // A low rating is worth hearing about at once (feature 56). The words of the review never go into the alert.
  if (input.rating <= LOW_RATING_MAX) {
    await notifyStaff(transaction, input.tenantId, {
      kind: "low_rating", appointmentId: input.appointmentId, dedupeKey: `review.low:${input.appointmentId}`,
    });
  }
  return { visibility, created: !existing };
}

/** Published reviews, newest first. Pass a team member to see only theirs. */
export async function listPublicReviews(
  tenantId: string,
  options: { practitionerId?: string; limit?: number } = {},
): Promise<PublicReview[]> {
  const limit = Math.min(Math.max(options.limit ?? 20, 1), 50);
  if (isPreviewMode()) {
    return allPreviewReviews()
      .filter((review) => !options.practitionerId || review.practitionerId === options.practitionerId)
      .slice(0, limit);
  }
  return withTenant(tenantId, (transaction) => listPublicReviewsIn(transaction, tenantId, { ...options, limit }));
}

export async function listPublicReviewsIn(
  transaction: KalendrTransaction,
  tenantId: string,
  options: { practitionerId?: string; limit: number },
): Promise<PublicReview[]> {
  const rows = await transaction
    .select()
    .from(reviews)
    .where(
      and(
        eq(reviews.tenantId, tenantId),
        eq(reviews.isHidden, false),
        eq(reviews.visibility, "public"),
        options.practitionerId ? eq(reviews.practitionerId, options.practitionerId) : undefined,
      ),
    )
    .orderBy(desc(reviews.createdAt))
    .limit(options.limit);
  return rows.map(toPublicReview);
}

/** Rating counts and averages for the business and each team member, from published reviews only. */
export async function loadRatingSummariesIn(transaction: KalendrTransaction, tenantId: string): Promise<RatingSummaries> {
  const rows = await transaction
    .select({
      practitionerId: reviews.practitionerId,
      ratings: sql<number[]>`array_agg(${reviews.rating})`,
    })
    .from(reviews)
    .where(and(eq(reviews.tenantId, tenantId), eq(reviews.isHidden, false), eq(reviews.visibility, "public")))
    .groupBy(reviews.practitionerId);
  return summariesFromGroups(rows.map((row) => ({ practitionerId: row.practitionerId, ratings: row.ratings.map(Number) })));
}

export function previewRatingSummaries(): RatingSummaries {
  const groups = new Map<string, number[]>();
  for (const review of allPreviewReviews()) {
    groups.set(review.practitionerId, [...(groups.get(review.practitionerId) ?? []), review.rating]);
  }
  return summariesFromGroups([...groups].map(([practitionerId, ratings]) => ({ practitionerId, ratings })));
}

export function summariesFromGroups(groups: { practitionerId: string; ratings: number[] }[]): RatingSummaries {
  const byPractitioner: Record<string, RatingSummary> = {};
  for (const group of groups) byPractitioner[group.practitionerId] = summarizeRatings(group.ratings);
  const all = groups.flatMap((group) => group.ratings);
  return { business: all.length ? summarizeRatings(all) : emptyRatingSummary, byPractitioner };
}

/** Every review, hidden ones included, for the business's own Settings page. */
export async function listStaffReviews(context: StaffContext, limit = 100): Promise<StaffReview[]> {
  requirePermission(context, "settings.manage");
  if (context.preview || isPreviewMode()) {
    return allPreviewReviews().map((review) => ({ ...review, isHidden: false, appointmentId: review.id, visibility: "public" as const, source: "manage_link" as const }));
  }
  return withTenant(context.tenantId, async (transaction) => {
    const rows = await transaction
      .select()
      .from(reviews)
      .where(eq(reviews.tenantId, context.tenantId))
      .orderBy(desc(reviews.createdAt))
      .limit(Math.min(Math.max(limit, 1), 200));
    return rows.map((row) => ({ ...toPublicReview(row), isHidden: row.isHidden, appointmentId: row.appointmentId, visibility: toVisibility(row.visibility), source: toSource(row.source) }));
  });
}

/** Hides a review from the public page, or shows it again. The customer's words are never changed. */
export async function setReviewHidden(context: StaffContext, reviewId: string, hidden: boolean): Promise<void> {
  requirePermission(context, "settings.manage");
  if (context.preview || isPreviewMode()) return;
  await withTenant(context.tenantId, async (transaction) => {
    const updated = await transaction
      .update(reviews)
      .set({ isHidden: hidden, updatedAt: new Date() })
      .where(and(eq(reviews.tenantId, context.tenantId), eq(reviews.id, reviewId)))
      .returning({ appointmentId: reviews.appointmentId });
    if (!updated[0]) throw new ApiError(404, "review_not_found", "Review not found.");
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId,
      appointmentId: updated[0].appointmentId,
      actorUserId: context.userId,
      actorType: "staff",
      action: hidden ? "review.hidden" : "review.shown",
      outcome: "success",
      metadata: { reviewId },
    });
  });
}

/**
 * The rating on one appointment, or every rating of one customer, for the appointment screen and the customer profile (feature 51).
 * Private and hidden ones are included: this is the business looking at its own feedback.
 */
export async function listAppointmentRatings(context: StaffContext, filter: { appointmentId?: string; patientId?: string }): Promise<AppointmentRating[]> {
  if (!can(context, "appointments.book") && !can(context, "appointments.status") && !can(context, "settings.manage")) {
    requirePermission(context, "appointments.status");
  }
  if (context.preview || isPreviewMode() || (!filter.appointmentId && !filter.patientId)) return [];
  return withTenant(context.tenantId, async (transaction) => {
    const rows = await transaction
      .select({ review: reviews })
      .from(reviews)
      .innerJoin(appointments, and(eq(appointments.tenantId, reviews.tenantId), eq(appointments.id, reviews.appointmentId)))
      .where(and(
        eq(reviews.tenantId, context.tenantId),
        filter.appointmentId ? eq(reviews.appointmentId, filter.appointmentId) : undefined,
        filter.patientId ? eq(appointments.patientId, filter.patientId) : undefined,
      ))
      .orderBy(desc(reviews.createdAt))
      .limit(50);
    return rows.map(({ review }) => ({
      id: review.id, appointmentId: review.appointmentId, rating: review.rating, comment: review.comment,
      visibility: toVisibility(review.visibility), source: toSource(review.source), isHidden: review.isHidden, createdAt: review.createdAt.toISOString(),
    }));
  });
}
