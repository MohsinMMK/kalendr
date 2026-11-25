import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { getDatabase, withTenant } from "@/db/client";
import { auditEvents, combinedLinks, specialLinks } from "@/db/schema";
import {
  type CombinedLinkView,
  type CreateCombinedLinkInput,
  type CreateSpecialLinkInput,
  type SpecialLinkView,
  linkStatus,
  specialLinkPath,
} from "@/lib/special-links";
import { ApiError } from "@/server/api-error";
import { createOpaqueToken, sha256 } from "@/server/crypto";
import { type ResolvedCombinedLink, resolveCombinedLink } from "@/server/special-links-core";
export { spendSpecialLink, SPECIAL_LINK_UNAVAILABLE } from "@/server/special-links-core";
import { type StaffContext, requirePermission } from "@/server/staff-context";

/**
 * Special links (feature 45). A link books one service, once, a few times or until a date. The token is 256 random bits,
 * shown to staff once and stored only as its hash; nothing here logs it, and audit rows carry ids and counts, never the
 * label (staff-typed free text) or the token.
 */

export async function createSpecialLink(context: StaffContext, serviceId: string, input: CreateSpecialLinkInput): Promise<{ id: string; token: string; path: string }> {
  requirePermission(context, "services.manage");
  const token = createOpaqueToken();
  const id = await withTenant(context.tenantId, async (transaction) => {
    const [service] = await transaction.execute<{ id: string }>(sql`select id from services where tenant_id = ${context.tenantId} and id = ${serviceId}`);
    if (!service) throw new ApiError(404, "service_not_found", "That service no longer exists.");
    const [row] = await transaction.insert(specialLinks).values({
      tenantId: context.tenantId,
      serviceId,
      tokenHash: sha256(token),
      label: input.label,
      kind: input.kind,
      maxUses: input.kind === "single_use" ? 1 : input.kind === "limited" ? input.maxUses ?? null : null,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      createdByUserId: context.userId,
    }).returning({ id: specialLinks.id });
    if (!row) throw new Error("Link insert did not return a row");
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "special_link.created", outcome: "success",
      metadata: { linkId: row.id, serviceId, kind: input.kind, ...(input.maxUses ? { maxUses: input.maxUses } : {}), expires: Boolean(input.expiresAt) },
    });
    return row.id;
  });
  return { id, token, path: specialLinkPath(token) };
}

export async function listSpecialLinks(context: StaffContext, serviceId: string): Promise<SpecialLinkView[]> {
  requirePermission(context, "services.manage");
  return withTenant(context.tenantId, async (transaction) => {
    const rows = await transaction.select().from(specialLinks)
      .where(and(eq(specialLinks.tenantId, context.tenantId), eq(specialLinks.serviceId, serviceId)))
      .orderBy(sql`${specialLinks.createdAt} desc`).limit(200);
    const bookings = rows.length === 0 ? [] : await transaction.execute<{ link_id: string; appointment_id: string; starts_at: Date; status: string; first_name: string; last_name: string }>(sql`
      select appointment.special_link_id as link_id, appointment.id as appointment_id, appointment.starts_at, appointment.status,
        patient.first_name, patient.last_name
      from appointments as appointment
      join patients as patient on patient.tenant_id = appointment.tenant_id and patient.id = appointment.patient_id
      where appointment.tenant_id = ${context.tenantId}
        and appointment.special_link_id in (${sql.join(rows.map((row) => sql`${row.id}`), sql`, `)})
      order by appointment.starts_at desc
    `);
    const now = new Date();
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      kind: row.kind as SpecialLinkView["kind"],
      maxUses: row.maxUses,
      usedCount: row.usedCount,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      status: linkStatus(row, now),
      bookings: bookings.filter((booking) => booking.link_id === row.id).map((booking) => ({
        appointmentId: booking.appointment_id,
        startsAt: new Date(booking.starts_at).toISOString(),
        status: booking.status,
        customerName: booking.last_name ? `${booking.first_name} ${booking.last_name.slice(0, 1)}.` : booking.first_name,
      })),
    }));
  });
}

export async function revokeSpecialLink(context: StaffContext, linkId: string): Promise<{ revoked: true }> {
  requirePermission(context, "services.manage");
  return withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction.update(specialLinks).set({ revokedAt: new Date() })
      .where(and(eq(specialLinks.tenantId, context.tenantId), eq(specialLinks.id, linkId), sql`${specialLinks.revokedAt} is null`))
      .returning({ id: specialLinks.id, serviceId: specialLinks.serviceId });
    if (!row) throw new ApiError(404, "special_link_not_found", "That link is already revoked or no longer exists.");
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "special_link.revoked", outcome: "success",
      metadata: { linkId: row.id, serviceId: row.serviceId },
    });
    return { revoked: true as const };
  });
}

/** What the public link page needs, found from the token alone. `unknown` is the same page whether the token never existed or was deleted. */
export type PublicLinkResolution =
  | { state: "ok"; tenantId: string; clinicSlug: string; serviceId: string; serviceSlug: string; token: string }
  | { state: "unavailable"; clinicSlug: string }
  | { state: "unknown" };

