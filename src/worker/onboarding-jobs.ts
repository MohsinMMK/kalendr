import type postgres from "postgres";
import { z } from "zod";

import { dueOnboardingEmails, type OnboardingEmailKind } from "../lib/onboarding-steps";
import { appOrigin } from "../server/env";
import { ONBOARDING_EMAIL_EVENT } from "../server/onboarding/events";
import { loadChecklist } from "../server/onboarding/facts";
import { postgresRunner } from "../server/workflows/runner";
import { deliveryToHandlerOutcome, type HandlerDependencies } from "./handlers/appointment-message";
import type { EventHandler } from "./handlers/types";

/**
 * The onboarding email series for a business's owner (feature 11). A timed job looks at every business in its first two
 * weeks and queues the emails that are due; each email is one outbox row with a fixed key, so it is sent at most once.
 * The goal of each email is checked again just before it is sent, so an owner who finishes in between is not nagged.
 *
 * The spec asks for these as workflows (feature 5). The workflow engine sends a business's messages to its customers, and
 * these are Kalendr's own messages to the owner, so they ride the owner-notice path used for billing and address emails.
 */

const kinds = ["onboarding_welcome", "onboarding_day1", "onboarding_day3"] as const satisfies readonly OnboardingEmailKind[];
const payload = z.object({ kind: z.enum(kinds) });
const hourMs = 3_600_000;

export interface OnboardingSweepSummary extends Record<string, number> {
  tenants: number;
  queued: number;
}

/** Queues the day-1 and day-3 emails that are due. The welcome email is queued at registration. Safe to run any number of times. */
export async function sweepOnboarding(database: postgres.Sql, now: Date = new Date()): Promise<OnboardingSweepSummary> {
  const summary: OnboardingSweepSummary = { tenants: 0, queued: 0 };
  const ids = await database<{ tenant_id: string }[]>`select kalendr_onboarding_tenants() as tenant_id`;
  for (const { tenant_id: tenantId } of ids) {
    summary.tenants += 1;
    await database.begin(async (tenantDb) => {
      await tenantDb`select set_config('app.tenant_id', ${tenantId}, true)`;
      const checklist = await loadChecklist(postgresRunner(tenantDb), tenantId);
      if (!checklist?.business.onboardingStartedAt) return;
      const due = dueOnboardingEmails({
        ageHours: (now.getTime() - checklist.business.onboardingStartedAt.getTime()) / hourMs,
        summary: checklist.summary,
        realBookings: checklist.business.realBookings,
      });
      for (const kind of due) {
        const queued = await tenantDb`
          insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
          values (${tenantId}, 'onboarding', ${tenantId}, ${ONBOARDING_EMAIL_EVENT}, ${tenantDb.json({ kind })}, ${`onboarding.email:${kind}`})
          on conflict (tenant_id, dedupe_key) do nothing
          returning id
        `;
        if (queued.length > 0) summary.queued += 1;
      }
    });
  }
  return summary;
}

/** Sends one onboarding email to the owner, unless its goal has been met since it was queued. */
export function onboardingEmailHandler({ sink, now }: Pick<HandlerDependencies, "sink" | "now">): EventHandler {
  return async (tenantDb, event) => {
    const parsed = payload.safeParse(event.payload);
    if (!parsed.success) return { outcome: "dead", code: "invalid_payload" };
    const { kind } = parsed.data;
    const at = now();
    const checklist = await loadChecklist(postgresRunner(tenantDb), event.tenantId);
    if (!checklist) return "delivered";
    // The goal is checked again now: asking for the same due list with the age that made it due stops an email that no longer applies.
    if (kind !== "onboarding_welcome") {
      const stillDue = dueOnboardingEmails({
        ageHours: kind === "onboarding_day1" ? 24 : 72,
        summary: checklist.summary,
        realBookings: checklist.business.realBookings,
      });
      if (!stillDue.includes(kind)) return "delivered";
    }
    const [owner] = await tenantDb<{ email: string | null; name: string }[]>`select email, name from tenants where id = ${event.tenantId}`;
    const email = owner?.email?.trim();
    if (!owner || !email) return { outcome: "dead", code: "no_destination" };
    const origin = appOrigin();
    return deliveryToHandlerOutcome(await sink.deliver(tenantDb, {
      tenantId: event.tenantId,
      appointmentId: null,
      patientId: "",
      channel: "email",
      message: {
        semanticKey: `local:owner:${event.tenantId}:${event.dedupeKey}`,
        templateKey: `owner.${kind}`,
        body: JSON.stringify({
          settingsUrl: `${origin}/settings`, dashboardUrl: `${origin}/dashboard`,
          bookingUrl: checklist.business.liveHost ? `https://${checklist.business.liveHost}/book` : `${origin}/book/${encodeURIComponent(checklist.business.slug)}`,
          done: checklist.summary.done, total: checklist.summary.total,
        }),
        scheduledAt: at,
      },
      recipient: { email, name: owner.name },
    }, at));
  };
}
