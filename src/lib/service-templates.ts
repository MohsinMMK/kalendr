import { z } from "zod";

import { approvalSettingsSchema } from "@/lib/approval";
import { intakeSettingsSchema } from "@/lib/booking-intake";
import { bookingPageSettingsSchema } from "@/lib/booking-page";
import { cancelPolicySchema } from "@/lib/cancel-policy";
import { resourceKinds } from "@/lib/business-types";
import {
  type ServiceLength,
  type ServiceLocationOption,
  type ServiceSetup,
  locationOptionKinds,
  serviceLengthsSchema,
  serviceLookSchema,
  serviceTimingSchema,
} from "@/lib/service-setup";

/**
 * Service templates (feature 48): one definition, many real services. A template holds the service settings that are not
 * about one branch or person; assigning it makes (or links) real services, and the fields the owner locks stay in step
 * with the template. Pure, so the server, the screen and the tests share one set of rules.
 */

/** The names an owner can lock. Each maps to a part of the service that the editor changes. */
export const lockableFields = [
  "name", "description", "category", "visibility", "resource",
  "lengths", "prices", "timing", "meeting", "look", "booking_page", "intake", "approval", "cancel_policy",
] as const;
export type LockableField = (typeof lockableFields)[number];

export const lockLabels: Record<LockableField, string> = {
  name: "Name",
  description: "Description",
  category: "Category",
  visibility: "Listed or hidden",
  resource: "Room or equipment needed",
  lengths: "Lengths (and their prices)",
  prices: "Prices only",
  timing: "Timing and booking window",
  meeting: "Ways of meeting",
  look: "Colours and banner",
  booking_page: "Booking page layout",
  intake: "Contact details and guests",
  approval: "Approval rules",
  cancel_policy: "Cancelling and moving",
};

const meetingOptionSchema = z.object({
  kind: z.enum(locationOptionKinds),
  note: z.string().trim().max(200).nullable(),
});

/** What a template stores. In-person is a kind without a branch: each copy meets in its own branch. */
export const templateSettingsSchema = z.object({
  description: z.string().trim().min(2).max(2000),
  category: z.string().trim().max(60).nullable(),
  visibility: z.enum(["listed", "hidden"]),
  requiredResourceKind: z.enum(resourceKinds).nullable(),
  lengths: serviceLengthsSchema,
  timing: serviceTimingSchema,
  meeting: z.array(meetingOptionSchema).min(1).max(5),
  look: serviceLookSchema,
  bookingPage: bookingPageSettingsSchema,
  intake: intakeSettingsSchema,
  approval: approvalSettingsSchema,
  cancelPolicy: cancelPolicySchema,
});
export type TemplateSettings = z.infer<typeof templateSettingsSchema>;

const idSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);
const nameSchema = z.string().trim().min(2, "Give the template a name.").max(120);
const lockedSchema = z.array(z.enum(lockableFields)).max(lockableFields.length).transform((values) => [...new Set(values)]);

export const createTemplateInput = z.object({
  name: nameSchema,
  lockedFields: lockedSchema.default([]),
  /** Start from this service's current settings. Without it, the template starts from sensible defaults and the owner edits it. */
  fromServiceId: idSchema.optional(),
});
export type CreateTemplateInput = z.infer<typeof createTemplateInput>;

export const updateTemplateInput = z.object({
  expectedVersion: z.number().int().positive(),
  name: nameSchema.optional(),
  settings: templateSettingsSchema.optional(),
  lockedFields: lockedSchema.optional(),
  /** Work out the summary only; change nothing. */
  dryRun: z.boolean().default(false),
}).refine((value) => value.name !== undefined || value.settings !== undefined || value.lockedFields !== undefined, { message: "Choose something to change." });
export type UpdateTemplateInput = z.infer<typeof updateTemplateInput>;

export const assignTemplateInput = z.object({
  /** One new service is made in each of these branches. */
  locationIds: z.array(idSchema).max(60).default([]),
  /** Who offers it. Without this, everyone active at the branch does. People who do not work at a branch are skipped there. */
  practitionerIds: z.array(idSchema).max(200).optional(),
  /** Existing services to link to the template; their locked fields are brought in line at once. */
  linkServiceIds: z.array(idSchema).max(200).default([]),
}).refine((value) => value.locationIds.length + value.linkServiceIds.length > 0, { message: "Choose at least one branch or service." });
export type AssignTemplateInput = z.infer<typeof assignTemplateInput>;

