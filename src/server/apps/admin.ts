import "server-only";

import { randomUUID } from "node:crypto";

import { and, desc, eq } from "drizzle-orm";

import { withTenant, type KalendrTransaction } from "@/db/client";
import { appEvents, appInstalls, auditEvents, outboxEvents } from "@/db/schema";
import {
  installAppInput, replaceCredentialsInput, appStatusInput, updateAppInput,
  type AppCard, type AppDetail, type AppEventView, type AppState,
} from "@/lib/apps/catalog";
import { ApiError } from "@/server/api-error";
import { requireFeature } from "@/server/entitlements";
import { sealSecret, secretKeyVersion } from "@/server/keys/secrets";
import { loadRecordKeys } from "@/server/record-crypto";
import { canUse } from "@/lib/entitlements";
import { requirePermission, requireRecentStepUp, type StaffContext } from "@/server/staff-context";

import { connectedCards } from "./connections";
import { APP_CHECK_EVENT, APP_REMOVE_EVENT } from "./events";
import { apps, getApp } from "./registry";
import type { RegisteredApp } from "./types";

/**
 * Install, change and remove apps (feature 55). Everything here is a database change in the business's own scope;
 * anything that needs the other service (checking a key, revoking it) is an outbox row the worker picks up.
 */

type InstallRow = typeof appInstalls.$inferSelect;

export const appSecretPurpose = (appKey: string): string => `app.${appKey}`;

function preview(context: StaffContext): void {
  if (context.preview) throw new ApiError(409, "preview_only", "Apps can't be installed in the preview.");
}

function stateOf(row: InstallRow | undefined): AppState {
  if (!row) return "available";
  return row.status === "active" ? "active" : row.status === "paused" ? "paused" : row.status === "failing" ? "failing" : "uninstalling";
}

const statusTexts: Record<string, string> = {
  active: "Connected and sending",
  paused: "Switched off by you",
  failing: "Switched off: it kept failing",
  uninstalling: "Being removed",
};

function nativeCard(app: RegisteredApp, row: InstallRow | undefined, needsUpgrade: boolean): AppCard {
  return {
    key: app.key, name: app.name, tagline: app.tagline, category: app.category, kind: "native", state: stateOf(row),
    statusText: row ? statusTexts[row.status] ?? null : null, dataSent: app.dataSent, manage: null, needsUpgrade,
  };
}

export async function listApps(context: StaffContext): Promise<{ apps: AppCard[] }> {
  requirePermission(context, "apps.manage");
  const entitled = !context.entitlements || canUse(context.entitlements, "api");
  const rows = context.preview ? [] : await withTenant(context.tenantId, (transaction) => transaction.select().from(appInstalls).where(eq(appInstalls.tenantId, context.tenantId)));
  const byKey = new Map(rows.map((row) => [row.appKey, row]));
  const native = apps.map((app) => nativeCard(app, byKey.get(app.key), !entitled && !byKey.has(app.key)));
  return { apps: [...native, ...await connectedCards(context, entitled)] };
}

function eventView(row: typeof appEvents.$inferSelect): AppEventView {
  return {
    id: row.id, eventType: row.eventType, outcome: row.outcome === "failed" ? "failed" : row.outcome === "skipped" ? "skipped" : "delivered",
    errorCode: row.errorCode, createdAt: row.createdAt.toISOString(),
  };
}

export async function getAppDetail(context: StaffContext, key: string): Promise<AppDetail> {
  requirePermission(context, "apps.manage");
  const app = requireApp(key);
  const entitled = !context.entitlements || canUse(context.entitlements, "api");
  const loaded = context.preview ? { row: undefined, events: [] } : await withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction.select().from(appInstalls).where(and(eq(appInstalls.tenantId, context.tenantId), eq(appInstalls.appKey, key))).limit(1);
    const events = await transaction.select().from(appEvents).where(and(eq(appEvents.tenantId, context.tenantId), eq(appEvents.appKey, key)))
      .orderBy(desc(appEvents.createdAt), desc(appEvents.id)).limit(25);
    return { row, events };
  });
  const { row, events } = loaded;
  return {
    ...nativeCard(app, row, !entitled && !row),
    description: app.description, credentialFields: app.credentialFields, settingFields: app.settingFields,
    settings: row?.settings ?? app.defaultSettings, hasCredentials: Boolean(row?.credentialsCiphertext), version: row?.version ?? null,
    installedAt: row?.installedAt.toISOString() ?? null, disabledReason: row?.disabledReason ?? null, uninstallNote: app.uninstallNote,
    events: events.map(eventView),
  };
}

function requireApp(key: string): RegisteredApp {
  const app = getApp(key);
  if (!app) throw new ApiError(404, "app_not_found", "That app was not found.");
  return app;
}

function validationError(fields: Record<string, string[]>): ApiError {
  return new ApiError(400, "validation_error", "Please check the highlighted fields.", fields);
}

