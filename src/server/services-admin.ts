import "server-only";

import { sql } from "drizzle-orm";

import { withTenant, type KalendrTransaction } from "@/db/client";
import { auditEvents } from "@/db/schema";
import { approvalRules, defaultApprovalSettings, type ApprovalSettings } from "@/lib/approval";
import { defaultCancelPolicy, type CancelPolicy } from "@/lib/cancel-policy";
import { afterBookingModes, defaultAfterBooking, type AfterBookingSettings } from "@/lib/after-booking";
import { contactModes, defaultIntakeSettings, type IntakeSettings } from "@/lib/booking-intake";
import { bookingLayouts, defaultBookingPageSettings, type BookingPageSettings } from "@/lib/booking-page";
import { priceFromLabel } from "@/lib/money";
import {
  serviceSetupIssues,
  type BookingWindow,
  type CalendarEntry,
  defaultCalendarEntry,
  type ServiceBasics,
  type ServiceLength,
  type ServiceLocationOption,
  type ServiceLook,
  type ServiceSetup,
  type ServiceSetupUpdate,
  type ServiceTiming,
} from "@/lib/service-setup";

import { ApiError, getPostgresErrorCode } from "./api-error";
import { assertNotLocked } from "./service-template-locks";
import { requirePermission, type StaffContext } from "./staff-context";

/** A link-safe name: lower-case letters, numbers and single dashes. */
export function slugify(name: string): string {
  const stem = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70)
    .replace(/-+$/g, "");
  return stem || "service";
}

