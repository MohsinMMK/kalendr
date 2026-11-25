import "server-only";

import { sql } from "drizzle-orm";

import type { KalendrTransaction } from "@/db/client";

import { env } from "../env";
import type { LlmUsage } from "./model";

/**
 * What a business has used this month (feature 30). Tokens count against one cap: input and output together, with cache reads
 * counted at a tenth because they cost a tenth. The check runs before every model call, so a business never goes far past the cap.
 */

export function usagePeriod(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
}

export function monthlyCap(): number {
  return env().ASSISTANT_MONTHLY_TOKEN_CAP;
}

/** Tokens that count toward the cap. */
export function billableTokens(usage: LlmUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheWriteTokens + Math.ceil(usage.cacheReadTokens / 10);
}

export async function tokensUsedThisMonth(transaction: KalendrTransaction, tenantId: string, now: Date): Promise<number> {
  const rows = await transaction.execute<{ total: string | number }>(sql`
    select (input_tokens + output_tokens + cache_write_tokens + ceil(cache_read_tokens / 10.0))::bigint as total
    from assistant_usage where tenant_id = ${tenantId} and period = ${usagePeriod(now)}::date
  `);
  return Number(rows[0]?.total ?? 0);
}

export async function isOverCap(transaction: KalendrTransaction, tenantId: string, now: Date): Promise<boolean> {
  return (await tokensUsedThisMonth(transaction, tenantId, now)) >= monthlyCap();
}

export async function recordUsage(transaction: KalendrTransaction, tenantId: string, usage: LlmUsage, now: Date): Promise<void> {
  await transaction.execute(sql`
    insert into assistant_usage (tenant_id, period, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, turns)
    values (${tenantId}, ${usagePeriod(now)}::date, ${usage.inputTokens}, ${usage.outputTokens}, ${usage.cacheReadTokens}, ${usage.cacheWriteTokens}, 1)
    on conflict (tenant_id, period) do update set
      input_tokens = assistant_usage.input_tokens + excluded.input_tokens,
      output_tokens = assistant_usage.output_tokens + excluded.output_tokens,
      cache_read_tokens = assistant_usage.cache_read_tokens + excluded.cache_read_tokens,
      cache_write_tokens = assistant_usage.cache_write_tokens + excluded.cache_write_tokens,
      turns = assistant_usage.turns + 1, updated_at = now()
  `);
}