function parseCredentials(app: RegisteredApp, value: Record<string, string>): Record<string, string> {
  const result = app.credentialSchema.safeParse(value);
  if (!result.success) {
    const flat = result.error.flatten().fieldErrors as Record<string, string[] | undefined>;
    throw validationError(Object.fromEntries(Object.entries(flat).flatMap(([k, v]) => (v ? [[`credentials.${k}`, v]] : []))));
  }
  return result.data;
}

function parseSettings(app: RegisteredApp, value: unknown): Record<string, unknown> {
  const result = app.parseSettings(value);
  if (!result.ok) throw validationError(Object.fromEntries(Object.entries(result.fieldErrors).map(([k, v]) => [`settings.${k}`, v])));
  return result.settings;
}

async function seal(transaction: KalendrTransaction, tenantId: string, app: RegisteredApp, credentials: Record<string, string>): Promise<{ ciphertext: string; keyVersion: number }> {
  await loadRecordKeys(transaction, tenantId, { forWrite: true });
  const ciphertext = sealSecret(tenantId, appSecretPurpose(app.key), JSON.stringify(credentials));
  return { ciphertext, keyVersion: secretKeyVersion(ciphertext) };
}

async function queueForInstall(transaction: KalendrTransaction, tenantId: string, eventType: string, installId: string, aggregateType: string): Promise<void> {
  await transaction.insert(outboxEvents).values({
    tenantId, aggregateType, aggregateId: installId, eventType, payload: { installId }, dedupeKey: `${eventType}:${installId}:${randomUUID()}`,
  });
}

async function audit(transaction: KalendrTransaction, context: StaffContext, action: string, appKey: string, extra: Record<string, unknown> = {}): Promise<void> {
  // The app's key and fixed words only. Never a credential, a channel name or any text the person typed.
  await transaction.insert(auditEvents).values({
    tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action, outcome: "success", metadata: { appKey, ...extra },
  });
}

async function lockInstall(transaction: KalendrTransaction, context: StaffContext, key: string): Promise<InstallRow> {
  const [row] = await transaction.select().from(appInstalls).where(and(eq(appInstalls.tenantId, context.tenantId), eq(appInstalls.appKey, key))).for("update").limit(1);
  if (!row) throw new ApiError(404, "app_not_installed", "That app is not installed.");
  return row;
}

function expectVersion(row: InstallRow, expected: number): void {
  if (row.version !== expected) throw new ApiError(409, "version_conflict", "Someone else changed this app. Reload and try again.");
}

export async function installApp(context: StaffContext, key: string, body: unknown): Promise<AppDetail> {
  requirePermission(context, "apps.manage");
  preview(context);
  requireFeature(context, "api");
  const app = requireApp(key);
  const parsedBody = installAppInput.safeParse(body);
  if (!parsedBody.success) throw validationError(parsedBody.error.flatten().fieldErrors);
  const credentials = parseCredentials(app, parsedBody.data.credentials);
  const settings = parseSettings(app, { ...app.defaultSettings, ...parsedBody.data.settings });
  // An app receives customer data, so adding one needs the same fresh second-factor check as an API key.
  requireRecentStepUp(context);
  await withTenant(context.tenantId, async (transaction) => {
    const [existing] = await transaction.select({ status: appInstalls.status }).from(appInstalls).where(and(eq(appInstalls.tenantId, context.tenantId), eq(appInstalls.appKey, key))).limit(1);
    if (existing) {
      throw new ApiError(409, existing.status === "uninstalling" ? "app_being_removed" : "app_already_installed",
        existing.status === "uninstalling" ? "This app is still being removed. Try again in a minute." : "This app is already installed.");
    }
    const sealed = await seal(transaction, context.tenantId, app, credentials);
    const [created] = await transaction.insert(appInstalls).values({
      tenantId: context.tenantId, appKey: key, status: "active", settings, credentialsCiphertext: sealed.ciphertext, keyVersion: sealed.keyVersion,
      installedByUserId: context.userId,
    }).returning({ id: appInstalls.id });
    if (!created) throw new ApiError(500, "app_not_installed", "The app could not be installed. Try again.");
    await audit(transaction, context, "app.installed", key);
    // The worker proves the key and the settings work and writes the answer to the activity log.
    await queueForInstall(transaction, context.tenantId, APP_CHECK_EVENT, created.id, "app_install");
  });
  return getAppDetail(context, key);
}

