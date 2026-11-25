/**
 * The consent gate for code that runs in the worker (campaigns, message handlers), where a business's
 * transaction is a postgres.js `TransactionSql` that has already set app.tenant_id. The web app uses the same
 * answers through consent.ts. Both call the rules in rules.ts, so they cannot disagree.
 *
 * No "server-only" import: the worker uses this file.
 */
import type postgres from "postgres";

import { consentPurposes, evaluateConsent, marketingAllowed, type ConsentPurpose } from "./rules";

type TenantDb = postgres.TransactionSql;

interface LatestRow {
  purpose: ConsentPurpose;
  granted: boolean;
}

async function latestAnswers(tenantDb: TenantDb, tenantId: string, patientId: string): Promise<Map<ConsentPurpose, boolean>> {
  const rows = await tenantDb<LatestRow[]>`
    select distinct on (purpose) purpose, granted from consent_records
    where tenant_id = ${tenantId} and patient_id = ${patientId}
    order by purpose, created_at desc, id desc
  `;
  return new Map(rows.map((row) => [row.purpose, row.granted]));
}

/** Whether this customer has agreed to (or not withdrawn) one purpose. A customer who does not exist is a no. */
export async function hasConsentTenantDb(tenantDb: TenantDb, tenantId: string, patientId: string, purpose: ConsentPurpose): Promise<boolean> {
  const [patient] = await tenantDb<{ erased_at: Date | null }[]>`
    select erased_at from patients where tenant_id = ${tenantId} and id = ${patientId}
  `;
  if (!patient || patient.erased_at) return false;
  const answers = await latestAnswers(tenantDb, tenantId, patientId);
  return evaluateConsent(purpose, answers.get(purpose));
}

/**
 * The one question every campaign asks before it sends marketing to a customer. False when they have not said yes,
 * have withdrawn, are under 18 or a dependant, or have been erased. Reminders and booking messages never call this.
 */
export async function canSendMarketingTenantDb(tenantDb: TenantDb, tenantId: string, patientId: string, now: Date = new Date()): Promise<boolean> {
  const [patient] = await tenantDb<{ date_of_birth: string | null; is_dependent: boolean; erased_at: Date | null }[]>`
    select date_of_birth::text as date_of_birth, is_dependent, erased_at from patients
    where tenant_id = ${tenantId} and id = ${patientId}
  `;
  if (!patient) return false;
  const answers = await latestAnswers(tenantDb, tenantId, patientId);
  return marketingAllowed({
    latestMarketingGranted: answers.get("marketing_messages"),
    dateOfBirth: patient.date_of_birth,
    isDependent: patient.is_dependent,
    erased: patient.erased_at !== null,
  }, now);
}

/** Every purpose's current answer, for the export and the worker's own checks. */
export async function currentAnswersTenantDb(tenantDb: TenantDb, tenantId: string, patientId: string): Promise<Record<ConsentPurpose, boolean>> {
  const answers = await latestAnswers(tenantDb, tenantId, patientId);
  return Object.fromEntries(consentPurposes.map((purpose) => [purpose, evaluateConsent(purpose, answers.get(purpose))])) as Record<ConsentPurpose, boolean>;
}
