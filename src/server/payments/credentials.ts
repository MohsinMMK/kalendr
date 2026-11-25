/**
 * A business's payment account: loading the row and opening its sealed keys. The caller loads the
 * business's data keys first (loadRecordKeys in the web app, loadDataKeys in the worker).
 * No "server-only": the worker imports this.
 */
import { sql } from "drizzle-orm";

import type { AccountMode, PaymentProviderId } from "../../lib/payments";
import { openSecret } from "../keys/secrets";
import { asDate, asString, type Runner } from "../workflows/runner";
import type { ProviderCredentials } from "./types";

export const PAYMENT_SECRET_PURPOSE = "payments.secret";
export const PAYMENT_WEBHOOK_PURPOSE = "payments.webhook-secret";

export interface AccountRow {
  id: string;
  tenantId: string;
  provider: PaymentProviderId;
  mode: AccountMode;
  status: "active" | "disabled";
  keyId: string;
  publicId: string;
  secretCiphertext: string | null;
  webhookSecretCiphertext: string | null;
  lastCheckedAt: Date | null;
}

function toAccount(row: Record<string, unknown>): AccountRow {
  return {
    id: asString(row.id), tenantId: asString(row.tenant_id), provider: asString(row.provider) as PaymentProviderId, mode: asString(row.mode) as AccountMode,
    status: asString(row.status) as AccountRow["status"], keyId: asString(row.key_id), publicId: asString(row.public_id),
    secretCiphertext: row.secret_ciphertext == null ? null : asString(row.secret_ciphertext),
    webhookSecretCiphertext: row.webhook_secret_ciphertext == null ? null : asString(row.webhook_secret_ciphertext),
    lastCheckedAt: row.last_checked_at == null ? null : asDate(row.last_checked_at),
  };
}

const columns = sql`id, tenant_id, provider, mode, status, key_id, public_id, secret_ciphertext, webhook_secret_ciphertext, last_checked_at`;

export async function loadAccount(run: Runner, tenantId: string): Promise<AccountRow | null> {
  const [row] = await run(sql`select ${columns} from tenant_payment_accounts where tenant_id = ${tenantId}`);
  return row ? toAccount(row) : null;
}

export async function loadAccountById(run: Runner, tenantId: string, accountId: string): Promise<AccountRow | null> {
  const [row] = await run(sql`select ${columns} from tenant_payment_accounts where tenant_id = ${tenantId} and id = ${accountId}`);
  return row ? toAccount(row) : null;
}

/** Opens the sealed keys. Stripe keeps no secret of its own (the platform key is in the environment), so those come back empty. */
export function openCredentials(account: AccountRow): ProviderCredentials {
  return {
    keyId: account.keyId,
    keySecret: account.secretCiphertext ? openSecret(account.tenantId, PAYMENT_SECRET_PURPOSE, account.secretCiphertext) : "",
    webhookSecret: account.webhookSecretCiphertext ? openSecret(account.tenantId, PAYMENT_WEBHOOK_PURPOSE, account.webhookSecretCiphertext) : "",
  };
}
