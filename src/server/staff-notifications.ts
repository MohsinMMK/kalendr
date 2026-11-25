import "server-only";

import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { z } from "zod";

import { withTenant, type KalendrTransaction } from "@/db/client";
import { appointments, auditEvents, customRoles, membershipLocations, memberships, notificationPreferences, outboxEvents, patients, practitioners, pushSubscriptions, services, staffNotifications, tenants } from "@/db/schema";
import type { StaffRole } from "@/lib/permissions";
import { effectiveFrequency, summaryFrequencySchema, type SummaryFrequency } from "@/lib/owner-summary";
import { minuteSchema } from "@/lib/quiet-hours";
import { planStaffAlert, defaultChannels } from "@/lib/staff-alert-plan";
import {
  alertDetail,
  alertKinds,
  alertTime,
  alertTitle,
  appointmentLink,
  mayReceiveAlert,
  PUSH_SECRET_PURPOSE,
  pushJobSchema,
  STAFF_EMAIL_EVENT,
  staffEmailJobSchema,
  type StaffEmailJob,
  pushSubscriptionInputSchema,
  type PushJob,
  type AlertKind,
  type NotificationList,
  type PreferenceView,
} from "@/lib/staff-alerts";
import { logger, errorSummary } from "@/server/logger";

import { ApiError } from "./api-error";
import { env } from "./env";
import { currentTraceParent } from "./tracing";
import { loadRecordKeys } from "./record-crypto";
import { sealSecret, secretKeyVersion } from "./keys/secrets";
import type { StaffContext } from "./staff-context";

const LIST_LIMIT = 40;

export interface AlertInput {
  kind: AlertKind;
  /** The appointment the alert is about; it fills the link and the time in the title. */
  appointmentId?: string;
  startsAt?: Date;
  /** The person a class is taught by, for an alert about a class seat (no appointment): only they, and staff who see everything, hear it. */
  practitionerId?: string;
  /** The location the event happened at, when there is no appointment to read it from. Staff limited to other locations are not told. */
  locationId?: string;
  /** Makes a repeat of the same event a no-op. */
  dedupeKey: string;
  /** The person who did it, so they are not told about their own action. */
  exceptUserId?: string | null;
  link?: string;
}

/**
 * Tells the right staff, inside the transaction that changed something: a row for the bell (when they
 * left it on) and a push job for the worker (when they left it on and have a device). It runs in its
 * own savepoint, so an alert that fails never undoes the booking or the payment it is about.
 */
export async function notifyStaff(transaction: KalendrTransaction, tenantId: string, input: AlertInput): Promise<void> {
  try {
    await transaction.transaction((savepoint) => writeAlerts(savepoint, tenantId, input));
  } catch (error: unknown) {
    logger().warn({ event: "alerts.write_failed", tenantId, kind: input.kind, ...errorSummary(error) }, "A staff alert could not be written");
  }
}

interface AppointmentFacts {
  practitionerUserId: string | null;
  firstName: string | null;
  service: string | null;
  startsAt: Date | null;
  locationId: string | null;
}

async function appointmentFacts(transaction: KalendrTransaction, tenantId: string, appointmentId: string | undefined): Promise<AppointmentFacts | null> {
  if (!appointmentId) return null;
  const [row] = await transaction.select({
    practitionerUserId: practitioners.authUserId, firstName: patients.firstName, service: services.name, startsAt: appointments.startsAt,
    locationId: appointments.locationId,
  }).from(appointments)
    .leftJoin(practitioners, and(eq(practitioners.tenantId, appointments.tenantId), eq(practitioners.id, appointments.practitionerId)))
    .leftJoin(patients, and(eq(patients.tenantId, appointments.tenantId), eq(patients.id, appointments.patientId)))
    .leftJoin(services, and(eq(services.tenantId, appointments.tenantId), eq(services.id, appointments.serviceId)))
    .where(and(eq(appointments.tenantId, tenantId), eq(appointments.id, appointmentId))).limit(1);
  return row ?? null;
}

