import { applyMapping } from "./map";
import { outcome, databaseFailureCode, type CheckState, type CommitResult, type CommitRow, type ImportContext, type KindImporter, type UndoRow } from "./kinds";
import type { RowOutcome, TenantDb } from "./job-db";
import { normaliseService, type Normalised, type ServiceValue } from "./validate";

/**
 * Services. Created the way the settings screen creates one: offered at every location, given to every active staff
 * member, in-person, with the usual length as its one duration. A service already named the same is a duplicate.
 */

interface ExistingService {
  id: string;
  name_key: string;
  category: string | null;
  price_label: string | null;
  /** Fields the service's template owns (feature 48); an import never fills those. */
  locked: string[] | null;
}

const normaliseRow = (context: ImportContext, rowNumber: number): Normalised<ServiceValue> =>
  normaliseService(applyMapping(context.file.rows[rowNumber - 1] ?? [], context.mapping, "services"));

async function findExisting(tenantDb: TenantDb, tenantId: string, keys: string[]): Promise<Map<string, ExistingService>> {
  const found = new Map<string, ExistingService>();
  if (keys.length === 0) return found;
  const rows = await tenantDb<ExistingService[]>`
    select id, lower(regexp_replace(trim(name), '[[:space:]]+', ' ', 'g')) as name_key, category, price_label
    from services
    where tenant_id = ${tenantId} and lower(regexp_replace(trim(name), '[[:space:]]+', ' ', 'g')) = any(${keys}::text[])
    order by created_at, id`;
  for (const row of rows) if (!found.has(row.name_key)) found.set(row.name_key, row);
  return found;
}

const blanks = (existing: ExistingService, value: ServiceValue) => ({
  category: !existing.category && value.category ? value.category : null,
  price: !existing.price_label && value.priceLabel ? { label: value.priceLabel, minor: value.priceMinor } : null,
});

async function check(context: ImportContext, start: number, end: number, state: CheckState): Promise<RowOutcome[]> {
  const rows: Array<{ rowNumber: number; result: Normalised<ServiceValue> }> = [];
  for (let rowNumber = start + 1; rowNumber <= end; rowNumber += 1) rows.push({ rowNumber, result: normaliseRow(context, rowNumber) });
  const existing = await findExisting(context.tenantDb, context.tenantId, rows.flatMap((row) => (row.result.ok ? [row.result.value.nameKey] : [])));
  const outcomes: RowOutcome[] = [];
  for (const { rowNumber, result } of rows) {
    if (!result.ok) {
      outcomes.push(outcome(rowNumber, "error", result.issue.code, result.issue.field));
      continue;
    }
    const value = result.value;
    if (state.names.has(value.nameKey)) {
      outcomes.push(outcome(rowNumber, "will_skip", "duplicate_in_file", "name"));
      continue;
    }
    state.names.add(value.nameKey);
    const match = existing.get(value.nameKey);
    if (!match) outcomes.push(outcome(rowNumber, "ready"));
    else if (context.options.duplicateRule === "fill_blanks" && (blanks(match, value).category || blanks(match, value).price)) outcomes.push(outcome(rowNumber, "will_update", null, null, match.id));
    else outcomes.push(outcome(rowNumber, "will_skip", "duplicate_existing", "name", match.id));
  }
  return outcomes;
}

