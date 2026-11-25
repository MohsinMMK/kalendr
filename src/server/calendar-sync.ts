import "server-only";

import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";

import { withTenant, type KalendrTransaction } from "@/db/client";
import {
  appointmentEventLinks,
  appointments,
  auditEvents,
  authUsers,
  calendarBusinessSettings,
  calendarConnections,
  calendarFeedTokens,
  calendarSelections,
  externalBusy,
  memberships,
  outboxEvents,
} from "@/db/schema";
import {
  CALENDAR_CREDENTIALS_PURPOSE,
  CALENDAR_DISCONNECT_EVENT,
  CALENDAR_VERIFY_EVENT,
  CALENDAR_WRITE_EVENT,
  MAX_CALENDAR_CONNECTIONS_PER_STAFF,
  calendarOverviewSchema,
  calendarProviderIds,
  eventTextSchema,
  type AppleConnectInput,
  type CalendarOverview,
  type CalendarProviderName,
  type EventTextSetting,
  type SelectionPatch,
} from "@/lib/calendar-sync";
import { ICLOUD_SERVER_URL } from "@/server/calendars";
import { calendarMode, providerStates } from "@/server/calendars/runtime";
import type { ProviderCredentials } from "@/server/calendars/provider";

import { ApiError } from "./api-error";
import { listOpenConflicts } from "./calendar-conflicts";
import { newFeedToken } from "./calendar-feed-token";
import { appOrigin } from "./env";
import { sealSecret, secretKeyVersion } from "./keys/secrets";
import { loadRecordKeys } from "./record-crypto";
import { can, type StaffContext } from "./staff-context";

/** What someone with only their own calendars may do, and what the owner may additionally see. */
function requireCalendarAccess(context: StaffContext): { membershipId: string; manage: boolean } {
  if (context.preview || !context.membershipId) {
    throw new ApiError(409, "calendar_unavailable", "Calendar sync is not available in the preview.");
  }
  const manage = can(context, "calendars.manage");
  if (!manage && !can(context, "calendars.own")) throw new ApiError(403, "forbidden", "You don't have permission to connect calendars.");
  return { membershipId: context.membershipId, manage };
}

/** The same, for actions that only change the caller's own connections. */
export function requireOwnCalendars(context: StaffContext): string {
  if (context.preview || !context.membershipId) {
    throw new ApiError(409, "calendar_unavailable", "Calendar sync is not available in the preview.");
  }
  if (!can(context, "calendars.own")) throw new ApiError(403, "forbidden", "You don't have permission to connect calendars.");
  return context.membershipId;
}

export async function recordCalendarAudit(
  transaction: KalendrTransaction,
  context: StaffContext,
  action: string,
  metadata: Record<string, string | number | boolean | null>,
): Promise<void> {
  await transaction.insert(auditEvents).values({
    tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action, outcome: "success", metadata,
  });
}

export async function queueCalendarEvent(
  transaction: KalendrTransaction,
  tenantId: string,
  event: { type: string; aggregateType: string; aggregateId: string; payload: Record<string, unknown>; dedupeKey: string },
): Promise<void> {
  await transaction.insert(outboxEvents).values({
    tenantId, aggregateType: event.aggregateType, aggregateId: event.aggregateId, eventType: event.type,
    payload: event.payload, dedupeKey: event.dedupeKey.slice(0, 200),
  }).onConflictDoNothing();
}

const unavailableOverview: CalendarOverview = {
  mode: "unavailable",
  providers: calendarProviderIds.map((provider) => ({
    provider, available: false, reason: "Calendar sync is not available in the preview.",
  })),
  maxConnections: MAX_CALENDAR_CONNECTIONS_PER_STAFF,
  connections: [],
  conflicts: [],
  eventText: "busy_only",
  canManageSettings: false,
  feed: { active: false, createdAt: null },
};

async function getEventTextSetting(transaction: KalendrTransaction, tenantId: string): Promise<EventTextSetting> {
  const [row] = await transaction.select({ eventText: calendarBusinessSettings.eventText }).from(calendarBusinessSettings)
    .where(eq(calendarBusinessSettings.tenantId, tenantId)).limit(1);
  const parsed = eventTextSchema.safeParse(row?.eventText);
  return parsed.success ? parsed.data : "busy_only";
}

