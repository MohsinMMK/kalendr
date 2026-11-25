import type { FileStore } from "@/server/file-store";

import type { ImportOptions, ImportMapping, ImportErrorCode, ImportRowStatus } from "./contracts";
import type { JobRow, RowOutcome, TenantDb } from "./job-db";
import type { ParsedFile } from "./parse";
import type { RowSettings } from "./validate";

/** What every kind's check, commit and undo needs. Built once per worker event. */
export interface ImportContext {
  tenantDb: TenantDb;
  tenantId: string;
  job: JobRow;
  file: ParsedFile;
  mapping: ImportMapping;
  options: ImportOptions;
  settings: RowSettings;
  /** The worker's database address, for the appointment kind, which books through the shared booking code on a pool of its own. */
  databaseUrl?: string;
  store?: FileStore;
}

/** One row going through a commit: what the check decided, and where the matching record is. */
export interface CommitRow {
  rowNumber: number;
  status: Extract<ImportRowStatus, "ready" | "will_update">;
  entityId: string | null;
}

export interface CommitResult {
  rowNumber: number;
  status: Extract<ImportRowStatus, "created" | "updated" | "skipped" | "failed">;
  code: ImportErrorCode | null;
  field: string | null;
  entityId: string | null;
}

export interface UndoRow {
  rowNumber: number;
  entityId: string;
  /** When the import wrote this row: later edits to the record are compared against it. */
  at: Date;
}

/** Rows the check has already seen, so a later row can be called a duplicate of an earlier one. Kept in memory between chunks. */
export interface CheckState {
  nextRow: number;
  phones: Set<string>;
  emails: Set<string>;
  names: Set<string>;
  /** Appointments the file itself has already placed, per staff member, as [start, end) in milliseconds. */
  booked: Map<string, Array<[number, number]>>;
}

export const newCheckState = (): CheckState => ({ nextRow: 0, phones: new Set(), emails: new Set(), names: new Set(), booked: new Map() });

export interface KindImporter {
  /** Looks at rows [start, end) of the file and says what an import would do with each. Writes nothing. */
  check(context: ImportContext, start: number, end: number, state: CheckState): Promise<RowOutcome[]>;
  /** Does the import for one batch. Each row is its own savepoint, so one bad row never stops the rest. */
  commit(context: ImportContext, rows: readonly CommitRow[]): Promise<CommitResult[]>;
  /** Removes what the import made, when it has not been used or edited since. "kept" leaves it alone. */
  undo(context: ImportContext, rows: readonly UndoRow[]): Promise<Array<{ rowNumber: number; outcome: "removed" | "kept" }>>;
}

export const outcome = (
  rowNumber: number,
  status: RowOutcome["status"],
  code: ImportErrorCode | null = null,
  field: string | null = null,
  entityId: string | null = null,
): RowOutcome => ({ rowNumber, status, code, field, entityId });

/** A fixed code for a database refusal. The message is never kept: it can quote the row. */
export function databaseFailureCode(error: unknown): ImportErrorCode {
  const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
  if (code === "23505") return "duplicate_existing";
  if (code === "23P01") return "slot_unavailable";
  if (code === "22001") return "too_long";
  if (code === "23514" || code === "22P02" || code === "22007" || code === "22008") return "invalid_value";
  return "row_failed";
}
