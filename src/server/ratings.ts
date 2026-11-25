import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { getDatabase, withTenant } from "@/db/client";
import { appointments, ratingRequests, reviews, services, tenants } from "@/db/schema";
import { RATING_EDIT_WINDOW_DAYS, type RatingPageParsed, type RatingPageState } from "@/lib/rating-page";
import { ApiError } from "@/server/api-error";
import { sha256 } from "@/server/crypto";
import { writeReview } from "@/server/reviews";

const notFound = () => new ApiError(404, "rating_not_found", "This rating link does not work. Ask the business for a new one.");

interface Resolved extends Record<string, unknown> { tenant_id: string; request_id: string; appointment_id: string }

async function resolve(token: string): Promise<Resolved> {
  const database = getDatabase();
  if (!database) throw new ApiError(503, "database_unavailable", "Ratings are unavailable right now. Try again later.");
  const rows = await database.execute<Resolved>(sql`select * from kalendr_resolve_rating_token(${sha256(token)})`);
  const found = Array.from(rows)[0];
  if (!found) throw notFound();
  return found;
}

/** The ask as the rating page shows it. Opening it for the first time records when. */
export async function getRatingState(token: string, now: Date = new Date()): Promise<RatingPageState> {
  const resolved = await resolve(token);
  return withTenant(resolved.tenant_id, async (transaction) => {
    const [request] = await transaction.select().from(ratingRequests)
      .where(and(eq(ratingRequests.tenantId, resolved.tenant_id), eq(ratingRequests.id, resolved.request_id))).for("update").limit(1);
    if (!request) throw notFound();
    if (!request.openedAt) await transaction.update(ratingRequests).set({ openedAt: now }).where(and(eq(ratingRequests.tenantId, resolved.tenant_id), eq(ratingRequests.id, request.id)));
    const [details] = await transaction
      .select({ business: tenants.name, service: services.name, status: appointments.status })
      .from(appointments)
      .innerJoin(tenants, eq(tenants.id, appointments.tenantId))
      .innerJoin(services, and(eq(services.tenantId, appointments.tenantId), eq(services.id, appointments.serviceId)))
      .where(and(eq(appointments.tenantId, resolved.tenant_id), eq(appointments.id, resolved.appointment_id))).limit(1);
    if (!details) throw notFound();
    const [review] = await transaction.select({ rating: reviews.rating, comment: reviews.comment, visibility: reviews.visibility })
      .from(reviews).where(and(eq(reviews.tenantId, resolved.tenant_id), eq(reviews.appointmentId, resolved.appointment_id))).limit(1);
    const editUntil = request.answeredAt ? new Date(request.answeredAt.getTime() + RATING_EDIT_WINDOW_DAYS * 86_400_000) : null;
    const expired = request.expiresAt.getTime() <= now.getTime();
    const answered = Boolean(review);
    return {
      business: details.business,
      service: details.service,
      phase: answered ? (editUntil && editUntil.getTime() > now.getTime() ? "answered" : "closed") : expired || details.status !== "completed" ? "expired" : "open",
      review: review ? { rating: review.rating, comment: review.comment, visibility: review.visibility === "private" ? "private" : "public" } : null,
      editableUntil: answered && editUntil && editUntil.getTime() > now.getTime() ? editUntil.toISOString() : null,
    } satisfies RatingPageState;
  });
}

/**
 * One tap records the stars. Opening the link again after answering shows the answer, and for a week the comment and who sees
 * it can still change; the stars themselves do not.
 */
export async function saveRating(token: string, input: RatingPageParsed, now: Date = new Date()): Promise<RatingPageState> {
  const resolved = await resolve(token);
  await withTenant(resolved.tenant_id, async (transaction) => {
    const [request] = await transaction.select().from(ratingRequests)
      .where(and(eq(ratingRequests.tenantId, resolved.tenant_id), eq(ratingRequests.id, resolved.request_id))).for("update").limit(1);
    if (!request) throw notFound();
    const [existing] = await transaction.select({ rating: reviews.rating, comment: reviews.comment, visibility: reviews.visibility })
      .from(reviews).where(and(eq(reviews.tenantId, resolved.tenant_id), eq(reviews.appointmentId, resolved.appointment_id))).limit(1);
    if (existing) {
      const editUntil = request.answeredAt ? request.answeredAt.getTime() + RATING_EDIT_WINDOW_DAYS * 86_400_000 : 0;
      if (editUntil <= now.getTime()) throw new ApiError(409, "rating_closed", "You already rated this visit, and the time to change your comment has passed.");
      if (input.rating !== undefined && input.rating !== existing.rating) throw new ApiError(409, "rating_locked", "Your stars are saved. You can still change your comment.");
    } else if (request.expiresAt.getTime() <= now.getTime()) {
      throw new ApiError(409, "review_not_open", "This link has expired. Reviews open once your visit is finished, for 60 days.");
    }
    const rating = input.rating ?? existing?.rating;
    if (rating === undefined) throw new ApiError(400, "invalid_review", "Choose a rating from 1 to 5.");
    // A comment left out of an edit keeps what was said; the second step of the page sends it with the choice of who sees it.
    const comment = input.comment !== undefined ? input.comment : existing?.comment ?? null;
    await writeReview(transaction, {
      tenantId: resolved.tenant_id, appointmentId: resolved.appointment_id, rating, comment, visibility: input.visibility, source: "rating_link", now,
    });
    if (!request.answeredAt) await transaction.update(ratingRequests).set({ answeredAt: now }).where(and(eq(ratingRequests.tenantId, resolved.tenant_id), eq(ratingRequests.id, request.id)));
  });
  return getRatingState(token, now);
}