/** Everything the "My calendars" screen shows. The owner sees every connection's status; others see only their own. */
export async function getCalendarOverview(context: StaffContext): Promise<CalendarOverview> {
  if (context.preview) return unavailableOverview;
  const { membershipId, manage } = requireCalendarAccess(context);
  return withTenant(context.tenantId, async (transaction) => {
    const scope = manage
      ? eq(calendarConnections.tenantId, context.tenantId)
      : and(eq(calendarConnections.tenantId, context.tenantId), eq(calendarConnections.membershipId, membershipId));
    const connections = await transaction.select({
      id: calendarConnections.id,
      provider: calendarConnections.provider,
      accountEmail: calendarConnections.accountEmail,
      status: calendarConnections.status,
      lastErrorCode: calendarConnections.lastErrorCode,
      membershipId: calendarConnections.membershipId,
      ownerName: authUsers.name,
    }).from(calendarConnections)
      .innerJoin(memberships, and(eq(memberships.tenantId, calendarConnections.tenantId), eq(memberships.id, calendarConnections.membershipId)))
      .innerJoin(authUsers, eq(authUsers.id, memberships.userId))
      .where(and(scope, ne(calendarConnections.status, "disconnecting")))
      .orderBy(asc(calendarConnections.createdAt));
    const ids = connections.map((connection) => connection.id);
    const selections = ids.length
      ? await transaction.select().from(calendarSelections)
        .where(and(eq(calendarSelections.tenantId, context.tenantId), inArray(calendarSelections.connectionId, ids)))
        .orderBy(sql`${calendarSelections.isPrimary} desc`, asc(calendarSelections.name))
      : [];
    const [feed] = await transaction.select({ createdAt: calendarFeedTokens.createdAt }).from(calendarFeedTokens)
      .where(and(eq(calendarFeedTokens.tenantId, context.tenantId), eq(calendarFeedTokens.membershipId, membershipId))).limit(1);
    const states = providerStates();
    return calendarOverviewSchema.parse({
      mode: calendarMode(),
      providers: states,
      maxConnections: MAX_CALENDAR_CONNECTIONS_PER_STAFF,
      connections: connections.map((connection) => ({
        id: connection.id,
        provider: connection.provider,
        accountEmail: connection.accountEmail,
        status: connection.status,
        lastErrorCode: connection.lastErrorCode,
        ownerName: connection.ownerName,
        mine: connection.membershipId === membershipId,
        calendars: selections.filter((selection) => selection.connectionId === connection.id).map((selection) => ({
          id: selection.id,
          name: selection.name,
          primary: selection.isPrimary,
          canWrite: selection.canWrite,
          blocksAvailability: selection.blocksAvailability,
          writesHere: selection.writesHere,
          lastSyncedAt: selection.lastSyncedAt?.toISOString() ?? null,
          version: selection.version,
        })),
      })),
      conflicts: await listOpenConflicts(transaction, context.tenantId, manage ? null : membershipId),
      eventText: await getEventTextSetting(transaction, context.tenantId),
      canManageSettings: manage,
      feed: { active: Boolean(feed), createdAt: feed?.createdAt.toISOString() ?? null },
    });
  });
}

/** Seals a login for storage. The business's keys must be loaded first. */
function sealCredentials(tenantId: string, credentials: ProviderCredentials): { ciphertext: string; keyVersion: number } {
  const ciphertext = sealSecret(tenantId, CALENDAR_CREDENTIALS_PURPOSE, JSON.stringify(credentials));
  return { ciphertext, keyVersion: secretKeyVersion(ciphertext) };
}

/**
 * Saves a login as a connection that the worker will check. Connecting the same account again (to fix
 * "Needs reconnecting") replaces the login and keeps the person's calendar choices.
 */
export async function saveConnection(
  context: StaffContext,
  membershipId: string,
  provider: CalendarProviderName,
  accountEmail: string | null,
  credentials: ProviderCredentials,
): Promise<{ connectionId: string }> {
  return withTenant(context.tenantId, async (transaction) => {
    await loadRecordKeys(transaction, context.tenantId, { forWrite: true });
    const sealed = sealCredentials(context.tenantId, credentials);
    const mine = await transaction.select({ id: calendarConnections.id, accountEmail: calendarConnections.accountEmail, provider: calendarConnections.provider })
      .from(calendarConnections)
      .where(and(eq(calendarConnections.tenantId, context.tenantId), eq(calendarConnections.membershipId, membershipId), ne(calendarConnections.status, "disconnecting")))
      .for("update");
    const same = mine.find((row) => row.provider === provider && (accountEmail === null || row.accountEmail?.toLowerCase() === accountEmail.toLowerCase()));
    let connectionId: string;
    if (same) {
      connectionId = same.id;
      await transaction.update(calendarConnections).set({
        credentialsCiphertext: sealed.ciphertext, keyVersion: sealed.keyVersion, status: "pending", lastErrorCode: null,
        version: sql`${calendarConnections.version} + 1`, updatedAt: new Date(),
      }).where(and(eq(calendarConnections.tenantId, context.tenantId), eq(calendarConnections.id, same.id)));
    } else {
      if (mine.length >= MAX_CALENDAR_CONNECTIONS_PER_STAFF) {
        throw new ApiError(409, "calendar_limit", `You can connect up to ${MAX_CALENDAR_CONNECTIONS_PER_STAFF} calendar accounts. Disconnect one first.`);
      }
      const [inserted] = await transaction.insert(calendarConnections).values({
        tenantId: context.tenantId, membershipId, provider, accountEmail,
        credentialsCiphertext: sealed.ciphertext, keyVersion: sealed.keyVersion, status: "pending",
      }).returning({ id: calendarConnections.id });
      if (!inserted) throw new Error("Calendar connection was not saved");
      connectionId = inserted.id;
    }
    await recordCalendarAudit(transaction, context, same ? "calendar.reconnected" : "calendar.connected", { provider, connectionId });
    await queueCalendarEvent(transaction, context.tenantId, {
      type: CALENDAR_VERIFY_EVENT, aggregateType: "calendar_connection", aggregateId: connectionId,
      payload: { connectionId }, dedupeKey: `calendar.verify:${connectionId}:${Date.now().toString(36)}`,
    });
    return { connectionId };
  });
}

