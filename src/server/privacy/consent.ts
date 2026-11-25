import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { withTenant, type KalendrTransaction } from "@/db/client";
import { auditEvents, consentRecords, patients } from "@/db/schema";

import { ApiError } from "../api-error";
import { sealSecret, secretKeyVersion } from "../keys/secrets";
import { loadRecordKeys } from "../record-crypto";
import { NOTICE_VERSION } from "./notice";
import {
  consentPurposes,
  evaluateConsent,
  isMinor,
  marketingAllowed,
  type ConsentActor,
  type ConsentPurpose,
  type ConsentSource,
} from "./rules";

export interface ConsentActorInfo {
  type: ConsentActor;
  userId?: string | null;
}

export interface ConsentChange {
  patientId: string;
  purpose: ConsentPurpose;
  granted: boolean;
  /** The version of the notice the customer was shown. */
  wordingVersion?: string;
  source: ConsentSource;
  actor: ConsentActorInfo;
}

export interface ConsentState {
  purpose: ConsentPurpose;
  granted: boolean;
  /** False when the customer has never answered and the business default applies. */
  answered: boolean;
  wordingVersion: string | null;
  since: string | null;
}

interface LatestRow extends Record<string, unknown> {
  purpose: ConsentPurpose;
  granted: boolean;
  wording_version: string;
  created_at: Date | string;
}

async function latestRows(transaction: KalendrTransaction, tenantId: string, patientId: string): Promise<LatestRow[]> {
  return transaction.execute<LatestRow>(sql`
    select distinct on (purpose) purpose, granted, wording_version, created_at from consent_records
    where tenant_id = ${tenantId} and patient_id = ${patientId}
    order by purpose, created_at desc, id desc
  `);
}

/** Every purpose's current answer for one customer, in the order the screens show them. */
export async function currentConsentsIn(transaction: KalendrTransaction, tenantId: string, patientId: string): Promise<ConsentState[]> {
  const rows = new Map((await latestRows(transaction, tenantId, patientId)).map((row) => [row.purpose, row]));
  return consentPurposes.map((purpose) => {
    const row = rows.get(purpose);
    return {
      purpose,
      granted: evaluateConsent(purpose, row?.granted),
      answered: Boolean(row),
      wordingVersion: row?.wording_version ?? null,
      since: row ? new Date(row.created_at).toISOString() : null,
    };
  });
}

export function currentConsents(tenantId: string, patientId: string): Promise<ConsentState[]> {
  return withTenant(tenantId, (transaction) => currentConsentsIn(transaction, tenantId, patientId));
}

export async function hasConsentIn(transaction: KalendrTransaction, tenantId: string, patientId: string, purpose: ConsentPurpose): Promise<boolean> {
  const [patient] = await transaction.select({ erasedAt: patients.erasedAt }).from(patients)
    .where(and(eq(patients.tenantId, tenantId), eq(patients.id, patientId)));
  if (!patient || patient.erasedAt) return false;
  const states = await currentConsentsIn(transaction, tenantId, patientId);
  return states.find((state) => state.purpose === purpose)?.granted ?? false;
}

/** Whether one customer has agreed to, or not withdrawn, a purpose. */
export function hasConsent(tenantId: string, patientId: string, purpose: ConsentPurpose): Promise<boolean> {
  return withTenant(tenantId, (transaction) => hasConsentIn(transaction, tenantId, patientId, purpose));
}

export async function canSendMarketingIn(transaction: KalendrTransaction, tenantId: string, patientId: string, now: Date = new Date()): Promise<boolean> {
  const [patient] = await transaction
    .select({ dateOfBirth: patients.dateOfBirth, isDependent: patients.isDependent, erasedAt: patients.erasedAt })
    .from(patients)
    .where(and(eq(patients.tenantId, tenantId), eq(patients.id, patientId)));
  if (!patient) return false;
  const marketing = (await latestRows(transaction, tenantId, patientId)).find((row) => row.purpose === "marketing_messages");
  return marketingAllowed({
    latestMarketingGranted: marketing?.granted,
    dateOfBirth: patient.dateOfBirth,
    isDependent: patient.isDependent,
    erased: patient.erasedAt !== null,
  }, now);
}

/**
 * The one check every campaign makes before it sends marketing to a customer. It is false for a customer who has not
 * said yes, who withdrew, who is under 18 or a dependant, or who was erased. Appointment reminders and booking
 * messages never call it: withdrawing marketing does not stop them.
 */
export function canSendMarketing(tenantId: string, patientId: string): Promise<boolean> {
  return withTenant(tenantId, (transaction) => canSendMarketingIn(transaction, tenantId, patientId));
}

/**
 * Records one consent change in the caller's transaction, keeps the quick lookups on the customer in step, and writes
 * the audit row. Saying the same thing again changes nothing (a double click or a repeated STOP). Returns whether a new
 * row was written.
 */