export const unlinkTemplateInput = z.object({ serviceIds: z.array(idSchema).min(1).max(200) });

export interface TemplateCopyView {
  serviceId: string;
  name: string;
  locationNames: string[];
  templateVersion: number;
  /** Behind the template: its locked fields have not been updated yet. */
  outOfDate: boolean;
}

export interface TemplateView {
  id: string;
  name: string;
  version: number;
  lockedFields: LockableField[];
  settings: TemplateSettings;
  copyCount: number;
  updatedAt: string;
}

export interface TemplateDetail extends TemplateView {
  copies: TemplateCopyView[];
}

export interface PublishSummary {
  /** The locked parts that differ between the stored template and this change, in plain words. */
  changedFields: LockableField[];
  /** Services that will be updated (every copy). */
  servicesUpdated: number;
  /** Of those, copies whose unlocked fields have been set locally, and stay as they are. */
  servicesWithLocalChanges: number;
  /** Prices change: bookings already made keep the price they were booked at. */
  changesPrices: boolean;
  /** The sentence staff read before confirming. */
  sentence: string;
}

// ---- reading a service as template settings, and a template onto a service ----

/** Equal by value, whatever order the keys were written in (a form and the database build the same object differently). */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, entry]) => `${JSON.stringify(key)}:${stable(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
const same = (a: unknown, b: unknown): boolean => stable(a) === stable(b);

/** The meeting kinds of a service: its in-person options collapse into one `in_person` entry. */
function meetingOf(options: readonly ServiceLocationOption[]): TemplateSettings["meeting"] {
  const seen = new Set<string>();
  const result: TemplateSettings["meeting"] = [];
  for (const option of options) {
    if (seen.has(option.kind)) continue;
    seen.add(option.kind);
    result.push({ kind: option.kind, note: option.kind === "in_person" ? null : option.note });
  }
  return result;
}

export function settingsFromSetup(setup: ServiceSetup): TemplateSettings {
  const parsed = templateSettingsSchema.safeParse({
    description: setup.basics.description,
    category: setup.basics.category,
    visibility: setup.basics.visibility,
    requiredResourceKind: setup.basics.requiredResourceKind,
    lengths: setup.lengths,
    timing: setup.timing,
    meeting: meetingOf(setup.locationOptions),
    look: setup.look,
    bookingPage: setup.bookingPage,
    intake: setup.intake,
    approval: setup.approval,
    cancelPolicy: setup.cancelPolicy,
  });
  if (!parsed.success) throw new Error("A service's settings did not fit a template.");
  return parsed.data;
}

/** Each copy meets in its own branches: in-person becomes one option per branch of the copy. */
export function locationOptionsFor(meeting: TemplateSettings["meeting"], locationIds: readonly string[]): ServiceLocationOption[] {
  return meeting.flatMap((option): ServiceLocationOption[] => option.kind === "in_person"
    ? locationIds.map((locationId) => ({ kind: "in_person", locationId, note: null }))
    : [{ kind: option.kind, locationId: null, note: option.note }]);
}

/** The prices a copy may keep when only prices are locked: its own lengths, with the template's price where minutes match. */
function pricesOnto(template: readonly ServiceLength[], copy: readonly ServiceLength[]): ServiceLength[] {
  return copy.map((length) => {
    const match = template.find((candidate) => candidate.minutes === length.minutes);
    return match ? { ...length, priceMinor: match.priceMinor } : length;
  });
}

/** What the service-editor patch should be to bring a copy in line with the template for the locked fields. */
export interface TemplatePatch {
  basics?: { name?: string; description?: string; category?: string | null; visibility?: "listed" | "hidden"; requiredResourceKind?: TemplateSettings["requiredResourceKind"] };
  timing?: TemplateSettings["timing"];
  lengths?: ServiceLength[];
  locationOptions?: ServiceLocationOption[];
  look?: TemplateSettings["look"];
  bookingPage?: TemplateSettings["bookingPage"];
  intake?: TemplateSettings["intake"];
  approval?: TemplateSettings["approval"];
  cancelPolicy?: TemplateSettings["cancelPolicy"];
}

export function patchFromTemplate(
  template: { name: string; settings: TemplateSettings },
  fields: readonly LockableField[],
  copy: ServiceSetup,
): TemplatePatch {
  const has = (field: LockableField) => fields.includes(field);
  const basics: NonNullable<TemplatePatch["basics"]> = {
    ...(has("name") ? { name: template.name } : {}),
    ...(has("description") ? { description: template.settings.description } : {}),
    ...(has("category") ? { category: template.settings.category } : {}),
    ...(has("visibility") ? { visibility: template.settings.visibility } : {}),
    ...(has("resource") ? { requiredResourceKind: template.settings.requiredResourceKind } : {}),
  };
  return {
    ...(Object.keys(basics).length > 0 ? { basics } : {}),
    ...(has("timing") ? { timing: template.settings.timing } : {}),
    ...(has("lengths") ? { lengths: template.settings.lengths } : has("prices") ? { lengths: pricesOnto(template.settings.lengths, copy.lengths) } : {}),
    ...(has("meeting") ? { locationOptions: locationOptionsFor(template.settings.meeting, copy.basics.locationIds) } : {}),
    ...(has("look") ? { look: template.settings.look } : {}),
    ...(has("booking_page") ? { bookingPage: template.settings.bookingPage } : {}),
    ...(has("intake") ? { intake: template.settings.intake } : {}),
    ...(has("approval") ? { approval: template.settings.approval } : {}),
    ...(has("cancel_policy") ? { cancelPolicy: template.settings.cancelPolicy } : {}),
  };
}

/** The lock names a patch to a service touches, so the server can refuse a change to a locked field. */
export function touchedLockFields(
  patch: {
    basics?: { name?: string; description?: string; category?: string | null; visibility?: string; requiredResourceKind?: string | null; bookingMode?: string } | undefined;
    timing?: unknown; lengths?: readonly ServiceLength[] | undefined; locationOptions?: unknown; look?: unknown;
    bookingPage?: unknown; intake?: unknown; approval?: unknown; cancelPolicy?: unknown;
    durationMinutes?: number | undefined; priceLabel?: string | null | undefined;
  },
  current: ServiceSetup,
): LockableField[] {
  const touched: LockableField[] = [];
  const basics = patch.basics;
  if (basics?.name !== undefined && basics.name !== current.basics.name) touched.push("name");
  if (basics?.description !== undefined && basics.description !== current.basics.description) touched.push("description");
  if (basics?.category !== undefined && (basics.category ?? null) !== (current.basics.category ?? null)) touched.push("category");
  if (basics?.visibility !== undefined && basics.visibility !== current.basics.visibility) touched.push("visibility");
  if (basics?.requiredResourceKind !== undefined && basics.requiredResourceKind !== current.basics.requiredResourceKind) touched.push("resource");
  if (patch.timing !== undefined && !same(patch.timing, current.timing)) touched.push("timing");
  if (patch.lengths !== undefined) {
    const next = [...patch.lengths].sort((a, b) => a.minutes - b.minutes);
    const now = [...current.lengths].sort((a, b) => a.minutes - b.minutes);
    if (!same(next, now)) {
      touched.push("lengths");
      const priceOf = (list: readonly ServiceLength[]) => list.map((length) => [length.minutes, length.priceMinor]);
      if (!same(priceOf(next), priceOf(now))) touched.push("prices");
    }
  }
  // The older quick edits: a usual length or a price label.
  if (patch.durationMinutes !== undefined && patch.durationMinutes !== (current.lengths.find((length) => length.isDefault) ?? current.lengths[0])?.minutes) touched.push("lengths");
  if (patch.priceLabel !== undefined) touched.push("prices");
  if (patch.locationOptions !== undefined && !same(meetingOf(patch.locationOptions as ServiceLocationOption[]), meetingOf(current.locationOptions))) touched.push("meeting");
  if (patch.look !== undefined && !same(patch.look, current.look)) touched.push("look");
  if (patch.bookingPage !== undefined && !same(patch.bookingPage, current.bookingPage)) touched.push("booking_page");
  if (patch.intake !== undefined && !same(patch.intake, current.intake)) touched.push("intake");
  if (patch.approval !== undefined && !same(patch.approval, current.approval)) touched.push("approval");
  // The older booking-mode switch becomes an approval rule when no approval group is sent, so it counts as one.
  else if (patch.approval === undefined && basics?.bookingMode !== undefined && basics.bookingMode !== current.basics.bookingMode) touched.push("approval");
  if (patch.cancelPolicy !== undefined && !same(patch.cancelPolicy, current.cancelPolicy)) touched.push("cancel_policy");
  return touched;
}

/** Which locked parts differ between two template states (name included). */
export function changedLockFields(
  before: { name: string; settings: TemplateSettings; lockedFields: readonly LockableField[] },
  after: { name: string; settings: TemplateSettings; lockedFields: readonly LockableField[] },
): LockableField[] {
  const locked = new Set<LockableField>([...before.lockedFields, ...after.lockedFields]);
  const differs = (field: LockableField): boolean => {
    switch (field) {
      case "name": return before.name !== after.name;
      case "description": return before.settings.description !== after.settings.description;
      case "category": return before.settings.category !== after.settings.category;
      case "visibility": return before.settings.visibility !== after.settings.visibility;
      case "resource": return before.settings.requiredResourceKind !== after.settings.requiredResourceKind;
      case "lengths": return !same(before.settings.lengths, after.settings.lengths);
      case "prices": return !same(before.settings.lengths.map((length) => [length.minutes, length.priceMinor]), after.settings.lengths.map((length) => [length.minutes, length.priceMinor]));
      case "timing": return !same(before.settings.timing, after.settings.timing);
      case "meeting": return !same(before.settings.meeting, after.settings.meeting);
      case "look": return !same(before.settings.look, after.settings.look);
      case "booking_page": return !same(before.settings.bookingPage, after.settings.bookingPage);
      case "intake": return !same(before.settings.intake, after.settings.intake);
      case "approval": return !same(before.settings.approval, after.settings.approval);
      case "cancel_policy": return !same(before.settings.cancelPolicy, after.settings.cancelPolicy);
    }
  };
  return lockableFields.filter((field) => locked.has(field) && differs(field));
}

export function publishSentence(summary: Omit<PublishSummary, "sentence">, units: { service: string; services: string }): string {
  if (summary.servicesUpdated === 0) return "No services use this template yet, so nothing else changes.";
  const what = summary.changedFields.length === 0 ? "Changes nothing that is locked" : `Changes ${summary.changedFields.map((field) => lockLabels[field].toLowerCase()).join(", ")}`;
  const count = `${summary.servicesUpdated} ${summary.servicesUpdated === 1 ? units.service : units.services}`;
  const local = summary.servicesWithLocalChanges > 0
    ? ` ${summary.servicesWithLocalChanges} ${summary.servicesWithLocalChanges === 1 ? units.service : units.services} ha${summary.servicesWithLocalChanges === 1 ? "s" : "ve"} local changes to unlocked fields, which stay.`
    : "";
  const prices = summary.changesPrices ? " Bookings already made keep the price they were booked at." : "";
  return `${what} on ${count}.${local}${prices}`;
}

/** The copy's unlocked fields that differ from the template, as a yes or no. */
export function hasLocalChanges(template: { name: string; settings: TemplateSettings; lockedFields: readonly LockableField[] }, copy: ServiceSetup): boolean {
  const unlocked = lockableFields.filter((field) => !template.lockedFields.includes(field));
  // With only prices locked, the lengths are compared without their prices: those follow the template and are not "local".
  const blank = (settings: TemplateSettings): TemplateSettings => template.lockedFields.includes("prices")
    ? { ...settings, lengths: settings.lengths.map((length) => ({ ...length, priceMinor: null })) } : settings;
  const mine = blank(settingsFromSetup(copy));
  template = { ...template, settings: blank(template.settings) };
  const probe = changedLockFields(
    { name: template.name, settings: template.settings, lockedFields: unlocked },
    { name: copy.basics.name, settings: mine, lockedFields: unlocked },
  );
  return probe.length > 0;
}
