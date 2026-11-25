import type postgres from "postgres";

import { emailDomainCheckDays, emailDomainRecordName, judgeEmailDomain } from "../lib/email-domain-rules";
import { systemResolver, type DnsResolver } from "./domain-jobs";

/**
 * Company email domains (feature 53). The owner publishes a TXT record; this sweep looks for it. All DNS lookups happen here,
 * in the worker, never in a web request. A domain is checked every sweep for a week after it is added, then left alone until
 * the owner asks for a new record.
 */

export interface EmailDomainSweepSummary {
  tenants: number;
  checked: number;
  verified: number;
  missing: number;
  failed: number;
}

interface PendingDomain {
  id: string;
  domain: string;
  token_hash: string;
}

async function note(database: postgres.Sql, tenantId: string, id: string, now: Date, text: string): Promise<void> {
  await database.begin(async (tenantDb) => {
    await tenantDb`select set_config('app.tenant_id', ${tenantId}, true)`;
    await tenantDb`update verified_domains set last_checked_at = ${now}, last_check_note = ${text} where tenant_id = ${tenantId} and id = ${id}`;
  });
}

async function claimDomain(database: postgres.Sql, tenantId: string, row: PendingDomain, now: Date): Promise<boolean> {
  try {
    await database.begin(async (tenantDb) => {
      await tenantDb`select set_config('app.tenant_id', ${tenantId}, true)`;
      const claimed = await tenantDb`
        update verified_domains set verified_at = ${now}, last_checked_at = ${now}, last_check_note = null, updated_at = ${now}
        where tenant_id = ${tenantId} and id = ${row.id} and verified_at is null returning id`;
      if (claimed.length === 0) return;
      await tenantDb`
        insert into audit_events (tenant_id, actor_type, action, outcome, metadata)
        values (${tenantId}, 'system', 'enterprise.domain.verified', 'success', ${tenantDb.json({ domainId: row.id })})`;
    });
    return true;
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      await note(database, tenantId, row.id, now, "This domain already belongs to another business.");
      return false;
    }
    throw error;
  }
}

export async function sweepEmailDomains(database: postgres.Sql, now: Date = new Date(), resolver: DnsResolver = systemResolver()): Promise<EmailDomainSweepSummary> {
  const summary: EmailDomainSweepSummary = { tenants: 0, checked: 0, verified: 0, missing: 0, failed: 0 };
  const ids = await database<{ tenant_id: string }[]>`select tenant_id from kalendr_email_domain_tenants() as tenant_id`;
  for (const { tenant_id: tenantId } of ids) {
    summary.tenants += 1;
    const pending = await database.begin(async (tenantDb) => {
      await tenantDb`select set_config('app.tenant_id', ${tenantId}, true)`;
      return tenantDb<PendingDomain[]>`
        select id, domain, token_hash from verified_domains
        where tenant_id = ${tenantId} and verified_at is null and created_at > ${new Date(now.getTime() - emailDomainCheckDays * 86_400_000)}`;
    });
    for (const row of pending) {
      // The lookup runs with no transaction open; the answer is written in a short one.
      const judgement = judgeEmailDomain(await resolver.txt(emailDomainRecordName(row.domain)), row.token_hash);
      summary.checked += 1;
      if (judgement.kind === "verified") {
        // Another business may have proved the same domain first. Row-level security hides its row from us, so the unique index
        // is what refuses the second claim; it is caught here and told to the owner in words.
        const claimed = await claimDomain(database, tenantId, row, now);
        if (claimed) summary.verified += 1;
        else summary.failed += 1;
        continue;
      }
      if (judgement.kind === "missing") summary.missing += 1;
      else summary.failed += 1;
      await note(database, tenantId, row.id, now, judgement.note);
    }
  }
  return summary;
}
