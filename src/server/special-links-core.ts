import "server-only";

import { and, eq, sql } from "drizzle-orm";

import type { KalendrTransaction } from "@/db/client";
import { combinedLinks } from "@/db/schema";
import { ApiError } from "@/server/api-error";
import { sha256 } from "@/server/crypto";

/** The part of special links the booking commit needs. It imports nothing from the staff side, so the commit can use it without a cycle. */

export const SPECIAL_LINK_UNAVAILABLE = "special_link_unavailable";

const unavailable = (): ApiError =>
  new ApiError(410, SPECIAL_LINK_UNAVAILABLE, "This link has already been used or has stopped working. Contact the business to book.");

/**
 * The booking transaction's one counting step. The conditional update is the whole check: no row back means the link is
 * used up, expired, revoked, for another service or unknown, and the booking is refused. It runs inside the booking
 * transaction, so a booking that fails later gives the use back, and two people on a single-use link cannot both win
 * (the second waits on the row lock, then finds it spent).
 */
export async function spendSpecialLink(transaction: KalendrTransaction, tenantId: string, token: string, serviceId: string): Promise<string> {
  const rows = await transaction.execute<{ id: string }>(sql`
    update special_links set used_count = used_count + 1
    where tenant_id = ${tenantId}
      and token_hash = ${sha256(token)}
      and service_id = ${serviceId}
      and revoked_at is null
      and (max_uses is null or used_count < max_uses)
      and (expires_at is null or expires_at > now())
    returning id
  `);
  const [row] = rows;
  if (!row) throw unavailable();
  return row.id;
}

export interface ResolvedCombinedLink {
  tenantId: string;
  clinicSlug: string;
  serviceId: string;
  serviceSlug: string;
  practitionerIds: string[];
}

/** The people on a combined link that are still active and still offer the service. A link with someone missing offers nothing. */
export async function resolveCombinedLink(transaction: KalendrTransaction, tenantId: string, slug: string): Promise<ResolvedCombinedLink | null> {
  const [link] = await transaction.select().from(combinedLinks).where(and(eq(combinedLinks.tenantId, tenantId), eq(combinedLinks.slug, slug)));
  if (!link) return null;
  const [tenant] = await transaction.execute<{ slug: string }>(sql`select slug from tenants where id = ${tenantId}`);
  const [service] = await transaction.execute<{ slug: string }>(sql`select slug from services where tenant_id = ${tenantId} and id = ${link.serviceId}`);
  if (!tenant || !service) return null;
  const active = await transaction.execute<{ id: string }>(sql`
    select practitioner.id from practitioners as practitioner
    join practitioner_services as practitioner_service on practitioner_service.tenant_id = practitioner.tenant_id and practitioner_service.practitioner_id = practitioner.id and practitioner_service.service_id = ${link.serviceId}
    where practitioner.tenant_id = ${tenantId} and practitioner.is_active and practitioner.id in (${sql.join(link.practitionerIds.map((value) => sql`${value}`), sql`, `)})
  `);
  if (active.length !== link.practitionerIds.length) return null;
  return { tenantId, clinicSlug: tenant.slug, serviceId: link.serviceId, serviceSlug: service.slug, practitionerIds: link.practitionerIds };
}
