import "server-only";

import { eq } from "drizzle-orm";
import { z } from "zod";

import { withTenant, type KalendrTransaction } from "@/db/client";
import { auditEvents, retentionPolicies, tenants } from "@/db/schema";

import { ApiError } from "../api-error";
import { can, requirePermission, requireRecentStepUp, type StaffContext } from "../staff-context";
import { effectiveRetention, retentionKindInfo, retentionKinds, validateRetention, type RetentionAction, type RetentionKind } from "./rules";

export interface RetentionSettings {
  policies: {
    dataKind: RetentionKind;
    keepDays: number;
    action: RetentionAction;
    isDefault: boolean;
    label?: string;
    description?: string;
    editable?: boolean;
    minDays?: number;
    maxDays?: number;
  }[];
}

export const retentionInputSchema = z.object({
  policies: z.array(z.object({
    dataKind: z.enum(retentionKinds),
    keepDays: z.number().int().min(1).max(36_500),
    action: z.enum(["delete", "anonymise"]),
  }).strict()).min(1).max(retentionKinds.length),
}).strict();
export type RetentionInput = z.infer<typeof retentionInputSchema>;

export async function loadRetentionSettings(transaction: KalendrTransaction, tenantId: string): Promise<RetentionSettings> {
  const [tenant] = await transaction.select({ businessType: tenants.businessType }).from(tenants).where(eq(tenants.id, tenantId));
  const stored = await transaction.select().from(retentionPolicies).where(eq(retentionPolicies.tenantId, tenantId));
  const effective = effectiveRetention(tenant?.businessType ?? "healthcare", stored.map((row) => ({ dataKind: row.dataKind, keepDays: row.keepDays, action: row.action })));
  return {
    policies: retentionKinds.map((kind) => ({
      dataKind: kind,
      keepDays: effective[kind].keepDays,
      action: effective[kind].action,
      isDefault: effective[kind].isDefault,
      label: retentionKindInfo[kind].label,
      description: retentionKindInfo[kind].description,
      editable: retentionKindInfo[kind].editable,
      minDays: retentionKindInfo[kind].minDays,
      maxDays: retentionKindInfo[kind].maxDays,
    })),
  };
}

function requireAccess(context: StaffContext): void {
  // Either permission is enough; a refusal is recorded in the activity log by requirePermission.
  if (!can(context, "settings.manage")) requirePermission(context, "privacy.manage");
}

export async function getRetentionSettings(context: StaffContext): Promise<RetentionSettings> {
  requireAccess(context);
  return withTenant(context.tenantId, (transaction) => loadRetentionSettings(transaction, context.tenantId));
}

/** Saves the periods the owner chose. Needs a recent second-factor check. Writes one audit row with the changed kinds and numbers. */
export async function saveRetentionSettings(context: StaffContext, input: RetentionInput): Promise<RetentionSettings> {
  requireAccess(context);
  if (context.preview) throw new ApiError(409, "preview_only", "Data retention can't be changed in the preview.");
  requireRecentStepUp(context);
  for (const policy of input.policies) {
    const problem = validateRetention(policy.dataKind, policy);
    if (problem) throw new ApiError(400, "validation_error", problem, { policies: [problem] });
  }
  return withTenant(context.tenantId, async (transaction) => {
    const before = await loadRetentionSettings(transaction, context.tenantId);
    const changes: Record<string, { from: number; to: number }> = {};
    for (const policy of input.policies) {
      const current = before.policies.find((entry) => entry.dataKind === policy.dataKind);
      if (current && current.keepDays === policy.keepDays && current.action === policy.action) continue;
      await transaction.insert(retentionPolicies).values({
        tenantId: context.tenantId,
        dataKind: policy.dataKind,
        keepDays: policy.keepDays,
        action: policy.action,
        updatedByUserId: context.userId,
      }).onConflictDoUpdate({
        target: [retentionPolicies.tenantId, retentionPolicies.dataKind],
        set: { keepDays: policy.keepDays, action: policy.action, updatedByUserId: context.userId, updatedAt: new Date() },
      });
      changes[policy.dataKind] = { from: current?.keepDays ?? 0, to: policy.keepDays };
    }
    if (Object.keys(changes).length > 0) {
      await transaction.insert(auditEvents).values({
        tenantId: context.tenantId,
        actorUserId: context.userId,
        actorType: "staff",
        action: "privacy.retention.updated",
        outcome: "success",
        metadata: { changes },
      });
    }
    return loadRetentionSettings(transaction, context.tenantId);
  });
}