export function appleCredentials(input: AppleConnectInput): ProviderCredentials {
  return { kind: "caldav", provider: "apple", serverUrl: ICLOUD_SERVER_URL, username: input.appleId, appPassword: input.appPassword };
}

/** Tick "blocks my availability" or choose where new bookings are written. Only the calendar's owner may. */
export async function updateSelection(context: StaffContext, selectionId: string, patch: SelectionPatch): Promise<CalendarOverview> {
  const membershipId = requireOwnCalendars(context);
  await withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction.select().from(calendarSelections)
      .where(and(eq(calendarSelections.tenantId, context.tenantId), eq(calendarSelections.id, selectionId))).for("update");
    if (!row || row.membershipId !== membershipId) throw new ApiError(404, "calendar_not_found", "That calendar was not found.");
    if (row.version !== patch.version) throw new ApiError(409, "version_conflict", "This changed on another screen. Reloaded.");
    if (patch.writesHere === true && !row.canWrite) {
      throw new ApiError(409, "calendar_read_only", "This calendar is read-only, so Kalendr cannot add bookings to it.");
    }
    if (patch.writesHere === true) {
      await transaction.update(calendarSelections).set({ writesHere: false, version: sql`${calendarSelections.version} + 1`, updatedAt: new Date() })
        .where(and(eq(calendarSelections.tenantId, context.tenantId), eq(calendarSelections.membershipId, membershipId), eq(calendarSelections.writesHere, true)));
    }
    const blocks = patch.blocksAvailability ?? row.blocksAvailability;
    await transaction.update(calendarSelections).set({
      blocksAvailability: blocks,
      writesHere: patch.writesHere ?? row.writesHere,
      // A calendar switched on starts from a fresh read.
      ...(blocks && !row.blocksAvailability ? { syncToken: null, lastSnapshotAt: null } : {}),
      version: row.version + 1,
      updatedAt: new Date(),
    }).where(and(eq(calendarSelections.tenantId, context.tenantId), eq(calendarSelections.id, selectionId)));
    if (!blocks && row.blocksAvailability) {
      await transaction.delete(externalBusy).where(and(eq(externalBusy.tenantId, context.tenantId), eq(externalBusy.selectionId, selectionId)));
    }
    if ((blocks && !row.blocksAvailability) || (patch.writesHere === true && !row.writesHere)) {
      await queueCalendarEvent(transaction, context.tenantId, {
        type: "calendar.sync", aggregateType: "calendar_selection", aggregateId: selectionId,
        payload: { selectionId, resnapshot: true }, dedupeKey: `calendar.sync:${selectionId}:choice:${row.version + 1}`,
      });
    }
    await recordCalendarAudit(transaction, context, "calendar.selection_changed", {
      selectionId, blocksAvailability: blocks, writesHere: patch.writesHere ?? row.writesHere,
    });
  });
  return getCalendarOverview(context);
}

/**
 * Stops using a connection: it disappears from the screen and its busy time is dropped at once; the worker
 * then stops the provider's channels and deletes the rest. The person's own calendar is left as it is.
 */
