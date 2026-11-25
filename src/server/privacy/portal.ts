import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import { requireDatabase, withTenant } from "@/db/client";
import { auditEvents, dataExports } from "@/db/schema";

import { ApiError } from "../api-error";
import { sha256 } from "../crypto";
import { openBytes } from "../keys/records";
import { type PatientAccount } from "../patient-auth";
import { loadRecordKeys } from "../record-crypto";
import { getFileStore } from "../file-store";
import { currentConsentsIn, recordConsentIn, setGuardianIn, type ConsentState } from "./consent";
import { getPrivacyNoticeIn, NOTICE_VERSION, type PrivacyNoticeText } from "./notice";
import { createDataRequestIn, listPatientRequestsIn, requestInputSchema, type CreateRequestResult, type DataRequestView } from "./requests";
import { consentPurposes, isMinor } from "./rules";

export const portalPrivacyQuerySchema = z.object({ language: z.string().trim().max(10).optional() });

export const portalConsentInputSchema = z.object({
  clinicSlug: z.string().trim().min(1).max(80),
  patientId: z.string().trim().min(1).max(100),
  purpose: z.enum(consentPurposes),
  granted: z.boolean(),
  /** The notice version the customer was looking at when they chose. */
  wordingVersion: z.string().trim().min(1).max(40),
  /** Needed the first time someone chooses for a customer under 18. */
  guardian: z.object({
    name: z.string().trim().min(1).max(120),
    relationship: z.string().trim().min(1).max(40),
    contact: z.string().trim().min(3).max(254),
  }).strict().optional(),
}).strict();
export type PortalConsentInput = z.infer<typeof portalConsentInputSchema>;

export const portalRequestInputSchema = requestInputSchema.extend({
  clinicSlug: z.string().trim().min(1).max(80),
  patientId: z.string().trim().min(1).max(100),
}).strict();
export type PortalRequestInput = z.infer<typeof portalRequestInputSchema>;

export interface PortalPrivacyPerson {
  clinicSlug: string;
  clinicName: string;
  patientId: string;
  name: string;
  isMinor: boolean;
  /** Whether a parent or guardian is on file. Needed before choices can be saved for a customer under 18. */
  guardianOnFile: boolean;
  consents: ConsentState[];
  requests: DataRequestView[];
}

export interface PortalPrivacy {
  noticeVersion: string;
  people: PortalPrivacyPerson[];
  /** The notice for the first business, in the asked language. Each person's own business may differ; see `notices`. */
  notices: Record<string, PrivacyNoticeText>;
}

interface PersonRow extends Record<string, unknown> {
  tenant_id: string;
  clinic_slug: string;
  clinic_name: string;
  patient_id: string;
}

async function portalPeople(account: PatientAccount): Promise<PersonRow[]> {
  return requireDatabase().execute<PersonRow>(sql`select * from kalendr_portal_people(${account.id})`);
}

/** The one customer record this signed-in person may act on, or a 404. Never reveals whether another business has them. */
export async function resolvePortalPerson(account: PatientAccount, clinicSlug: string, patientId: string): Promise<{ tenantId: string; clinicName: string }> {
  const person = (await portalPeople(account)).find((row) => row.clinic_slug === clinicSlug && row.patient_id === patientId);
  if (!person) throw new ApiError(404, "not_found", "We could not find that person.");
  return { tenantId: person.tenant_id, clinicName: person.clinic_name };
}