export async function resolvePublicSpecialLink(token: string): Promise<PublicLinkResolution> {
  const database = getDatabase();
  if (!database || !/^[A-Za-z0-9_-]{20,100}$/.test(token)) return { state: "unknown" };
  const [found] = await database.execute<{ tenant_id: string; link_id: string }>(sql`select tenant_id, link_id from kalendr_resolve_special_link(${sha256(token)})`);
  if (!found) return { state: "unknown" };
  return withTenant(found.tenant_id, async (transaction) => {
    const [row] = await transaction.execute<{ slug: string; service_id: string; service_slug: string; max_uses: number | null; used_count: number; expires_at: Date | null; revoked_at: Date | null }>(sql`
      select tenant.slug, link.service_id, service.slug as service_slug, link.max_uses, link.used_count, link.expires_at, link.revoked_at
      from special_links as link
      join tenants as tenant on tenant.id = link.tenant_id
      join services as service on service.tenant_id = link.tenant_id and service.id = link.service_id
      where link.tenant_id = ${found.tenant_id} and link.id = ${found.link_id}
    `);
    if (!row) return { state: "unknown" as const };
    const status = linkStatus({ maxUses: row.max_uses, usedCount: row.used_count, expiresAt: row.expires_at, revokedAt: row.revoked_at });
    return status === "active"
      ? { state: "ok" as const, tenantId: found.tenant_id, clinicSlug: row.slug, serviceId: row.service_id, serviceSlug: row.service_slug, token }
      : { state: "unavailable" as const, clinicSlug: row.slug };
  });
}

// ---- combined links: two to four people booked together ----

export async function createCombinedLink(context: StaffContext, serviceId: string, input: CreateCombinedLinkInput): Promise<{ id: string; slug: string }> {
  requirePermission(context, "services.manage");
  const unique = [...new Set(input.practitionerIds)];
  if (unique.length !== input.practitionerIds.length) throw new ApiError(400, "validation_error", "Each person can be chosen once.", { practitionerIds: ["Each person can be chosen once."] });
  return withTenant(context.tenantId, async (transaction) => {
    const [service] = await transaction.execute<{ id: string; payment_mode: string }>(sql`select id, payment_mode from services where tenant_id = ${context.tenantId} and id = ${serviceId}`);
    if (!service) throw new ApiError(404, "service_not_found", "That service no longer exists.");
    // One payment step cannot pay for several bookings, so a combined link needs a service that takes no online payment.
    if (service.payment_mode !== "none") throw new ApiError(409, "combined_payment_unsupported", "A service that takes online payment can't be booked for several people at once. Turn its payment off first.");
    const offering = await transaction.execute<{ practitioner_id: string }>(sql`
      select practitioner_service.practitioner_id from practitioner_services as practitioner_service
      join practitioners as practitioner on practitioner.tenant_id = practitioner_service.tenant_id and practitioner.id = practitioner_service.practitioner_id and practitioner.is_active
      where practitioner_service.tenant_id = ${context.tenantId} and practitioner_service.service_id = ${serviceId}
        and practitioner_service.practitioner_id in (${sql.join(unique.map((value) => sql`${value}`), sql`, `)})
    `);
    if (offering.length !== unique.length) throw new ApiError(400, "validation_error", "Everyone chosen must offer this service.", { practitionerIds: ["Everyone chosen must offer this service."] });
    const [row] = await transaction.insert(combinedLinks).values({
      tenantId: context.tenantId, slug: input.slug, label: input.label, serviceId, practitionerIds: unique, createdByUserId: context.userId,
    }).onConflictDoNothing().returning({ id: combinedLinks.id });
    if (!row) throw new ApiError(409, "slug_taken", "Another combined link already uses that address. Pick a different one.", { slug: ["Already used."] });
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "combined_link.created", outcome: "success",
      metadata: { linkId: row.id, serviceId, people: unique.length },
    });
    return { id: row.id, slug: input.slug };
  });
}

export async function listCombinedLinks(context: StaffContext, serviceId: string): Promise<CombinedLinkView[]> {
  requirePermission(context, "services.manage");
  return withTenant(context.tenantId, async (transaction) => {
    const rows = await transaction.select().from(combinedLinks)
      .where(and(eq(combinedLinks.tenantId, context.tenantId), eq(combinedLinks.serviceId, serviceId))).orderBy(sql`${combinedLinks.createdAt} desc`);
    return rows.map((row) => ({ id: row.id, label: row.label, slug: row.slug, practitionerIds: row.practitionerIds, createdAt: row.createdAt.toISOString() }));
  });
}

export async function deleteCombinedLink(context: StaffContext, linkId: string): Promise<{ removed: true }> {
  requirePermission(context, "services.manage");
  return withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction.delete(combinedLinks).where(and(eq(combinedLinks.tenantId, context.tenantId), eq(combinedLinks.id, linkId))).returning({ id: combinedLinks.id });
    if (!row) throw new ApiError(404, "combined_link_not_found", "That link no longer exists.");
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "combined_link.removed", outcome: "success", metadata: { linkId: row.id },
    });
    return { removed: true as const };
  });
}


/** A combined link from its business address and its own address, for the public page. Null for anything that no longer works. */
export async function resolvePublicCombinedLink(clinicSlug: string, combo: string): Promise<ResolvedCombinedLink | null> {
  const database = getDatabase();
  if (!database) return null;
  const [tenant] = await database.execute<{ tenant_id: string }>(sql`select tenant_id from kalendr_resolve_tenant(${clinicSlug}, null)`);
  if (!tenant) return null;
  return withTenant(tenant.tenant_id, (transaction) => resolveCombinedLink(transaction, tenant.tenant_id, combo));
}