/** The first of `stem`, `stem-2`, `stem-3`… that no other service of this business uses. */
export async function uniqueServiceSlug(
  transaction: KalendrTransaction,
  tenantId: string,
  stem: string,
  excludeServiceId?: string,
): Promise<string> {
  const taken = await transaction.execute<{ slug: string }>(sql`
    select slug from services
    where tenant_id = ${tenantId}
      and (slug = ${stem} or slug like ${`${stem}-%`})
      and (${excludeServiceId ?? null}::text is null or id <> ${excludeServiceId ?? null})
  `);
  const used = new Set(taken.map((row) => row.slug));
  if (!used.has(stem)) return stem;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${stem}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

export interface ServiceRowForSetup {
  id: string;
  name: string;
  description: string;
  category: string | null;
  booking_mode: "instant" | "request";
  required_resource_kind: ServiceBasics["requiredResourceKind"];
  is_active: boolean;
  visibility: "listed" | "hidden";
  slug: string;
  schedule_id: string | null;
  restriction_schedule_id: string | null;
  version: number;
  duration_minutes: number;
  price_minor: number | null;
  buffer_before_minutes: number;
  buffer_after_minutes: number;
  slot_interval_minutes: number | null;
  minimum_lead_minutes: number;
  maximum_advance_days: number;
  booking_window_kind: BookingWindow["kind"];
  booking_window_from: string | null;
  booking_window_through: string | null;
  start_offset_minutes: number;
  color_light: ServiceLook["colorLight"];
  color_dark: ServiceLook["colorDark"];
  banner_media_id: string | null;
  layouts_enabled: string[];
  default_layout: string;
  lock_timezone: boolean;
  week_start: number | null;
  allow_guests: boolean;
  after_booking: string;
  redirect_url: string | null;
  pass_details_on_redirect: boolean;
  success_message: string | null;
  hide_success_details: boolean;
  max_guests: number;
  contact_mode: string;
  verify_email: boolean;
  approval_rule: string;
  approval_notice_hours: number;
  requests_hold_slot: boolean;
  hide_location_until_confirmed: boolean;
  allow_customer_cancel: boolean;
  allow_customer_reschedule: boolean;
  cancel_cutoff_minutes: number;
  reschedule_cutoff_minutes: number;
  reschedule_same_person: boolean;
  reschedule_request_days: number;
  /** Calendar wording (feature 50). Optional so rows read elsewhere keep working. */
  customer_event_title?: string | null;
  staff_event_title?: string | null;
  event_description?: string | null;
  hide_notes_in_calendar?: boolean;
  hide_details_in_calendar?: boolean;
}

export interface ServiceLengthRow { minutes: number; price_minor: number | null; is_default: boolean; sort_order: number }
export interface ServiceOptionRow { kind: ServiceLocationOption["kind"]; location_id: string | null; note: string | null; sort_order: number }

/** The window as the editor shows it, from the stored columns. */
function windowFromRow(row: ServiceRowForSetup): BookingWindow {
  if (row.booking_window_kind === "date_range" && row.booking_window_from && row.booking_window_through) {
    return { kind: "date_range", from: row.booking_window_from, through: row.booking_window_through };
  }
  return { kind: row.booking_window_kind === "business_days" ? "business_days" : "rolling_days", days: row.maximum_advance_days };
}

/**
 * Turns the stored rows into the editor's document. A service made before lengths and options
 * existed has no rows for them, so its single length and branches stand in.
 */
export function buildServiceSetup(
  row: ServiceRowForSetup,
  lengthRows: ServiceLengthRow[],
  optionRows: ServiceOptionRow[],
  locationIds: string[],
  practitionerIds: string[],
): ServiceSetup {
  const lengths: ServiceLength[] = lengthRows.length > 0
    ? [...lengthRows].sort((a, b) => a.sort_order - b.sort_order).map((length) => ({ minutes: length.minutes, priceMinor: length.price_minor, isDefault: length.is_default }))
    : [{ minutes: row.duration_minutes, priceMinor: row.price_minor, isDefault: true }];
  const locationOptions: ServiceLocationOption[] = optionRows.length > 0
    ? [...optionRows].sort((a, b) => a.sort_order - b.sort_order).map((option) => ({ kind: option.kind, locationId: option.location_id, note: option.note }))
    : locationIds.map((locationId) => ({ kind: "in_person" as const, locationId, note: null }));
  return {
    id: row.id,
    version: row.version,
    basics: {
      name: row.name,
      description: row.description,
      category: row.category,
      bookingMode: row.booking_mode,
      requiredResourceKind: row.required_resource_kind,
      isActive: row.is_active,
      visibility: row.visibility,
      slug: row.slug,
      scheduleId: row.schedule_id,
      restrictionScheduleId: row.restriction_schedule_id,
      locationIds,
      practitionerIds,
    },
    timing: {
      bufferBeforeMinutes: row.buffer_before_minutes,
      bufferAfterMinutes: row.buffer_after_minutes,
      minimumNoticeMinutes: row.minimum_lead_minutes,
      window: windowFromRow(row),
      slotIntervalMinutes: row.slot_interval_minutes,
      startOffsetMinutes: row.start_offset_minutes,
    },
    lengths,
    locationOptions,
    look: { colorLight: row.color_light, colorDark: row.color_dark, bannerMediaId: row.banner_media_id },
    bookingPage: {
      layoutsEnabled: bookingLayouts.filter((layout) => row.layouts_enabled.includes(layout)),
      defaultLayout: bookingLayouts.find((layout) => layout === row.default_layout) ?? "month",
      lockTimezone: row.lock_timezone,
      weekStart: row.week_start === 7 ? 7 : row.week_start === 1 ? 1 : null,
    },
    intake: {
      contactMode: contactModes.find((mode) => mode === row.contact_mode) ?? "email_or_phone",
      allowGuests: row.allow_guests,
      maxGuests: Math.min(Math.max(row.max_guests, 1), 10),
      verifyEmail: row.verify_email,
    },
    afterBooking: {
      mode: afterBookingModes.find((mode) => mode === row.after_booking) ?? "kalendr_page",
      redirectUrl: row.redirect_url,
      passDetailsOnRedirect: row.pass_details_on_redirect,
      successMessage: row.success_message,
      hideSuccessDetails: row.hide_success_details,
    },
    approval: {
      rule: approvalRules.find((rule) => rule === row.approval_rule) ?? "never",
      noticeHours: Math.min(Math.max(row.approval_notice_hours, 1), 720),
      requestsHoldSlot: row.requests_hold_slot,
      hideLocationUntilConfirmed: row.hide_location_until_confirmed,
    },
    cancelPolicy: {
      allowCustomerCancel: row.allow_customer_cancel,
      allowCustomerReschedule: row.allow_customer_reschedule,
      cancelCutoffMinutes: row.cancel_cutoff_minutes,
      rescheduleCutoffMinutes: row.reschedule_cutoff_minutes,
      rescheduleSamePerson: row.reschedule_same_person,
      rescheduleRequestDays: row.reschedule_request_days,
    },
    calendarEntry: {
      customerTitle: row.customer_event_title ?? null,
      staffTitle: row.staff_event_title ?? null,
      description: row.event_description ?? null,
      hideNotes: row.hide_notes_in_calendar ?? false,
      hideDetails: row.hide_details_in_calendar ?? false,
    },
  };
}

type Tx = KalendrTransaction;

const serviceColumns = sql`
  id, name, description, category, booking_mode, required_resource_kind, is_active, visibility, slug, schedule_id, restriction_schedule_id, version,
  duration_minutes, price_minor, buffer_before_minutes, buffer_after_minutes, slot_interval_minutes,
  minimum_lead_minutes, maximum_advance_days, booking_window_kind, booking_window_from::text as booking_window_from,
  booking_window_through::text as booking_window_through, start_offset_minutes, color_light, color_dark, banner_media_id,
  layouts_enabled, default_layout, lock_timezone, week_start, allow_guests, max_guests, contact_mode, verify_email,
  approval_rule, approval_notice_hours, requests_hold_slot, hide_location_until_confirmed,
  allow_customer_cancel, allow_customer_reschedule, cancel_cutoff_minutes, reschedule_cutoff_minutes, reschedule_same_person, reschedule_request_days, after_booking, redirect_url, pass_details_on_redirect, success_message, hide_success_details,
  customer_event_title, staff_event_title, event_description, hide_notes_in_calendar, hide_details_in_calendar
`;

export async function loadServiceSetupIn(
  transaction: Tx,
  tenantId: string,
  serviceId: string,
  options: { lock?: boolean } = {},
): Promise<ServiceSetup | null> {
  const [row] = await transaction.execute<ServiceRowForSetup & Record<string, unknown>>(sql`
    select ${serviceColumns} from services
    where tenant_id = ${tenantId} and id = ${serviceId}
    ${options.lock ? sql`for update` : sql``}
  `);
  if (!row) return null;
  const [lengths, optionRows, locationRows, practitionerRows] = await Promise.all([
    transaction.execute<ServiceLengthRow & Record<string, unknown>>(sql`
      select minutes, price_minor, is_default, sort_order from service_durations
      where tenant_id = ${tenantId} and service_id = ${serviceId}`),
    transaction.execute<ServiceOptionRow & Record<string, unknown>>(sql`
      select kind, location_id, note, sort_order from service_location_options
      where tenant_id = ${tenantId} and service_id = ${serviceId}`),
    transaction.execute<{ location_id: string }>(sql`
      select location_id from service_locations where tenant_id = ${tenantId} and service_id = ${serviceId} order by location_id`),
    transaction.execute<{ practitioner_id: string }>(sql`
      select practitioner_id from practitioner_services where tenant_id = ${tenantId} and service_id = ${serviceId} order by practitioner_id`),
  ]);
  return buildServiceSetup(row, [...lengths], [...optionRows], locationRows.map((r) => r.location_id), practitionerRows.map((r) => r.practitioner_id));
}

function invalid(message: string, field: string): ApiError {
  return new ApiError(400, "validation_error", message, { [field]: [message] });
}

export function serviceVersionConflict(): ApiError {
  return new ApiError(409, "version_conflict", "Someone else changed this service while you were editing. Reload it and try again.");
}

export async function getServiceSetup(context: StaffContext, serviceId: string): Promise<ServiceSetup> {
  requirePermission(context, "settings.manage");
  return withTenant(context.tenantId, async (transaction) => {
    const setup = await loadServiceSetupIn(transaction, context.tenantId, serviceId);
    if (!setup) throw new ApiError(404, "service_not_found", "Service not found.");
    const [template] = await transaction.execute<{ id: string; name: string; version: number; locked_fields: string[] }>(sql`
      select template.id, template.name, service.template_version as version, template.locked_fields
      from services as service join service_templates as template on template.tenant_id = service.tenant_id and template.id = service.template_id
      where service.tenant_id = ${context.tenantId} and service.id = ${serviceId}`);
    return { ...setup, template: template ? { id: template.id, name: template.name, version: template.version, lockedFields: template.locked_fields } : null };
  });
}

/** What changes besides the editor's groups: the old quick-edit fields the visit-type list still sends. */
export interface LegacyExtras {
  priceLabel?: string | null;
  durationMinutes?: number;
}

export interface Patch extends LegacyExtras {
  basics?: Partial<ServiceBasics>;
  timing?: ServiceTiming;
  lengths?: ServiceLength[];
  locationOptions?: ServiceLocationOption[];
  look?: ServiceLook;
  bookingPage?: BookingPageSettings;
  intake?: IntakeSettings;
  approval?: ApprovalSettings;
  cancelPolicy?: CancelPolicy;
  calendarEntry?: CalendarEntry;
  afterBooking?: AfterBookingSettings;
}

function mergeSetup(current: ServiceSetup, patch: Patch): ServiceSetup {
  let lengths = patch.lengths ?? current.lengths;
  if (patch.durationMinutes !== undefined && !patch.lengths) {
    lengths = current.lengths.map((length) => (length.isDefault ? { ...length, minutes: patch.durationMinutes! } : length));
    if (new Set(lengths.map((length) => length.minutes)).size !== lengths.length) {
      throw invalid("Another length already uses that many minutes.", "durationMinutes");
    }
  }
  if (patch.priceLabel !== undefined && !patch.lengths) {
    const price = priceFromLabel(patch.priceLabel);
    lengths = lengths.map((length) => (length.isDefault ? { ...length, priceMinor: price } : length));
  }
  const basics = { ...current.basics, ...patch.basics };
  let locationOptions = patch.locationOptions ?? current.locationOptions;
  if (!patch.locationOptions && patch.basics?.locationIds) {
    // The branches changed without the options being edited: keep the options in step with them.
    const wanted = new Set(basics.locationIds);
    const kept = current.locationOptions.filter((option) => option.kind !== "in_person" || (option.locationId && wanted.has(option.locationId)));
    const have = new Set(kept.filter((option) => option.kind === "in_person").map((option) => option.locationId));
    locationOptions = [...kept, ...basics.locationIds.filter((id) => !have.has(id)).map((locationId) => ({ kind: "in_person" as const, locationId, note: null }))];
  }
  return { ...current, basics, timing: patch.timing ?? current.timing, lengths, locationOptions, look: patch.look ?? current.look, bookingPage: patch.bookingPage ?? current.bookingPage, intake: patch.intake ?? current.intake, approval: patch.approval ?? current.approval, cancelPolicy: patch.cancelPolicy ?? current.cancelPolicy, calendarEntry: patch.calendarEntry ?? current.calendarEntry, afterBooking: patch.afterBooking ?? current.afterBooking };
}

async function assertReferences(transaction: Tx, tenantId: string, setup: ServiceSetup, patch: Patch): Promise<void> {
  const issues = serviceSetupIssues(setup);
  if (issues[0]) throw invalid(issues[0], "timing");
  const branchIds = new Set(setup.basics.locationIds);
  for (const option of setup.locationOptions) {
    if (option.kind === "in_person" && option.locationId && !branchIds.has(option.locationId)) {
      throw invalid("Choose in-person branches this service is offered at.", "locationOptions");
    }
  }
  if (patch.basics?.locationIds) {
    const rows = await transaction.execute<{ id: string }>(sql`
      select id from locations where tenant_id = ${tenantId} and id in (${sql.join(patch.basics.locationIds.map((id) => sql`${id}`), sql`, `)})`);
    if (rows.length !== new Set(patch.basics.locationIds).size) throw invalid("Choose branches that belong to this business.", "locationIds");
  }
  if (patch.basics?.practitionerIds && patch.basics.practitionerIds.length > 0) {
    const rows = await transaction.execute<{ id: string }>(sql`
      select id from practitioners where tenant_id = ${tenantId} and id in (${sql.join(patch.basics.practitionerIds.map((id) => sql`${id}`), sql`, `)})`);
    if (rows.length !== new Set(patch.basics.practitionerIds).size) throw invalid("Choose people who belong to this business.", "practitionerIds");
  }
  if (patch.look?.bannerMediaId) {
    const rows = await transaction.execute<{ id: string }>(sql`
      select id from media_assets where tenant_id = ${tenantId} and id = ${patch.look.bannerMediaId}`);
    if (rows.length === 0) throw invalid("Choose a picture from your media library.", "bannerMediaId");
  }
  for (const [key, value] of [["scheduleId", patch.basics?.scheduleId], ["restrictionScheduleId", patch.basics?.restrictionScheduleId]] as const) {
    if (!value) continue;
    const rows = await transaction.execute<{ id: string }>(sql`
      select id from availability_schedules where tenant_id = ${tenantId} and id = ${value}`);
    if (rows.length === 0) throw invalid("Choose one of this business's schedules.", key);
  }
  if (patch.basics?.slug) {
    const rows = await transaction.execute<{ id: string }>(sql`
      select id from services where tenant_id = ${tenantId} and slug = ${patch.basics.slug} and id <> ${setup.id}`);
    if (rows.length > 0) throw new ApiError(409, "slug_taken", "Another service already uses that link name.", { slug: ["Another service already uses that link name."] });
  }
}

/** Replaces the lengths in one go. The default goes in first so the one-default index never sees two. */
async function writeLengths(transaction: Tx, tenantId: string, serviceId: string, lengths: ServiceLength[]): Promise<void> {
  await transaction.execute(sql`delete from service_durations where tenant_id = ${tenantId} and service_id = ${serviceId}`);
  const ordered = [...lengths].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.minutes - b.minutes);
  for (const [index, length] of ordered.entries()) {
    await transaction.execute(sql`
      insert into service_durations (tenant_id, service_id, minutes, price_minor, is_default, sort_order)
      values (${tenantId}, ${serviceId}, ${length.minutes}, ${length.priceMinor}, ${length.isDefault}, ${index})`);
  }
}