/**
 * Drops staff limited to other locations. An owner, and anyone with no location rows, hears about
 * every location. Without a known location the alert stays business-wide.
 */
async function staffAtLocation<T extends { id: string; role: string }>(transaction: KalendrTransaction, tenantId: string, people: T[], locationId: string | null): Promise<T[]> {
  if (!locationId || !people.length) return people;
  const rows = await transaction.select({ membershipId: membershipLocations.membershipId, locationId: membershipLocations.locationId })
    .from(membershipLocations)
    .where(and(eq(membershipLocations.tenantId, tenantId), inArray(membershipLocations.membershipId, people.map((person) => person.id))));
  const limits = new Map<string, Set<string>>();
  for (const row of rows) limits.set(row.membershipId, (limits.get(row.membershipId) ?? new Set()).add(row.locationId));
  return people.filter((person) => person.role === "owner" || !limits.has(person.id) || limits.get(person.id)!.has(locationId));
}

async function writeAlerts(transaction: KalendrTransaction, tenantId: string, input: AlertInput): Promise<void> {
  const [tenant] = await transaction.select({ timezone: tenants.timezone }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const timeZone = tenant?.timezone ?? "UTC";
  let facts = await appointmentFacts(transaction, tenantId, input.appointmentId);
  if (!facts && input.practitionerId) {
    const [teacher] = await transaction.select({ authUserId: practitioners.authUserId }).from(practitioners)
      .where(and(eq(practitioners.tenantId, tenantId), eq(practitioners.id, input.practitionerId))).limit(1);
    facts = { practitionerUserId: teacher?.authUserId ?? null, firstName: null, service: null, startsAt: null, locationId: null };
  }
  const startsAt = input.startsAt ?? facts?.startsAt ?? undefined;
  const when = startsAt ? alertTime(startsAt, timeZone) : undefined;
  const title = alertTitle(input.kind, when);
  const detail = alertDetail({ firstName: facts?.firstName, service: facts?.service, when });
  const link = input.link ?? (input.appointmentId ? appointmentLink(input.appointmentId) : null);

  const everyone = await transaction.select({
    id: memberships.id, userId: memberships.userId, role: memberships.role, overrides: memberships.permissionOverrides,
    quietStartMinute: memberships.quietStartMinute, quietEndMinute: memberships.quietEndMinute,
    customPermissions: customRoles.permissions,
  }).from(memberships).leftJoin(customRoles, and(eq(customRoles.tenantId, memberships.tenantId), eq(customRoles.id, memberships.customRoleId))).where(and(eq(memberships.tenantId, tenantId), eq(memberships.isActive, true)));
  const people = await staffAtLocation(transaction, tenantId, everyone, input.locationId ?? facts?.locationId ?? null);
  if (!people.length) return;

  const ids = people.map((person) => person.id);
  const choices = await transaction.select().from(notificationPreferences).where(and(
    eq(notificationPreferences.tenantId, tenantId),
    eq(notificationPreferences.kind, input.kind),
    inArray(notificationPreferences.membershipId, ids),
  ));
  const choiceOf = new Map(choices.map((row) => [row.membershipId, { inApp: row.inApp, push: row.push, email: row.email }]));
  const devices = await transaction.selectDistinct({ membershipId: pushSubscriptions.membershipId }).from(pushSubscriptions)
    .where(and(eq(pushSubscriptions.tenantId, tenantId), inArray(pushSubscriptions.membershipId, ids)));
  const withDevice = new Set(devices.map((row) => row.membershipId));

  const plan = planStaffAlert({
    kind: input.kind,
    members: people.map((person) => ({
      id: person.id, userId: person.userId, role: person.role as StaffRole, overrides: person.overrides, customPermissions: person.customPermissions,
      quietStartMinute: person.quietStartMinute, quietEndMinute: person.quietEndMinute,
      choice: choiceOf.get(person.id) ?? null, hasPushDevice: withDevice.has(person.id),
    })),
    exceptUserId: input.exceptUserId,
    appointmentPractitionerUserId: facts?.practitionerUserId,
    aboutAppointment: Boolean(input.appointmentId) || Boolean(input.practitionerId),
    now: new Date(),
    timeZone,
  });

  for (const entry of plan) {
    if (entry.inApp) {
      await transaction.insert(staffNotifications).values({
        tenantId, membershipId: entry.membershipId, kind: input.kind, title, link, dedupeKey: input.dedupeKey,
      }).onConflictDoNothing();
    }
    if (entry.push) {
      await queuePush(transaction, tenantId, { membershipId: entry.membershipId, title, ...(detail ? { body: detail } : {}), link: link ?? undefined, kind: input.kind }, input.dedupeKey, entry.push.availableAt);
    }
    if (entry.email) {
      await queueStaffEmail(transaction, tenantId, { membershipId: entry.membershipId, kind: input.kind, title, ...(detail ? { body: detail } : {}), ...(link ? { link } : {}) }, input.dedupeKey, entry.email.availableAt);
    }
  }
}

/** One outbox row per push; the worker sends it. */
export async function queuePush(transaction: KalendrTransaction, tenantId: string, job: PushJob, dedupeKey: string, availableAt?: Date): Promise<void> {
  const owner = job.membershipId ?? job.patientId ?? "none";
  await transaction.insert(outboxEvents).values({
    tenantId,
    aggregateType: "push",
    aggregateId: owner,
    eventType: PUSH_EVENT,
    payload: pushJobSchema.parse(job),
    dedupeKey: `push:${owner}:${dedupeKey}`.slice(0, 200),
    traceParent: currentTraceParent(),
    ...(availableAt ? { availableAt } : {}),
  }).onConflictDoNothing();
}

/** One outbox row per alert email; the worker sends it to the person's own address, after quiet hours when they have them. */
export async function queueStaffEmail(transaction: KalendrTransaction, tenantId: string, job: StaffEmailJob, dedupeKey: string, availableAt?: Date): Promise<void> {
  await transaction.insert(outboxEvents).values({
    tenantId,
    aggregateType: "staff_email",
    aggregateId: job.membershipId,
    eventType: STAFF_EMAIL_EVENT,
    payload: staffEmailJobSchema.parse(job),
    dedupeKey: `staff-email:${job.membershipId}:${dedupeKey}`.slice(0, 200),
    traceParent: currentTraceParent(),
    ...(availableAt ? { availableAt } : {}),
  }).onConflictDoNothing();
}

export const PUSH_EVENT = "push.send";

function requireMember(context: StaffContext): string {
  if (context.preview || !context.membershipId) throw new ApiError(400, "preview_only", "Alerts need a database.");
  return context.membershipId;
}

export async function listNotifications(context: StaffContext): Promise<NotificationList> {
  if (context.preview || !context.membershipId) return { items: [], unread: 0 };
  const membershipId = context.membershipId;
  return withTenant(context.tenantId, async (transaction) => {
    const rows = await transaction.select().from(staffNotifications)
      .where(and(eq(staffNotifications.tenantId, context.tenantId), eq(staffNotifications.membershipId, membershipId)))
      .orderBy(desc(staffNotifications.createdAt)).limit(LIST_LIMIT);
    const [count] = await transaction.select({ unread: sql<number>`count(*)::int` }).from(staffNotifications).where(and(
      eq(staffNotifications.tenantId, context.tenantId), eq(staffNotifications.membershipId, membershipId), isNull(staffNotifications.readAt),
    ));
    return {
      items: rows.map((row) => ({ id: row.id, kind: row.kind, title: row.title, link: row.link, read: row.readAt !== null, at: row.createdAt.toISOString() })),
      unread: count?.unread ?? 0,
    };
  });
}

export const markReadInputSchema = z.union([z.object({ ids: z.array(z.string().min(1).max(64)).min(1).max(100) }), z.object({ all: z.literal(true) })]);

/** Marks some or all of the caller's own alerts as read. Someone else's ids simply match nothing. */
export async function markNotificationsRead(context: StaffContext, input: z.infer<typeof markReadInputSchema>): Promise<NotificationList> {
  const membershipId = requireMember(context);
  await withTenant(context.tenantId, async (transaction) => {
    const own = and(eq(staffNotifications.tenantId, context.tenantId), eq(staffNotifications.membershipId, membershipId), isNull(staffNotifications.readAt));
    await transaction.update(staffNotifications).set({ readAt: new Date() })
      .where("all" in input ? own : and(own, inArray(staffNotifications.id, input.ids)));
  });
  return listNotifications(context);
}

export async function listPreferences(context: StaffContext): Promise<PreferenceView[]> {
  const stored = new Map<string, PreferenceView>();
  if (!context.preview && context.membershipId) {
    const membershipId = context.membershipId;
    const rows = await withTenant(context.tenantId, (transaction) => transaction.select().from(notificationPreferences)
      .where(and(eq(notificationPreferences.tenantId, context.tenantId), eq(notificationPreferences.membershipId, membershipId))));
    for (const row of rows) stored.set(row.kind, { kind: row.kind, inApp: row.inApp, push: row.push, email: row.email });
  }
  return alertKinds
    .filter((kind) => mayReceiveAlert(context.permissions, kind))
    .map((kind) => stored.get(kind) ?? { kind, ...defaultChannels(context.role) });
}

export const preferencesInputSchema = z.object({
  kind: z.enum(alertKinds),
  inApp: z.boolean(),
  push: z.boolean(),
  email: z.boolean(),
});

export async function setPreference(context: StaffContext, input: z.infer<typeof preferencesInputSchema>): Promise<PreferenceView[]> {
  const membershipId = requireMember(context);
  if (!mayReceiveAlert(context.permissions, input.kind)) throw new ApiError(403, "forbidden", "You don't get this kind of alert.");
  await withTenant(context.tenantId, async (transaction) => {
    await transaction.insert(notificationPreferences).values({
      tenantId: context.tenantId, membershipId, kind: input.kind, inApp: input.inApp, push: input.push, email: input.email,
    }).onConflictDoUpdate({
      target: [notificationPreferences.tenantId, notificationPreferences.membershipId, notificationPreferences.kind],
      set: { inApp: input.inApp, push: input.push, email: input.email, updatedAt: new Date() },
    });
  });
  return listPreferences(context);
}

export const quietHoursSchema = z.object({ start: minuteSchema, end: minuteSchema }).refine((value) => value.start !== value.end, "Quiet hours need different start and end times.");

/** Quiet hours and the morning digest. `quietHours` null is none. */
export const notificationSettingsInputSchema = z.object({
  quietHours: quietHoursSchema.nullable(),
  digest: z.object({ enabled: z.boolean(), minute: minuteSchema }),
  /** The owner's weekly or monthly summary. Left out, or sent by anyone but an owner, it changes nothing. */
  summaryFrequency: summaryFrequencySchema.optional(),
});
export type NotificationSettingsInput = z.infer<typeof notificationSettingsInputSchema>;

export interface MyNotificationSettings extends NotificationSettingsInput {
  preferences: PreferenceView[];
  /** The business's time zone, which both times are read in. */
  timezone: string;
  /** Whether the digest is on when the person never chose (owners and admins). */
  digestOnByDefault: boolean;
  /** The owner's weekly or monthly summary choice. `available` is false for everyone but owners, who are the only ones who get it. */
  summary: { frequency: SummaryFrequency; available: boolean };
}

export const DEFAULT_DIGEST_MINUTE = 420;

export async function getMyNotificationSettings(context: StaffContext): Promise<MyNotificationSettings> {
  const preferences = await listPreferences(context);
  const digestOnByDefault = context.role === "owner" || context.role === "admin";
  if (context.preview || !context.membershipId) {
    return { preferences, quietHours: null, digest: { enabled: digestOnByDefault, minute: DEFAULT_DIGEST_MINUTE }, timezone: "UTC", digestOnByDefault, summary: { frequency: effectiveFrequency(null, context.role), available: context.role === "owner" } };
  }
  const membershipId = context.membershipId;
  return withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction.select({
      start: memberships.quietStartMinute, end: memberships.quietEndMinute, enabled: memberships.digestEnabled, minute: memberships.digestMinute, timezone: tenants.timezone,
      summary: memberships.summaryFrequency,
    }).from(memberships).innerJoin(tenants, eq(tenants.id, memberships.tenantId))
      .where(and(eq(memberships.tenantId, context.tenantId), eq(memberships.id, membershipId))).limit(1);
    return {
      preferences,
      quietHours: row && row.start !== null && row.end !== null ? { start: row.start, end: row.end } : null,
      digest: { enabled: row?.enabled ?? digestOnByDefault, minute: row?.minute ?? DEFAULT_DIGEST_MINUTE },
      timezone: row?.timezone ?? "UTC",
      digestOnByDefault,
      summary: { frequency: effectiveFrequency(row?.summary ?? null, context.role), available: context.role === "owner" },
    };
  });
}

