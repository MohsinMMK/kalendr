import { lockRefusal, templateLocksOf } from "@/server/service-template-locks";
import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";

import { withTenant, type KalendrTransaction } from "@/db/client";
import {
  auditEvents,
  locations,
  patients,
  practitionerServices,
  practitioners,
  recalls,
  resources,
  scheduleBlocks,
  serviceDurations,
  serviceLocationOptions,
  serviceLocations,
  services,
  tenants,
  waitlistEntries,
} from "@/db/schema";
import { priceFromLabel } from "@/lib/money";
import { dateOfBirthSchema } from "@/lib/contracts";
import type { BookingMode, Patient, Recall, WaitlistEntry } from "@/lib/domain";
import { profileWords, type TermWords } from "@/lib/terminology";

import { ApiError } from "./api-error";
import { notifyStaff } from "./staff-notifications";
import { slugify, uniqueServiceSlug } from "./services-admin";
import type {
  StaffClinicProfileInput,
  StaffCreateResourceInput,
  StaffCreateScheduleBlockInput,
  StaffCreateServiceInput,
  StaffServiceModesInput,
  StaffUpdateResourceInput,
  StaffUpdateScheduleBlockInput,
} from "./contracts";
import { loadBusinessProfileIn } from "./business-profile";
import { assertLocationAllowed, canUseLocation, customerVisibleHere, isLimitedToLocations } from "./location-scope";
import { requirePermission, type StaffContext } from "./staff-context";
import { offerFreedRangeHook } from "./waitlist-hook";
import { recordConsentIn } from "./privacy/consent";

type TenantTransaction = Parameters<Parameters<typeof withTenant>[1]>[0];

async function wordsIn(transaction: TenantTransaction, tenantId: string): Promise<TermWords> {
  return profileWords(await loadBusinessProfileIn(transaction, tenantId));
}

const identifier = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/);

const patientFields = {
  firstName: z.string().trim().min(1).max(80),
  /** Empty for a one-word name. */
  lastName: z.string().trim().max(80),
  phone: z.string().trim().min(7).max(32).regex(/^\+?[\d\s()-]+$/, "Use digits, spaces, brackets, dashes and a leading +."),
  /** Blank when the person gave no email; reminders then go by text or WhatsApp only. */
  email: z.union([z.literal(""), z.email().max(254)]),
  dateOfBirth: dateOfBirthSchema,
  preferredChannel: z.enum(["sms", "email", "whatsapp", "phone"]),
  accessibilityNeed: z.string().trim().max(500),
  isDependent: z.boolean(),
  /** The patient agreed to reminders by text or WhatsApp. */
  messagingConsent: z.boolean(),
};

export const staffPatientInput = z.strictObject({
  ...patientFields,
  email: patientFields.email.default(""),
  dateOfBirth: patientFields.dateOfBirth.optional(),
  accessibilityNeed: patientFields.accessibilityNeed.optional(),
  isDependent: patientFields.isDependent.default(false),
  messagingConsent: patientFields.messagingConsent.default(false),
});

/** Every field is optional; null clears date of birth or the accessibility note. */
export const staffPatientUpdateInput = z.strictObject({
  firstName: patientFields.firstName.optional(),
  lastName: patientFields.lastName.optional(),
  phone: patientFields.phone.optional(),
  email: patientFields.email.optional(),
  dateOfBirth: patientFields.dateOfBirth.nullable().optional(),
  preferredChannel: patientFields.preferredChannel.optional(),
  accessibilityNeed: patientFields.accessibilityNeed.nullable().optional(),
  isDependent: patientFields.isDependent.optional(),
  messagingConsent: patientFields.messagingConsent.optional(),
}).refine((value) => Object.keys(value).length > 0, "Nothing to change.");

export const recallStatuses = ["upcoming", "due", "overdue", "contacted", "snoozed", "booked", "closed"] as const;

/** A recall change: a new status, a new due date, or both. A bare date means 9 am clinic time that day. */
export const recallInput = z.strictObject({
  status: z.enum(recallStatuses).optional(),
  dueAt: z.union([z.iso.date(), z.iso.datetime({ offset: true })]).optional(),
}).refine((value) => value.status !== undefined || value.dueAt !== undefined, "Nothing to change.");

