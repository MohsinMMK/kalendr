import { isSupportedCountry } from "libphonenumber-js";
import { z } from "zod";


/**
 * Data import (feature 12): the shapes shared by the routes, the screen and the worker. No server-only code here, so the
 * worker bundle and the browser can both read it.
 */

export const importKinds = ["customers", "services", "appointments"] as const;
export type ImportKind = (typeof importKinds)[number];

export const importStatuses = ["uploaded", "mapped", "checking", "checked", "queued", "running", "done", "failed", "undoing", "undone"] as const;
export type ImportStatus = (typeof importStatuses)[number];

export const importRowStatuses = ["ready", "will_update", "will_skip", "error", "created", "updated", "skipped", "failed", "undone"] as const;
export type ImportRowStatus = (typeof importRowStatuses)[number];

/** The only reasons a row can carry. They name a problem, never a value from the file. */
export const importErrorCodes = [
  "required_missing",
  "invalid_phone",
  "invalid_email",
  "invalid_date",
  "invalid_value",
  "too_long",
  "duplicate_in_file",
  "duplicate_existing",
  "unknown_customer",
  "unknown_service",
  "unknown_staff",
  "no_location",
  "slot_unavailable",
  "limit_reached",
  "clash",
  "past_time",
  "forbidden",
  "in_use",
  "row_failed",
] as const;
export type ImportErrorCode = (typeof importErrorCodes)[number];

/** Why a whole file was refused or a job failed. */
export const importFileErrorCodes = [
  "file_too_large",
  "too_many_rows",
  "too_many_columns",
  "unreadable_file",
  "empty_file",
  "no_header",
  "macros_not_allowed",
  "file_missing",
  "expired",
  "import_failed",
] as const;
export type ImportFileErrorCode = (typeof importFileErrorCodes)[number];

export const importLimits = {
  maxBytes: 10 * 1024 * 1024,
  maxRows: 20_000,
  maxColumns: 60,
  maxCellLength: 1_000,
  /** Rows the check looks at per worker event, and rows a commit or undo handles per event. */
  checkChunk: 500,
  commitBatch: 200,
  undoDays: 7,
} as const;

export const dateFormats = ["dd/mm/yyyy", "mm/dd/yyyy", "yyyy-mm-dd", "d-mmm-yyyy"] as const;
export type DateFormat = (typeof dateFormats)[number];

export const importOptionsSchema = z.object({
  dateFormat: z.enum(dateFormats),
  /** Two-letter country the phone numbers are from when they carry no +code. Defaults to the business's own country. */
  defaultCountry: z.string().trim().length(2).regex(/^[A-Za-z]{2}$/).transform((value) => value.toUpperCase()).refine((value) => isSupportedCountry(value), "Choose a country we know.").optional(),
  /** What to do with a customer or service the business already has: leave it, or fill only its empty fields. */
  duplicateRule: z.enum(["skip", "fill_blanks"]),
  /** The owner ticked the box saying they hold the consent a mapped consent column claims. */
  consentConfirmed: z.boolean(),
  /** Send the normal confirmation for each imported appointment. Off by default. */
  sendConfirmations: z.boolean(),
}).strict();
export type ImportOptions = z.infer<typeof importOptionsSchema>;

export const defaultImportOptions: ImportOptions = {
  dateFormat: "dd/mm/yyyy",
  duplicateRule: "skip",
  consentConfirmed: false,
  sendConfirmations: false,
};

/** field name -> zero-based column, or null for "none". */
export const mappingSchema = z.record(z.string().min(1).max(40), z.number().int().min(0).max(59).nullable());
export type ImportMapping = z.infer<typeof mappingSchema>;

export const importIdSchema = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);

export const importCounts = z.object({
  ready: z.number().int(),
  update: z.number().int(),
  skip: z.number().int(),
  error: z.number().int(),
  created: z.number().int(),
  updated: z.number().int(),
  skipped: z.number().int(),
  failed: z.number().int(),
});
export type ImportCounts = z.infer<typeof importCounts>;

export interface ImportJobView {
  id: string;
  kind: ImportKind;
  fileFormat: "csv" | "xlsx";
  status: ImportStatus;
  rowCount: number;
  counts: ImportCounts;
  options: ImportOptions | null;
  mapping: ImportMapping | null;
  failureCode: ImportFileErrorCode | null;
  undoUntil: string | null;
  undoneAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  version: number;
  createdAt: string;
  /** Only once an undo has run: rows removed, and rows left because they were used or edited since. */
  undo?: { removed: number; kept: number };
}

export interface ImportFieldView {
  key: string;
  label: string;
  required: boolean;
  description: string;
}

export interface ImportUploadResult {
  job: ImportJobView;
  headers: string[];
  suggestedMapping: ImportMapping;
  fields: ImportFieldView[];
}

export interface ImportPreviewRow {
  rowNumber: number;
  values: Record<string, string>;
}

export const importUpdateInput = z.object({
  mapping: mappingSchema,
  options: importOptionsSchema,
  expectedVersion: z.number().int().positive(),
}).strict();
export type ImportUpdateInput = z.infer<typeof importUpdateInput>;

export const importVersionInput = z.object({ expectedVersion: z.number().int().positive() }).strict();

export const importRowsQuery = z.object({
  status: z.enum(importRowStatuses).optional(),
  cursor: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export interface ImportRowView {
  rowNumber: number;
  status: ImportRowStatus;
  errorCode: ImportErrorCode | null;
  errorField: string | null;
}

export const isImportKind = (value: string): value is ImportKind => (importKinds as readonly string[]).includes(value);