/** Saves the caller's own quiet hours and digest. Asking for the digest to be off or on is always their own choice. */
export async function saveMyNotificationSettings(context: StaffContext, input: NotificationSettingsInput): Promise<MyNotificationSettings> {
  const membershipId = requireMember(context);
  await withTenant(context.tenantId, async (transaction) => {
    await transaction.update(memberships).set({
      quietStartMinute: input.quietHours?.start ?? null, quietEndMinute: input.quietHours?.end ?? null,
      digestEnabled: input.digest.enabled, digestMinute: input.digest.minute, updatedAt: new Date(),
      // Only an owner has a summary to choose; anyone else's request for one is ignored.
      ...(input.summaryFrequency !== undefined && context.role === "owner" ? { summaryFrequency: input.summaryFrequency } : {}),
    }).where(and(eq(memberships.tenantId, context.tenantId), eq(memberships.id, membershipId)));
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "staff.notification_settings.updated", outcome: "success",
      metadata: { quietHours: input.quietHours !== null, digest: input.digest.enabled, ...(input.summaryFrequency !== undefined && context.role === "owner" ? { summary: input.summaryFrequency } : {}) },
    });
  });
  return getMyNotificationSettings(context);
}

export function endpointHash(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

/** The public half of the VAPID pair, which the browser needs to subscribe. Null when push is not set up. */
export function pushPublicKey(): string | null {
  return env().VAPID_PUBLIC_KEY ?? null;
}

/** Stores this browser's push address, sealed. Subscribing again from the same browser just refreshes it. */
export async function savePushSubscription(context: StaffContext, input: z.infer<typeof pushSubscriptionInputSchema>): Promise<{ saved: true }> {
  const membershipId = requireMember(context);
  await withTenant(context.tenantId, async (transaction) => {
    await loadRecordKeys(transaction, context.tenantId, { forWrite: true });
    const sealed = sealSecret(context.tenantId, PUSH_SECRET_PURPOSE, JSON.stringify({ endpoint: input.endpoint, keys: input.keys }));
    const values = { subscriptionCiphertext: sealed, keyVersion: secretKeyVersion(sealed) };
    await transaction.insert(pushSubscriptions).values({
      tenantId: context.tenantId, ownerType: "staff", membershipId, endpointHash: endpointHash(input.endpoint), ...values,
    }).onConflictDoUpdate({
      target: [pushSubscriptions.tenantId, pushSubscriptions.endpointHash],
      // The same browser signed in as someone else now belongs to them.
      set: { ...values, membershipId, patientId: null, ownerType: "staff" },
    });
  });
  return { saved: true };
}

export const pushUnsubscribeSchema = z.object({ endpoint: z.string().url().max(1_000) });

export async function removePushSubscription(context: StaffContext, endpoint: string): Promise<{ removed: boolean }> {
  const membershipId = requireMember(context);
  return withTenant(context.tenantId, async (transaction) => {
    const removed = await transaction.delete(pushSubscriptions).where(and(
      eq(pushSubscriptions.tenantId, context.tenantId),
      eq(pushSubscriptions.membershipId, membershipId),
      eq(pushSubscriptions.endpointHash, endpointHash(endpoint)),
    )).returning({ id: pushSubscriptions.id });
    return { removed: removed.length > 0 };
  });
}
