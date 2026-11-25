import "server-only";

import { sql } from "drizzle-orm";

import { getDatabase, withTenant } from "@/db/client";
import { recordConsentIn } from "@/server/privacy/consent";

import { hashUnsubscribeToken, UNSUBSCRIBE_TOKEN_PATTERN } from "./tokens";

export type UnsubscribeStatus = "done" | "already" | "invalid";

export interface UnsubscribeResult {
  status: UnsubscribeStatus;
  /** Shown on the confirmation page so the person knows whose messages they stopped. */
  businessName: string | null;
}

/**
 * The public unsubscribe link (feature 28). No sign-in: the token in the link is the proof, and only its hash is stored.
 * It takes effect at once and covers all marketing from this business (the consent is withdrawn, with the same record a
 * portal switch or a STOP reply leaves), marks the channel as opted out, and drops anything of theirs still waiting to go.
 * Appointment messages are untouched. Saying it twice changes nothing. A dead or mistyped link reveals nothing.
 */
export async function unsubscribeByToken(token: string): Promise<UnsubscribeResult> {
  if (!UNSUBSCRIBE_TOKEN_PATTERN.test(token)) return { status: "invalid", businessName: null };
  const database = getDatabase();
  if (!database) return { status: "invalid", businessName: null };
  const [found] = await database.execute<{ tenant_id: string; send_id: string; patient_id: string }>(sql`select * from kalendr_resolve_unsubscribe(${hashUnsubscribeToken(token)})`);
  if (!found) return { status: "invalid", businessName: null };

  return withTenant(found.tenant_id, async (transaction) => {
    const [send] = await transaction.execute<{ channel: string; unsubscribed_at: Date | null }>(sql`
      select channel, unsubscribed_at from campaign_sends where tenant_id = ${found.tenant_id} and id = ${found.send_id} for update
    `);
    const [tenant] = await transaction.execute<{ name: string }>(sql`select name from tenants where id = ${found.tenant_id}`);
    if (!send) return { status: "invalid" as const, businessName: null };
    let changed = false;
    try {
      changed = (await recordConsentIn(transaction, found.tenant_id, {
        patientId: found.patient_id, purpose: "marketing_messages", granted: false, source: "unsubscribe_link", actor: { type: "patient" },
      })).changed;
    } catch {
      // A customer whose data was erased has nothing left to withdraw: the link still reads as done.
    }
    await transaction.execute(sql`
      insert into marketing_preferences (tenant_id, patient_id, channel, opted_in, source, changed_at)
      values (${found.tenant_id}, ${found.patient_id}, ${send.channel}, false, 'unsubscribe_link', now())
      on conflict (tenant_id, patient_id, channel) do update set opted_in = false, source = excluded.source, changed_at = excluded.changed_at
        where marketing_preferences.opted_in
    `);
    await transaction.execute(sql`update campaign_sends set unsubscribed_at = coalesce(unsubscribed_at, now()), updated_at = now() where tenant_id = ${found.tenant_id} and id = ${found.send_id}`);
    // Anything of theirs that was still waiting, from any campaign, never goes.
    await transaction.execute(sql`
      update campaign_sends set status = 'skipped', reason = 'unsubscribed', updated_at = now()
      where tenant_id = ${found.tenant_id} and patient_id = ${found.patient_id} and status in ('pending', 'queued')
    `);
    return { status: changed || !send.unsubscribed_at ? ("done" as const) : ("already" as const), businessName: tenant?.name ?? null };
  });
}
