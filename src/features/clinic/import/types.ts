import type {
  DateFormat,
  ImportCounts,
  ImportFieldView,
  ImportJobView,
  ImportKind,
  ImportMapping,
  ImportOptions,
  ImportPreviewRow,
  ImportRowView,
  ImportStatus,
  ImportUploadResult,
} from "@/server/imports/contracts";

/** The import API's shapes come from the server's contracts (types only, so no server code reaches the browser). */
export type { DateFormat, ImportCounts, ImportKind, ImportMapping, ImportOptions, ImportRowView, ImportStatus };
export type ImportJob = ImportJobView;
export type ImportField = ImportFieldView;
export type PreviewRow = ImportPreviewRow;
/** What the upload returns, and what is kept in this tab so a reload can still show the column step. */
export type ImportSetup = ImportUploadResult;
export type DuplicateRule = ImportOptions["duplicateRule"];

/** The row groups the check step can list. */
export type RowStatus = "error" | "will_skip" | "will_update" | "ready";

export const dateFormats: { value: DateFormat; label: string }[] = [
  { value: "dd/mm/yyyy", label: "Day first: 31/12/2026" },
  { value: "mm/dd/yyyy", label: "Month first: 12/31/2026" },
  { value: "yyyy-mm-dd", label: "Year first: 2026-12-31" },
  { value: "d-mmm-yyyy", label: "Month in words: 31-Dec-2026" },
];

export const defaultOptions: ImportOptions = {
  dateFormat: "dd/mm/yyyy",
  defaultCountry: "IN",
  duplicateRule: "skip",
  consentConfirmed: false,
  sendConfirmations: false,
};

export const pollingStatuses: readonly ImportStatus[] = ["checking", "queued", "running", "undoing"];

/** The file types the upload accepts, and the size limit the server also enforces. */
export const maxFileBytes = 10 * 1024 * 1024;
