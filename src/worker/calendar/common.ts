/**
 * What every calendar handler needs: the stored login (sealed), the adapter for its provider, the
 * rule that refreshed tokens are saved even when the call then fails, and how a failed call becomes
 * an outcome. Handlers return outcomes instead of throwing after a call, because a thrown error rolls
 * the whole transaction back, including a refresh token the provider has already rotated.
 */
import {
  CALENDAR_CREDENTIALS_PURPOSE,
} from "../../lib/calendar-sync";
import { calendarProvider } from "../../server/calendars/runtime";
import { classifyFailure, CalendarProviderError } from "../../server/calendars/errors";
import {
  providerCredentialsSchema,
  type CalendarProvider,
  type ProviderCredentials,
  type ProviderId,
  type RefreshedTokens,
} from "../../server/calendars/provider";
import { postgresDataKeyStore } from "../../server/keys/postgres-store";
import { loadDataKeys } from "../../server/keys/ring";
import { openSecret, sealSecret, secretKeyVersion } from "../../server/keys/secrets";
import type { HandlerOutcome, TenantDb } from "../handlers/types";

export interface ConnectionRow {
  id: string;
  membership_id: string;
  provider: ProviderId;
  account_email: string | null;
  credentials_ciphertext: string;
  status: "pending" | "active" | "needs_reconnect" | "disconnecting";
}

/** The seams tests replace: the clock and the adapter for a provider. */
export interface CalendarDeps {
  now: () => Date;
  adapter: (id: ProviderId, onRefreshed: (tokens: RefreshedTokens) => void) => CalendarProvider;
}

export const liveCalendarDeps: CalendarDeps = {
  now: () => new Date(),
  adapter: (id, onRefreshed) => calendarProvider(id, onRefreshed),
};

export async function loadKeys(tenantDb: TenantDb, tenantId: string): Promise<void> {
  await loadDataKeys(postgresDataKeyStore(tenantDb), tenantId, { forWrite: true });
}

export async function readConnection(tenantDb: TenantDb, tenantId: string, connectionId: string): Promise<ConnectionRow | undefined> {
  const rows = await tenantDb<ConnectionRow[]>`
    select id, membership_id, provider, account_email, credentials_ciphertext, status
    from calendar_connections where tenant_id = ${tenantId} and id = ${connectionId} for update`;
  return rows[0];
}

