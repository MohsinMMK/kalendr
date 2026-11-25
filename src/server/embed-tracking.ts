import "server-only";

import { eq } from "drizzle-orm";

import { withTenant } from "@/db/client";
import { auditEvents, trackingSettings } from "@/db/schema";
import { emptyTracking, hasTracking, type TrackingSettings, type TrackingUpdate } from "@/lib/embed/tracking";

import { ApiError } from "./api-error";
import type { StaffContext } from "./staff-context";

export interface TrackingView extends TrackingSettings {
  version: number;
}

function view(row: typeof trackingSettings.$inferSelect | undefined): TrackingView {
  return row
    ? { googleAnalyticsId: row.googleAnalyticsId, tagManagerId: row.tagManagerId, metaPixelId: row.metaPixelId, plausibleDomain: row.plausibleDomain, version: row.version }
    : { ...emptyTracking, version: 0 };
}

export async function getTrackingSettings(context: StaffContext): Promise<TrackingView> {
  if (context.preview) return { ...emptyTracking, version: 0 };
  return withTenant(context.tenantId, async (transaction) => {
    const [row] = await transaction.select().from(trackingSettings).where(eq(trackingSettings.tenantId, context.tenantId)).limit(1);
    return view(row);
  });
}

/**
 * Saves the business's tracking ids. `expectedVersion` is 0 for a first save; a stale one is refused so two managers
 * cannot overwrite each other. The audit row names which providers are on, never the ids themselves.
 */
export async function saveTrackingSettings(context: StaffContext, input: TrackingUpdate): Promise<TrackingView> {
  if (context.preview) throw new ApiError(409, "preview_only", "Tracking needs a database.");
  const { expectedVersion, ...values } = input;
  return withTenant(context.tenantId, async (transaction) => {
    const [current] = await transaction.select().from(trackingSettings).where(eq(trackingSettings.tenantId, context.tenantId)).limit(1).for("update");
    if ((current?.version ?? 0) !== expectedVersion) {
      throw new ApiError(409, "version_conflict", "Someone else changed the tracking settings. Reload and try again.");
    }
    const [saved] = current
      ? await transaction.update(trackingSettings).set({ ...values, version: current.version + 1, updatedAt: new Date() })
        .where(eq(trackingSettings.tenantId, context.tenantId)).returning()
      : await transaction.insert(trackingSettings).values({ tenantId: context.tenantId, ...values }).returning();
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff",
      action: "settings.tracking.updated", outcome: "success",
      metadata: { ga: Boolean(values.googleAnalyticsId), gtm: Boolean(values.tagManagerId), meta: Boolean(values.metaPixelId), plausible: Boolean(values.plausibleDomain) },
    });
    return view(saved);
  });
}

/** The ids a public booking page injects, or null when the business has none. Read inside the business's own scope. */
export async function publicTracking(tenantId: string): Promise<TrackingSettings | null> {
  try {
    const row = await withTenant(tenantId, async (transaction) => {
      const [found] = await transaction.select().from(trackingSettings).where(eq(trackingSettings.tenantId, tenantId)).limit(1);
      return found;
    });
    const found = view(row);
    return hasTracking(found) ? found : null;
  } catch {
    return null;
  }
}

