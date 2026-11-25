import type { TermWords } from "@/lib/terminology";

/**
 * Plain-words reasons for a row the import will not save, and for the job-level failures.
 * Client-safe: no server imports. Words follow the business (a salon sees "client", a clinic "patient").
 */
export function importReasons(t: TermWords): Record<string, string> {
  return {
    required_missing: "A required value is empty.",
    invalid_phone: "This phone number is not valid. Check the digits and the country code.",
    invalid_email: "This email address is not valid.",
    invalid_date: "This date could not be read in the date format you chose.",
    invalid_value: "This value is not one we can accept.",
    too_long: "This value is too long.",
    duplicate_in_file: "This row repeats another row in your file.",
    duplicate_existing: `This ${t.customer} is already in your list.`,
    unknown_customer: `No ${t.customer} with this name or phone number is in your list. Import your ${t.customers} first.`,
    unknown_service: `No ${t.service} with this name is set up.`,
    unknown_staff: `No ${t.provider} with this name is on your team.`,
    no_location: `This ${t.appointment} has no location we can use. Add the location name or set up a location first.`,
    limit_reached: "Your plan's limit has been reached, so this row could not be added.",
    forbidden: "You do not have permission to import this row.",
    in_use: "This record has been used since the import, so it was kept.",
    row_failed: "This row could not be saved. Try it again in a new file.",
    slot_unavailable: "That time is outside working hours or already blocked.",
    clash: `That time overlaps another ${t.appointment}.`,
    past_time: "That time is in the past.",
    file_too_large: "The file is bigger than 10 MB.",
    too_many_rows: "The file has more rows than one import can hold. Split it and import the parts one by one.",
    unreadable_file: "We could not read this file. Save it as CSV or XLSX and try again.",
    too_many_columns: "The file has more columns than we can read. Remove the ones you do not need.",
    macros_not_allowed: "Files with macros are not accepted. Save a copy without macros, or as CSV.",
    file_missing: "The uploaded file is no longer here. Upload it again.",
    expired: "This import has expired. Upload the file again.",
    import_failed: "The import stopped before it finished.",
    empty_file: "The file has no rows.",
    no_header: "The first row of the file must hold the column names.",
  };
}

const generic = "This row has a problem. Open it in your file, fix it and import it again.";

export function importReason(code: string | null | undefined, t: TermWords): string {
  if (!code) return generic;
  return importReasons(t)[code] ?? generic;
}

export const importFailureFallback = "The import stopped before it finished. Nothing more will be added; what was already saved can be undone.";