export function recallDueDate(dueAt: string): Date {
  return new Date(/^\d{4}-\d{2}-\d{2}$/.test(dueAt) ? `${dueAt}T09:00:00+05:30` : dueAt);
}

export const waitlistInput = z.object({
  patientId: identifier,
  serviceId: identifier,
  locationId: identifier,
  preferredPractitionerIds: z.array(identifier).max(20).default([]),
  dateFrom: z.iso.date(),
  dateTo: z.iso.date(),
  timePreference: z.enum(["morning", "afternoon", "evening", "any"]),
}).refine((value) => value.dateTo >= value.dateFrom, { path: ["dateTo"], message: "End date must be on or after start date." });

export const waitlistStatuses = ["active", "offered", "fulfilled", "expired", "declined"] as const;

/** A waitlist change: status, wanted dates and time preference, in any combination (at least one). */
export const waitlistStatusInput = z.strictObject({
  status: z.enum(waitlistStatuses).optional(),
  dateFrom: z.iso.date().optional(),
  dateTo: z.iso.date().optional(),
  timePreference: z.enum(["morning", "afternoon", "evening", "any"]).optional(),
}).refine((value) => Object.values(value).some((item) => item !== undefined), "Nothing to change.")
  .refine((value) => !value.dateFrom || !value.dateTo || value.dateTo >= value.dateFrom, { path: ["dateTo"], message: "End date must be on or after start date." });

type PatientRecord = typeof patients.$inferSelect;

function toStaffPatient(row: PatientRecord, clinicId: string): Patient {
  return {
    id: row.id, clinicId, firstName: row.firstName, lastName: row.lastName,
    phone: row.phone, email: row.email, preferredChannel: row.preferredChannel, isDependent: row.isDependent,
    ...(row.dateOfBirth ? { dateOfBirth: row.dateOfBirth } : {}),
    ...(row.accessibilityNeed ? { accessibilityNeed: row.accessibilityNeed } : {}),
    ...(row.privacyAcceptedAt ? { privacyAcceptedAt: row.privacyAcceptedAt.toISOString() } : {}),
    ...(row.messagingConsentAt ? { messagingConsentAt: row.messagingConsentAt.toISOString() } : {}),
  };
}

/** The desk's add form: the patient, plus "Add anyway" once staff have seen who already has this phone or email. */
export const staffPatientCreateInput = staffPatientInput.extend({ allowDuplicate: z.boolean().default(false) });

export async function createStaffPatient(context: StaffContext, input: z.infer<typeof staffPatientCreateInput>): Promise<Patient> {
  requirePermission(context, "appointments.book");
  const { allowDuplicate, ...fields } = input;
  return withTenant(context.tenantId, async (transaction) => {
    if (!allowDuplicate && !fields.isDependent) {
      const existing = await samePhoneOrEmail(transaction, context.tenantId, fields.phone, fields.email);
      if (existing.length) {
        const words = await wordsIn(transaction, context.tenantId);
        const names = existing.map((row) => `${row.first_name} ${row.last_name}`.trim());
        throw new ApiError(409, "possible_duplicate", `${names.join(", ")} already ${names.length === 1 ? "uses" : "use"} this phone number or email. Open the existing ${words.customer}, or add anyway.`, undefined, undefined, {
          matches: existing.map((row) => ({ id: row.id, name: `${row.first_name} ${row.last_name}`.trim() })),
        });
      }
    }
    return toStaffPatient(await insertStaffPatient(transaction, context, fields), context.tenantId);
  });
}

/** Live, non-dependent patients with the same last ten phone digits or the same email: the rule Possible duplicates uses. */
async function samePhoneOrEmail(transaction: KalendrTransaction, tenantId: string, phone: string, email: string) {
  const digits = phone.replace(/\D/g, "").slice(-10);
  const mail = email.trim().toLowerCase();
  return transaction.execute<{ id: string; first_name: string; last_name: string }>(sql`
    select id, first_name, last_name from patients
    where tenant_id = ${tenantId} and merged_into_id is null and erased_at is null and not is_test and not is_dependent
      and ((${digits.length >= 7} and right(regexp_replace(phone, '\\D', '', 'g'), 10) = ${digits})
        or (${mail} <> '' and lower(email) = ${mail}))
    order by created_at limit 3
  `);
}