export async function recordConsentIn(transaction: KalendrTransaction, tenantId: string, change: ConsentChange): Promise<{ changed: boolean }> {
  const [patient] = await transaction
    .select({
      dateOfBirth: patients.dateOfBirth,
      isDependent: patients.isDependent,
      guardianName: patients.guardianName,
      erasedAt: patients.erasedAt,
      privacyAcceptedAt: patients.privacyAcceptedAt,
      messagingConsentAt: patients.messagingConsentAt,
    })
    .from(patients)
    .where(and(eq(patients.tenantId, tenantId), eq(patients.id, change.patientId)))
    .for("update");
  if (!patient || patient.erasedAt) throw new ApiError(404, "not_found", "We could not find that person.");

  if (change.granted) {
    const minor = isMinor(patient, new Date());
    if (minor && change.purpose === "marketing_messages") {
      throw new ApiError(403, "minor_no_marketing", "Marketing messages are never sent to anyone under 18.");
    }
    if (minor && change.source === "portal" && !patient.guardianName) {
      throw new ApiError(409, "guardian_required", "A parent or guardian must give their name before choices can be saved for someone under 18.");
    }
  }

  const [latest] = (await latestRows(transaction, tenantId, change.patientId)).filter((row) => row.purpose === change.purpose);
  if (latest && latest.granted === change.granted) {
    // Older code wrote messaging_consent_at without the ledger; the ledger wins, so the quick lookup is put back in step.
    if (change.purpose === "appointment_messages" && Boolean(patient.messagingConsentAt) !== change.granted) {
      await transaction.update(patients)
        .set({ messagingConsentAt: change.granted ? new Date() : null, updatedAt: new Date() })
        .where(and(eq(patients.tenantId, tenantId), eq(patients.id, change.patientId)));
    }
    return { changed: false };
  }

  const wordingVersion = change.wordingVersion ?? NOTICE_VERSION;
  await transaction.insert(consentRecords).values({
    tenantId,
    patientId: change.patientId,
    purpose: change.purpose,
    granted: change.granted,
    wordingVersion,
    source: change.source,
    actorType: change.actor.type,
    actorUserId: change.actor.userId ?? null,
  });

  const now = new Date();
  if (change.purpose === "appointment_messages") {
    await transaction.update(patients)
      .set({ messagingConsentAt: change.granted ? now : null, updatedAt: now })
      .where(and(eq(patients.tenantId, tenantId), eq(patients.id, change.patientId)));
  }
  if (change.granted && !patient.privacyAcceptedAt) {
    await transaction.update(patients)
      .set({ privacyAcceptedAt: now, updatedAt: now })
      .where(and(eq(patients.tenantId, tenantId), eq(patients.id, change.patientId)));
  }

  await transaction.insert(auditEvents).values({
    tenantId,
    actorUserId: change.actor.userId ?? null,
    actorType: change.actor.type === "staff" ? "staff" : change.actor.type === "system" || change.actor.type === "provider" ? "system" : "patient",
    action: change.granted ? "privacy.consent.granted" : "privacy.consent.withdrawn",
    outcome: "success",
    metadata: { patientId: change.patientId, purpose: change.purpose, source: change.source, wordingVersion },
  });
  return { changed: true };
}

/**
 * How sure a public form is that it found the right customer:
 * - `new`: a record it just made.
 * - `full`: name, email and phone all match (booking, waitlist).
 * - `partial`: phone and first name only (door check-in), so it can't speak for the customer.
 */
export type FormMatch = "new" | "full" | "partial";

/**
 * Applies the "messages about my visits" box from a public form through the consent ledger, never by writing the column.
 * `new` and `full` record the customer's answer either way. `partial` may only fill in a yes for someone who never
 * answered: it can't withdraw, and it can't undo a STOP or an earlier no.
 */
export async function applyFormMessagingConsentIn(
  transaction: KalendrTransaction,
  tenantId: string,
  patientId: string,
  input: { agreed: boolean; match: FormMatch },
): Promise<{ changed: boolean }> {
  if (input.match === "partial") {
    if (!input.agreed) return { changed: false };
    const [latest] = (await latestRows(transaction, tenantId, patientId)).filter((row) => row.purpose === "appointment_messages");
    if (latest) return { changed: false };
  }
  return recordConsentIn(transaction, tenantId, {
    patientId,
    purpose: "appointment_messages",
    granted: input.agreed,
    source: "booking",
    actor: { type: "patient" },
  });
}

export function recordConsent(tenantId: string, change: ConsentChange): Promise<{ changed: boolean }> {
  return withTenant(tenantId, (transaction) => recordConsentIn(transaction, tenantId, change));
}

/**
 * Withdraws one purpose. STOP on WhatsApp or SMS calls this with source "whatsapp_stop" or "sms_stop" and the
 * "provider" actor; the portal switch uses source "portal".
 */
export function withdrawConsent(
  tenantId: string,
  patientId: string,
  purpose: ConsentPurpose,
  options: { source: ConsentSource; actor?: ConsentActorInfo; wordingVersion?: string },
): Promise<{ changed: boolean }> {
  return recordConsent(tenantId, {
    patientId,
    purpose,
    granted: false,
    source: options.source,
    wordingVersion: options.wordingVersion,
    actor: options.actor ?? { type: options.source === "whatsapp_stop" || options.source === "sms_stop" ? "provider" : "patient" },
  });
}

export interface GuardianInput {
  name: string;
  relationship: string;
  /** An email address or phone number. Stored sealed. */
  contact: string;
}

/** Records the parent or guardian who consented for a customer under 18. The contact is sealed with the business's data key. */
export async function setGuardianIn(transaction: KalendrTransaction, tenantId: string, patientId: string, guardian: GuardianInput): Promise<void> {
  await loadRecordKeys(transaction, tenantId, { forWrite: true });
  const sealed = sealSecret(tenantId, "patient.guardian-contact", guardian.contact);
  const now = new Date();
  const updated = await transaction.update(patients)
    .set({
      guardianName: guardian.name,
      guardianRelationship: guardian.relationship,
      guardianContactCiphertext: sealed,
      guardianKeyVersion: secretKeyVersion(sealed),
      guardianConsentedAt: now,
      updatedAt: now,
    })
    .where(and(eq(patients.tenantId, tenantId), eq(patients.id, patientId)))
    .returning({ id: patients.id });
  if (updated.length === 0) throw new ApiError(404, "not_found", "We could not find that person.");
  await transaction.insert(auditEvents).values({
    tenantId,
    actorType: "patient",
    action: "privacy.guardian.recorded",
    outcome: "success",
    metadata: { patientId },
  });
}