async function writeOptions(transaction: Tx, tenantId: string, serviceId: string, options: ServiceLocationOption[]): Promise<void> {
  await transaction.execute(sql`delete from service_location_options where tenant_id = ${tenantId} and service_id = ${serviceId}`);
  for (const [index, option] of options.entries()) {
    await transaction.execute(sql`
      insert into service_location_options (tenant_id, service_id, kind, location_id, note, sort_order)
      values (${tenantId}, ${serviceId}, ${option.kind}, ${option.locationId}, ${option.note || null}, ${index})`);
  }
}

async function writeLinks(transaction: Tx, tenantId: string, serviceId: string, locationIds: string[], practitionerIds: string[] | undefined): Promise<void> {
  await transaction.execute(sql`delete from service_locations where tenant_id = ${tenantId} and service_id = ${serviceId}`);
  for (const locationId of new Set(locationIds)) {
    await transaction.execute(sql`insert into service_locations (tenant_id, service_id, location_id) values (${tenantId}, ${serviceId}, ${locationId})`);
  }
  if (practitionerIds) {
    // Rows already there keep their routing priority and weight (feature 20); only people added or removed change.
    const keep = [...new Set(practitionerIds)];
    await transaction.execute(keep.length === 0
      ? sql`delete from practitioner_services where tenant_id = ${tenantId} and service_id = ${serviceId}`
      : sql`delete from practitioner_services where tenant_id = ${tenantId} and service_id = ${serviceId} and practitioner_id not in (${sql.join(keep.map((id) => sql`${id}`), sql`, `)})`);
    for (const practitionerId of keep) {
      await transaction.execute(sql`insert into practitioner_services (tenant_id, practitioner_id, service_id) values (${tenantId}, ${practitionerId}, ${serviceId}) on conflict do nothing`);
    }
  }
}