/**
 * The insert and its audit entry, for a caller that already holds the transaction. The public API (feature 34) adds
 * its Idempotency-Key claim and the `customer.created` outbox row in the same transaction. When an API key made the
 * change the audit row names the key instead of a user.
 */
export async function insertStaffPatient(transaction: KalendrTransaction, context: StaffContext, input: z.infer<typeof staffPatientInput>): Promise<PatientRecord> {
  const [created] = await transaction.insert(patients).values({
    tenantId: context.tenantId, firstName: input.firstName, lastName: input.lastName,
    phone: input.phone, email: input.email.toLowerCase(), dateOfBirth: input.dateOfBirth,
    preferredChannel: input.preferredChannel, accessibilityNeed: input.accessibilityNeed,
    isDependent: input.isDependent,
    messagingConsentAt: input.messagingConsent ? new Date() : null,
  }).returning();
  if (!created) throw new Error("Patient insert returned no row");
  await transaction.insert(auditEvents).values({
    tenantId: context.tenantId, actorUserId: context.userId, actorType: context.apiKeyId ? "api_key" : "staff",
    action: "patient.created", outcome: "success",
    metadata: { patientId: created.id, ...(context.apiKeyId ? { apiKeyId: context.apiKeyId, apiKeyPrefix: context.apiKeyPrefix ?? "" } : {}) },
  });
  return created;
}

/**
 * Front-desk correction of a patient's details. The audit names the fields that changed, never their values,
 * so the activity log does not become a second copy of personal data.
 */
export async function updateStaffPatient(context: StaffContext, id: string, input: z.infer<typeof staffPatientUpdateInput>): Promise<Patient> {
  requirePermission(context, "appointments.book");
  return withTenant(context.tenantId, async (transaction) => {
    const [current] = await transaction.select().from(patients)
      .where(and(eq(patients.tenantId, context.tenantId), eq(patients.id, id))).limit(1).for("update");
    if (!current || !(await customerVisibleHere(transaction, context, id))) throw new ApiError(404, "patient_not_found", `${(await wordsIn(transaction, context.tenantId)).Customer} not found.`);
    const changes: Partial<typeof patients.$inferInsert> = {};
    if (input.firstName !== undefined && input.firstName !== current.firstName) changes.firstName = input.firstName;
    if (input.lastName !== undefined && input.lastName !== current.lastName) changes.lastName = input.lastName;
    if (input.phone !== undefined && input.phone !== current.phone) changes.phone = input.phone;
    if (input.email !== undefined && input.email.toLowerCase() !== current.email) changes.email = input.email.toLowerCase();
    if (input.dateOfBirth !== undefined && input.dateOfBirth !== current.dateOfBirth) changes.dateOfBirth = input.dateOfBirth;
    if (input.preferredChannel !== undefined && input.preferredChannel !== current.preferredChannel) changes.preferredChannel = input.preferredChannel;
    if (input.accessibilityNeed !== undefined) {
      const need = input.accessibilityNeed?.trim() || null;
      if (need !== current.accessibilityNeed) changes.accessibilityNeed = need;
    }
    if (input.isDependent !== undefined && input.isDependent !== current.isDependent) changes.isDependent = input.isDependent;
    // Messages consent goes through the ledger (feature 7) with its own audit row, never a bare column write.
    const consentChange = input.messagingConsent !== undefined && input.messagingConsent !== Boolean(current.messagingConsentAt);
    const fields = Object.keys(changes);
    if (!fields.length && !consentChange) return toStaffPatient(current, context.tenantId);
    if (fields.length) {
      await transaction.update(patients).set({ ...changes, updatedAt: new Date() })
        .where(and(eq(patients.tenantId, context.tenantId), eq(patients.id, id)));
      await transaction.insert(auditEvents).values({
        tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff",
        action: "patient.updated", outcome: "success", metadata: { patientId: id, fields },
      });
    }
    if (consentChange) {
      await recordConsentIn(transaction, context.tenantId, {
        patientId: id, purpose: "appointment_messages", granted: input.messagingConsent === true,
        source: "staff", actor: { type: "staff", userId: context.userId },
      });
    }
    const [updated] = await transaction.select().from(patients)
      .where(and(eq(patients.tenantId, context.tenantId), eq(patients.id, id))).limit(1);
    if (!updated) throw new ApiError(404, "patient_not_found", `${(await wordsIn(transaction, context.tenantId)).Customer} not found.`);
    return toStaffPatient(updated, context.tenantId);
  });
}

