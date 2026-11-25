import { applyMapping } from "./map";
import { outcome, databaseFailureCode, type CheckState, type CommitResult, type CommitRow, type ImportContext, type KindImporter, type UndoRow } from "./kinds";
import type { RowOutcome, TenantDb } from "./job-db";
import { normaliseCustomer, type CustomerValue, type Normalised } from "./validate";

/**
 * Customers. A row is a duplicate when its phone (compared the way kalendr_normalize_phone() reads stored numbers) or its
 * email matches another row earlier in the file, or a customer the business already has. The first row in the file wins.
 */

interface ExistingCustomer {
  id: string;
  phone_key: string;
  email_key: string;
  last_name: string;
  email: string;
  date_of_birth: string | null;
  accessibility_need: string | null;
}

const normaliseRow = (context: ImportContext, rowNumber: number): Normalised<CustomerValue> =>
  normaliseCustomer(applyMapping(context.file.rows[rowNumber - 1] ?? [], context.mapping, "customers"), context.settings);

async function findExisting(tenantDb: TenantDb, tenantId: string, phones: string[], emails: string[]): Promise<{ byPhone: Map<string, ExistingCustomer>; byEmail: Map<string, ExistingCustomer> }> {
  const byPhone = new Map<string, ExistingCustomer>();
  const byEmail = new Map<string, ExistingCustomer>();
  if (phones.length === 0 && emails.length === 0) return { byPhone, byEmail };
  // An erased customer's contact details are gone, so it can never match. A blank email never matches anything.
  const rows = await tenantDb<ExistingCustomer[]>`
    select id, kalendr_normalize_phone(phone) as phone_key, lower(trim(email)) as email_key, last_name, email,
      date_of_birth::text as date_of_birth, accessibility_need
    from patients
    where tenant_id = ${tenantId} and erased_at is null
      and (kalendr_normalize_phone(phone) = any(${phones}::text[])
        or (email <> '' and lower(trim(email)) = any(${emails}::text[])))
    order by created_at, id`;
  for (const row of rows) {
    if (!byPhone.has(row.phone_key)) byPhone.set(row.phone_key, row);
    if (row.email_key && !byEmail.has(row.email_key)) byEmail.set(row.email_key, row);
  }
  return { byPhone, byEmail };
}

const matchExisting = (value: CustomerValue, found: Awaited<ReturnType<typeof findExisting>>): ExistingCustomer | undefined =>
  found.byPhone.get(value.phoneKey) ?? (value.emailKey ? found.byEmail.get(value.emailKey) : undefined);

/** Fill-in-the-blanks never overwrites: it only sets a field the customer has nothing in. */
function blanksToFill(existing: ExistingCustomer, value: CustomerValue) {
  return {
    lastName: existing.last_name === "" && value.lastName ? value.lastName : null,
    email: existing.email === "" && value.email ? value.email : null,
    dateOfBirth: !existing.date_of_birth && value.dateOfBirth ? value.dateOfBirth : null,
    accessibilityNeed: !existing.accessibility_need && value.accessibilityNeed ? value.accessibilityNeed : null,
  };
}

const hasAnyBlank = (fill: ReturnType<typeof blanksToFill>) => Object.values(fill).some((entry) => entry !== null);

async function check(context: ImportContext, start: number, end: number, state: CheckState): Promise<RowOutcome[]> {
  const normalised: Array<{ rowNumber: number; result: Normalised<CustomerValue> }> = [];
  for (let rowNumber = start + 1; rowNumber <= end; rowNumber += 1) normalised.push({ rowNumber, result: normaliseRow(context, rowNumber) });
  const valid = normalised.flatMap((entry) => (entry.result.ok ? [entry.result.value] : []));
  const found = await findExisting(
    context.tenantDb, context.tenantId,
    [...new Set(valid.map((value) => value.phoneKey))],
    [...new Set(valid.map((value) => value.emailKey).filter(Boolean))],
  );
  const outcomes: RowOutcome[] = [];
  for (const { rowNumber, result } of normalised) {
    if (!result.ok) {
      outcomes.push(outcome(rowNumber, "error", result.issue.code, result.issue.field));
      continue;
    }
    const value = result.value;
    const samePhone = state.phones.has(value.phoneKey);
    const sameEmail = value.emailKey !== "" && state.emails.has(value.emailKey);
    state.phones.add(value.phoneKey);
    if (value.emailKey) state.emails.add(value.emailKey);
    if (samePhone || sameEmail) {
      outcomes.push(outcome(rowNumber, "will_skip", "duplicate_in_file", samePhone ? "phone" : "email"));
      continue;
    }
    const existing = matchExisting(value, found);
    if (!existing) {
      outcomes.push(outcome(rowNumber, "ready"));
    } else if (context.options.duplicateRule === "fill_blanks" && hasAnyBlank(blanksToFill(existing, value))) {
      outcomes.push(outcome(rowNumber, "will_update", null, null, existing.id));
    } else {
      outcomes.push(outcome(rowNumber, "will_skip", "duplicate_existing", found.byPhone.has(value.phoneKey) ? "phone" : "email", existing.id));
    }
  }
  return outcomes;
}

