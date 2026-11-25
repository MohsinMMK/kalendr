/**
 * Carries out an approved erasure inside one business's transaction (the worker passes it). A customer row is never
 * deleted: bookings, payments and records point at it, so it is anonymised in place. What is removed, and what the
 * business must keep, is written down in plain words on the request for the customer to read.
 *
 * Kept on purpose: payments and refunds (never edited, kept for the business's billing period), visit records inside
 * the business's record period, consent history (ids only), and the audit log. The audit log is never deleted from:
 * personal details inside old rows are replaced through kalendr_scrub_audit_personal().
 *
 * No "server-only" import: the worker uses this file.
 */
import type postgres from "postgres";

import { normalizeContact } from "../../lib/patient-contact";
import { buildErasureSummary, effectiveRetention, type ErasureSummary, type RetentionKind } from "./rules";

type TenantDb = postgres.TransactionSql;

export interface ErasureResult {
  summary: ErasureSummary;
  /** Where to send the plain-language notice. Read before the details were cleared; null when the customer had no email. */
  recipient: { email: string; name: string } | null;
  patientId: string;
  /** False when the request had already been carried out. */
  performed: boolean;
}

interface RequestRow {
  patient_id: string;
  status: string;
  type: string;
}

const none = [""];

export async function eraseCustomer(tenantDb: TenantDb, tenantId: string, requestId: string, now: Date): Promise<ErasureResult> {
  const [request] = await tenantDb<RequestRow[]>`
    select patient_id, status, type from data_requests where tenant_id = ${tenantId} and id = ${requestId} for update
  `;
  if (!request || request.type !== "erasure") throw new Error("erasure_request_missing");
  const patientId = request.patient_id;
  if (request.status === "completed") {
    return { summary: { removed: [], kept: [] }, recipient: null, patientId, performed: false };
  }
  if (request.status !== "approved" && request.status !== "processing") throw new Error("erasure_not_approved");
  await tenantDb`update data_requests set status = 'processing', updated_at = now() where tenant_id = ${tenantId} and id = ${requestId}`;

  const [patient] = await tenantDb<{ first_name: string; last_name: string; phone: string; email: string; erased_at: Date | null }[]>`
    select first_name, last_name, phone, email, erased_at from patients where tenant_id = ${tenantId} and id = ${patientId} for update
  `;
  if (!patient) throw new Error("erasure_customer_missing");
  const fullName = `${patient.first_name} ${patient.last_name}`.trim();
  const needles = [fullName, patient.phone.trim(), patient.email.trim()].filter((value) => value.length >= 6);
  const email = patient.email.trim();
  const recipient = patient.erased_at || !normalizeContact("email", email) ? null : { email, name: patient.first_name };

  const [tenant] = await tenantDb<{ business_type: string }[]>`select business_type from tenants where id = ${tenantId}`;
  const stored = await tenantDb<{ data_kind: RetentionKind; keep_days: number; action: "delete" | "anonymise" }[]>`
    select data_kind, keep_days, action from retention_policies where tenant_id = ${tenantId}
  `;
  const policy = effectiveRetention(tenant?.business_type ?? "healthcare", stored.map((row) => ({ dataKind: row.data_kind, keepDays: row.keep_days, action: row.action })));

  const appointments = await tenantDb<{ id: string }[]>`select id from appointments where tenant_id = ${tenantId} and patient_id = ${patientId}`;
  const appointmentIds = appointments.length > 0 ? appointments.map((row) => row.id) : none;

  // The sign-in account for this contact goes too, but only when it opens nothing else: no other person here or at another business.
  const contactAccounts = await tenantDb<{ id: string }[]>`
    select id from patient_accounts
    where (contact_kind = 'email' and contact_value = ${normalizeContact("email", patient.email) ?? ""})
      or (contact_kind = 'phone' and contact_value = ${normalizeContact("phone", patient.phone) ?? ""})
  `;
  const accountsToRemove: string[] = [];
  for (const account of contactAccounts) {
    const people = await tenantDb<{ tenant_id: string; patient_id: string }[]>`select tenant_id, patient_id from kalendr_portal_people(${account.id})`;
    if (people.every((person) => person.tenant_id === tenantId && person.patient_id === patientId)) accountsToRemove.push(account.id);
  }

  const bookingDetails = await tenantDb`
    update appointments set notes = null, reason_for_visit = null, custom_fields = '{}'::jsonb, manage_token_ciphertext = null,
      manage_token_hash = replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), updated_at = now()
    where tenant_id = ${tenantId} and patient_id = ${patientId}
      and (notes is not null or reason_for_visit is not null or custom_fields <> '{}'::jsonb or manage_token_ciphertext is not null)
    returning id
  `;
  // Links retired by a move still show the booking's new time, so the erased customer's old links go too.
  await tenantDb`delete from retired_manage_tokens where tenant_id = ${tenantId} and patient_id = ${patientId}`;
  // No reminders or other messages to the erased address for bookings still ahead. The bookings themselves stay on the calendar.
  await tenantDb`
    update appointments set reminder_status = 'not_scheduled', updated_at = now()
    where tenant_id = ${tenantId} and patient_id = ${patientId} and reminder_status <> 'not_scheduled'
  `;
  await tenantDb`
    delete from outbox_events
    where tenant_id = ${tenantId} and aggregate_type = 'appointment' and aggregate_id in ${tenantDb(appointmentIds)} and status in ('pending', 'failed')
  `;
  const formAnswers = await tenantDb`
    update forms set response_ciphertext = null, updated_at = now()
    where tenant_id = ${tenantId} and patient_id = ${patientId} and response_ciphertext is not null returning id
  `;
  // Routing form answers (feature 46) are sealed answers about the customer too. The trace holds only the owner's rule text, so it stays.
  await tenantDb`
    update routing_responses set answers_ciphertext = null, patient_id = null
    where tenant_id = ${tenantId} and patient_id = ${patientId}
  `;
  const messageLog = await tenantDb`
    delete from notifications where tenant_id = ${tenantId} and appointment_id in ${tenantDb(appointmentIds)} returning id
  `;
  const reviews = await tenantDb`
    update reviews set display_name = 'Anonymous', comment = null, updated_at = now()
    where tenant_id = ${tenantId} and appointment_id in ${tenantDb(appointmentIds)} and (display_name <> 'Anonymous' or comment is not null)
    returning id
  `;
  await tenantDb`delete from waitlist_entries where tenant_id = ${tenantId} and patient_id = ${patientId}`;
  // Chats with the booking assistant tied to this customer (feature 30), and the turns inside them.
  await tenantDb`delete from assistant_conversations where tenant_id = ${tenantId} and patient_id = ${patientId}`;
  // Places in classes (feature 18): no seat is kept for an erased customer and nothing more is sent to them.
  await tenantDb`
    delete from outbox_events
    where tenant_id = ${tenantId} and aggregate_type = 'class_enrolment' and status in ('pending', 'failed')
      and aggregate_id in (select id from class_enrolments where tenant_id = ${tenantId} and patient_id = ${patientId})
  `;
  await tenantDb`
    update class_enrolments set status = 'cancelled', cancelled_at = coalesce(cancelled_at, now()), cancelled_by = coalesce(cancelled_by, 'business'),
      offer_expires_at = null, version = version + 1, updated_at = now()
    where tenant_id = ${tenantId} and patient_id = ${patientId} and status in ('booked', 'waitlisted')
  `;
  // Attendance already recorded stays as it was; only the private link that could reach the person is removed.
  await tenantDb`update class_enrolments set token_sealed = null where tenant_id = ${tenantId} and patient_id = ${patientId} and token_sealed is not null`;
  await tenantDb`delete from recalls where tenant_id = ${tenantId} and patient_id = ${patientId}`;
  // Customer profiles (feature 27): internal notes, tags and extra details go; a merge's saved contact details go with them.
  await tenantDb`delete from customer_notes where tenant_id = ${tenantId} and patient_id = ${patientId}`;
  await tenantDb`delete from customer_tag_links where tenant_id = ${tenantId} and patient_id = ${patientId}`;
  // A merge copies answers to the kept profile and leaves the merged-away row's own, so those go too.
  await tenantDb`
    delete from customer_field_values
    where tenant_id = ${tenantId} and (patient_id = ${patientId} or patient_id in (select id from patients where tenant_id = ${tenantId} and merged_into_id = ${patientId}))
  `;
  await tenantDb`
    update customer_merges set snapshot_ciphertext = null
    where tenant_id = ${tenantId} and (kept_patient_id = ${patientId} or merged_patient_id = ${patientId})
  `;
  await tenantDb`
    update patients set first_name = 'Erased', last_name = 'customer', date_of_birth = null, accessibility_need = null, block_reason = null, updated_at = now()
    where tenant_id = ${tenantId} and merged_into_id = ${patientId}
  `;
  await tenantDb`
    update outbox_events set payload = '{}'::jsonb, updated_at = now()
    where tenant_id = ${tenantId} and aggregate_id in ${tenantDb(appointmentIds)} and status in ('delivered', 'dead_letter')
  `;

  // Saved answers to repeated requests can hold the customer's name (for example a staff screen's reply). They only exist to catch double clicks.
  for (const needle of needles) {
    await tenantDb`delete from idempotency_keys where tenant_id = ${tenantId} and position(${needle} in coalesce(response_body::text, '')) > 0`;
  }

  // Visit records: kept while the business's record period runs, removed once it has passed.
  const keepRecordsDays = policy.medical_records.keepDays;
  const expired = await tenantDb<{ id: string }[]>`
    select id from visit_records
    where tenant_id = ${tenantId} and patient_id = ${patientId} and created_at < now() - ${keepRecordsDays} * interval '1 day'
  `;
  let removedRecords = 0;
  if (expired.length > 0) {
    const ids = expired.map((row) => row.id);
    const files = await tenantDb<{ storage_key: string }[]>`
      select storage_key from visit_record_files where tenant_id = ${tenantId} and record_id in ${tenantDb(ids)}
    `;
    for (const file of files) await queueRemoval(tenantDb, tenantId, file.storage_key);
    await tenantDb`delete from visit_records where tenant_id = ${tenantId} and id in ${tenantDb(ids)}`;
    removedRecords = ids.length;
  }
  const [keptRecordCount] = await tenantDb<{ count: number }[]>`
    select count(*)::int as count from visit_records where tenant_id = ${tenantId} and patient_id = ${patientId}
  `;
  const [keptPaymentCount] = await tenantDb<{ count: number }[]>`
    select count(*)::int as count from payments where tenant_id = ${tenantId} and appointment_id in ${tenantDb(appointmentIds)}
  `;

  // Earlier exports hold the customer's data in a file: remove the file with the row.
  const exports = await tenantDb<{ id: string; storage_key: string }[]>`
    select export.id, export.storage_key from data_exports as export
    join data_requests as earlier on earlier.tenant_id = export.tenant_id and earlier.id = export.request_id
    where export.tenant_id = ${tenantId} and earlier.patient_id = ${patientId}
  `;
  for (const file of exports) {
    await queueRemoval(tenantDb, tenantId, file.storage_key);
    await tenantDb`delete from data_exports where tenant_id = ${tenantId} and id = ${file.id}`;
  }
  await tenantDb`update data_requests set note = null, decision_note = null where tenant_id = ${tenantId} and patient_id = ${patientId}`;
  await tenantDb`delete from patient_record_access where tenant_id = ${tenantId} and patient_id = ${patientId}`;
  const [guardianBefore] = await tenantDb<{ had: boolean }[]>`
    select (guardian_name is not null) as had from patients where tenant_id = ${tenantId} and id = ${patientId}
  `;
  await tenantDb`
    update patients set first_name = 'Erased', last_name = 'customer', phone = 'erased',
      email = ${`erased-${patientId}@erased.invalid`}, date_of_birth = null, accessibility_need = null,
      guardian_name = null, guardian_relationship = null, guardian_contact_ciphertext = null, guardian_key_version = 0,
      guardian_consented_at = null, privacy_accepted_at = null, messaging_consent_at = null, block_reason = null,
      erased_at = ${now}, updated_at = now()
    where tenant_id = ${tenantId} and id = ${patientId}
  `;
  for (const accountId of accountsToRemove) await tenantDb`delete from patient_accounts where id = ${accountId}`;

  await tenantDb`select kalendr_scrub_audit_personal(${requestId}, ${needles})`;

  const summary = buildErasureSummary({
    removedBookingDetails: bookingDetails.length,
    removedFormAnswers: formAnswers.length,
    removedMessageLog: messageLog.length,
    removedReviewNames: reviews.length,
    removedRecords,
    removedGuardian: Boolean(guardianBefore?.had),
    keptPayments: keptPaymentCount?.count ?? 0,
    keptRecords: keptRecordCount?.count ?? 0,
    billingKeepDays: policy.billing_records.keepDays,
    recordsKeepDays: policy.medical_records.keepDays,
  });
  await tenantDb`
    update data_requests set status = 'completed', completed_at = ${now}, result_summary = ${tenantDb.json({ removed: summary.removed, kept: summary.kept })},
      version = version + 1, updated_at = now()
    where tenant_id = ${tenantId} and id = ${requestId}
  `;
  // Counts and ids only. The names that were removed are not repeated here.
  await tenantDb`
    insert into audit_events (tenant_id, actor_type, action, outcome, metadata)
    values (${tenantId}, 'system', 'privacy.erasure.completed', 'success', ${tenantDb.json({
      requestId,
      patientId,
      bookings: bookingDetails.length,
      forms: formAnswers.length,
      messages: messageLog.length,
      reviews: reviews.length,
      records: removedRecords,
      keptPayments: keptPaymentCount?.count ?? 0,
      keptRecords: keptRecordCount?.count ?? 0,
      accountsRemoved: accountsToRemove.length,
    })})
  `;
  return { summary, recipient, patientId, performed: true };
}

/** Queues the stored object for removal once this transaction commits. */
async function queueRemoval(tenantDb: TenantDb, tenantId: string, key: string): Promise<void> {
  await tenantDb`
    insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
    values (${tenantId}, 'file', ${key}, 'file.remove', ${tenantDb.json({ key })}, ${`file.remove:${key}`.slice(0, 200)})
    on conflict (tenant_id, dedupe_key) do nothing
  `;
}
