import { z } from "zod";

import type { WebhookEventType } from "../../lib/api-scopes";
import { APP_DISABLE_AFTER_FAILURES, APP_RETRY_DELAYS_MS, APP_DELIVER_EVENT, appDeliverPayload, appInstallPayload } from "../../server/apps/events";
import { getApp } from "../../server/apps/registry";
import { createAppTransport, type AppTransport } from "../../server/apps/transport";
import type { AppCredentials, DeliveryFacts, RegisteredApp, Verdict } from "../../server/apps/types";
import { postgresDataKeyStore } from "../../server/keys/postgres-store";
import { loadDataKeys } from "../../server/keys/ring";
import { openSecret } from "../../server/keys/secrets";
import type { TenantDb } from "../handlers/types";
import { buildEnvelope } from "../webhooks/build";
import type { EventHandler } from "../handlers/types";

/**
 * The worker's side of the Apps page (feature 55): deliver an event to one installed app, check an install, and remove
 * one. The app modules only describe a request; everything here is the part no app may get wrong. Every outcome is a
 * fixed code in the activity log, the other service's reply is read and dropped, and a failing app never changes a
 * booking or any other app.
 */

export interface AppDependencies {
  transport?: AppTransport;
  /** Wait before attempt 2, 3, ... Tests shrink it. */
  retryDelaysMs?: readonly number[];
  disableAfterFailures?: number;
}

interface InstallRow {
  id: string;
  app_key: string;
  status: string;
  settings: unknown;
  credentials_ciphertext: string | null;
  consecutive_failures: number;
  version: number;
}

const secretPurpose = (appKey: string): string => `app.${appKey}`;
const REMOVE_TRIES = 4;

async function lockInstall(tenantDb: TenantDb, tenantId: string, installId: string): Promise<InstallRow | null> {
  const rows = await tenantDb<InstallRow[]>`
    select id, app_key, status, settings, credentials_ciphertext, consecutive_failures, version
    from app_installs where tenant_id = ${tenantId} and id = ${installId} for update
  `;
  return rows[0] ?? null;
}

