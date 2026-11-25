import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";

import { getDatabase, withTenant } from "@/db/client";
import { auditEvents, outboxEvents, tenantDomains, tenantEmbedOrigins } from "@/db/schema";
import {
  domainState, maxEmbedOrigins, newVerificationToken, normaliseHostname, normaliseOrigin, pendingWindowHours,
  verifyRecordName, verifyRecordValue, type DomainState,
} from "@/lib/domain-rules";

import { ApiError } from "../api-error";
import { env, appOrigin } from "../env";
import { loadEntitlements, requireFeature } from "../entitlements";
import { clearHostCache } from "../host-lookup";
import { assertNotReadOnlyImpersonation, requirePermission, type StaffContext } from "../staff-context";
import { currentTraceParent } from "../tracing";

import { DOMAIN_CHECK_EVENT } from "./events";
import { hashToken } from "./verify";

/**
 * Own web address and allowed embed sites (feature 13), the staff side. Nothing here looks anything up in DNS: "Check
 * now" writes an outbox row and the worker does the lookup (src/worker/domain-jobs.ts), so a slow resolver never holds
 * a request. The owner sees the TXT value only when it is made; only its hash is stored, so "show the records again"
 * makes a new one.
 */

const maxDomainsPerBusiness = 3;

/** The host owners point their CNAME at, or null when this deployment has not set one up. */
export function cnameTarget(): string | null {
  return env().KALENDR_CNAME_TARGET?.trim().toLowerCase() || null;
}

function reservedHosts(): string[] {
  const hosts = [new URL(appOrigin()).hostname];
  const target = cnameTarget();
  if (target) hosts.push(target);
  return hosts;
}

export interface DomainRecords {
  cname: { name: string; value: string };
  txt: { name: string };
}

export interface StaffDomain {
  id: string;
  hostname: string;
  state: DomainState;
  lastCheckedAt: string | null;
  lastResult: string | null;
  /** When rechecking a pending address stops. */
  checkUntil: string | null;
  /** When the records of a live address first went missing; the address stops being served 7 days later. */
  missingSince: string | null;
  records: DomainRecords;
}

export interface DomainOverview {
  /** False when this deployment has no CNAME target, so the screen can say so plainly. */
  configured: boolean;
  cnameTarget: string | null;
  domains: StaffDomain[];
}

export interface CreatedDomain {
  domain: StaffDomain;
  /** The TXT value to publish. Shown once. */
  txtValue: string;
}

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

function toStaffDomain(row: typeof tenantDomains.$inferSelect, target: string): StaffDomain {
  return {
    id: row.id,
    hostname: row.hostname,
    state: domainState({ status: row.status, missingSince: row.missingSince }),
    lastCheckedAt: iso(row.lastCheckedAt),
    lastResult: row.lastResult,
    checkUntil: iso(row.checkUntil),
    missingSince: iso(row.missingSince),
    records: { cname: { name: row.hostname, value: target }, txt: { name: verifyRecordName(row.hostname) } },
  };
}

export async function listDomains(context: StaffContext): Promise<DomainOverview> {
  requirePermission(context, "settings.manage");
  const target = cnameTarget();
  if (context.preview) return { configured: false, cnameTarget: target, domains: [] };
  const rows = await withTenant(context.tenantId, (transaction) =>
    transaction.select().from(tenantDomains).where(eq(tenantDomains.tenantId, context.tenantId)).orderBy(asc(tenantDomains.createdAt)));
  return { configured: target !== null, cnameTarget: target, domains: rows.map((row) => toStaffDomain(row, target ?? "")) };
}

function requireConfigured(): string {
  const target = cnameTarget();
  if (!target) throw new ApiError(409, "domains_not_configured", "Own web addresses are not set up on this Kalendr yet. Ask the person who runs it to set the CNAME target.");
  return target;
}

