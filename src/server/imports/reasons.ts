import type { ImportErrorCode, ImportFileErrorCode } from "./contracts";
import { importFields } from "./map";
import type { ImportKind } from "./contracts";

/** Plain-words reasons for the fixed codes. Used in the error file and by the screen; no value from the file is ever in one. */

function fieldLabel(kind: ImportKind, field: string | null): string {
  return importFields[kind].find((entry) => entry.key === field)?.label.toLowerCase() ?? "a value";
}

export function reasonText(kind: ImportKind, code: ImportErrorCode | null, field: string | null): string {
  const label = fieldLabel(kind, field);
  switch (code) {
    case "required_missing": return `The ${label} is empty. It is needed.`;
    case "invalid_phone": return "This is not a phone number we can read. Add the country code, such as +91, or fix the digits.";
    case "invalid_email": return "This is not a valid email address.";
    case "invalid_date": return `The ${label} is not a real date in the date format you chose.`;
    case "invalid_value": return `The ${label} is not a value we understand.`;
    case "too_long": return `The ${label} is too long.`;
    case "duplicate_in_file": return "The same person or service appears earlier in this file, so this row was left out.";
    case "duplicate_existing": return "You already have this one, so it was left alone.";
    case "unknown_customer": return "No customer matches this phone or email. Import your customers first.";
    case "unknown_service": return "No service has this name.";
    case "unknown_staff": return "No staff member has this name.";
    case "no_location": return "This service and staff member do not share a location.";
    case "slot_unavailable": return "That time is not available for this service and staff member.";
    case "limit_reached": return "A booking limit is already full at that time.";
    case "clash": return "This clashes with another appointment for the same staff member.";
    case "past_time": return "This time has already passed.";
    case "forbidden": return "The person who started this import is no longer allowed to book appointments.";
    case "in_use": return "This was used or changed after the import, so it was kept.";
    case "row_failed":
    case null: return "This row could not be saved. Try it again.";
  }
}

export function fileErrorText(code: ImportFileErrorCode): string {
  switch (code) {
    case "file_too_large": return "That file is bigger than 10 MB. Split it into smaller files.";
    case "too_many_rows": return "That file has more than 20,000 rows. Split it into smaller files.";
    case "too_many_columns": return "That file has more than 60 columns. Remove the ones you do not need.";
    case "empty_file": return "That file has no rows to import.";
    case "no_header": return "The first row should be column names, such as Name and Phone.";
    case "macros_not_allowed": return "Spreadsheets with macros are not accepted. Save a copy as a normal .xlsx or .csv file.";
    case "file_missing": return "The uploaded file is no longer available. Upload it again.";
    case "expired": return "This upload was not finished in time and was removed. Upload the file again.";
    case "import_failed": return "The import stopped because of a problem on our side. Try again.";
    case "unreadable_file": return "We could not read that file. Use a .csv or .xlsx file.";
  }
}