export async function updateStaffRecall(context: StaffContext, id: string, input: z.infer<typeof recallInput>): Promise<Recall> {
  requirePermission(context, "appointments.book");
  return withTenant(context.tenantId, async (transaction) => {
    const [recall] = await transaction.select({ patientId: recalls.patientId }).from(recalls).where(and(eq(recalls.tenantId, context.tenantId), eq(recalls.id, id))).limit(1);
    if (recall && !(await customerVisibleHere(transaction, context, recall.patientId))) throw new ApiError(404, "recall_not_found", "Recall not found.");
    const [updated] = await transaction.update(recalls).set({
      ...(input.status ? { status: input.status } : {}),
      ...(input.dueAt ? { dueAt: recallDueDate(input.dueAt) } : {}),
      ...(input.status === "contacted" ? { lastContactedAt: new Date() } : {}),
      updatedAt: new Date(),
    }).where(and(eq(recalls.tenantId, context.tenantId), eq(recalls.id, id))).returning();
    if (!updated) throw new ApiError(404, "recall_not_found", "Recall not found.");
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff",
      action: input.status ? `recall.status.${input.status}` : "recall.due_date.changed",
      outcome: "success",
      metadata: { recallId: id, ...(input.status && input.dueAt ? { dueDateChanged: true } : {}) },
    });
    return { id: updated.id, patientId: updated.patientId, serviceId: updated.serviceId,
      dueAt: updated.dueAt.toISOString(), status: updated.status,
      ...(updated.lastContactedAt ? { lastContactedAt: updated.lastContactedAt.toISOString() } : {}),
    };
  });
}

export async function createStaffWaitlist(context: StaffContext, input: z.infer<typeof waitlistInput>): Promise<WaitlistEntry> {
  requirePermission(context, "appointments.book");
  assertLocationAllowed(context, input.locationId);
  return withTenant(context.tenantId, async (transaction) => {
    const [created] = await transaction.insert(waitlistEntries).values({
      tenantId: context.tenantId, patientId: input.patientId, serviceId: input.serviceId,
      locationId: input.locationId, preferredPractitionerIds: input.preferredPractitionerIds,
      dateFrom: input.dateFrom, dateTo: input.dateTo, timePreference: input.timePreference,
      status: "active",
    }).returning();
    if (!created) throw new Error("Waitlist insert returned no row");
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff",
      action: "waitlist.created", outcome: "success", metadata: { waitlistId: created.id },
    });
    return { id: created.id, patientId: created.patientId, serviceId: created.serviceId,
      locationId: created.locationId, preferredPractitionerIds: created.preferredPractitionerIds,
      dateFrom: created.dateFrom, dateTo: created.dateTo, timePreference: input.timePreference,
      status: created.status, createdAt: created.createdAt.toISOString(),
    };
  });
}

