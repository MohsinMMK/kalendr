import "server-only";

/**
 * Short links for SMS, for the web app. Building one (ensureShortLink) lives in
 * channels/short-link-code.ts because the worker needs it and can't import server-only files;
 * this file adds the lookup the /m/[code] route uses.
 */
import { sql } from "drizzle-orm";

import { requireDatabase, withTenant } from "@/db/client";
import { openManageToken } from "./messaging/sealed-link";
import { hashShortLinkCode, SHORT_CODE_PATTERN } from "./channels/short-link-code";

export { ensureShortLink, hashShortLinkCode, shortLinkCode, shortLinkExpiry, shortLinkUrl } from "./channels/short-link-code";

/** The manage token behind a short code, or null when the code is unknown, expired or can't be opened. */
export async function resolveShortLinkToken(code: string): Promise<string | null> {
  if (!SHORT_CODE_PATTERN.test(code)) return null;
  const found = await requireDatabase().execute<{ tenant_id: string; appointment_id: string }>(
    sql`select tenant_id, appointment_id from kalendr_resolve_short_link(${hashShortLinkCode(code)})`,
  );
  const target = found[0];
  if (!target) return null;
  const rows = await withTenant(target.tenant_id, (transaction) => transaction.execute<{ manage_token_ciphertext: string | null }>(
    sql`select manage_token_ciphertext from appointments
        where tenant_id = ${target.tenant_id} and id = ${target.appointment_id}`,
  ));
  return openManageToken(target.tenant_id, target.appointment_id, rows[0]?.manage_token_ciphertext ?? null);
}
