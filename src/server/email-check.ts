import "server-only";

import { createHmac, randomInt, timingSafeEqual } from "node:crypto";

import { sql } from "drizzle-orm";

import { getDatabase, withTenant, type KalendrTransaction } from "@/db/client";
import { outboxEvents } from "@/db/schema";
import { EMAIL_CODE_ATTEMPTS, EMAIL_CODE_MINUTES, type EmailCheckBody } from "@/lib/booking-intake";
import { isPreviewMode } from "@/server/preview-repository";

import { ApiError } from "./api-error";
import { createOpaqueToken, sha256 } from "./crypto";
import { env } from "./env";
import { assertTenantNotPaused } from "./tenant-pause";
import { sealPrivate } from "./messaging/sealed-link";
import { currentTraceParent } from "./tracing";

/**
 * The email check (feature 40). A customer types an email, the page asks for a code, the code arrives by email and
 * the customer enters it; the page then holds a one-use proof that goes with the booking. Codes are 6 digits, kept as a
 * keyed hash, live 10 minutes and allow 5 attempts. Sending goes through the outbox, so nothing here calls a provider.
 */

const PROOF_MINUTES = 30;
const SENDS_PER_HOUR = 5;
const EMAIL_CHECK_EVENT = "email_check.code";

const normalise = (email: string): string => email.trim().toLowerCase();
const emailDigest = (email: string): string => sha256(`email-check:${normalise(email)}`);

/** Six digits can be tried offline in seconds, so the hash needs a key the database does not hold. */
function codeDigest(emailHash: string, code: string): string {
  const secret = env().BETTER_AUTH_SECRET;
  if (!secret) throw new ApiError(503, "email_check_unavailable", "We can't check email addresses right now. Please try again shortly.");
  return createHmac("sha256", secret).update(`${emailHash}:${code}`).digest("hex");
}

async function tenantFor(slug: string): Promise<string> {
  if (isPreviewMode()) throw new ApiError(409, "preview_only", "The preview does not send codes.");
  const database = getDatabase();
  if (!database) throw new ApiError(503, "database_unavailable", "Booking is not available right now. Please try again shortly.");
  const [tenant] = await database.execute<{ tenant_id: string }>(sql`select tenant_id from kalendr_resolve_tenant(${slug}, null)`);
  if (!tenant) throw new ApiError(404, "clinic_not_found", "Business not found.");
  await assertTenantNotPaused(tenant.tenant_id);
  return tenant.tenant_id;
}

/** The code and its email for one address: rate-limited per address, sealed for the worker, sent through the outbox. */
export async function queueCodeIn(transaction: KalendrTransaction, tenantId: string, email: string): Promise<void> {
  const emailHash = emailDigest(email);
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const [recent] = await transaction.execute<{ sent: number }>(sql`
    select count(*)::int as sent from email_checks
    where tenant_id = ${tenantId} and email_hash = ${emailHash} and created_at > now() - interval '1 hour'
  `);
  if ((recent?.sent ?? 0) >= SENDS_PER_HOUR) {
    throw new ApiError(429, "too_many_codes", "Too many codes were sent to this address. Please wait an hour, then ask for a new one.");
  }
  const [created] = await transaction.execute<{ id: string }>(sql`
    insert into email_checks (tenant_id, email_hash, code_hash, expires_at)
    values (${tenantId}, ${emailHash}, ${codeDigest(emailHash, code)}, now() + (${EMAIL_CODE_MINUTES} * interval '1 minute'))
    returning id
  `);
  if (!created) throw new Error("Email check insert returned no row");
  const sealed = sealPrivate("email_check", tenantId, created.id, JSON.stringify({ email: normalise(email), code }));
  if (!sealed) throw new ApiError(503, "email_check_unavailable", "We can't check email addresses right now. Please try again shortly.");
  await transaction.execute(sql`update email_checks set delivery_sealed = ${sealed} where tenant_id = ${tenantId} and id = ${created.id}`);
  await transaction.insert(outboxEvents).values({
    tenantId,
    aggregateType: "email_check",
    aggregateId: created.id,
    eventType: EMAIL_CHECK_EVENT,
    payload: { emailCheckId: created.id },
    dedupeKey: `${EMAIL_CHECK_EVENT}:${created.id}`,
    traceParent: currentTraceParent(),
  });
}

