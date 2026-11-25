import "server-only";

import { createHash, createHmac } from "node:crypto";

import { metrics } from "@opentelemetry/api";
import { lte, sql } from "drizzle-orm";

import { getDatabase, type KalendrDatabase } from "@/db/client";
import { rateLimitBuckets } from "@/db/schema";
import { env } from "@/server/env";
import { logger } from "@/server/logger";
import { rateLimitRules, type RateLimitRuleName } from "@/server/rate-limit-rules";

/**
 * Request limits shared by every app server. Each hit is one statement:
 * INSERT ... ON CONFLICT DO UPDATE ... RETURNING count, on a row keyed by a hash of the rule
 * and the key, for the current fixed window. Counts survive restarts and deploys.
 */

export interface RateLimitResult {
  readonly rule: RateLimitRuleName;
  readonly allowed: boolean;
  /** Requests counted in this window, including this one. */
  readonly count: number;
  readonly limit: number;
  readonly resetAt: Date;
  /** Whole seconds until the window ends, at least 1. */
  readonly retryAfterSeconds: number;
}

/** Windows start on multiples of their length since the Unix epoch, so every server agrees. */
export function rateLimitWindow(windowSeconds: number, now: Date): { start: Date; end: Date } {
  const size = windowSeconds * 1_000;
  const start = Math.floor(now.getTime() / size) * size;
  return { start: new Date(start), end: new Date(start + size) };
}

/**
 * The stored key. Keyed with the auth secret when there is one, so a copy of the table can't be
 * matched back to IP addresses or phone numbers by hashing every possible value.
 */
export function rateLimitKeyHash(rule: RateLimitRuleName, key: string): string {
  const value = `${rule}\u0000${key}`;
  const secret = env().BETTER_AUTH_SECRET;
  return secret
    ? createHmac("sha256", secret).update(value).digest("hex")
    : createHash("sha256").update(value).digest("hex");
}

/** Counts used only when no database is configured (the preview). One process, lost on restart. */
const memoryBuckets = new Map<string, number>();

async function countHit(
  database: KalendrDatabase | null,
  keyHash: string,
  window: { start: Date; end: Date },
  now: Date,
): Promise<number> {
  if (!database) {
    const id = `${keyHash}:${window.start.getTime()}`;
    const count = (memoryBuckets.get(id) ?? 0) + 1;
    memoryBuckets.set(id, count);
    if (memoryBuckets.size > 10_000) {
      for (const [entry] of memoryBuckets) {
        if (Number(entry.slice(entry.lastIndexOf(":") + 1)) < now.getTime() - 24 * 60 * 60 * 1_000) memoryBuckets.delete(entry);
      }
    }
    return count;
  }
  const [row] = await database
    .insert(rateLimitBuckets)
    .values({ keyHash, windowStart: window.start, windowEnd: window.end, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimitBuckets.keyHash, rateLimitBuckets.windowStart],
      set: { count: sql`${rateLimitBuckets.count} + 1` },
    })
    .returning({ count: rateLimitBuckets.count });
  if (!row) throw new Error("Rate limit counter returned no row");
  return row.count;
}

/** Counts one request against a rule. Does not throw when the limit is reached; see enforceLimit in http.ts. */
export async function hitRateLimit(
  rule: RateLimitRuleName,
  key: string,
  options: { now?: Date; database?: KalendrDatabase | null } = {},
): Promise<RateLimitResult> {
  const now = options.now ?? new Date();
  const { limit, windowSeconds } = rateLimitRules[rule];
  const window = rateLimitWindow(windowSeconds, now);
  const database = options.database === undefined ? getDatabase() : options.database;
  const count = await countHit(database, rateLimitKeyHash(rule, key), window, now);
  return {
    rule,
    allowed: count <= limit,
    count,
    limit,
    resetAt: window.end,
    retryAfterSeconds: Math.max(1, Math.ceil((window.end.getTime() - now.getTime()) / 1_000)),
  };
}

const refusedCounter = metrics.getMeter("kalendr").createCounter("kalendr.rate_limit.refused", {
  description: "Requests refused by a rate limit or the bot check, by rule",
  unit: "{request}",
});

/**
 * One count per refused request, by rule name only (no IP, contact or token). Goes to the
 * OpenTelemetry meter (a no-op until a metrics exporter is registered) and to the JSON log,
 * which is what operators can query today.
 */
export function recordRefusal(rule: RateLimitRuleName | "bot_check.honeypot" | "bot_check.too_fast" | "bot_check.turnstile"): void {
  refusedCounter.add(1, { "kalendr.rate_limit.rule": rule });
  logger().warn({ event: "rate_limit.refused", rule }, "request refused");
}

/**
 * Deletes counters whose window has ended. Returns how many rows went.
 *
 * FEATURE 1 SCHEDULER HOOK: run this once a night from the job scheduler (feature 1), for
 * example `await deleteExpiredRateLimitBuckets()` in a daily maintenance job. Until then the
 * table only grows by one small row per key per window, and old rows are never read.
 */
export async function deleteExpiredRateLimitBuckets(
  now: Date = new Date(),
  database: KalendrDatabase | null = getDatabase(),
): Promise<number> {
  if (!database) {
    let removed = 0;
    for (const [entry] of memoryBuckets) {
      if (Number(entry.slice(entry.lastIndexOf(":") + 1)) + 24 * 60 * 60 * 1_000 <= now.getTime()) {
        memoryBuckets.delete(entry);
        removed += 1;
      }
    }
    return removed;
  }
  const removed = await database
    .delete(rateLimitBuckets)
    .where(lte(rateLimitBuckets.windowEnd, now))
    .returning({ keyHash: rateLimitBuckets.keyHash });
  return removed.length;
}

/**
 * The client's IP address. The host's proxies append the address they saw to X-Forwarded-For,
 * so with TRUSTED_PROXY_HOPS = n the client is the n-th entry from the right, and everything to
 * its left was written by the client and is ignored. With 0 (local development only; production
 * refuses to start without a value) the rightmost entry is used, which Next.js fills from the
 * socket when the header is missing.
 */
export function clientAddress(headers: Headers, trustedProxyHops: number = env().TRUSTED_PROXY_HOPS ?? 0): string {
  const entries = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) return "unknown";
  const index = trustedProxyHops <= 0 ? entries.length - 1 : Math.max(0, entries.length - trustedProxyHops);
  return normalizeAddress(entries[index] ?? "unknown");
}

function normalizeAddress(value: string): string {
  const address = value.toLowerCase().replace(/^\[|\](:\d+)?$/g, "").replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");
  // An IPv4 address with a port, as some proxies write it.
  const v4WithPort = /^(\d+\.\d+\.\d+\.\d+):\d+$/.exec(address);
  if (v4WithPort?.[1]) return v4WithPort[1];
  // IPv6 clients usually own a whole /64, so count the network, not the single address.
  if (address.includes(":")) return ipv6Prefix(address);
  return address.slice(0, 64);
}

function ipv6Prefix(address: string): string {
  const [head = "", tail = ""] = address.split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = tail ? tail.split(":") : [];
  const missing = Math.max(0, 8 - headParts.length - tailParts.length);
  const full = address.includes("::") ? [...headParts, ...Array<string>(missing).fill("0"), ...tailParts] : headParts;
  return `${full.slice(0, 4).map((part) => part.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}
