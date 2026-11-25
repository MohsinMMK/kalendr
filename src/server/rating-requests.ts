/**
 * Asking for a rating (feature 51). One helper serves both ways the ask goes out, the "Ask for a review" workflow and the
 * fixed review message, so a visit gets one link, a customer is asked at most once a month, and nobody is asked after a
 * no-show or a cancellation. No "server-only": the worker calls it while rendering a message.
 */
import { createHash, randomBytes } from "node:crypto";

import { sql } from "drizzle-orm";

import { RATING_REPEAT_DAYS, reviewClosesAt } from "../lib/reviews";
import { openManageToken, sealManageToken } from "./messaging/sealed-link";
import type { Runner } from "./workflows/runner";

export type RatingAskResult =
  | { ok: true; token: string; link: (origin: string) => string }
  | { ok: false; reason: "not_finished" | "already_rated" | "asked_recently" | "no_key" };

const hashToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");

const ratingLink = (token: string) => (origin: string) => `${origin.replace(/\/$/, "")}/r/${encodeURIComponent(token)}`;

/**
 * Finds or makes the visit's rating link. Asking again for the same visit (a retried message) returns the same link; a link
 * that cannot be read back is replaced by a fresh one, which stops the old one working.
 */
export async function ensureRatingLink(run: Runner, input: { tenantId: string; appointmentId: string; now: Date }): Promise<RatingAskResult> {
  const [visit] = await run(sql`
    select a.status, a.ends_at, a.patient_id from appointments a
    where a.tenant_id = ${input.tenantId} and a.id = ${input.appointmentId} for update`);
  if (!visit || visit.status !== "completed") return { ok: false, reason: "not_finished" };
  const endsAt = visit.ends_at instanceof Date ? visit.ends_at : new Date(String(visit.ends_at));
  const patientId = String(visit.patient_id);

  const [rated] = await run(sql`select 1 as present from reviews where tenant_id = ${input.tenantId} and appointment_id = ${input.appointmentId}`);
  if (rated) return { ok: false, reason: "already_rated" };

  const [existing] = await run(sql`
    select id, token_ciphertext from rating_requests where tenant_id = ${input.tenantId} and appointment_id = ${input.appointmentId}`);
  if (existing) {
    const token = openManageToken(input.tenantId, input.appointmentId, typeof existing.token_ciphertext === "string" ? existing.token_ciphertext : null);
    if (token) return { ok: true, token, link: ratingLink(token) };
    const fresh = randomBytes(32).toString("base64url");
    const sealed = sealManageToken(input.tenantId, input.appointmentId, fresh);
    if (!sealed) return { ok: false, reason: "no_key" };
    await run(sql`update rating_requests set token_hash = ${hashToken(fresh)}, token_ciphertext = ${sealed} where tenant_id = ${input.tenantId} and id = ${String(existing.id)}`);
    return { ok: true, token: fresh, link: ratingLink(fresh) };
  }

  // Once a month per customer, however many visits they made.
  const [recent] = await run(sql`
    select 1 as present from rating_requests
    where tenant_id = ${input.tenantId} and patient_id = ${patientId} and sent_at > ${input.now.toISOString()}::timestamptz - (${RATING_REPEAT_DAYS} * interval '1 day')`);
  if (recent) return { ok: false, reason: "asked_recently" };

  const token = randomBytes(32).toString("base64url");
  const sealed = sealManageToken(input.tenantId, input.appointmentId, token);
  if (!sealed) return { ok: false, reason: "no_key" };
  await run(sql`
    insert into rating_requests (tenant_id, appointment_id, patient_id, token_hash, token_ciphertext, sent_at, expires_at)
    values (${input.tenantId}, ${input.appointmentId}, ${patientId}, ${hashToken(token)}, ${sealed}, ${input.now.toISOString()}::timestamptz,
      ${reviewClosesAt(endsAt).toISOString()}::timestamptz)`);
  return { ok: true, token, link: ratingLink(token) };
}
