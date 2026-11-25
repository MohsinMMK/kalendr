import "server-only";

import { cache } from "react";
import { sql } from "drizzle-orm";

import { getDatabase, withTenant } from "@/db/client";
import { businessTypeIds, type BusinessTypeId } from "@/lib/business-types";
import { canonicalUrl, isIndexable, pagePath, parseSeo, planHasLapsed, type SeoSettings } from "@/lib/seo";

import { env, publicAppUrl } from "./env";
import { withoutSearchText } from "./search/scrub";
import { isPreviewMode } from "./preview-repository";

/** What the public pages need to know about a business to describe themselves to search engines. */
export interface DiscoveryState {
  tenantId: string;
  listed: boolean;
  /** Listed, switched on, not paused and not on a lapsed plan: the only case pages may be indexed. */
  indexable: boolean;
  seo: SeoSettings;
  /** The business's verified own web address, when it has one. */
  customHost: string | null;
  city: string | null;
}

interface StateRow extends Record<string, unknown> {
  listed: boolean;
  is_active: boolean;
  paused_at: Date | string | null;
  seo: unknown;
  status: string | null;
  trial_ends_at: Date | string | null;
  past_due_since: Date | string | null;
  current_period_end: Date | string | null;
  host: string | null;
  city: string | null;
}

const asDate = (value: Date | string | null): Date | null => (value === null ? null : new Date(value));

/**
 * One read per render of the listing switch, the owner's page words, the plan state and the verified address. Null in
 * preview mode and for a link that names no business, which both carry `noindex`.
 */
export const loadDiscoveryState = cache(async (slug: string): Promise<DiscoveryState | null> => {
  if (isPreviewMode()) return null;
  const database = getDatabase();
  if (!database) return null;
  const [tenant] = await database.execute<{ tenant_id: string }>(sql`select tenant_id from kalendr_resolve_tenant(${slug}, null)`);
  if (!tenant) return null;
  const tenantId = tenant.tenant_id;
  const [row] = await withTenant(tenantId, (transaction) => transaction.execute<StateRow>(sql`
    select t.listed, t.is_active, t.paused_at, t.seo, s.status, s.trial_ends_at, s.past_due_since, s.current_period_end,
      (select d.hostname from tenant_domains as d where d.tenant_id = t.id and d.status = 'active' order by d.created_at limit 1) as host,
      (select l.city from locations as l where l.tenant_id = t.id and l.is_active order by l.created_at, l.id limit 1) as city
    from tenants as t left join tenant_subscriptions as s on s.tenant_id = t.id
    where t.id = ${tenantId}
  `));
  if (!row) return null;
  const lapsed = planHasLapsed(row.status === null ? null : {
    status: row.status, trialEndsAt: asDate(row.trial_ends_at), pastDueSince: asDate(row.past_due_since), currentPeriodEnd: asDate(row.current_period_end),
  });
  return {
    tenantId,
    listed: row.listed,
    indexable: isIndexable({ listed: row.listed, isActive: row.is_active, paused: row.paused_at !== null, planLapsed: lapsed }),
    seo: parseSeo(row.seo),
    customHost: row.host,
    city: row.city,
  };
});

/** A page's canonical address for this business. */
export function canonicalFor(state: DiscoveryState | null, kind: "business" | "service" | "person", slug: string, key = ""): string {
  const customHost = state?.customHost ?? null;
  return canonicalUrl({ appUrl: publicAppUrl(), customHost, path: pagePath(kind, slug, key, customHost !== null) });
}

export interface SitemapRow {
  slug: string;
  kind: "business" | "service" | "person";
  key: string;
  domain: string | null;
  updatedAt: Date;
}

export const SITEMAP_PAGE_SIZE = 10_000;

interface Remembered { expires: number; value: Promise<unknown> }
const remembered = new Map<string, Remembered>();
const REMEMBER_LIMIT = 100;

/**
 * Answers that every crawler and visitor asks for alike (the sitemap files, the directory's filters) are kept in this process
 * for a few minutes, so they cost the database one read per window, not one per request. A failed read is not kept. The map
 * has a hard size, because a made-up sitemap number is a made-up key.
 */
function remember<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = remembered.get(key);
  if (hit && hit.expires > now) return hit.value as Promise<T>;
  const value = load();
  value.catch(() => { if (remembered.get(key)?.value === value) remembered.delete(key); });
  if (remembered.size >= REMEMBER_LIMIT) remembered.delete(remembered.keys().next().value as string);
  remembered.set(key, { expires: now + ttlMs, value });
  return value;
}

/** For tests: forget everything kept above. */
export function resetDiscoveryCache(): void {
  remembered.clear();
}