async function openCredentials(tenantDb: TenantDb, tenantId: string, app: RegisteredApp, install: InstallRow): Promise<AppCredentials | null> {
  if (!install.credentials_ciphertext) return null;
  try {
    await loadDataKeys(postgresDataKeyStore(tenantDb), tenantId);
    const parsed = app.credentialSchema.safeParse(JSON.parse(openSecret(tenantId, secretPurpose(app.key), install.credentials_ciphertext)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function log(tenantDb: TenantDb, tenantId: string, appKey: string, eventType: string, outcome: "delivered" | "failed" | "skipped", code: string | null): Promise<void> {
  await tenantDb`
    insert into app_events (tenant_id, app_key, event_type, outcome, error_code) values (${tenantId}, ${appKey}, ${eventType}, ${outcome}, ${code})
  `;
  // The log keeps ninety days; a handful of old rows go on each write so it never needs a job of its own.
  await tenantDb`
    delete from app_events where id in (
      select id from app_events where tenant_id = ${tenantId} and app_key = ${appKey} and created_at < now() - interval '90 days' limit 25
    )
  `;
}

async function switchOff(tenantDb: TenantDb, tenantId: string, install: InstallRow, reason: "credential_rejected" | "repeated_failure", failures: number, at: Date): Promise<void> {
  await tenantDb`
    update app_installs set status = 'failing', disabled_reason = ${reason}, consecutive_failures = ${failures}, version = version + 1, updated_at = ${at}
    where tenant_id = ${tenantId} and id = ${install.id}
  `;
  await tenantDb`
    insert into audit_events (tenant_id, actor_type, action, outcome, metadata)
    values (${tenantId}, 'system', 'app.disabled', 'success', ${tenantDb.json({ appKey: install.app_key, reason })})
  `;
}

type Sent = { verdict: Verdict } | { error: "timeout" | "connection_failed" | "blocked_address" | "tls_error" };

async function send(transport: AppTransport, app: RegisteredApp, request: Parameters<AppTransport["send"]>[0]): Promise<Sent> {
  try {
    const result = await transport.send(request, { allowedHosts: app.allowedHosts });
    if (result.kind === "error") return { error: result.errorCode };
    return { verdict: app.interpret({ statusCode: result.statusCode, body: result.body }) };
  } catch {
    // A transport that throws is a connection failure; the row must still be written.
    return { error: "connection_failed" };
  }
}

const failureOf = (sent: Sent): { code: string; retry: boolean; credential: boolean } | null => {
  if ("error" in sent) return { code: sent.error, retry: sent.error !== "blocked_address", credential: false };
  return sent.verdict.ok ? null : { code: sent.verdict.code, retry: sent.verdict.retry, credential: sent.verdict.credential === true };
};

async function loadFacts(tenantDb: TenantDb, tenantId: string, app: RegisteredApp, settings: unknown, data: Record<string, unknown>): Promise<DeliveryFacts> {
  const [tenant] = await tenantDb<{ timezone: string }[]>`select timezone from tenants where id = ${tenantId}`;
  const serviceId = typeof data.serviceId === "string" ? data.serviceId : null;
  const [service] = serviceId ? await tenantDb<{ name: string }[]>`select name from services where tenant_id = ${tenantId} and id = ${serviceId}` : [];
  const customerId = typeof data.customerId === "string" ? data.customerId : null;
  let customer: DeliveryFacts["customer"] = null;
  if (customerId && app.needsCustomer(settings)) {
    const [row] = await tenantDb<{ first_name: string; last_name: string; email: string; phone: string; consent: boolean | null }[]>`
      select first_name, last_name, email, phone,
        (select consent.granted from consent_records as consent
          where consent.tenant_id = patient.tenant_id and consent.patient_id = patient.id and consent.purpose = 'marketing_messages'
          order by consent.created_at desc, consent.id desc limit 1) as consent
      from patients as patient where patient.tenant_id = ${tenantId} and patient.id = ${customerId} and patient.erased_at is null
    `;
    if (row) customer = { firstName: row.first_name, lastName: row.last_name, email: row.email.trim() || null, phone: row.phone.trim() || null, marketingConsent: row.consent === true };
  }
  return { serviceName: service?.name ?? null, timezone: tenant?.timezone ?? "UTC", customer };
}

/** Sends one event to one app. */
export function appDeliverHandler(dependencies: AppDependencies, now: () => Date): EventHandler {
  const transport = dependencies.transport ?? createAppTransport();
  const delays = dependencies.retryDelaysMs ?? APP_RETRY_DELAYS_MS;
  const disableAfter = dependencies.disableAfterFailures ?? APP_DISABLE_AFTER_FAILURES;

  return async (tenantDb, event) => {
    const parsed = appDeliverPayload.safeParse(event.payload);
    if (!parsed.success) return { outcome: "dead", code: "invalid_payload" };
    const { installId, type, aggregateId, source, attempt } = parsed.data;
    const install = await lockInstall(tenantDb, event.tenantId, installId);
    if (!install) return "delivered";
    const app = getApp(install.app_key);
    if (!app) return { outcome: "dead", code: "unknown_app" };
    const at = now();
    // Switched off, paused or being removed since this was queued: nothing to send, and it is not an error.
    if (install.status !== "active") return "delivered";

    const credentials = await openCredentials(tenantDb, event.tenantId, app, install);
    if (!credentials) {
      await log(tenantDb, event.tenantId, app.key, type, "failed", "credential_rejected");
      await switchOff(tenantDb, event.tenantId, install, "credential_rejected", install.consecutive_failures + 1, at);
      return "delivered";
    }
    const envelope = await buildEnvelope(tenantDb, { ...event, aggregateId, payload: source }, type as WebhookEventType, at);
    if (!envelope) return "delivered";
    const data = z.record(z.string(), z.unknown()).safeParse(envelope.data).data ?? {};
    const facts = await loadFacts(tenantDb, event.tenantId, app, install.settings, data);
    const built = app.build({ event: envelope, settings: install.settings, credentials, facts });
    if ("skip" in built) {
      await log(tenantDb, event.tenantId, app.key, type, "skipped", built.skip);
      return "delivered";
    }

    const sent = await send(transport, app, built.request);
    const failure = failureOf(sent);
    if (!failure) {
      await log(tenantDb, event.tenantId, app.key, type, "delivered", null);
      if (install.consecutive_failures > 0) {
        await tenantDb`update app_installs set consecutive_failures = 0 where tenant_id = ${event.tenantId} and id = ${install.id}`;
      }
      return "delivered";
    }
    await log(tenantDb, event.tenantId, app.key, type, "failed", failure.code);
    const failures = install.consecutive_failures + 1;
    if (failure.credential) {
      await switchOff(tenantDb, event.tenantId, install, "credential_rejected", failures, at);
      return "delivered";
    }
    if (failures >= disableAfter) {
      await switchOff(tenantDb, event.tenantId, install, "repeated_failure", failures, at);
      return "delivered";
    }
    await tenantDb`update app_installs set consecutive_failures = ${failures} where tenant_id = ${event.tenantId} and id = ${install.id}`;
    const delay = failure.retry ? delays[attempt - 1] : undefined;
    if (delay !== undefined) {
      const next = new Date(at.getTime() + delay);
      const nextKey = `${event.dedupeKey.replace(/:\d+$/, "")}:${attempt + 1}`;
      await tenantDb`
        insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key, available_at)
        values (${event.tenantId}, 'app_install', ${install.id}, ${APP_DELIVER_EVENT},
          ${tenantDb.json({ installId, type, aggregateId, source, attempt: attempt + 1 })},
          ${nextKey}, ${next})
        on conflict (tenant_id, dedupe_key) do nothing
      `;
    }
    return "delivered";
  };
}

/** Proves the saved key and settings work. One try, no retries: the owner sees the answer and can press it again. */
export function appCheckHandler(dependencies: AppDependencies, now: () => Date): EventHandler {
  const transport = dependencies.transport ?? createAppTransport();
  return async (tenantDb, event) => {
    const parsed = appInstallPayload.safeParse(event.payload);
    if (!parsed.success) return { outcome: "dead", code: "invalid_payload" };
    const install = await lockInstall(tenantDb, event.tenantId, parsed.data.installId);
    if (!install || install.status === "uninstalling") return "delivered";
    const app = getApp(install.app_key);
    if (!app) return { outcome: "dead", code: "unknown_app" };
    const at = now();
    const credentials = await openCredentials(tenantDb, event.tenantId, app, install);
    const [business] = await tenantDb<{ name: string }[]>`select name from tenants where id = ${event.tenantId}`;
    const facts = await loadFacts(tenantDb, event.tenantId, app, install.settings, {});
    const request = credentials ? app.buildCheck({ settings: install.settings, credentials, facts, businessName: business?.name ?? "your business" }) : null;
    if (!credentials || !request) {
      await log(tenantDb, event.tenantId, app.key, "check", "failed", credentials ? "rejected" : "credential_rejected");
      if (!credentials) await switchOff(tenantDb, event.tenantId, install, "credential_rejected", install.consecutive_failures + 1, at);
      return "delivered";
    }
    const failure = failureOf(await send(transport, app, request));
    if (!failure) {
      await log(tenantDb, event.tenantId, app.key, "check", "delivered", null);
      // A good check on a switched-off app (a key just replaced) puts it back to work.
      await tenantDb`
        update app_installs set status = case when status = 'failing' then 'active' else status end,
          disabled_reason = case when status = 'failing' then null else disabled_reason end, consecutive_failures = 0
        where tenant_id = ${event.tenantId} and id = ${install.id}
      `;
      return "delivered";
    }
    await log(tenantDb, event.tenantId, app.key, "check", "failed", failure.code);
    if (failure.credential) await switchOff(tenantDb, event.tenantId, install, "credential_rejected", install.consecutive_failures + 1, at);
    return "delivered";
  };
}

/**
 * Finishes a removal: revokes the key at the other service when the app has a way to, then deletes the credentials and
 * the install. A revoke that keeps failing does not keep the key: after a few tries the credentials are deleted anyway
 * and the log says the owner must finish at the other service.
 */
export function appRemoveHandler(dependencies: AppDependencies): EventHandler {
  const transport = dependencies.transport ?? createAppTransport();
  return async (tenantDb, event) => {
    const parsed = appInstallPayload.safeParse(event.payload);
    if (!parsed.success) return { outcome: "dead", code: "invalid_payload" };
    const install = await lockInstall(tenantDb, event.tenantId, parsed.data.installId);
    if (!install || install.status !== "uninstalling") return "delivered";
    const app = getApp(install.app_key);
    let code: string | null = null;
    if (app?.hasRevoke) {
      const credentials = await openCredentials(tenantDb, event.tenantId, app, install);
      const request = credentials ? app.buildRevoke(credentials) : null;
      if (request) {
        const failure = failureOf(await send(transport, app, request));
        // An already-dead token answers "refused" too, which is the state we wanted.
        if (failure && !failure.credential) {
          if (failure.retry && event.attemptCount + 1 < REMOVE_TRIES) return { outcome: "retry", code: failure.code };
          code = "revoke_failed";
        }
      }
    }
    await tenantDb`delete from app_installs where tenant_id = ${event.tenantId} and id = ${install.id}`;
    await log(tenantDb, event.tenantId, install.app_key, "uninstall", code ? "failed" : "delivered", code);
    await tenantDb`
      insert into audit_events (tenant_id, actor_type, action, outcome, metadata)
      values (${event.tenantId}, 'system', 'app.uninstalled', 'success', ${tenantDb.json({ appKey: install.app_key, revoked: Boolean(app?.hasRevoke) && !code })})
    `;
    return "delivered";
  };
}