export async function updateStaffWaitlist(context: StaffContext, id: string, input: z.infer<typeof waitlistStatusInput>): Promise<WaitlistEntry> {
  requirePermission(context, "appointments.book");
  return withTenant(context.tenantId, async (transaction) => {
    const [seen] = await transaction.select({ locationId: waitlistEntries.locationId }).from(waitlistEntries)
      .where(and(eq(waitlistEntries.tenantId, context.tenantId), eq(waitlistEntries.id, id))).limit(1);
    if (seen && !canUseLocation(context, seen.locationId)) throw new ApiError(404, "waitlist_not_found", "Waitlist entry not found.");
    if (input.dateFrom || input.dateTo) {
      const [current] = await transaction.select({ dateFrom: waitlistEntries.dateFrom, dateTo: waitlistEntries.dateTo }).from(waitlistEntries)
        .where(and(eq(waitlistEntries.tenantId, context.tenantId), eq(waitlistEntries.id, id))).limit(1).for("update");
      if (!current) throw new ApiError(404, "waitlist_not_found", "Waitlist entry not found.");
      if ((input.dateTo ?? current.dateTo) < (input.dateFrom ?? current.dateFrom)) {
        throw new ApiError(400, "invalid_date_range", "End date must be on or after start date.");
      }
    }
    const [updated] = await transaction.update(waitlistEntries).set({
      ...(input.status ? { status: input.status } : {}),
      ...(input.dateFrom ? { dateFrom: input.dateFrom } : {}),
      ...(input.dateTo ? { dateTo: input.dateTo } : {}),
      ...(input.timePreference ? { timePreference: input.timePreference } : {}),
      updatedAt: new Date(),
    }).where(and(eq(waitlistEntries.tenantId, context.tenantId), eq(waitlistEntries.id, id))).returning();
    if (!updated) throw new ApiError(404, "waitlist_not_found", "Waitlist entry not found.");
    const fields = (["dateFrom", "dateTo", "timePreference"] as const).filter((key) => input[key] !== undefined);
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff",
      action: input.status ? `waitlist.status.${input.status}` : "waitlist.updated",
      outcome: "success", metadata: { waitlistId: id, ...(fields.length ? { fields } : {}) },
    });
    if (input.status === "fulfilled") {
      await notifyStaff(transaction, context.tenantId, { kind: "waitlist_filled", dedupeKey: `waitlist.fulfilled:${id}`, locationId: updated.locationId, exceptUserId: context.userId, link: "/follow-ups" });
    }
    return { id: updated.id, patientId: updated.patientId, serviceId: updated.serviceId,
      locationId: updated.locationId, preferredPractitionerIds: updated.preferredPractitionerIds,
      dateFrom: updated.dateFrom, dateTo: updated.dateTo,
      timePreference: updated.timePreference as WaitlistEntry["timePreference"],
      status: updated.status, createdAt: updated.createdAt.toISOString(),
    };
  });
}

export async function updateStaffServiceModes(
  context: StaffContext,
  input: StaffServiceModesInput,
): Promise<Record<string, BookingMode>> {
  requirePermission(context, "settings.manage");
  return withTenant(context.tenantId, async (transaction) => {
    for (const [serviceId, bookingMode] of Object.entries(input.serviceModes)) {
      // The approval rule may belong to a template (feature 48).
      const locks = await templateLocksOf(transaction, context.tenantId, serviceId);
      if (locks?.locked.includes("approval")) throw lockRefusal(locks.templateName, ["approval"]);
      const [updated] = await transaction.update(services).set({
        mode: bookingMode,
        updatedAt: new Date(),
      }).where(and(eq(services.tenantId, context.tenantId), eq(services.id, serviceId))).returning({
        id: services.id,
      });
      if (!updated) throw new ApiError(404, "service_not_found", "Service not found.");
    }
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff",
      action: "settings.services.booking_mode", outcome: "success",
      metadata: { serviceIds: Object.keys(input.serviceModes) },
    });
    return input.serviceModes;
  });
}