export async function disconnectCalendar(context: StaffContext, connectionId: string): Promise<CalendarOverview> {
  const membershipId = requireOwnCalendars(context);
  await withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction.select({ id: calendarConnections.id, membershipId: calendarConnections.membershipId, status: calendarConnections.status, provider: calendarConnections.provider })
      .from(calendarConnections).where(and(eq(calendarConnections.tenantId, context.tenantId), eq(calendarConnections.id, connectionId))).for("update");
    if (!row || row.membershipId !== membershipId) throw new ApiError(404, "calendar_not_found", "That calendar account was not found.");
    if (row.status === "disconnecting") return;
    await transaction.update(calendarConnections).set({ status: "disconnecting", version: sql`${calendarConnections.version} + 1`, updatedAt: new Date() })
      .where(and(eq(calendarConnections.tenantId, context.tenantId), eq(calendarConnections.id, connectionId)));
    const selectionIds = (await transaction.select({ id: calendarSelections.id }).from(calendarSelections)
      .where(and(eq(calendarSelections.tenantId, context.tenantId), eq(calendarSelections.connectionId, connectionId)))).map((selection) => selection.id);
    if (selectionIds.length) {
      await transaction.delete(externalBusy).where(and(eq(externalBusy.tenantId, context.tenantId), inArray(externalBusy.selectionId, selectionIds)));
    }
    await queueCalendarEvent(transaction, context.tenantId, {
      type: CALENDAR_DISCONNECT_EVENT, aggregateType: "calendar_connection", aggregateId: connectionId,
      payload: { connectionId }, dedupeKey: `calendar.disconnect:${connectionId}`,
    });
    await recordCalendarAudit(transaction, context, "calendar.disconnected", { provider: row.provider, connectionId });
  });
  return getCalendarOverview(context);
}

/** How much of an appointment is written into calendars and the private feed. Owner and admins only. */
export async function setEventText(context: StaffContext, eventText: EventTextSetting): Promise<CalendarOverview> {
  if (context.preview || !context.membershipId) throw new ApiError(409, "calendar_unavailable", "Calendar sync is not available in the preview.");
  if (!can(context, "calendars.manage")) throw new ApiError(403, "forbidden", "You don't have permission to manage calendar sync.");
  await withTenant(context.tenantId, async (transaction) => {
    const [saved] = await transaction.insert(calendarBusinessSettings).values({ tenantId: context.tenantId, eventText })
      .onConflictDoUpdate({
        target: calendarBusinessSettings.tenantId,
        set: { eventText, version: sql`${calendarBusinessSettings.version} + 1`, updatedAt: new Date() },
      }).returning({ version: calendarBusinessSettings.version });
    // Events already written follow the new setting the next time they are reconciled.
    const upcoming = await transaction.select({ appointmentId: appointmentEventLinks.appointmentId }).from(appointmentEventLinks)
      .innerJoin(appointments, and(eq(appointments.tenantId, appointmentEventLinks.tenantId), eq(appointments.id, appointmentEventLinks.appointmentId)))
      .where(and(eq(appointmentEventLinks.tenantId, context.tenantId), eq(appointmentEventLinks.status, "active"), sql`${appointments.startsAt} > now()`));
    for (const link of upcoming) {
      await queueCalendarEvent(transaction, context.tenantId, {
        type: CALENDAR_WRITE_EVENT, aggregateType: "appointment", aggregateId: link.appointmentId,
        payload: { appointmentId: link.appointmentId, refresh: true, text: eventText },
        dedupeKey: `calendar.write:${link.appointmentId}:text:${saved?.version ?? 0}`,
      });
    }
    await recordCalendarAudit(transaction, context, "calendar.event_text_changed", { eventText });
  });
  return getCalendarOverview(context);
}

/** A new private feed address; the older one stops working. The address is shown once and only its hash is kept. */
export async function createFeed(context: StaffContext): Promise<{ url: string; createdAt: string }> {
  const membershipId = requireOwnCalendars(context);
  const { token, hash } = newFeedToken();
  const createdAt = new Date();
  await withTenant(context.tenantId, async (transaction) => {
    await transaction.delete(calendarFeedTokens).where(and(eq(calendarFeedTokens.tenantId, context.tenantId), eq(calendarFeedTokens.membershipId, membershipId)));
    await transaction.insert(calendarFeedTokens).values({ tenantId: context.tenantId, membershipId, tokenHash: hash, createdAt });
    await recordCalendarAudit(transaction, context, "calendar.feed_created", {});
  });
  return { url: `${appOrigin()}/api/calendar-feed/${token}.ics`, createdAt: createdAt.toISOString() };
}

export async function revokeFeed(context: StaffContext): Promise<CalendarOverview> {
  const membershipId = requireOwnCalendars(context);
  await withTenant(context.tenantId, async (transaction) => {
    const removed = await transaction.delete(calendarFeedTokens)
      .where(and(eq(calendarFeedTokens.tenantId, context.tenantId), eq(calendarFeedTokens.membershipId, membershipId))).returning({ id: calendarFeedTokens.id });
    if (removed.length) await recordCalendarAudit(transaction, context, "calendar.feed_revoked", {});
  });
  return getCalendarOverview(context);
}