export async function sendEmailCode(input: Extract<EmailCheckBody, { action: "send" }>): Promise<{ sent: true; expiresInMinutes: number }> {
  const tenantId = await tenantFor(input.clinicSlug);
  await withTenant(tenantId, async (transaction) => {
    const [service] = await transaction.execute<{ verify_email: boolean }>(sql`
      select verify_email from services where tenant_id = ${tenantId} and id = ${input.serviceId} and is_active
    `);
    if (!service) throw new ApiError(404, "service_not_found", "That service could not be found.");
    if (!service.verify_email) throw new ApiError(409, "email_check_not_required", "This booking does not need an email code.");
    await queueCodeIn(transaction, tenantId, input.email);
  });
  return { sent: true, expiresInMinutes: EMAIL_CODE_MINUTES };
}

export type VerifyOutcome = { kind: "ok"; proof: string } | { kind: "wrong" } | { kind: "locked" } | { kind: "none" };

/** Checks one code for one address inside a transaction. A wrong guess is counted and kept, so callers commit before refusing. */
export async function checkCodeIn(transaction: KalendrTransaction, tenantId: string, email: string, code: string): Promise<VerifyOutcome> {
  const emailHash = emailDigest(email);
  const [check] = await transaction.execute<{ id: string; code_hash: string; attempts: number }>(sql`
    select id, code_hash, attempts from email_checks
    where tenant_id = ${tenantId} and email_hash = ${emailHash} and verified_at is null and expires_at > now()
    order by created_at desc limit 1
    for update
  `);
  if (!check) return { kind: "none" };
  if (check.attempts >= EMAIL_CODE_ATTEMPTS) return { kind: "locked" };
  const expected = Buffer.from(check.code_hash);
  const given = Buffer.from(codeDigest(emailHash, code));
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    await transaction.execute(sql`update email_checks set attempts = attempts + 1 where tenant_id = ${tenantId} and id = ${check.id}`);
    return { kind: "wrong" };
  }
  const proof = createOpaqueToken();
  await transaction.execute(sql`
    update email_checks set verified_at = now(), proof_hash = ${sha256(proof)}, delivery_sealed = null
    where tenant_id = ${tenantId} and id = ${check.id}
  `);
  return { kind: "ok", proof };
}

export async function verifyEmailCode(input: Extract<EmailCheckBody, { action: "verify" }>): Promise<{ proof: string }> {
  const tenantId = await tenantFor(input.clinicSlug);
  // A wrong guess is counted and kept, so the transaction commits and the refusal is raised after it.
  const outcome = await withTenant(tenantId, (transaction) => checkCodeIn(transaction, tenantId, input.email, input.code));
  if (outcome.kind === "ok") return { proof: outcome.proof };
  if (outcome.kind === "locked") throw new ApiError(429, "too_many_attempts", "Too many wrong codes. Ask for a new code and try again.");
  throw new ApiError(400, "invalid_code", "That code isn't right or has expired. Check it, or ask for a new one.");
}

/** Inside the booking transaction: the proof must be for this address, fresh and unused. It is used up here. */
export async function consumeEmailProof(transaction: KalendrTransaction, tenantId: string, email: string, proof: string | undefined): Promise<void> {
  const notChecked = new ApiError(422, "email_not_verified", "Please confirm your email address with the code we sent.", { email: ["Confirm your email address with the code we sent."] });
  if (!proof) throw notChecked;
  const rows = await transaction.execute<{ id: string }>(sql`
    update email_checks set consumed_at = now()
    where tenant_id = ${tenantId} and proof_hash = ${sha256(proof)} and email_hash = ${emailDigest(email)}
      and consumed_at is null and verified_at > now() - (${PROOF_MINUTES} * interval '1 minute')
    returning id
  `);
  if (rows.length === 0) throw notChecked;
}
