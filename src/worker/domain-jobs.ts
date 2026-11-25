import { promises as dns } from "node:dns";

import type postgres from "postgres";
import { z } from "zod";

import { missingGraceDays, verifyRecordName, type DomainCheckResult } from "../lib/domain-rules";
import { judgeDomain } from "../server/domains/verify";
import { appOrigin, env } from "../server/env";
import type { EventHandler, TenantDb } from "./handlers/types";
import { deliveryToHandlerOutcome, type HandlerDependencies } from "./handlers/appointment-message";

/**
 * Own web address checks (feature 13). All DNS lookups happen here, in the worker, never in a web request. A pending
 * address is looked at every few minutes for 72 hours; a live one once a day, and when its records disappear the owner
 * is warned and the address stops being served 7 days later. Lookups go through an injected resolver so tests never
 * touch a real network.
 */

export const DOMAIN_NOTICE_EVENT = "domain.notice";
const DAY_MS = 86_400_000;

export interface DnsResolver {
  /** CNAME targets of a name. [] when the name has none; null when the lookup itself failed. */
  cname(name: string): Promise<string[] | null>;
  /** TXT values of a name, each joined from its chunks. [] when none; null when the lookup failed. */
  txt(name: string): Promise<string[] | null>;
}

const absent = new Set(["ENODATA", "ENOTFOUND", "NXDOMAIN"]);

async function lookup<T>(work: Promise<T[]>, timeoutMs: number): Promise<T[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } catch (error: unknown) {
    const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
    return absent.has(code) ? [] : null;
  } finally {
    clearTimeout(timer);
  }
}

/** The real resolver, on the machine's DNS, with a time limit on every lookup. */
export function systemResolver(timeoutMs = 4_000): DnsResolver {
  return {
    cname: (name) => lookup(dns.resolveCname(name), timeoutMs),
    txt: (name) => lookup(dns.resolveTxt(name).then((rows) => rows.map((chunks) => chunks.join(""))), timeoutMs),
  };
}

export interface DomainRow {
  id: string;
  hostname: string;
  status: "pending" | "verified" | "active" | "failed";
  verification_token_hash: string | null;
  check_until: Date | null;
  missing_since: Date | null;
}

/** Looks the records up and judges them. */
export async function readDomain(resolver: DnsResolver, row: Pick<DomainRow, "hostname" | "verification_token_hash">, target: string): Promise<DomainCheckResult> {
  const [cname, txt] = await Promise.all([resolver.cname(row.hostname), resolver.txt(verifyRecordName(row.hostname))]);
  return judgeDomain({ cname, txt }, target, row.verification_token_hash);
}

async function queueNotice(tenantDb: TenantDb, tenantId: string, domainId: string, kind: string, hostname: string, dedupe: string): Promise<void> {
  await tenantDb`
    insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
    values (${tenantId}, 'domain', ${domainId}, ${DOMAIN_NOTICE_EVENT}, ${tenantDb.json({ kind, hostname })}, ${`domain.notice:${kind}:${domainId}:${dedupe}`.slice(0, 200)})
    on conflict (tenant_id, dedupe_key) do nothing
  `;
}

export type DomainOutcome = "went_live" | "still_pending" | "gave_up" | "healthy" | "records_missing" | "stopped" | "unchanged";

/**
 * Applies one lookup's result to the address, inside its business's scope. A failed lookup (timeout, DNS outage)
 * never counts as a missing record: it only records that the check ran. Safe to run twice.
 */
export async function applyDomainCheck(tenantDb: TenantDb, tenantId: string, row: DomainRow, result: DomainCheckResult, now: Date): Promise<DomainOutcome> {
  const stamp = { last_checked_at: now, last_result: result };
  if (row.status === "pending") {
    if (result === "ok") {
      await tenantDb`update tenant_domains set status = 'active', verified_at = ${now}, missing_since = null, last_checked_at = ${now}, last_result = ${result}, updated_at = now() where tenant_id = ${tenantId} and id = ${row.id}`;
      return "went_live";
    }
    if (row.check_until && row.check_until <= now) {
      await tenantDb`update tenant_domains set status = 'failed', last_checked_at = ${now}, last_result = ${result}, updated_at = now() where tenant_id = ${tenantId} and id = ${row.id}`;
      await queueNotice(tenantDb, tenantId, row.id, "domain_failed", row.hostname, "final");
      return "gave_up";
    }
    await tenantDb`update tenant_domains set last_checked_at = ${stamp.last_checked_at}, last_result = ${stamp.last_result}, updated_at = now() where tenant_id = ${tenantId} and id = ${row.id}`;
    return "still_pending";
  }
  if (row.status !== "active") return "unchanged";
  if (result === "ok") {
    await tenantDb`update tenant_domains set missing_since = null, last_checked_at = ${now}, last_result = ${result}, updated_at = now() where tenant_id = ${tenantId} and id = ${row.id}`;
    return "healthy";
  }
  if (result === "lookup_failed") {
    await tenantDb`update tenant_domains set last_checked_at = ${now}, last_result = ${result}, updated_at = now() where tenant_id = ${tenantId} and id = ${row.id}`;
    return "unchanged";
  }
  const since = row.missing_since ?? now;
  if (now.getTime() - since.getTime() >= missingGraceDays * DAY_MS) {
    await tenantDb`update tenant_domains set status = 'failed', missing_since = ${since}, last_checked_at = ${now}, last_result = ${result}, updated_at = now() where tenant_id = ${tenantId} and id = ${row.id}`;
    await queueNotice(tenantDb, tenantId, row.id, "domain_stopped", row.hostname, "final");
    return "stopped";
  }
  await tenantDb`update tenant_domains set missing_since = ${since}, last_checked_at = ${now}, last_result = ${result}, updated_at = now() where tenant_id = ${tenantId} and id = ${row.id}`;
  // One warning per run of missing records: keyed on when they first went missing.
  if (!row.missing_since) await queueNotice(tenantDb, tenantId, row.id, "domain_records_missing", row.hostname, since.toISOString().slice(0, 10));
  return "records_missing";
}

