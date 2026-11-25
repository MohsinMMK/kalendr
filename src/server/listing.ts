import "server-only";

import { eq, sql } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { auditEvents, tenants } from "@/db/schema";
import { listingUpdateSchema, type ListingUpdate, type ListingView } from "@/lib/listing";
import { businessTitle, canonicalUrl, isIndexable, pagePath, parseSeo, planHasLapsed, type SeoSettings } from "@/lib/seo";
import { emailSignatureLine, shareLinks } from "@/lib/share-kit";

import { ApiError } from "./api-error";
import { publicAppUrl } from "./env";
import { assertNotReadOnlyImpersonation, requirePermission, type StaffContext } from "./staff-context";

interface ListingRow extends Record<string, unknown> {
  name: string;
  slug: string;
  about: string | null;
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
const sameSeo = (a: SeoSettings, b: SeoSettings): boolean => (a.title ?? "") === (b.title ?? "") && (a.description ?? "") === (b.description ?? "");

function previewListing(context: StaffContext): ListingView {
  const origin = publicAppUrl();
  const links = shareLinks(origin, context.clinicSlug);
  return {
    listed: false, seo: {}, indexable: false, blockers: ["Search listing is not available in the preview."], businessName: context.clinicName, city: null,
    pageUrl: `${origin}/b/${context.clinicSlug}`, defaultTitle: `Book an appointment at ${context.clinicName}`, defaultDescription: "", links,
    emailSignature: emailSignatureLine(context.clinicName, links.find((link) => link.id === "email")?.url ?? origin), preview: true,
  };
}

function blockersFor(row: ListingRow, lapsed: boolean): string[] {
  const blockers: string[] = [];
  if (!row.is_active) blockers.push("Your business is switched off.");
  if (row.paused_at !== null) blockers.push("Your business is paused by Kalendr, so its pages stay hidden from search.");
  if (lapsed) blockers.push("Your plan has ended. Choose a plan in Billing to get found again.");
  return blockers;
}

async function readListing(context: StaffContext, transaction: Pick<Parameters<Parameters<typeof withTenant>[1]>[0], "execute">): Promise<{ row: ListingRow; lapsed: boolean }> {
  const [row] = await transaction.execute<ListingRow>(sql`
    select t.name, t.slug, t.about, t.listed, t.is_active, t.paused_at, t.seo, s.status, s.trial_ends_at, s.past_due_since, s.current_period_end,
      (select d.hostname from tenant_domains as d where d.tenant_id = t.id and d.status = 'active' order by d.created_at limit 1) as host,
      (select l.city from locations as l where l.tenant_id = t.id and l.is_active order by l.created_at, l.id limit 1) as city
    from tenants as t left join tenant_subscriptions as s on s.tenant_id = t.id
    where t.id = ${context.tenantId}
  `);
  if (!row) throw new ApiError(404, "not_found", "That business could not be found.");
  const lapsed = planHasLapsed(row.status === null ? null : {
    status: row.status, trialEndsAt: asDate(row.trial_ends_at), pastDueSince: asDate(row.past_due_since), currentPeriodEnd: asDate(row.current_period_end),
  });
  return { row, lapsed };
}

function toView(row: ListingRow, lapsed: boolean): ListingView {
  const seo = parseSeo(row.seo);
  const customHost = row.host;
  const origin = customHost ? `https://${customHost}` : publicAppUrl();
  const links = shareLinks(origin, row.slug);
  const defaultDescription = row.about?.slice(0, 160) ?? `Book an appointment at ${row.name}${row.city ? ` in ${row.city}` : ""}. See services, team, opening hours and reviews.`;
  return {
    listed: row.listed,
    seo,
    indexable: isIndexable({ listed: row.listed, isActive: row.is_active, paused: row.paused_at !== null, planLapsed: lapsed }),
    blockers: blockersFor(row, lapsed),
    businessName: row.name,
    city: row.city,
    pageUrl: canonicalUrl({ appUrl: publicAppUrl(), customHost, path: pagePath("business", row.slug, "", customHost !== null) }),
    defaultTitle: businessTitle(row.name, row.city ?? undefined, {}),
    defaultDescription,
    links,
    emailSignature: emailSignatureLine(row.name, links.find((link) => link.id === "email")?.url ?? origin),
    preview: false,
  };
}

/** Listing and share-kit facts for Settings. Any staff member who may manage settings. */
export async function loadListing(context: StaffContext): Promise<ListingView> {
  requirePermission(context, "settings.manage");
  if (context.preview) return previewListing(context);
  return withTenant(context.tenantId, async (transaction) => {
    const { row, lapsed } = await readListing(context, transaction);
    return toView(row, lapsed);
  });
}

/**
 * Switches listing on or off and saves the owner's page title and description. Written once, checked against what the
 * screen last saw (`version_conflict` when someone changed it meanwhile), and recorded in the activity log with field
 * names only, never the owner's words.
 */
export async function saveListing(context: StaffContext, rawInput: ListingUpdate): Promise<ListingView> {
  assertNotReadOnlyImpersonation(context);
  requirePermission(context, "settings.manage");
  const input = listingUpdateSchema.parse(rawInput);
  if (context.preview) throw new ApiError(400, "preview_only", "Search listing is unavailable in preview mode.");
  const seo: SeoSettings = { title: input.seo.title || undefined, description: input.seo.description || undefined };
  return withTenant(context.tenantId, async (transaction) => {
    const [locked] = await transaction.execute<{ listed: boolean; seo: unknown }>(sql`select listed, seo from tenants where id = ${context.tenantId} for update`);
    if (!locked) throw new ApiError(404, "not_found", "That business could not be found.");
    if (locked.listed !== input.expected.listed || !sameSeo(parseSeo(locked.seo), input.expected.seo)) {
      throw new ApiError(409, "version_conflict", "Someone else changed this just now. Reload to see the latest, then try again.");
    }
    await transaction.update(tenants).set({
      listed: input.listed,
      seo: { ...(seo.title ? { title: seo.title } : {}), ...(seo.description ? { description: seo.description } : {}) },
      updatedAt: new Date(),
    }).where(eq(tenants.id, context.tenantId));
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "settings.listing", outcome: "success",
      metadata: { listed: input.listed, listedBefore: locked.listed, titleSet: Boolean(seo.title), descriptionSet: Boolean(seo.description) },
    });
    const { row, lapsed } = await readListing(context, transaction);
    return toView(row, lapsed);
  });
}