export async function updateAppSettings(context: StaffContext, key: string, body: unknown): Promise<AppDetail> {
  requirePermission(context, "apps.manage");
  preview(context);
  const app = requireApp(key);
  const parsedBody = updateAppInput.safeParse(body);
  if (!parsedBody.success) throw validationError(parsedBody.error.flatten().fieldErrors);
  const settings = parseSettings(app, parsedBody.data.settings);
  await withTenant(context.tenantId, async (transaction) => {
    const row = await lockInstall(transaction, context, key);
    expectVersion(row, parsedBody.data.expectedVersion);
    if (row.status === "uninstalling") throw new ApiError(409, "app_being_removed", "This app is being removed.");
    await transaction.update(appInstalls).set({ settings, version: row.version + 1, updatedAt: new Date() })
      .where(and(eq(appInstalls.tenantId, context.tenantId), eq(appInstalls.id, row.id)));
    await audit(transaction, context, "app.settings_changed", key);
  });
  return getAppDetail(context, key);
}

/** Replacing the key also puts a failed app back to work, and checks the new key. */
export async function replaceAppCredentials(context: StaffContext, key: string, body: unknown): Promise<AppDetail> {
  requirePermission(context, "apps.manage");
  preview(context);
  requireFeature(context, "api");
  const app = requireApp(key);
  const parsedBody = replaceCredentialsInput.safeParse(body);
  if (!parsedBody.success) throw validationError(parsedBody.error.flatten().fieldErrors);
  const credentials = parseCredentials(app, parsedBody.data.credentials);
  requireRecentStepUp(context);
  await withTenant(context.tenantId, async (transaction) => {
    const row = await lockInstall(transaction, context, key);
    expectVersion(row, parsedBody.data.expectedVersion);
    if (row.status === "uninstalling") throw new ApiError(409, "app_being_removed", "This app is being removed.");
    const sealed = await seal(transaction, context.tenantId, app, credentials);
    await transaction.update(appInstalls).set({
      credentialsCiphertext: sealed.ciphertext, keyVersion: sealed.keyVersion, status: "active", consecutiveFailures: 0, disabledReason: null,
      version: row.version + 1, updatedAt: new Date(),
    }).where(and(eq(appInstalls.tenantId, context.tenantId), eq(appInstalls.id, row.id)));
    await audit(transaction, context, "app.credentials_replaced", key);
    await queueForInstall(transaction, context.tenantId, APP_CHECK_EVENT, row.id, "app_install");
  });
  return getAppDetail(context, key);
}

export async function setAppStatus(context: StaffContext, key: string, body: unknown): Promise<AppDetail> {
  requirePermission(context, "apps.manage");
  preview(context);
  requireApp(key);
  const parsedBody = appStatusInput.safeParse(body);
  if (!parsedBody.success) throw validationError(parsedBody.error.flatten().fieldErrors);
  await withTenant(context.tenantId, async (transaction) => {
    const row = await lockInstall(transaction, context, key);
    expectVersion(row, parsedBody.data.expectedVersion);
    if (row.status === "uninstalling") throw new ApiError(409, "app_being_removed", "This app is being removed.");
    if (row.status === "failing" && parsedBody.data.status === "active") throw new ApiError(409, "replace_key_first", "This app was switched off because its key stopped working. Replace the key to turn it back on.");
    await transaction.update(appInstalls).set({ status: parsedBody.data.status, consecutiveFailures: 0, disabledReason: null, version: row.version + 1, updatedAt: new Date() })
      .where(and(eq(appInstalls.tenantId, context.tenantId), eq(appInstalls.id, row.id)));
    await audit(transaction, context, parsedBody.data.status === "active" ? "app.resumed" : "app.paused", key);
  });
  return getAppDetail(context, key);
}

/** Queues a check. The result shows in the activity log within a minute. */
export async function checkApp(context: StaffContext, key: string): Promise<{ queued: true }> {
  requirePermission(context, "apps.manage");
  preview(context);
  requireApp(key);
  await withTenant(context.tenantId, async (transaction) => {
    const row = await lockInstall(transaction, context, key);
    if (row.status === "uninstalling") throw new ApiError(409, "app_being_removed", "This app is being removed.");
    await queueForInstall(transaction, context.tenantId, APP_CHECK_EVENT, row.id, "app_install");
  });
  return { queued: true };
}

/**
 * Starts removal. The row stays, switched off, until the worker has revoked the key at the other service (when it can)
 * and then deletes the credentials and the row. A removal that is asked for twice is one removal.
 */
export async function uninstallApp(context: StaffContext, key: string): Promise<{ removing: true }> {
  requirePermission(context, "apps.manage");
  preview(context);
  requireApp(key);
  await withTenant(context.tenantId, async (transaction) => {
    const row = await lockInstall(transaction, context, key);
    if (row.status === "uninstalling") return;
    await transaction.update(appInstalls).set({ status: "uninstalling", version: row.version + 1, updatedAt: new Date() })
      .where(and(eq(appInstalls.tenantId, context.tenantId), eq(appInstalls.id, row.id)));
    await audit(transaction, context, "app.uninstall_requested", key);
    await queueForInstall(transaction, context.tenantId, APP_REMOVE_EVENT, row.id, "app_install");
  });
  return { removing: true };
}