async function loadDomain(tenantDb: TenantDb, tenantId: string, id: string): Promise<DomainRow | undefined> {
  const [row] = await tenantDb<DomainRow[]>`
    select id, hostname, status, verification_token_hash, check_until, missing_since
    from tenant_domains where tenant_id = ${tenantId} and id = ${id} for update
  `;
  return row;
}

function configuredTarget(): string | null {
  return env().KALENDR_CNAME_TARGET?.trim().toLowerCase() || null;
}

const checkPayload = z.object({ domainId: z.string().min(1).max(100) });

/** "Check now" from the screen: one lookup for one address. */
export function domainCheckHandler({ now }: Pick<HandlerDependencies, "now">, resolver: DnsResolver = systemResolver()): EventHandler {
  return async (tenantDb, event) => {
    const payload = checkPayload.safeParse(event.payload);
    if (!payload.success) return { outcome: "dead", code: "invalid_payload" };
    const target = configuredTarget();
    if (!target) return "delivered";
    const row = await loadDomain(tenantDb, event.tenantId, payload.data.domainId);
    if (!row) return "delivered";
    const result = await readDomain(resolver, row, target);
    await applyDomainCheck(tenantDb, event.tenantId, row, result, now());
    return "delivered";
  };
}

const noticePayload = z.object({ kind: z.enum(["domain_records_missing", "domain_stopped", "domain_failed"]), hostname: z.string().min(1).max(253) });

/** Emails the owner about their address. The body is the kind and the host only. */
export function domainNoticeHandler({ sink, now }: Pick<HandlerDependencies, "sink" | "now">): EventHandler {
  return async (tenantDb, event) => {
    const payload = noticePayload.safeParse(event.payload);
    if (!payload.success) return { outcome: "dead", code: "invalid_payload" };
    const [owner] = await tenantDb<{ email: string | null; name: string }[]>`select email, name from tenants where id = ${event.tenantId}`;
    const email = owner?.email?.trim();
    if (!owner || !email) return { outcome: "dead", code: "no_destination" };
    const at = now();
    return deliveryToHandlerOutcome(await sink.deliver(tenantDb, {
      tenantId: event.tenantId,
      appointmentId: null,
      patientId: "",
      channel: "email",
      message: {
        semanticKey: `local:owner:${event.tenantId}:${event.dedupeKey}`,
        templateKey: `owner.${payload.data.kind}`,
        body: JSON.stringify({ hostname: payload.data.hostname, settingsUrl: `${appOrigin()}/settings` }),
        scheduledAt: at,
      },
      recipient: { email, name: owner.name },
    }, at));
  };
}

export interface DomainSweepSummary extends Record<string, number> {
  tenants: number;
  checked: number;
  wentLive: number;
  gaveUp: number;
  recordsMissing: number;
  stopped: number;
}

/**
 * The repeating job: for every business with an address due a lookup, look it up and apply the result. A lookup that
 * hangs is cut off by the resolver's own time limit, so one slow name cannot hold the sweep.
 */
export async function sweepDomains(database: postgres.Sql, now: Date = new Date(), resolver: DnsResolver = systemResolver()): Promise<DomainSweepSummary> {
  const summary: DomainSweepSummary = { tenants: 0, checked: 0, wentLive: 0, gaveUp: 0, recordsMissing: 0, stopped: 0 };
  const target = configuredTarget();
  if (!target) return summary;
  const ids = await database<{ tenant_id: string }[]>`select tenant_id from kalendr_domain_tenants() as tenant_id`;
  for (const { tenant_id: tenantId } of ids) {
    summary.tenants += 1;
    // Find what is due, look it up with no transaction open, then record the answers.
    const due = await database.begin(async (tenantDb) => {
      await tenantDb`select set_config('app.tenant_id', ${tenantId}, true)`;
      return tenantDb<DomainRow[]>`
        select id, hostname, status, verification_token_hash, check_until, missing_since
        from tenant_domains
        where tenant_id = ${tenantId}
          and ((status = 'pending' and (last_checked_at is null or last_checked_at < ${new Date(now.getTime() - 5 * 60_000)}))
            or (status = 'active' and (last_checked_at is null or last_checked_at < ${new Date(now.getTime() - DAY_MS)})))
      `;
    });
    for (const row of due) {
      const result = await readDomain(resolver, row, target);
      await database.begin(async (tenantDb) => {
        await tenantDb`select set_config('app.tenant_id', ${tenantId}, true)`;
        const fresh = await loadDomain(tenantDb, tenantId, row.id);
        if (!fresh) return;
        const outcome = await applyDomainCheck(tenantDb, tenantId, fresh, result, now);
        summary.checked += 1;
        if (outcome === "went_live") summary.wentLive += 1;
        if (outcome === "gave_up") summary.gaveUp += 1;
        if (outcome === "records_missing") summary.recordsMissing += 1;
        if (outcome === "stopped") summary.stopped += 1;
      });
    }
  }
  return summary;
}