export async function createStaffService(
  context: StaffContext,
  input: StaffCreateServiceInput,
): Promise<{ serviceId: string }> {
  requirePermission(context, "settings.manage");
  return withTenant(context.tenantId, async (transaction) => {
    const t = await wordsIn(transaction, context.tenantId);
    const locationRows = await transaction
      .select({ id: locations.id })
      .from(locations)
      .where(eq(locations.tenantId, context.tenantId));
    const locationIds = input.locationIds?.length
      ? input.locationIds
      : locationRows.map((row) => row.id);
    if (locationIds.length === 0) {
      throw new ApiError(400, "location_not_found", `Add ${t.aBusiness} ${t.location} before creating a service.`);
    }
    const slug = await uniqueServiceSlug(transaction, context.tenantId, slugify(input.name));
    const [created] = await transaction.insert(services).values({
      tenantId: context.tenantId,
      slug,
      name: input.name,
      description: input.description,
      durationMinutes: input.durationMinutes,
      mode: input.bookingMode,
      patientTypes: ["new", "returning"],
      ...(input.requiredResourceKind ? { requiredResourceKind: input.requiredResourceKind } : {}),
      ...(input.priceLabel ? { priceLabel: input.priceLabel, priceMinor: priceFromLabel(input.priceLabel) } : {}),
      ...(input.category ? { category: input.category } : {}),
    }).returning({ id: services.id });
    if (!created) throw new Error("Service insert returned no row");
    // The one length it starts with, and in-person at every branch it is offered at.
    await transaction.insert(serviceDurations).values({
      tenantId: context.tenantId,
      serviceId: created.id,
      minutes: input.durationMinutes,
      priceMinor: input.priceLabel ? priceFromLabel(input.priceLabel) : null,
      isDefault: true,
      sortOrder: 0,
    });
    await transaction.insert(serviceLocationOptions).values(
      locationIds.map((locationId, index) => ({
        tenantId: context.tenantId, serviceId: created.id, kind: "in_person", locationId, sortOrder: index,
      })),
    );
    await transaction.insert(serviceLocations).values(
      locationIds.map((locationId) => ({
        tenantId: context.tenantId,
        serviceId: created.id,
        locationId,
      })),
    );
    const requestedPractitionerIds = input.practitionerIds?.filter(Boolean) ?? [];
    const practitionerRows = requestedPractitionerIds.length > 0
      ? await transaction
        .select({ id: practitioners.id })
        .from(practitioners)
        .where(and(
          eq(practitioners.tenantId, context.tenantId),
          inArray(practitioners.id, requestedPractitionerIds),
        ))
      : await transaction
        .select({ id: practitioners.id })
        .from(practitioners)
        .where(and(eq(practitioners.tenantId, context.tenantId), eq(practitioners.isActive, true)));
    if (requestedPractitionerIds.length > 0 && practitionerRows.length !== requestedPractitionerIds.length) {
      throw new ApiError(400, "practitioner_not_found", `Choose ${t.practitioners} who belong to this ${t.business}.`);
    }
    if (practitionerRows.length > 0) {
      await transaction.insert(practitionerServices).values(
        practitionerRows.map((row) => ({
          tenantId: context.tenantId,
          practitionerId: row.id,
          serviceId: created.id,
        })),
      );
    }
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId,
      actorUserId: context.userId,
      actorType: "staff",
      action: "settings.service.created",
      outcome: "success",
      metadata: { serviceId: created.id },
    });
    return { serviceId: created.id };
  });
}

/** A limited person may close time at their own locations only; a block with no location closes everywhere, so it is not theirs to make. */
function assertBlockLocation(context: StaffContext, locationId: string | null): void {
  if (isLimitedToLocations(context) && !locationId) {
    throw new ApiError(403, "location_not_allowed", "Pick one of your locations: closing time for the whole business is up to the owner.");
  }
  assertLocationAllowed(context, locationId);
}

async function assertExistingBlockVisible(transaction: KalendrTransaction, context: StaffContext, blockId: string): Promise<void> {
  if (!isLimitedToLocations(context)) return;
  const [block] = await transaction.select({ locationId: scheduleBlocks.locationId }).from(scheduleBlocks)
    .where(and(eq(scheduleBlocks.tenantId, context.tenantId), eq(scheduleBlocks.id, blockId))).limit(1);
  if (block && (!block.locationId || !canUseLocation(context, block.locationId))) throw new ApiError(404, "schedule_block_not_found", "That closed time was not found.");
}

