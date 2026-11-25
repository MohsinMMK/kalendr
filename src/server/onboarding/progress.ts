import "server-only";

import { and, eq } from "drizzle-orm";
import { z } from "zod";

import { withTenant, type KalendrTransaction } from "@/db/client";
import { auditEvents, onboardingProgress } from "@/db/schema";
import {
  checklistKeySchema, goLiveChecks, goLiveClear,
  type BookkeepingKey, type ChecklistKey, type ChecklistSummary, type GoLiveCheck, type GoLiveFacts, type StepView,
} from "@/lib/onboarding-steps";
import { profileWords } from "@/lib/terminology";

import { ApiError } from "../api-error";
import { loadBusinessProfileIn } from "../business-profile";
import { appOrigin, emailIsConfigured, env } from "../env";
import { assertNotReadOnlyImpersonation, requirePermission, type StaffContext } from "../staff-context";
import { drizzleRunner } from "../workflows/runner";
import { loadChecklist } from "./facts";

/**
 * Where a business is in the first-run checklist (feature 11), and the small actions that move it: marking a step done
 * or skipped, the tour, the go-live check. Nothing here calls out. Step completion times are kept in
 * `onboarding_progress.done_at` (the first time a step was seen done), which the admin console's funnel reads.
 */

export const stepActionSchema = z.strictObject({
  step: checklistKeySchema,
  action: z.enum(["done", "skip", "undo"]),
});
export type StepAction = z.infer<typeof stepActionSchema>;

export const tourActionSchema = z.strictObject({ action: z.enum(["done", "skip", "reopen"]) });

/** Steps the owner can mark done themselves. The rest are found done from the business's own data, or by their own action. */
const markableByOwner: readonly ChecklistKey[] = ["services", "hours", "share_link"];

export interface OnboardingStepState extends Omit<StepView, "doneAt" | "newlyDetected"> {
  doneAt: string | null;
}

export interface OnboardingState {
  steps: OnboardingStepState[];
  summary: ChecklistSummary;
  tour: "new" | "done" | "skipped";
  /** Sample appointments and customers from "Add sample data" are in. */
  sampleData: boolean;
  /** The owner's test booking or sample rows are in, so "Remove test data" has something to do. */
  testRows: number;
  goLive: { checks: GoLiveCheck[]; clear: boolean };
  /** The address to share: the business's own live address if it has one, otherwise its Kalendr page. */
  bookingUrl: string;
  /** For pre-filling the owner's test booking. Returned only to the signed-in owner. */
  owner: { name: string; email: string; phone: string };
}

function reminderChannelWorks(): boolean {
  const settings = env();
  return emailIsConfigured() || Boolean(settings.WHATSAPP_ACCESS_TOKEN && settings.WHATSAPP_PHONE_NUMBER_ID) || Boolean(settings.SMS_PROVIDER && (settings.SMS_API_KEY || settings.MSG91_AUTH_KEY));
}