/** The groups of the setup that a patch touches, for the audit trail. Names only, never values. */
function touchedGroups(patch: Patch): string[] {
  return [
    ...(patch.basics ? ["basics"] : []),
    ...(patch.timing ? ["timing"] : []),
    ...(patch.lengths || patch.durationMinutes !== undefined || patch.priceLabel !== undefined ? ["lengths"] : []),
    ...(patch.locationOptions ? ["locationOptions"] : []),
    ...(patch.look ? ["look"] : []),
    ...(patch.bookingPage ? ["bookingPage"] : []),
    ...(patch.intake ? ["intake"] : []),
    ...(patch.approval ? ["approval"] : []),
    ...(patch.cancelPolicy ? ["cancelPolicy"] : []),
    ...(patch.calendarEntry ? ["calendarEntry"] : []),
    ...(patch.afterBooking ? ["afterBooking"] : []),
  ];
}

/** One save for both the editor and the older quick edits. Every save bumps `version`. */
export async function applyServiceSetupPatch(
  context: StaffContext,
  serviceId: string,
  patch: Patch,
  expectedVersion?: number,
): Promise<ServiceSetup> {
  requirePermission(context, "settings.manage");
  return withTenant(context.tenantId, (transaction) => applyServicePatchIn(transaction, context, serviceId, patch, expectedVersion));
}

