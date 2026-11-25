import { createHash } from "node:crypto";

import type postgres from "postgres";

import { notificationChannel } from "../../lib/notification-routing";
import { expiryReminderText } from "../../lib/offers";
import { expireCredits, EXPIRY_REMINDER_EVENT, queueExpiryReminders, remainingCredits } from "../../server/offers/credits-core";
import { pauseLapsedMemberships } from "../../server/offers/memberships-core";
import { postgresRunner } from "../../server/workflows/runner";
import { deliveryToHandlerOutcome, type HandlerDependencies } from "../handlers/appointment-message";
import type { EventHandler } from "../handlers/types";

export interface OffersJobSummary {
  tenants: number;
  rows: number;
}

type OffersJob = "credit_expiry" | "membership_grace";

async function forEachOffersTenant(database: postgres.Sql, job: OffersJob, work: (tenantDb: postgres.TransactionSql, tenantId: string) => Promise<number>): Promise<OffersJobSummary> {
  const rows = await database<{ tenant_id: string }[]>`select tenant_id from kalendr_offers_tenants(${job}) as tenant_id`;
  let count = 0;
  for (const { tenant_id: tenantId } of rows) {
    count += await database.begin(async (tenantDb) => {
      await tenantDb`select set_config('app.tenant_id', ${tenantId}, true)`;
      return work(tenantDb, tenantId);
    }) as number;
  }
  return { tenants: rows.length, rows: count };
}

/** Nightly: credits left on a package that ran out of time get an expiry row, and the 14-day and 3-day reminders are queued. */
export function sweepCredits(database: postgres.Sql): Promise<OffersJobSummary> {
  return forEachOffersTenant(database, "credit_expiry", async (tenantDb, tenantId) => {
    const run = postgresRunner(tenantDb);
    const now = new Date();
    return (await expireCredits(run, tenantId, now)) + (await queueExpiryReminders(run, tenantId, now));
  });
}

/** A membership whose failed renewal ran 7 days past grace pauses its benefits. */
export function sweepMemberships(database: postgres.Sql): Promise<OffersJobSummary> {
  return forEachOffersTenant(database, "membership_grace", (tenantDb, tenantId) => pauseLapsedMemberships(postgresRunner(tenantDb), tenantId, new Date()));
}

/** "You have 3 sessions left on 10 massages, valid until 30 March." Skipped when nothing is left or the package has moved on. */
export function expiryReminderHandler({ sink, now }: HandlerDependencies): EventHandler {
  return async (tenantDb, event) => {
    const payload = event.payload as { customerPackageId?: unknown; stage?: unknown } | null;
    if (typeof payload?.customerPackageId !== "string") return { outcome: "dead", code: "invalid_payload" };
    const [row] = await tenantDb<{ name: string; expires_at: Date; patient_id: string; preferred_channel: "sms" | "email" | "whatsapp" | "phone"; messaging_consent: boolean; business: string; timezone: string }[]>`
      select package.name, package.expires_at, package.patient_id, patient.preferred_channel, patient.messaging_consent_at is not null as messaging_consent,
        tenant.name as business, tenant.timezone
      from customer_packages as package
      join patients as patient on patient.tenant_id = package.tenant_id and patient.id = package.patient_id
      join tenants as tenant on tenant.id = package.tenant_id
      where package.tenant_id = ${event.tenantId} and package.id = ${payload.customerPackageId}`;
    if (!row) return "delivered";
    const at = now();
    const remaining = await remainingCredits(postgresRunner(tenantDb), event.tenantId, payload.customerPackageId);
    if (remaining <= 0 || new Date(row.expires_at) <= at) return "delivered";
    const body = expiryReminderText({ name: row.name, remaining, validUntil: new Date(row.expires_at), timeZone: row.timezone, businessName: row.business });
    return deliveryToHandlerOutcome(await sink.deliver(tenantDb, {
      tenantId: event.tenantId,
      appointmentId: null,
      patientId: row.patient_id,
      channel: notificationChannel("staff", row.preferred_channel, row.messaging_consent),
      message: { semanticKey: `local:email:${createHash("sha256").update(event.dedupeKey).digest("hex")}`, templateKey: EXPIRY_REMINDER_EVENT, body, scheduledAt: at },
    }, at));
  };
}

export function offersHandlers(dependencies: HandlerDependencies): [string, EventHandler][] {
  return [[EXPIRY_REMINDER_EVENT, expiryReminderHandler(dependencies)]];
}