export async function addDomain(context: StaffContext, hostname: string): Promise<CreatedDomain> {
  requirePermission(context, "settings.manage");
  assertNotReadOnlyImpersonation(context);
  if (context.preview) throw new ApiError(409, "preview_mode", "Own web addresses are not saved in the preview.");
  const target = requireConfigured();
  const host = normaliseHostname(hostname, { reservedHosts: reservedHosts() });
  if (!host) {
    throw new ApiError(400, "validation_error", "Enter an address like book.yourbusiness.com. It needs a name in front of your domain.", { hostname: ["Enter an address like book.yourbusiness.com."] });
  }
  const token = newVerificationToken();
  const until = new Date(Date.now() + pendingWindowHours * 3_600_000);
  const row = await withTenant(context.tenantId, async (transaction) => {
    const { entitlements } = await loadEntitlements(context.tenantId, transaction);
    requireFeature({ entitlements }, "customDomain");
    const existing = await transaction.select({ id: tenantDomains.id, hostname: tenantDomains.hostname }).from(tenantDomains).where(eq(tenantDomains.tenantId, context.tenantId));
    if (existing.some((entry) => entry.hostname === host)) {
      throw new ApiError(409, "domain_exists", "You already added this address. Use \"Show the records again\" on it if you need the records.", { hostname: ["This address is already added."] });
    }
    if (existing.length >= maxDomainsPerBusiness) throw new ApiError(409, "too_many_domains", `You can connect up to ${maxDomainsPerBusiness} web addresses. Remove one first.`);
    const claimed = await transaction.execute<{ id: string | null }>(sql`select kalendr_claim_hostname(${context.tenantId}, ${host}, ${hashToken(token)}, ${until.toISOString()}::timestamptz) as id`);
    const id = claimed[0]?.id;
    if (!id) throw new ApiError(409, "domain_taken", "That address is already connected to a business. Use another address, or remove it from the other account first.", { hostname: ["That address is already in use."] });
    const [created] = await transaction.select().from(tenantDomains).where(and(eq(tenantDomains.tenantId, context.tenantId), eq(tenantDomains.id, id))).limit(1);
    if (!created) throw new ApiError(500, "internal_error", "The address could not be saved. Try again.");
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "domain.added", outcome: "success", metadata: { hostname: host },
    });
    return created;
  });
  clearHostCache();
  return { domain: toStaffDomain(row, target), txtValue: verifyRecordValue(token) };
}

async function findOwn(context: StaffContext, id: string) {
  const [row] = await withTenant(context.tenantId, (transaction) =>
    transaction.select().from(tenantDomains).where(and(eq(tenantDomains.tenantId, context.tenantId), eq(tenantDomains.id, id))).limit(1));
  if (!row) throw new ApiError(404, "not_found", "That address is not on your account.");
  return row;
}

/** Queues one lookup for the worker. Pressing the button again within the same minute queues nothing new. */
export async function requestDomainCheck(context: StaffContext, id: string, now: Date = new Date()): Promise<{ queued: true }> {
  requirePermission(context, "settings.manage");
  assertNotReadOnlyImpersonation(context);
  if (context.preview) throw new ApiError(409, "preview_mode", "Own web addresses are not checked in the preview.");
  requireConfigured();
  await findOwn(context, id);
  await withTenant(context.tenantId, async (transaction) => {
    await transaction.insert(outboxEvents).values({
      tenantId: context.tenantId,
      aggregateType: "domain",
      aggregateId: id,
      eventType: DOMAIN_CHECK_EVENT,
      payload: { domainId: id },
      dedupeKey: `${DOMAIN_CHECK_EVENT}:${id}:${Math.floor(now.getTime() / 60_000)}`,
      traceParent: currentTraceParent(),
    }).onConflictDoNothing();
  });
  return { queued: true };
}

/** Makes a new TXT value (the old one stops working) and restarts the 72 hours. Used when the owner lost the value or the window ran out. */
export async function regenerateDomainToken(context: StaffContext, id: string): Promise<CreatedDomain> {
  requirePermission(context, "settings.manage");
  assertNotReadOnlyImpersonation(context);
  if (context.preview) throw new ApiError(409, "preview_mode", "Own web addresses are not saved in the preview.");
  const target = requireConfigured();
  const current = await findOwn(context, id);
  if (current.status === "active") throw new ApiError(409, "domain_live", "This address is already live. Remove it first if you want to connect it again.");
  const token = newVerificationToken();
  const row = await withTenant(context.tenantId, async (transaction) => {
    const [updated] = await transaction.update(tenantDomains).set({
      status: "pending", verificationTokenHash: hashToken(token), checkUntil: new Date(Date.now() + pendingWindowHours * 3_600_000), lastCheckedAt: null, lastResult: null, updatedAt: new Date(),
    }).where(and(eq(tenantDomains.tenantId, context.tenantId), eq(tenantDomains.id, id))).returning();
    if (!updated) throw new ApiError(404, "not_found", "That address is not on your account.");
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "domain.token_reset", outcome: "success", metadata: { hostname: updated.hostname },
    });
    return updated;
  });
  return { domain: toStaffDomain(row, target), txtValue: verifyRecordValue(token) };
}