/**
 * The save itself, for a caller that holds the transaction. A service that follows a template (feature 48) refuses a
 * change to a locked field here, so every screen and request is covered; the template's own publish passes
 * `fromTemplate` because it is the one thing allowed to write those fields.
 */
export async function applyServicePatchIn(
  transaction: Tx,
  context: StaffContext,
  serviceId: string,
  patch: Patch,
  expectedVersion?: number,
  options: { fromTemplate?: boolean } = {},
): Promise<ServiceSetup> {
  const current = await loadServiceSetupIn(transaction, context.tenantId, serviceId, { lock: true });
  if (!current) throw new ApiError(404, "service_not_found", "Service not found.");
  if (expectedVersion !== undefined && expectedVersion !== current.version) throw serviceVersionConflict();
  // The older visit-types list sends every field on every save. Only what really changed counts, so pressing its
  // Save never writes an empty price label over prices set in the editor.
  const [stored] = await transaction.execute<{ price_label: string | null }>(sql`
    select price_label from services where tenant_id = ${context.tenantId} and id = ${serviceId}`);
  const usual = current.lengths.find((length) => length.isDefault) ?? current.lengths[0];
  if (patch.priceLabel !== undefined && (patch.priceLabel ?? "") === (stored?.price_label ?? "")) delete patch.priceLabel;
  if (patch.durationMinutes !== undefined && patch.durationMinutes === usual?.minutes) delete patch.durationMinutes;
  if (!options.fromTemplate) await assertNotLocked(transaction, context.tenantId, serviceId, patch, current);
  const next = mergeSetup(current, patch);
  await assertReferences(transaction, context.tenantId, next, patch);
  const { basics, timing, lengths, look } = next;
  const bookingPage = next.bookingPage ?? defaultBookingPageSettings;
  const intake = next.intake ?? defaultIntakeSettings;
  // booking_mode is kept in step for older code: the approval group wins, and an older "mode" edit maps onto the rule.
  let approval = next.approval ?? defaultApprovalSettings;
  if (!patch.approval && patch.basics?.bookingMode && patch.basics.bookingMode !== current.basics.bookingMode) {
    approval = { ...approval, rule: patch.basics.bookingMode === "request" ? "always" : "never" };
  }
  const cancelPolicy = next.cancelPolicy ?? defaultCancelPolicy;
  const calendarEntry = next.calendarEntry ?? defaultCalendarEntry;
  const afterBooking = next.afterBooking ?? defaultAfterBooking;
  const bookingMode = approval.rule === "never" ? "instant" : "request";
  const defaultLength = lengths.find((length) => length.isDefault) ?? lengths[0]!;
  const window = timing.window;
  await transaction.execute(sql`
    update services set
      name = ${basics.name}, description = ${basics.description}, category = ${basics.category || null},
      booking_mode = ${bookingMode}, required_resource_kind = ${basics.requiredResourceKind},
      is_active = ${basics.isActive}, visibility = ${basics.visibility}, slug = ${basics.slug},
      schedule_id = ${basics.scheduleId}, restriction_schedule_id = ${basics.restrictionScheduleId},
      duration_minutes = ${defaultLength.minutes}, price_minor = ${defaultLength.priceMinor},
      ${patch.priceLabel !== undefined ? sql`price_label = ${patch.priceLabel || null},` : sql``}
      buffer_before_minutes = ${timing.bufferBeforeMinutes}, buffer_after_minutes = ${timing.bufferAfterMinutes},
      minimum_lead_minutes = ${timing.minimumNoticeMinutes}, slot_interval_minutes = ${timing.slotIntervalMinutes},
      start_offset_minutes = ${timing.startOffsetMinutes},
      booking_window_kind = ${window.kind},
      booking_window_from = ${window.kind === "date_range" ? window.from : null}::date,
      booking_window_through = ${window.kind === "date_range" ? window.through : null}::date,
      ${window.kind === "date_range" ? sql`` : sql`maximum_advance_days = ${window.days},`}
      color_light = ${look.colorLight}, color_dark = ${look.colorDark}, banner_media_id = ${look.bannerMediaId},
      layouts_enabled = ${sql`ARRAY[${sql.join(bookingPage.layoutsEnabled.map((layout) => sql`${layout}`), sql`, `)}]::text[]`},
      default_layout = ${bookingPage.defaultLayout}, lock_timezone = ${bookingPage.lockTimezone}, week_start = ${bookingPage.weekStart},
      allow_guests = ${intake.allowGuests}, max_guests = ${intake.maxGuests}, contact_mode = ${intake.contactMode}, verify_email = ${intake.verifyEmail},
      approval_rule = ${approval.rule}, approval_notice_hours = ${approval.noticeHours},
      requests_hold_slot = ${approval.requestsHoldSlot}, hide_location_until_confirmed = ${approval.hideLocationUntilConfirmed},
      allow_customer_cancel = ${cancelPolicy.allowCustomerCancel}, allow_customer_reschedule = ${cancelPolicy.allowCustomerReschedule},
      cancel_cutoff_minutes = ${cancelPolicy.cancelCutoffMinutes}, reschedule_cutoff_minutes = ${cancelPolicy.rescheduleCutoffMinutes},
      reschedule_same_person = ${cancelPolicy.rescheduleSamePerson}, reschedule_request_days = ${cancelPolicy.rescheduleRequestDays},
      after_booking = ${afterBooking.mode}, redirect_url = ${afterBooking.mode === "redirect" ? afterBooking.redirectUrl : null},
      pass_details_on_redirect = ${afterBooking.passDetailsOnRedirect}, success_message = ${afterBooking.successMessage || null}, hide_success_details = ${afterBooking.hideSuccessDetails},
      customer_event_title = ${calendarEntry.customerTitle || null}, staff_event_title = ${calendarEntry.staffTitle || null},
      event_description = ${calendarEntry.description || null}, hide_notes_in_calendar = ${calendarEntry.hideNotes},
      hide_details_in_calendar = ${calendarEntry.hideDetails},
      version = version + 1, updated_at = now()
    where tenant_id = ${context.tenantId} and id = ${serviceId}
  `);
  if (patch.lengths || patch.durationMinutes !== undefined || patch.priceLabel !== undefined) {
    await writeLengths(transaction, context.tenantId, serviceId, lengths);
  }
  if (patch.locationOptions || patch.basics?.locationIds) {
    await writeOptions(transaction, context.tenantId, serviceId, next.locationOptions);
  }
  if (patch.basics?.locationIds || patch.basics?.practitionerIds) {
    await writeLinks(transaction, context.tenantId, serviceId, basics.locationIds, patch.basics?.practitionerIds);
  }
  await transaction.insert(auditEvents).values({
    tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff",
    action: "settings.service.updated", outcome: "success",
    metadata: { serviceId, groups: touchedGroups(patch) },
  });
  const saved = await loadServiceSetupIn(transaction, context.tenantId, serviceId);
  if (!saved) throw new ApiError(404, "service_not_found", "Service not found.");
  return saved;
}