/** Everything the privacy page shows: each person this account can act for, their choices, their requests, and the notice. */
export async function getPortalPrivacy(account: PatientAccount, language?: string): Promise<PortalPrivacy> {
  const people = await portalPeople(account);
  const result: PortalPrivacy = { noticeVersion: NOTICE_VERSION, people: [], notices: {} };
  for (const person of people) {
    await withTenant(person.tenant_id, async (transaction) => {
      const [patient] = await transaction.execute<{ first_name: string; last_name: string; date_of_birth: string | null; is_dependent: boolean; guardian_name: string | null; erased_at: unknown }>(sql`
        select first_name, last_name, date_of_birth::text as date_of_birth, is_dependent, guardian_name, erased_at
        from patients where tenant_id = ${person.tenant_id} and id = ${person.patient_id}
      `);
      if (!patient || patient.erased_at) return;
      result.people.push({
        clinicSlug: person.clinic_slug,
        clinicName: person.clinic_name,
        patientId: person.patient_id,
        name: `${patient.first_name} ${patient.last_name}`.trim(),
        isMinor: isMinor({ dateOfBirth: patient.date_of_birth, isDependent: patient.is_dependent }),
        guardianOnFile: Boolean(patient.guardian_name),
        consents: await currentConsentsIn(transaction, person.tenant_id, person.patient_id),
        requests: await listPatientRequestsIn(transaction, person.tenant_id, person.patient_id),
      });
      if (!result.notices[person.clinic_slug]) result.notices[person.clinic_slug] = await getPrivacyNoticeIn(transaction, person.tenant_id, language);
    });
  }
  return result;
}

/** One switch, one purpose, one customer. Saying what is already true changes nothing. */
export async function setPortalConsent(account: PatientAccount, input: PortalConsentInput): Promise<{ consents: ConsentState[]; changed: boolean }> {
  const { tenantId } = await resolvePortalPerson(account, input.clinicSlug, input.patientId);
  return withTenant(tenantId, async (transaction) => {
    if (input.guardian) await setGuardianIn(transaction, tenantId, input.patientId, input.guardian);
    const { changed } = await recordConsentIn(transaction, tenantId, {
      patientId: input.patientId,
      purpose: input.purpose,
      granted: input.granted,
      wordingVersion: input.wordingVersion,
      source: "portal",
      actor: { type: input.guardian ? "guardian" : "patient" },
    });
    return { consents: await currentConsentsIn(transaction, tenantId, input.patientId), changed };
  });
}

/** Asks for a download, an erasure or a correction. Asking again while one is open returns the open one. */
export async function createPortalRequest(account: PatientAccount, input: PortalRequestInput): Promise<CreateRequestResult> {
  const { tenantId } = await resolvePortalPerson(account, input.clinicSlug, input.patientId);
  return withTenant(tenantId, (transaction) => createDataRequestIn(transaction, tenantId, input.patientId, { type: input.type, note: input.note }, "portal"));
}

export interface ExportDownload {
  bytes: Buffer;
  filename: string;
}

/**
 * Hands over an export once. The link's token is hashed and found through a narrow lookup; the claim is one UPDATE
 * that needs the export to be unused and unexpired, so two people opening the link at the same moment cannot both
 * get it. A wrong, used or expired link all answer the same way.
 */
export async function consumeExportDownload(token: string): Promise<ExportDownload> {
  const gone = new ApiError(410, "link_expired", "This link has already been used or has expired. Ask for a new download from your privacy page.");
  if (!/^[A-Za-z0-9_-]{32,100}$/.test(token)) throw gone;
  const tokenHash = sha256(token);
  const [found] = await requireDatabase().execute<{ tenant_id: string; export_id: string }>(sql`select tenant_id, export_id from kalendr_resolve_data_export(${tokenHash})`);
  if (!found) throw gone;
  return withTenant(found.tenant_id, async (transaction) => {
    const [claimed] = await transaction.update(dataExports)
      .set({ usedAt: new Date() })
      .where(and(eq(dataExports.tenantId, found.tenant_id), eq(dataExports.id, found.export_id), isNull(dataExports.usedAt), gt(dataExports.expiresAt, new Date())))
      .returning({ storageKey: dataExports.storageKey, tokenHash: dataExports.tokenHash });
    if (!claimed || !constantTimeEqual(claimed.tokenHash, tokenHash)) throw gone;
    await loadRecordKeys(transaction, found.tenant_id);
    const bytes = openBytes(found.tenant_id, await getFileStore().get(claimed.storageKey));
    await transaction.insert(auditEvents).values({
      tenantId: found.tenant_id,
      actorType: "patient",
      action: "privacy.export.downloaded",
      outcome: "success",
      metadata: { exportId: found.export_id },
    });
    return { bytes, filename: "my-data.zip" };
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}
