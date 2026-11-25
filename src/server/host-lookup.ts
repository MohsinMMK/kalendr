/**
 * The proxy's two database questions (feature 13): which business serves this host, and which sites may frame this
 * business's booking page. Both go through narrow SECURITY DEFINER functions that return a slug or origins only.
 *
 * No "server-only" and no import of the app's own database module: the proxy loads this file, and it keeps its own
 * small pool so a flood of requests with made-up Host headers cannot starve the app's pool. Answers are cached for a
 * short time, misses included, and the cache has a hard size so random hosts cannot grow it without limit.
 */
import postgres from "postgres";

export interface HostBusiness {
  tenantId: string;
  slug: string;
}

const hitSeconds = 60;
const missSeconds = 15;
const maxEntries = 500;
const queryTimeoutMs = 2_000;

interface Entry<T> { value: T; expires: number }

class BoundedCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  get(key: string, now: number): { value: T } | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expires <= now) {
      this.entries.delete(key);
      return null;
    }
    return { value: entry.value };
  }
  set(key: string, value: T, ttlSeconds: number, now: number): void {
    if (this.entries.size >= maxEntries && !this.entries.has(key)) {
      // Drop the oldest insertion; a Map iterates in insertion order.
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expires: now + ttlSeconds * 1_000 });
  }
  clear(): void {
    this.entries.clear();
  }
}

interface Globals {
  kalendrHostSql?: postgres.Sql;
  kalendrHostBusinesses?: BoundedCache<HostBusiness | null>;
  kalendrHostOrigins?: BoundedCache<string[]>;
}
const globals = globalThis as typeof globalThis & Globals;

function pool(): postgres.Sql | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  globals.kalendrHostSql ??= postgres(url, { max: 2, connect_timeout: 3, idle_timeout: 20, max_lifetime: 60 * 30, prepare: false });
  return globals.kalendrHostSql;
}

function businesses(): BoundedCache<HostBusiness | null> {
  return (globals.kalendrHostBusinesses ??= new BoundedCache());
}
function origins(): BoundedCache<string[]> {
  return (globals.kalendrHostOrigins ??= new BoundedCache());
}

/** Forgets cached answers. Tests and the settings routes call this so a change shows at once on this server. */
export function clearHostCache(): void {
  businesses().clear();
  origins().clear();
}

function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("host lookup timed out")), queryTimeoutMs);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The business that serves a host, or null when none does. Throws when the database cannot be reached, so the proxy
 * can answer 503 for a real outage instead of caching "no such business".
 */
export async function lookupHostBusiness(hostname: string, now: number = Date.now()): Promise<HostBusiness | null> {
  const cached = businesses().get(hostname, now);
  if (cached) return cached.value;
  const sql = pool();
  if (!sql) return null;
  const rows = await withTimeout(sql<{ tenant_id: string; slug: string }[]>`select tenant_id, slug from kalendr_domain_lookup(${hostname})`);
  const row = rows[0];
  const value = row ? { tenantId: row.tenant_id, slug: row.slug } : null;
  businesses().set(hostname, value, value ? hitSeconds : missSeconds, now);
  return value;
}

/** The sites saved to frame one business's booking page. An unreachable database gives an empty list, which only narrows who may frame. */
export async function lookupEmbedOrigins(slug: string, now: number = Date.now()): Promise<string[]> {
  const cached = origins().get(slug, now);
  if (cached) return cached.value;
  const sql = pool();
  if (!sql) return [];
  try {
    const rows = await withTimeout(sql<{ origin: string }[]>`select kalendr_embed_origins as origin from kalendr_embed_origins(${slug})`);
    const value = rows.map((row) => row.origin);
    origins().set(slug, value, value.length > 0 ? hitSeconds : missSeconds, now);
    return value;
  } catch {
    return [];
  }
}