export function openCredentials(tenantId: string, sealed: string): ProviderCredentials | null {
  try {
    const parsed = providerCredentialsSchema.safeParse(JSON.parse(openSecret(tenantId, CALENDAR_CREDENTIALS_PURPOSE, sealed)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function sealCredentials(tenantId: string, credentials: ProviderCredentials): { ciphertext: string; keyVersion: number } {
  const ciphertext = sealSecret(tenantId, CALENDAR_CREDENTIALS_PURPOSE, JSON.stringify(credentials));
  return { ciphertext, keyVersion: secretKeyVersion(ciphertext) };
}

type CallResult<T> = { ok: true; value: T } | { ok: false; outcome: HandlerOutcome; failure: ReturnType<typeof classifyFailure> | { kind: "provider_error"; code: string } };

export interface ProviderSession {
  provider: CalendarProvider;
  credentials: ProviderCredentials;
  /** Runs one adapter call and turns any failure into a result. Never throws. */
  call<T>(work: (provider: CalendarProvider, credentials: ProviderCredentials) => Promise<T>): Promise<CallResult<T>>;
  /** Saves any token the provider refreshed. Call before returning an outcome. */
  persist(): Promise<void>;
}

/**
 * Opens a connection's login and builds its adapter. The refreshed tokens are written back with
 * `persist()`, and the handler must call it before it returns.
 */
export function openSession(
  tenantDb: TenantDb,
  tenantId: string,
  connection: ConnectionRow,
  deps: CalendarDeps,
): ProviderSession | null {
  const credentials = openCredentials(tenantId, connection.credentials_ciphertext);
  if (!credentials) return null;
  let refreshed: RefreshedTokens | null = null;
  const provider = deps.adapter(connection.provider, (tokens) => { refreshed = tokens; });
  return {
    provider,
    credentials,
    async call(work) {
      try {
        return { ok: true, value: await work(provider, credentials) };
      } catch (error: unknown) {
        const failure = classifyFailure(error);
        if (failure.kind === "revoked") return { ok: false, outcome: "delivered", failure };
        if (failure.kind === "rate_limited") return { ok: false, outcome: { outcome: "retry", code: "rate_limited" }, failure };
        if (error instanceof CalendarProviderError && error.kind !== "transient") {
          return { ok: false, outcome: { outcome: "retry", code: `provider_${error.kind}` }, failure: { kind: "provider_error", code: error.kind } };
        }
        return { ok: false, outcome: { outcome: "retry", code: "provider_unavailable" }, failure };
      }
    },
    async persist() {
      if (!refreshed || credentials.kind !== "oauth") return;
      const tokens: RefreshedTokens = refreshed;
      refreshed = null;
      const next: ProviderCredentials = { ...credentials, refreshToken: tokens.refreshToken, accessToken: tokens.accessToken, expiresAt: tokens.expiresAt };
      const sealed = sealCredentials(tenantId, next);
      await tenantDb`
        update calendar_connections set credentials_ciphertext = ${sealed.ciphertext}, key_version = ${sealed.keyVersion}, updated_at = now()
        where tenant_id = ${tenantId} and id = ${connection.id}`;
    },
  };
}

/**
 * The login no longer works. The connection waits for the person to reconnect, the busy time it
 * saved is forgotten (availability goes back to Kalendr's own data), and they are told once.
 */
export async function markNeedsReconnect(tenantDb: TenantDb, tenantId: string, connection: ConnectionRow): Promise<void> {
  const changed = await tenantDb`
    update calendar_connections set status = 'needs_reconnect', last_error_code = 'revoked', version = version + 1, updated_at = now()
    where tenant_id = ${tenantId} and id = ${connection.id} and status <> 'needs_reconnect' and status <> 'disconnecting'
    returning id`;
  await tenantDb`
    delete from external_busy where tenant_id = ${tenantId}
      and selection_id in (select id from calendar_selections where tenant_id = ${tenantId} and connection_id = ${connection.id})`;
  // The saved read position is now meaningless; reconnecting starts from a full read.
  await tenantDb`
    update calendar_selections set sync_token = null, last_snapshot_at = null
    where tenant_id = ${tenantId} and connection_id = ${connection.id}`;
  if (changed.length === 0) return;
  await alertMember(tenantDb, tenantId, connection.membership_id, "Your calendar needs reconnecting", "/profile", `calendar.reconnect:${connection.id}:${Date.now().toString(36)}`);
}

/**
 * A "needs a person" alert for one staff member: a row for the bell, and a push when they have a device.
 * It honours their alert choices. The text never carries a name or a time.
 */
export async function alertMember(
  tenantDb: TenantDb,
  tenantId: string,
  membershipId: string,
  title: string,
  link: string,
  dedupeKey: string,
): Promise<void> {
  const [choice] = await tenantDb<{ in_app: boolean; push: boolean }[]>`
    select in_app, push from notification_preferences
    where tenant_id = ${tenantId} and membership_id = ${membershipId} and kind = 'needs_person'`;
  if (choice?.in_app ?? true) {
    await tenantDb`
      insert into staff_notifications (tenant_id, membership_id, kind, title, link, dedupe_key)
      values (${tenantId}, ${membershipId}, 'needs_person', ${title}, ${link}, ${dedupeKey.slice(0, 160)})
      on conflict do nothing`;
  }
  if (!(choice?.push ?? true)) return;
  const [device] = await tenantDb`select 1 from push_subscriptions where tenant_id = ${tenantId} and membership_id = ${membershipId} limit 1`;
  if (!device) return;
  const payload = { membershipId, title, link, kind: "needs_person" };
  await tenantDb`
    insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key)
    values (${tenantId}, 'push', ${membershipId}, 'push.send', ${tenantDb.json(payload)}, ${`push:${membershipId}:${dedupeKey}`.slice(0, 200)})
    on conflict (tenant_id, dedupe_key) do nothing`;
}

/** How far ahead busy time is read: the longest advance booking of any service, plus a day. */
export async function readWindow(tenantDb: TenantDb, tenantId: string, now: Date): Promise<{ from: Date; to: Date }> {
  const [row] = await tenantDb<{ days: number | null }[]>`select max(maximum_advance_days)::int as days from services where tenant_id = ${tenantId}`;
  const days = Math.min(Math.max(row?.days ?? 90, 30), 400) + 1;
  return { from: new Date(now.getTime() - 60 * 60 * 1_000), to: new Date(now.getTime() + days * 86_400_000) };
}