export async function createStaffScheduleBlock(
  context: StaffContext,
  input: StaffCreateScheduleBlockInput,
): Promise<{ blockId: string }> {
  requirePermission(context, "hours.edit");
  return withTenant(context.tenantId, async (transaction) => {
    const t = await wordsIn(transaction, context.tenantId);
    const practitionerId = input.practitionerId || null;
    const locationId = input.locationId || null;
    assertBlockLocation(context, locationId);
    if (practitionerId) {
      const [practitioner] = await transaction
        .select({ id: practitioners.id })
        .from(practitioners)
        .where(and(eq(practitioners.tenantId, context.tenantId), eq(practitioners.id, practitionerId)))
        .limit(1);
      if (!practitioner) throw new ApiError(400, "practitioner_not_found", `Choose ${t.aPractitioner} who belongs to this ${t.business}.`);
    }
    if (locationId) {
      const [location] = await transaction
        .select({ id: locations.id })
        .from(locations)
        .where(and(eq(locations.tenantId, context.tenantId), eq(locations.id, locationId)))
        .limit(1);
      if (!location) throw new ApiError(400, "location_not_found", `Choose ${t.aBusiness} ${t.location}.`);
    }
    const [created] = await transaction.insert(scheduleBlocks).values({
      tenantId: context.tenantId,
      practitionerId,
      locationId,
      startsAt: new Date(input.startsAt),
      endsAt: new Date(input.endsAt),
      reason: input.reason,
    }).returning({ id: scheduleBlocks.id });
    if (!created) throw new Error("Schedule block insert returned no row");
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId,
      actorUserId: context.userId,
      actorType: "staff",
      action: "settings.schedule_block.created",
      outcome: "success",
      metadata: { blockId: created.id },
    });
    return { blockId: created.id };
  });
}

/** Edits a closed time in place, with the same checks as when it was made. */
export async function updateStaffScheduleBlock(
  context: StaffContext,
  blockId: string,
  input: StaffUpdateScheduleBlockInput,
): Promise<{ blockId: string }> {
  requirePermission(context, "hours.edit");
  return withTenant(context.tenantId, async (transaction) => {
    const t = await wordsIn(transaction, context.tenantId);
    const practitionerId = input.practitionerId || null;
    const locationId = input.locationId || null;
    assertBlockLocation(context, locationId);
    await assertExistingBlockVisible(transaction, context, blockId);
    if (practitionerId) {
      const [practitioner] = await transaction
        .select({ id: practitioners.id })
        .from(practitioners)
        .where(and(eq(practitioners.tenantId, context.tenantId), eq(practitioners.id, practitionerId)))
        .limit(1);
      if (!practitioner) throw new ApiError(400, "practitioner_not_found", `Choose ${t.aPractitioner} who belongs to this ${t.business}.`);
    }
    if (locationId) {
      const [location] = await transaction
        .select({ id: locations.id })
        .from(locations)
        .where(and(eq(locations.tenantId, context.tenantId), eq(locations.id, locationId)))
        .limit(1);
      if (!location) throw new ApiError(400, "location_not_found", `Choose ${t.aBusiness} ${t.location}.`);
    }
    const [updated] = await transaction
      .update(scheduleBlocks)
      .set({
        practitionerId,
        locationId,
        startsAt: new Date(input.startsAt),
        endsAt: new Date(input.endsAt),
        reason: input.reason,
        updatedAt: new Date(),
      })
      .where(and(eq(scheduleBlocks.tenantId, context.tenantId), eq(scheduleBlocks.id, blockId)))
      .returning({ id: scheduleBlocks.id });
    if (!updated) throw new ApiError(404, "schedule_block_not_found", "That closed time was not found.");
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId,
      actorUserId: context.userId,
      actorType: "staff",
      action: "settings.schedule_block.updated",
      outcome: "success",
      metadata: { blockId },
    });
    return { blockId };
  });
}

export async function deleteStaffScheduleBlock(
  context: StaffContext,
  blockId: string,
): Promise<{ blockId: string }> {
  requirePermission(context, "hours.edit");
  return withTenant(context.tenantId, async (transaction) => {
    await assertExistingBlockVisible(transaction, context, blockId);
    const [deleted] = await transaction
      .delete(scheduleBlocks)
      .where(and(eq(scheduleBlocks.tenantId, context.tenantId), eq(scheduleBlocks.id, blockId)))
      .returning({ id: scheduleBlocks.id, practitionerId: scheduleBlocks.practitionerId, locationId: scheduleBlocks.locationId, startsAt: scheduleBlocks.startsAt, endsAt: scheduleBlocks.endsAt });
    if (!deleted) throw new ApiError(404, "schedule_block_not_found", "That closed time was not found.");
    await offerFreedRangeHook(transaction, context.tenantId, deleted); // feature 21: the times it opened go to the waitlist
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId,
      actorUserId: context.userId,
      actorType: "staff",
      action: "settings.schedule_block.deleted",
      outcome: "success",
      metadata: { blockId },
    });
    return { blockId };
  });
}