/** The checklist, the tour and the go-live check, from the business's own data. Saves the first time each automatic step is seen done. */
export async function loadOnboardingState(context: StaffContext): Promise<OnboardingState | null> {
  requirePermission(context, "settings.manage");
  if (context.preview) return null;
  return withTenant(context.tenantId, async (transaction) => {
    const [checklist, profile] = await Promise.all([loadChecklist(drizzleRunner(transaction), context.tenantId), loadBusinessProfileIn(transaction, context.tenantId)]);
    if (!checklist) throw new ApiError(404, "not_found", "This business could not be found.");
    // A business set up before the guided first run existed has no checklist.
    if (!checklist.business.onboardingStartedAt) return null;
    const { marks, business, steps } = checklist;
    // Remember when an automatic step was first seen done, so the funnel has a time for it.
    for (const step of steps.filter((candidate) => candidate.newlyDetected)) {
      await writeMark(transaction, context.tenantId, step.key, "done");
    }
    const goLiveFacts: GoLiveFacts = {
      bookableServices: business.bookable,
      peopleWithHours: business.peopleWithHours,
      reminderChannelWorks: reminderChannelWorks(),
      hasPhoneAndAddress: business.contact,
      testRows: business.testRows,
    };
    const checks = goLiveChecks(goLiveFacts, profileWords(profile));
    const tour = marks.tour?.doneAt ? "done" : marks.tour?.skippedAt ? "skipped" : "new";
    return {
      steps: steps.map((step) => ({ key: step.key, status: step.status, optional: step.optional, target: step.target, actionLabel: step.actionLabel, doneAt: (step.doneAt ?? (step.newlyDetected ? new Date() : null))?.toISOString() ?? null })),
      summary: checklist.summary,
      tour,
      sampleData: Boolean(marks.sample_data?.doneAt),
      testRows: business.testRows,
      goLive: { checks, clear: goLiveClear(checks) },
      bookingUrl: business.liveHost ? `https://${business.liveHost}/book` : `${appOrigin()}/book/${encodeURIComponent(business.slug)}`,
      owner: { name: context.userName, email: context.userEmail, phone: business.phone },
    };
  });
}

async function writeMark(transaction: KalendrTransaction, tenantId: string, key: ChecklistKey | BookkeepingKey, state: "done" | "skipped" | "cleared"): Promise<void> {
  if (state === "cleared") {
    await transaction.delete(onboardingProgress).where(and(eq(onboardingProgress.tenantId, tenantId), eq(onboardingProgress.stepKey, key)));
    return;
  }
  const now = new Date();
  const values = state === "done" ? { doneAt: now, skippedAt: null } : { doneAt: null, skippedAt: now };
  await transaction.insert(onboardingProgress).values({ tenantId, stepKey: key, ...values })
    .onConflictDoUpdate({ target: [onboardingProgress.tenantId, onboardingProgress.stepKey], set: { ...values, updatedAt: now } });
}

/** Marks a step done or skipped, or undoes a skip. Doing the same thing twice changes nothing. */
export async function updateStep(context: StaffContext, input: StepAction): Promise<OnboardingState | null> {
  requirePermission(context, "settings.manage");
  assertNotReadOnlyImpersonation(context);
  if (context.preview) throw new ApiError(409, "preview_mode", "The checklist is not saved in the preview.");
  if (input.action === "done" && !markableByOwner.includes(input.step)) {
    throw new ApiError(409, "step_not_markable", "This step is finished by doing it, so it cannot be ticked off by hand.");
  }
  await withTenant(context.tenantId, async (transaction) => {
    const [existing] = await transaction.select().from(onboardingProgress).where(and(eq(onboardingProgress.tenantId, context.tenantId), eq(onboardingProgress.stepKey, input.step)));
    if (input.action === "done" && !existing?.doneAt) await writeMark(transaction, context.tenantId, input.step, "done");
    // A finished step stays finished: a skip never overwrites it.
    if (input.action === "skip" && !existing?.doneAt) await writeMark(transaction, context.tenantId, input.step, "skipped");
    if (input.action === "undo" && existing?.skippedAt) await writeMark(transaction, context.tenantId, input.step, "cleared");
    await transaction.insert(auditEvents).values({
      tenantId: context.tenantId, actorUserId: context.userId, actorType: "staff", action: "onboarding.step", outcome: "success",
      metadata: { step: input.step, change: input.action },
    });
  });
  return loadOnboardingState(context);
}

export async function updateTour(context: StaffContext, action: "done" | "skip" | "reopen"): Promise<void> {
  requirePermission(context, "settings.manage");
  assertNotReadOnlyImpersonation(context);
  if (context.preview) return;
  await withTenant(context.tenantId, (transaction) => writeMark(transaction, context.tenantId, "tour", action === "done" ? "done" : action === "skip" ? "skipped" : "cleared"));
}

export { writeMark };
