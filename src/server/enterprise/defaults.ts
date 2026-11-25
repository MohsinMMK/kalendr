import "server-only";

import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import { withTenant } from "@/db/client";
import { auditEvents, tenants } from "@/db/schema";
import { clockOptions, weekStartOptions, type OrgDefaults, type OrgDefaultsInput } from "@/lib/enterprise-contracts";
import { ApiError } from "@/server/api-error";
import type { StaffContext } from "@/server/staff-context";

import { guardOrgRead, guardOrgWrite } from "./guard";

const storedSchema = z.object({
  timezone: z.string().nullable().catch(null),
  clock: z.enum(clockOptions).nullable().catch(null),
  weekStart: z.enum(weekStartOptions).nullable().catch(null),
  confirmationMessage: z.string().nullable().catch(null),
  reminderMessage: z.string().nullable().catch(null),
  version: z.number().int().min(0).catch(0),
});

const empty: OrgDefaults = { timezone: null, clock: null, weekStart: null, confirmationMessage: null, reminderMessage: null, version: 0 };

export function parseOrgDefaults(value: unknown): OrgDefaults {
  const parsed = storedSchema.safeParse(typeof value === "object" && value !== null ? value : {});
  return parsed.success ? parsed.data : empty;
}

function validTimezone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The defaults for one business, read in its own scope. New branches and services start from these. */
export async function orgDefaultsFor(tenantId: string): Promise<OrgDefaults> {
  return withTenant(tenantId, async (transaction) => {
    const [row] = await transaction.select({ defaults: tenants.defaults }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    return parseOrgDefaults(row?.defaults);
  });
}

export async function getOrgDefaults(context: StaffContext): Promise<OrgDefaults> {
  guardOrgRead(context);
  return context.preview ? empty : orgDefaultsFor(context.tenantId);
}

export async function saveOrgDefaults(context: StaffContext, input: OrgDefaultsInput): Promise<OrgDefaults> {
  guardOrgWrite(context);
  if (input.timezone && !validTimezone(input.timezone)) throw new ApiError(400, "invalid_timezone", "Choose a time zone from the list.", { timezone: ["Choose a time zone from the list."] });
  return withTenant(context.tenantId, async (transaction) => {
    await transaction.execute(sql`select 1 from tenants where id = ${context.tenantId} for update`);
    const [row] = await transaction.select({ defaults: tenants.defaults }).from(tenants).where(eq(tenants.id, context.tenantId)).limit(1);
    const current = parseOrgDefaults(row?.defaults);
    if ((input.version ?? current.version) !== current.version) throw new ApiError(409, "version_conflict", "Someone else changed these defaults. Reload and try again.");
    const next: OrgDefaults = {
      timezone: input.timezone === undefined ? current.timezone : input.timezone,
      clock: input.clock === undefined ? current.clock : input.clock,
      weekStart: input.weekStart === undefined ? current.weekStart : input.weekStart,
      confirmationMessage: input.confirmationMessage === undefined ? current.confirmationMessage : input.confirmationMessage || null,
      reminderMessage: input.reminderMessage === undefined ? current.reminderMessage : input.reminderMessage || null,
      version: current.version + 1,
    };
    await transaction.update(tenants).set({ defaults: { ...next }, updatedAt: new Date() }).where(eq(tenants.id, context.tenantId));
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "enterprise.defaults.updated", outcome: "success",
      // The wording is free text, so the audit row says only which defaults changed.
      metadata: { changed: (Object.keys(input) as (keyof OrgDefaultsInput)[]).filter((key) => key !== "version") },
    });
    return next;
  });
}