export function updateServiceSetup(context: StaffContext, serviceId: string, input: ServiceSetupUpdate): Promise<ServiceSetup> {
  return applyServiceSetupPatch(context, serviceId, {
    ...(input.basics ? { basics: input.basics } : {}),
    ...(input.timing ? { timing: input.timing } : {}),
    ...(input.lengths ? { lengths: input.lengths } : {}),
    ...(input.locationOptions ? { locationOptions: input.locationOptions } : {}),
    ...(input.look ? { look: input.look } : {}),
    ...(input.bookingPage ? { bookingPage: input.bookingPage } : {}),
    ...(input.intake ? { intake: input.intake } : {}),
    ...(input.approval ? { approval: input.approval } : {}),
    ...(input.cancelPolicy ? { cancelPolicy: input.cancelPolicy } : {}),
    ...(input.calendarEntry ? { calendarEntry: input.calendarEntry } : {}),
    ...(input.afterBooking ? { afterBooking: input.afterBooking } : {}),
  }, input.expectedVersion);
}

/** Copies a service with its lengths, ways of meeting, people, branches and booking forms. One transaction. */
export async function duplicateService(context: StaffContext, serviceId: string): Promise<{ serviceId: string }> {
  requirePermission(context, "settings.manage");
  return withTenant(context.tenantId, async (transaction) => {
    const source = await loadServiceSetupIn(transaction, context.tenantId, serviceId);
    if (!source) throw new ApiError(404, "service_not_found", "Service not found.");
    const name = `${source.basics.name.slice(0, 160 - " (copy)".length)} (copy)`;
    const slug = await uniqueServiceSlug(transaction, context.tenantId, slugify(`${source.basics.slug}-copy`));
    const [created] = await transaction.execute<{ id: string }>(sql`
      insert into services (
        tenant_id, name, description, duration_minutes, buffer_before_minutes, buffer_after_minutes,
        slot_interval_minutes, minimum_lead_minutes, maximum_advance_days, booking_mode, patient_types,
        required_resource_kind, price_label, price_minor, category, is_active, booking_window_kind,
        booking_window_from, booking_window_through, start_offset_minutes, color_light, color_dark,
        visibility, slug, banner_media_id, schedule_id, restriction_schedule_id,
        max_active_per_customer, offer_reschedule_when_capped, first_slot_only,
        layouts_enabled, default_layout, lock_timezone, week_start, allow_guests, max_guests, contact_mode, verify_email,
  approval_rule, approval_notice_hours, requests_hold_slot, hide_location_until_confirmed,
  allow_customer_cancel, allow_customer_reschedule, cancel_cutoff_minutes, reschedule_cutoff_minutes, reschedule_same_person, reschedule_request_days, after_booking, redirect_url, pass_details_on_redirect, success_message, hide_success_details,
  customer_event_title, staff_event_title, event_description, hide_notes_in_calendar, hide_details_in_calendar
      )
      select tenant_id, ${name}, description, duration_minutes, buffer_before_minutes, buffer_after_minutes,
        slot_interval_minutes, minimum_lead_minutes, maximum_advance_days, booking_mode, patient_types,
        required_resource_kind, price_label, price_minor, category, is_active, booking_window_kind,
        booking_window_from, booking_window_through, start_offset_minutes, color_light, color_dark,
        visibility, ${slug}, banner_media_id, schedule_id, restriction_schedule_id,
        max_active_per_customer, offer_reschedule_when_capped, first_slot_only,
        layouts_enabled, default_layout, lock_timezone, week_start, allow_guests, max_guests, contact_mode, verify_email,
  approval_rule, approval_notice_hours, requests_hold_slot, hide_location_until_confirmed,
  allow_customer_cancel, allow_customer_reschedule, cancel_cutoff_minutes, reschedule_cutoff_minutes, reschedule_same_person, reschedule_request_days, after_booking, redirect_url, pass_details_on_redirect, success_message, hide_success_details,
  customer_event_title, staff_event_title, event_description, hide_notes_in_calendar, hide_details_in_calendar
      from services where tenant_id = ${context.tenantId} and id = ${serviceId}
      returning id`);
    if (!created) throw new Error("Service copy returned no row");
    // Limits go with the copy; the customer cap and first-slot switch were copied with the row.
    await transaction.execute(sql`
      insert into booking_limits (tenant_id, scope, service_id, measure, period, max_value, week_start)
      select tenant_id, scope, ${created.id}, measure, period, max_value, week_start from booking_limits
      where tenant_id = ${context.tenantId} and scope = 'service' and service_id = ${serviceId}`);
    await writeLengths(transaction, context.tenantId, created.id, source.lengths);
    await writeOptions(transaction, context.tenantId, created.id, source.locationOptions);
    await writeLinks(transaction, context.tenantId, created.id, source.basics.locationIds, source.basics.practitionerIds);
    await transaction.execute(sql`
      insert into form_definition_services (tenant_id, form_definition_id, service_id)
      select tenant_id, form_definition_id, ${created.id} from form_definition_services
      where tenant_id = ${context.tenantId} and service_id = ${serviceId}`);
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff",
      action: "settings.service.duplicated", outcome: "success",
      metadata: { serviceId: created.id, copiedFrom: serviceId },
    });
    return { serviceId: created.id };
  });
}

/**
 * Removes a service for good, but only when nothing refers to it. Bookings, series, classes, links, the waitlist
 * and recalls all hold on to their service, so the database refuses and the owner is told to turn it off instead.
 */
export async function deleteService(context: StaffContext, serviceId: string): Promise<{ serviceId: string }> {
  requirePermission(context, "settings.manage");
  try {
    return await withTenant(context.tenantId, async (transaction) => {
      const removed = await transaction.execute<{ id: string }>(sql`
        delete from services where tenant_id = ${context.tenantId} and id = ${serviceId} returning id`);
      if (removed.length === 0) throw new ApiError(404, "service_not_found", "Service not found.");
      await transaction.insert(auditEvents).values({
        tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff",
        action: "settings.service.deleted", outcome: "success",
        metadata: { serviceId },
      });
      return { serviceId };
    });
  } catch (error: unknown) {
    const code = getPostgresErrorCode(error);
    if (code === "23001" || code === "23503") {
      throw new ApiError(409, "service_in_use", "This has bookings or links, so it cannot be deleted. Turn it off instead.");
    }
    throw error;
  }
}