/** Ten minutes unless KALENDR_DISCOVERY_CACHE_SECONDS says otherwise; 0 keeps nothing. */
const keepMs = (): number => (env().KALENDR_DISCOVERY_CACHE_SECONDS ?? 600) * 1000;

export interface SitemapRowRaw extends Record<string, unknown> {
  slug: string;
  kind: string;
  key: string;
  domain: string | null;
  updated_at: Date | string;
}

/** How many sitemap files the listed businesses need. Always at least one, which also carries the home page. */
export async function sitemapFileCount(): Promise<number> {
  const database = getDatabase();
  if (!database || isPreviewMode()) return 1;
  return remember("sitemap-count", keepMs(), async () => {
    const [row] = await database.execute<{ total: string | number }>(sql`select kalendr_sitemap_count() as total`);
    return Math.max(1, Math.ceil(Number(row?.total ?? 0) / SITEMAP_PAGE_SIZE));
  });
}

/** One sitemap file's rows: listed, running businesses and their service and team pages, slugs and keys only. */
export async function sitemapRows(fileIndex: number): Promise<SitemapRow[]> {
  const database = getDatabase();
  if (!database || isPreviewMode()) return [];
  // A file number past the last one is an empty file; it never reaches the database.
  if (fileIndex >= (await sitemapFileCount())) return [];
  return remember(`sitemap-${fileIndex}`, keepMs(), async () => {
    const rows = await database.execute<SitemapRowRaw>(sql`select * from kalendr_sitemap_entries(${fileIndex * SITEMAP_PAGE_SIZE}, ${SITEMAP_PAGE_SIZE})`);
    return parseSitemapRows(rows);
  });
}

function parseSitemapRows(rows: SitemapRowRaw[]): SitemapRow[] {
  return rows.flatMap((row): SitemapRow[] => (row.kind === "business" || row.kind === "service" || row.kind === "person"
    ? [{ slug: row.slug, kind: row.kind, key: row.key, domain: row.domain, updatedAt: new Date(row.updated_at) }]
    : []));
}

export interface DirectoryCard {
  slug: string;
  name: string;
  businessType: BusinessTypeId;
  city: string | null;
  about: string | null;
  url: string;
}

export interface DirectoryPage {
  cards: DirectoryCard[];
  total: number;
}

interface DirectoryRow extends Record<string, unknown> {
  slug: string;
  name: string;
  business_type: string;
  city: string | null;
  about: string | null;
  domain: string | null;
  total: string | number;
}

export const DIRECTORY_PAGE_SIZE = 24;

const asBusinessType = (value: string): BusinessTypeId => businessTypeIds.find((id) => id === value) ?? "other";

/** Listed businesses for /explore, narrowed by words, city and type. Business facts that are already public, nothing else. */
export function searchDirectory(filter: { q?: string; city?: string; type?: string; page?: number }): Promise<DirectoryPage> {
  return withoutSearchText(() => runDirectorySearch(filter));
}

async function runDirectorySearch(filter: { q?: string; city?: string; type?: string; page?: number }): Promise<DirectoryPage> {
  const database = getDatabase();
  if (!database || isPreviewMode()) return { cards: [], total: 0 };
  const page = Math.max(1, Math.floor(filter.page ?? 1));
  const type = filter.type && businessTypeIds.some((id) => id === filter.type) ? filter.type : null;
  const rows = await database.execute<DirectoryRow>(sql`
    select * from kalendr_directory_search(${filter.q ?? ""}, ${filter.city ?? null}, ${type}, ${(page - 1) * DIRECTORY_PAGE_SIZE}, ${DIRECTORY_PAGE_SIZE})
  `);
  return {
    total: Number(rows[0]?.total ?? 0),
    cards: rows.map((row) => ({
      slug: row.slug,
      name: row.name,
      businessType: asBusinessType(row.business_type),
      city: row.city,
      about: row.about,
      url: canonicalUrl({ appUrl: publicAppUrl(), customHost: row.domain, path: pagePath("business", row.slug, "", row.domain !== null) }),
    })),
  };
}

export interface DirectoryFacets {
  types: { value: BusinessTypeId; count: number }[];
  cities: { value: string; count: number }[];
}

interface FacetRow extends Record<string, unknown> {
  facet: string;
  value: string;
  count: string | number;
}

export async function directoryFacets(): Promise<DirectoryFacets> {
  const database = getDatabase();
  if (!database || isPreviewMode()) return { types: [], cities: [] };
  return remember("directory-facets", keepMs(), async () => {
    const rows = await database.execute<FacetRow>(sql`select * from kalendr_directory_facets()`);
    return {
      types: rows.filter((row) => row.facet === "type").map((row) => ({ value: asBusinessType(row.value), count: Number(row.count) })),
      cities: rows.filter((row) => row.facet === "city").map((row) => ({ value: row.value, count: Number(row.count) })),
    };
  });
}