export async function createStaffResource(
  context: StaffContext,
  input: StaffCreateResourceInput,
): Promise<{ resourceId: string }> {
  requirePermission(context, "settings.manage");
  return withTenant(context.tenantId, async (transaction) => {
    const t = await wordsIn(transaction, context.tenantId);
    const locationRows = await transaction
      .select({ id: locations.id })
      .from(locations)
      .where(eq(locations.tenantId, context.tenantId));
    const locationId = input.locationId ?? locationRows[0]?.id;
    if (!locationId) {
      throw new ApiError(400, "location_not_found", `Add ${t.aBusiness} ${t.location} before creating a room or chair.`);
    }
    const [created] = await transaction.insert(resources).values({
      tenantId: context.tenantId,
      locationId,
      name: input.name,
      kind: input.kind,
    }).returning({ id: resources.id });
    if (!created) throw new Error("Resource insert returned no row");
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId,
      actorUserId: context.userId,
      actorType: "staff",
      action: "settings.resource.created",
      outcome: "success",
      metadata: { resourceId: created.id },
    });
    return { resourceId: created.id };
  });
}

/** Renames a room or chair, or takes it out of (or back into) use. Like services, it can be switched off at any time; past visits keep their record. */
export async function updateStaffResource(
  context: StaffContext,
  resourceId: string,
  input: StaffUpdateResourceInput,
): Promise<{ resourceId: string }> {
  requirePermission(context, "settings.manage");
  return withTenant(context.tenantId, async (transaction) => {
    const [updated] = await transaction
      .update(resources)
      .set({
        ...(input.name ? { name: input.name } : {}),
        ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(resources.tenantId, context.tenantId), eq(resources.id, resourceId)))
      .returning({ id: resources.id });
    if (!updated) throw new ApiError(404, "resource_not_found", "That room or chair was not found.");
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId,
      actorUserId: context.userId,
      actorType: "staff",
      action: "settings.resource.updated",
      outcome: "success",
      metadata: { resourceId },
    });
    return { resourceId };
  });
}

export async function updateStaffClinicProfile(
  context: StaffContext,
  input: StaffClinicProfileInput,
): Promise<{ clinicName: string }> {
  requirePermission(context, "settings.manage");
  return withTenant(context.tenantId, async (transaction) => {
    const t = await wordsIn(transaction, context.tenantId);
    if (input.name || input.legalName || input.phone || input.about !== undefined) {
      await transaction.update(tenants).set({
        ...(input.name ? { name: input.name } : {}),
        ...(input.about !== undefined ? { about: input.about || null } : {}),
        ...(input.legalName ? { legalName: input.legalName } : {}),
        ...(input.phone ? { phone: input.phone } : {}),
        updatedAt: new Date(),
      }).where(eq(tenants.id, context.tenantId));
    }
    if (input.city || input.address || input.locationName) {
      const [location] = await transaction
        .select({ id: locations.id })
        .from(locations)
        .where(eq(locations.tenantId, context.tenantId))
        .limit(1);
      if (!location) throw new ApiError(404, "location_not_found", `${t.Business} ${t.location} not found.`);
      await transaction.update(locations).set({
        ...(input.city ? { city: input.city } : {}),
        ...(input.address ? { address: input.address } : {}),
        ...(input.locationName ? { name: input.locationName } : {}),
        updatedAt: new Date(),
      }).where(and(eq(locations.tenantId, context.tenantId), eq(locations.id, location.id)));
    }
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId,
      actorUserId: context.userId,
      actorType: "staff",
      action: "settings.clinic.updated",
      outcome: "success",
      metadata: {},
    });
    return { clinicName: input.name ?? context.clinicName };
  });
}