export async function removeDomain(context: StaffContext, id: string): Promise<{ removed: true }> {
  requirePermission(context, "settings.manage");
  assertNotReadOnlyImpersonation(context);
  if (context.preview) throw new ApiError(409, "preview_mode", "Own web addresses are not saved in the preview.");
  const current = await findOwn(context, id);
  await withTenant(context.tenantId, async (transaction) => {
    await transaction.delete(tenantDomains).where(and(eq(tenantDomains.tenantId, context.tenantId), eq(tenantDomains.id, id)));
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "domain.removed", outcome: "success", metadata: { hostname: current.hostname },
    });
  });
  clearHostCache();
  return { removed: true };
}

/** What the certificate host asks before issuing a certificate: is this a live address of some business? */
export async function isServedDomain(hostname: string): Promise<boolean> {
  const host = hostname.trim().toLowerCase();
  if (!/^[a-z0-9.-]{3,253}$/.test(host)) return false;
  const database = getDatabase();
  if (!database) return false;
  const rows = await database.execute<{ tenant_id: string }>(sql`select tenant_id from kalendr_domain_lookup(${host})`);
  return rows.length > 0;
}

// ---- Sites allowed to frame the booking widget ----

export interface StaffEmbedOrigin {
  id: string;
  origin: string;
  createdAt: string;
}

export async function listEmbedOrigins(context: StaffContext): Promise<StaffEmbedOrigin[]> {
  requirePermission(context, "settings.manage");
  if (context.preview) return [];
  const rows = await withTenant(context.tenantId, (transaction) =>
    transaction.select().from(tenantEmbedOrigins).where(eq(tenantEmbedOrigins.tenantId, context.tenantId)).orderBy(asc(tenantEmbedOrigins.origin)));
  return rows.map((row) => ({ id: row.id, origin: row.origin, createdAt: row.createdAt.toISOString() }));
}

/** Saves a site that may show the booking widget. Saving one that is already there changes nothing. */
export async function addEmbedOrigin(context: StaffContext, input: string): Promise<StaffEmbedOrigin> {
  requirePermission(context, "settings.manage");
  assertNotReadOnlyImpersonation(context);
  if (context.preview) throw new ApiError(409, "preview_mode", "Allowed sites are not saved in the preview.");
  const origin = normaliseOrigin(input);
  if (!origin) throw new ApiError(400, "validation_error", "Enter your website's address, like https://www.yourbusiness.com. It must start with https.", { origin: ["Enter an https address like https://www.yourbusiness.com."] });
  const row = await withTenant(context.tenantId, async (transaction) => {
    const existing = await transaction.select().from(tenantEmbedOrigins).where(eq(tenantEmbedOrigins.tenantId, context.tenantId));
    const same = existing.find((entry) => entry.origin === origin);
    if (same) return same;
    if (existing.length >= maxEmbedOrigins) throw new ApiError(409, "too_many_origins", `You can allow up to ${maxEmbedOrigins} sites. Remove one first.`);
    const [created] = await transaction.insert(tenantEmbedOrigins).values({ tenantId: context.tenantId, origin, addedBy: context.userId }).returning();
    if (!created) throw new ApiError(500, "internal_error", "The site could not be saved. Try again.");
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "embed_origin.added", outcome: "success", metadata: { origin },
    });
    return created;
  });
  clearHostCache();
  return { id: row.id, origin: row.origin, createdAt: row.createdAt.toISOString() };
}

export async function removeEmbedOrigin(context: StaffContext, id: string): Promise<{ removed: true }> {
  requirePermission(context, "settings.manage");
  assertNotReadOnlyImpersonation(context);
  if (context.preview) throw new ApiError(409, "preview_mode", "Allowed sites are not saved in the preview.");
  await withTenant(context.tenantId, async (transaction) => {
    const [removed] = await transaction.delete(tenantEmbedOrigins).where(and(eq(tenantEmbedOrigins.tenantId, context.tenantId), eq(tenantEmbedOrigins.id, id))).returning();
    if (!removed) throw new ApiError(404, "not_found", "That site is not on your list.");
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "embed_origin.removed", outcome: "success", metadata: { origin: removed.origin },
    });
  });
  clearHostCache();
  return { removed: true };
}