async function commit(context: ImportContext, rows: readonly CommitRow[]): Promise<CommitResult[]> {
  const { tenantDb, tenantId } = context;
  const locations = await tenantDb<{ id: string }[]>`select id from locations where tenant_id = ${tenantId} order by created_at, id`;
  const staff = await tenantDb<{ id: string }[]>`select id from practitioners where tenant_id = ${tenantId} and is_active order by created_at, id`;
  const parsed = rows.map((row) => ({ row, result: normaliseRow(context, row.rowNumber) }));
  const existing = await findExisting(tenantDb, tenantId, parsed.flatMap((entry) => (entry.result.ok && entry.row.status === "ready" ? [entry.result.value.nameKey] : [])));
  const results: CommitResult[] = [];
  for (const { row, result } of parsed) {
    const done = (status: CommitResult["status"], code: CommitResult["code"] = null, field: string | null = null, entityId: string | null = null) =>
      results.push({ rowNumber: row.rowNumber, status, code, field, entityId });
    if (!result.ok) {
      done("failed", result.issue.code, result.issue.field);
      continue;
    }
    const value = result.value;
    try {
      if (row.status === "will_update") {
        const filled = await tenantDb.savepoint(async (savepoint) => {
          const [current] = row.entityId ? await savepoint<ExistingService[]>`
            select id, lower(trim(name)) as name_key, category, price_label,
              (select template.locked_fields from service_templates as template where template.tenant_id = services.tenant_id and template.id = services.template_id) as locked
            from services
            where tenant_id = ${tenantId} and id = ${row.entityId} for update` : [];
          if (!current) return null;
          const found = blanks(current, value);
          const locked = current.locked ?? [];
          const fill = { category: locked.includes("category") ? null : found.category, price: locked.includes("prices") || locked.includes("lengths") ? null : found.price };
          if (!fill.category && !fill.price) return false;
          await savepoint`
            update services set category = coalesce(${fill.category}, category),
              price_label = case when ${fill.price !== null} then ${fill.price?.label ?? null} else price_label end,
              price_minor = case when ${fill.price !== null} then ${fill.price?.minor ?? null}::int else price_minor end,
              version = version + 1, updated_at = now()
            where tenant_id = ${tenantId} and id = ${current.id}`;
          return true;
        });
        if (filled === null) done("failed", "row_failed", null, row.entityId);
        else done(filled ? "updated" : "skipped", filled ? null : "duplicate_existing", null, row.entityId);
        continue;
      }
      const match = existing.get(value.nameKey);
      if (match) {
        done("skipped", "duplicate_existing", "name", match.id);
        continue;
      }
      if (locations.length === 0) {
        done("failed", "no_location");
        continue;
      }
      const id = await tenantDb.savepoint(async (savepoint) => {
        // The slug column is filled by its trigger when it arrives empty, the way older code paths rely on.
        const [created] = await savepoint<{ id: string }[]>`
          insert into services (tenant_id, slug, name, description, duration_minutes, booking_mode, patient_types, price_label, price_minor, category)
          values (${tenantId}, '', ${value.name}, ${value.description}, ${value.durationMinutes}, ${value.bookingMode},
            ${["new", "returning"]}, ${value.priceLabel}, ${value.priceMinor}, ${value.category})
          returning id`;
        if (!created) throw new Error("no row");
        await savepoint`
          insert into service_durations (tenant_id, service_id, minutes, price_minor, is_default, sort_order)
          values (${tenantId}, ${created.id}, ${value.durationMinutes}, ${value.priceMinor}, true, 0)`;
        for (const [index, location] of locations.entries()) {
          await savepoint`
            insert into service_location_options (tenant_id, service_id, kind, location_id, sort_order)
            values (${tenantId}, ${created.id}, 'in_person', ${location.id}, ${index})`;
          await savepoint`insert into service_locations (tenant_id, service_id, location_id) values (${tenantId}, ${created.id}, ${location.id})`;
        }
        for (const person of staff) {
          await savepoint`insert into practitioner_services (tenant_id, practitioner_id, service_id) values (${tenantId}, ${person.id}, ${created.id})`;
        }
        return created.id;
      });
      done("created", null, null, id);
    } catch (error) {
      done("failed", databaseFailureCode(error));
    }
  }
  return results;
}

async function undo(context: ImportContext, rows: readonly UndoRow[]): Promise<Array<{ rowNumber: number; outcome: "removed" | "kept" }>> {
  const { tenantDb, tenantId } = context;
  const results: Array<{ rowNumber: number; outcome: "removed" | "kept" }> = [];
  for (const row of rows) {
    let removed = false;
    try {
      removed = await tenantDb.savepoint(async (savepoint) => {
        const [current] = await savepoint<{ version: number; updated_at: Date }[]>`
          select version, updated_at from services where tenant_id = ${tenantId} and id = ${row.entityId} for update`;
        if (!current) return true;
        // Edited since (the version counts every edit), or booked since: leave it.
        if (current.version !== 1 || current.updated_at.getTime() > row.at.getTime()) return false;
        const [used] = await savepoint<{ used: boolean }[]>`
          select (exists (select 1 from appointments where tenant_id = ${tenantId} and service_id = ${row.entityId})
            or exists (select 1 from waitlist_entries where tenant_id = ${tenantId} and service_id = ${row.entityId})) as used`;
        if (used?.used) return false;
        await savepoint`delete from service_durations where tenant_id = ${tenantId} and service_id = ${row.entityId}`;
        await savepoint`delete from service_location_options where tenant_id = ${tenantId} and service_id = ${row.entityId}`;
        await savepoint`delete from service_locations where tenant_id = ${tenantId} and service_id = ${row.entityId}`;
        await savepoint`delete from practitioner_services where tenant_id = ${tenantId} and service_id = ${row.entityId}`;
        await savepoint`delete from services where tenant_id = ${tenantId} and id = ${row.entityId}`;
        return true;
      });
    } catch {
      removed = false;
    }
    results.push({ rowNumber: row.rowNumber, outcome: removed ? "removed" : "kept" });
  }
  return results;
}

export const serviceImporter: KindImporter = { check, commit, undo };