async function commit(context: ImportContext, rows: readonly CommitRow[]): Promise<CommitResult[]> {
  const { tenantDb, tenantId } = context;
  const parsed = rows.map((row) => ({ row, result: normaliseRow(context, row.rowNumber) }));
  const found = await findExisting(
    tenantDb, tenantId,
    parsed.flatMap((entry) => (entry.result.ok && entry.row.status === "ready" ? [entry.result.value.phoneKey] : [])),
    parsed.flatMap((entry) => (entry.result.ok && entry.row.status === "ready" && entry.result.value.emailKey ? [entry.result.value.emailKey] : [])),
  );
  const results: CommitResult[] = [];
  for (const { row, result } of parsed) {
    const done = (status: CommitResult["status"], code: CommitResult["code"] = null, field: string | null = null, entityId: string | null = null) =>
      results.push({ rowNumber: row.rowNumber, status, code, field, entityId });
    // The file may have changed meaning since the check (a date format picked again): trust only a row that still passes.
    if (!result.ok) {
      done("failed", result.issue.code, result.issue.field);
      continue;
    }
    const value = result.value;
    try {
      if (row.status === "will_update") {
        const filled = await tenantDb.savepoint(async (savepoint) => {
          const [current] = row.entityId ? await savepoint<ExistingCustomer[]>`
            select id, kalendr_normalize_phone(phone) as phone_key, lower(trim(email)) as email_key, last_name, email,
              date_of_birth::text as date_of_birth, accessibility_need
            from patients where tenant_id = ${tenantId} and id = ${row.entityId} for update` : [];
          if (!current) return null;
          const fill = blanksToFill(current, value);
          if (!hasAnyBlank(fill)) return false;
          await savepoint`
            update patients set
              last_name = coalesce(${fill.lastName}, last_name), email = coalesce(${fill.email}, email),
              date_of_birth = coalesce(${fill.dateOfBirth}::date, date_of_birth),
              accessibility_need = coalesce(${fill.accessibilityNeed}, accessibility_need), updated_at = now()
            where tenant_id = ${tenantId} and id = ${current.id}`;
          return true;
        });
        if (filled === null) done("failed", "row_failed", null, row.entityId);
        else done(filled ? "updated" : "skipped", filled ? null : "duplicate_existing", null, row.entityId);
        continue;
      }
      const existing = matchExisting(value, found);
      if (existing) {
        // Someone added this customer after the check. Never make a second copy.
        done("skipped", "duplicate_existing", "phone", existing.id);
        continue;
      }
      const id = await tenantDb.savepoint(async (savepoint) => {
        // Consent is only recorded when the column was mapped and the owner ticked the box saying they hold it.
        const consented = value.messagingConsent && context.options.consentConfirmed;
        const [created] = await savepoint<{ id: string }[]>`
          insert into patients (tenant_id, first_name, last_name, phone, email, date_of_birth, preferred_channel,
            accessibility_need, is_dependent, messaging_consent_at)
          values (${tenantId}, ${value.firstName}, ${value.lastName}, ${value.phone}, ${value.email}, ${value.dateOfBirth ?? null},
            ${value.preferredChannel}, ${value.accessibilityNeed ?? null}, false, case when ${consented}::boolean then now() else null end)
          returning id`;
        if (!created) throw new Error("no row");
        await savepoint`
          insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
          values (${tenantId}, 'customer', ${created.id}, 'customer.created', ${savepoint.json({ customerId: created.id })}, ${`customer.created:${created.id}`})
          on conflict (tenant_id, dedupe_key) do nothing`;
        return created.id;
      });
      done("created", null, null, id);
      found.byPhone.set(value.phoneKey, { id, phone_key: value.phoneKey, email_key: value.emailKey, last_name: value.lastName, email: value.email, date_of_birth: null, accessibility_need: null });
    } catch (error) {
      done("failed", databaseFailureCode(error));
    }
  }
  return results;
}

/** Tables whose rows point at a customer: if any does, the customer has been used and stays. */
const usedSince = (tenantDb: TenantDb, tenantId: string, customerId: string) => tenantDb<{ used: boolean }[]>`
  select (
    exists (select 1 from appointments where tenant_id = ${tenantId} and patient_id = ${customerId})
    or exists (select 1 from waitlist_entries where tenant_id = ${tenantId} and patient_id = ${customerId})
    or exists (select 1 from recalls where tenant_id = ${tenantId} and patient_id = ${customerId})
    or exists (select 1 from forms where tenant_id = ${tenantId} and patient_id = ${customerId})
    or exists (select 1 from message_threads where tenant_id = ${tenantId} and patient_id = ${customerId})
    or exists (select 1 from visit_records where tenant_id = ${tenantId} and patient_id = ${customerId})
    or exists (select 1 from patient_record_access where tenant_id = ${tenantId} and patient_id = ${customerId})
    or exists (select 1 from consent_records where tenant_id = ${tenantId} and patient_id = ${customerId})
    or exists (select 1 from data_requests where tenant_id = ${tenantId} and patient_id = ${customerId})
    or exists (select 1 from push_subscriptions where tenant_id = ${tenantId} and patient_id = ${customerId})
  ) as used`;

async function undo(context: ImportContext, rows: readonly UndoRow[]): Promise<Array<{ rowNumber: number; outcome: "removed" | "kept" }>> {
  const { tenantDb, tenantId } = context;
  const results: Array<{ rowNumber: number; outcome: "removed" | "kept" }> = [];
  for (const row of rows) {
    let removed = false;
    try {
      removed = await tenantDb.savepoint(async (savepoint) => {
        const [current] = await savepoint<{ updated_at: Date }[]>`
          select updated_at from patients where tenant_id = ${tenantId} and id = ${row.entityId} for update`;
        if (!current) return true;
        if (current.updated_at.getTime() > row.at.getTime()) return false;
        const [usage] = await usedSince(savepoint, tenantId, row.entityId);
        if (usage?.used) return false;
        await savepoint`delete from patients where tenant_id = ${tenantId} and id = ${row.entityId}`;
        return true;
      });
    } catch {
      // A reference the list above does not know about: the database refuses the delete, so the customer is kept.
      removed = false;
    }
    results.push({ rowNumber: row.rowNumber, outcome: removed ? "removed" : "kept" });
  }
  return results;
}

export const customerImporter: KindImporter = { check, commit, undo };
