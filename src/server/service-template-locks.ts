import "server-only";

import { sql } from "drizzle-orm";

import type { KalendrTransaction } from "@/db/client";
import { type LockableField, lockLabels, lockableFields, touchedLockFields } from "@/lib/service-templates";
import type { ServiceSetup } from "@/lib/service-setup";

import { ApiError } from "./api-error";

/**
 * The server's side of "locked fields" (feature 48). Every path that changes a service's settings asks here first, so a
 * locked field is refused no matter which screen or request tries to change it.
 */

type PatchLike = Parameters<typeof touchedLockFields>[0];

interface LockRow extends Record<string, unknown> {
  name: string;
  locked_fields: string[];
}

/** The lock names of the template a service follows, or null for a service that follows none. */
export async function templateLocksOf(transaction: KalendrTransaction, tenantId: string, serviceId: string): Promise<{ templateName: string; locked: LockableField[] } | null> {
  const [row] = await transaction.execute<LockRow>(sql`
    select template.name, template.locked_fields
    from services as service
    join service_templates as template on template.tenant_id = service.tenant_id and template.id = service.template_id
    where service.tenant_id = ${tenantId} and service.id = ${serviceId}
  `);
  if (!row) return null;
  return { templateName: row.name, locked: row.locked_fields.filter((field): field is LockableField => (lockableFields as readonly string[]).includes(field)) };
}

export function lockRefusal(templateName: string, fields: readonly LockableField[]): ApiError {
  const names = fields.map((field) => lockLabels[field].toLowerCase());
  const message = `Set by the template “${templateName}”: ${names.join(", ")} can only be changed there.`;
  return new ApiError(409, "template_locked", message, { template: [message] }, undefined, { fields: [...fields] });
}

/** Refuses a patch that touches a locked field of a copy. A service that follows no template is never refused. */
export async function assertNotLocked(transaction: KalendrTransaction, tenantId: string, serviceId: string, patch: PatchLike, current: ServiceSetup): Promise<void> {
  const locks = await templateLocksOf(transaction, tenantId, serviceId);
  if (!locks || locks.locked.length === 0) return;
  // A locked "lengths" also covers prices, and locked "prices" is the narrower of the two.
  const blocked = touchedLockFields(patch, current).filter((field) => locks.locked.includes(field) || (field === "prices" && locks.locked.includes("lengths")));
  if (blocked.length > 0) throw lockRefusal(locks.templateName, blocked);
}

/** For the payment screen: a price change on a copy whose prices are locked is refused. */
export async function assertPriceNotLocked(transaction: KalendrTransaction, tenantId: string, serviceId: string, newDefaultPriceMinor: number | null): Promise<void> {
  const locks = await templateLocksOf(transaction, tenantId, serviceId);
  if (!locks || !(locks.locked.includes("prices") || locks.locked.includes("lengths"))) return;
  const [row] = await transaction.execute<{ price_minor: number | null }>(sql`select price_minor from services where tenant_id = ${tenantId} and id = ${serviceId}`);
  if ((row?.price_minor ?? null) !== newDefaultPriceMinor) throw lockRefusal(locks.templateName, ["prices"]);
}
