import "server-only";

import { sql } from "drizzle-orm";

import type { KalendrTransaction } from "@/db/client";
import { editableCalendarIds, limitFor, planDefinitions, withinLimit, type PlanKey } from "@/lib/entitlements";
import { planLimitErrorCode } from "@/lib/billing-contracts";
import { usagePeriod } from "@/lib/billing-rules";

import { ApiError } from "../api-error";
import { planLimitError } from "../entitlements";
import { loadBilling, type LoadedBilling } from "./entitlement-loader";
import { drizzleRunner } from "../workflows/runner";

/**
 * Plan limits that depend on how much a business already has (feature 14). Each check runs inside the transaction
 * that makes the change, so two requests at once cannot both slip under a limit: the subscription row is locked
 * first. Pure feature gates (`requireFeature`) live in src/server/entitlements.ts.
 */

type Transaction = Pick<KalendrTransaction, "execute">;

interface CountRow extends Record<string, unknown> { count: number | string }

async function activeCalendars(transaction: Transaction, tenantId: string): Promise<string[]> {
  // Oldest first, so the newest calendars are the ones that go read-only after a downgrade.
  const rows = await transaction.execute<{ id: string }>(sql`
    select id from practitioners where tenant_id = ${tenantId} and is_active order by created_at, id
  `);
  return Array.from(rows, (row) => row.id);
}

/** Creating or re-activating a staff calendar. Locks the subscription so concurrent creates are counted one by one. */
export async function assertCanAddCalendar(transaction: Transaction, tenantId: string): Promise<void> {
  const { entitlements } = await loadBilling(drizzleRunner(transaction), tenantId, { lock: true });
  const count = (await activeCalendars(transaction, tenantId)).length;
  if (!withinLimit(entitlements, "staffCalendars", count)) throw planLimitError("staffCalendars", entitlements, count);
}

/** Creating a location. Exported for the screen that adds locations; no staff route creates one yet. */
export async function assertCanAddLocation(transaction: Transaction, tenantId: string): Promise<void> {
  const { entitlements } = await loadBilling(drizzleRunner(transaction), tenantId, { lock: true });
  const rows = await transaction.execute<CountRow>(sql`select count(*)::int as count from locations where tenant_id = ${tenantId} and is_active`);
  const count = Number(Array.from(rows)[0]?.count ?? 0);
  if (!withinLimit(entitlements, "locations", count)) throw planLimitError("locations", entitlements, count);
}

/** Calendars beyond the plan's limit after a downgrade. They stay visible but cannot be edited or booked. */
export async function readOnlyCalendarIds(transaction: Transaction, tenantId: string, loaded?: LoadedBilling): Promise<Set<string>> {
  const { entitlements } = loaded ?? await loadBilling(drizzleRunner(transaction), tenantId);
  const limit = limitFor(entitlements, "staffCalendars");
  if (limit === null) return new Set();
  const ordered = await activeCalendars(transaction, tenantId);
  const editable = editableCalendarIds(ordered, limit);
  return new Set(ordered.filter((id) => !editable.has(id)));
}

function readOnlyError(audience: "staff" | "public", entitlements: LoadedBilling["entitlements"], readOnlyCount: number): ApiError {
  if (audience === "public") {
    return new ApiError(402, planLimitErrorCode, "This calendar isn't taking new bookings online right now. Please contact the business directly.");
  }
  // limit + read-only calendars is how many are switched on, so the prompt names the plan that holds them all.
  const limit = limitFor(entitlements, "staffCalendars") ?? 0;
  const error = planLimitError("staffCalendars", entitlements, limit + readOnlyCount - 1);
  const required = typeof error.details?.requiredPlan === "string" ? planDefinitions[error.details.requiredPlan as PlanKey]?.name : undefined;
  return new ApiError(402, planLimitErrorCode, `This calendar is read-only because your ${entitlements.planName} plan includes fewer calendars than you have. Upgrade to ${required ?? "a higher plan"} or switch off other calendars.`, undefined, undefined, error.details);
}

/** A calendar over the plan's limit cannot be edited (details, hours, services). Deactivating it is always allowed. */
export async function assertCalendarEditable(transaction: Transaction, tenantId: string, practitionerId: string): Promise<void> {
  const loaded = await loadBilling(drizzleRunner(transaction), tenantId);
  const readOnly = await readOnlyCalendarIds(transaction, tenantId, loaded);
  if (readOnly.has(practitionerId)) throw readOnlyError("staff", loaded.entitlements, readOnly.size);
}

async function bookingsThisMonth(transaction: Transaction, tenantId: string, now: Date): Promise<number> {
  const rows = await transaction.execute<CountRow>(sql`
    select count(*)::int as count from appointments
    where tenant_id = ${tenantId} and created_at >= ${usagePeriod(now)}::date and status <> 'entered_in_error'
  `);
  return Number(Array.from(rows)[0]?.count ?? 0);
}

/**
 * Called inside every booking transaction (public, staff and the queue door) before the appointment row is written.
 * Refuses a NEW booking on a calendar that went read-only, and on Free once the month's bookings are used up.
 * Existing bookings are never touched. The public message does not talk about plans: the customer can't upgrade.
 */
export async function assertBookingAllowed(
  transaction: Transaction,
  tenantId: string,
  practitionerId: string | null,
  audience: "staff" | "public",
  now: Date = new Date(),
): Promise<void> {
  const loaded = await loadBilling(drizzleRunner(transaction), tenantId, { now });
  const { entitlements } = loaded;
  if (practitionerId && limitFor(entitlements, "staffCalendars") !== null) {
    const readOnly = await readOnlyCalendarIds(transaction, tenantId, loaded);
    if (readOnly.has(practitionerId)) throw readOnlyError(audience, entitlements, readOnly.size);
  }
  const limit = limitFor(entitlements, "bookingsPerMonth");
  if (limit === null) return;
  const count = await bookingsThisMonth(transaction, tenantId, now);
  if (count < limit) return;
  if (audience === "public") {
    throw new ApiError(402, planLimitErrorCode, "This business isn't taking new online bookings right now. Please contact them directly.");
  }
  throw planLimitError("bookingsPerMonth", entitlements, count);
}
