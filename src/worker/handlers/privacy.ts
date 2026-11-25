import { randomUUID } from "node:crypto";

import { appOrigin } from "../../server/env";
import { createOpaqueToken, sha256 } from "../../server/crypto";
import { fileStoreKey, getFileStore, type FileStore } from "../../server/file-store";
import { postgresDataKeyStore } from "../../server/keys/postgres-store";
import { sealBytes } from "../../server/keys/records";
import { loadDataKeys } from "../../server/keys/ring";
import { buildExportZip, collectCustomerExport } from "../../server/privacy/export";
import { eraseCustomer } from "../../server/privacy/erasure";
import { EXPORT_VALID_DAYS } from "../../server/privacy/rules";
import { deliveryToHandlerOutcome, type HandlerDependencies } from "./appointment-message";
import type { EventHandler, TenantDb } from "./types";

const DAY_MS = 24 * 60 * 60 * 1_000;

export interface PrivacyHandlerDependencies extends HandlerDependencies {
  store?: () => FileStore;
}

function requestIdOf(payload: unknown): string | null {
  const value = payload && typeof payload === "object" ? (payload as { requestId?: unknown }).requestId : null;
  return typeof value === "string" && value.length > 0 && value.length <= 100 ? value : null;
}

interface RequestRow {
  id: string;
  patient_id: string;
  type: string;
  status: string;
}

async function lockRequest(tenantDb: TenantDb, tenantId: string, requestId: string): Promise<RequestRow | undefined> {
  const rows = await tenantDb<RequestRow[]>`
    select id, patient_id, type, status from data_requests where tenant_id = ${tenantId} and id = ${requestId} for update
  `;
  return rows[0];
}

/**
 * Builds the customer's export, stores it encrypted, and emails a one-time link. Safe to run again: there is one export
 * row per request, and every attempt makes a fresh token, so the link in the email is always the current one. The token
 * itself is never stored, only its SHA-256 hash.
 */
export function exportRequestedHandler({ sink, now, store }: PrivacyHandlerDependencies): EventHandler {
  return async (tenantDb, event) => {
    const requestId = requestIdOf(event.payload);
    if (!requestId) return { outcome: "dead", code: "invalid_payload" };
    const request = await lockRequest(tenantDb, event.tenantId, requestId);
    if (!request || request.type !== "export") return "delivered";
    if (request.status === "completed" || request.status === "refused") return "delivered";
    const at = now();
    await tenantDb`update data_requests set status = 'processing', updated_at = now() where tenant_id = ${event.tenantId} and id = ${requestId}`;

    const [patient] = await tenantDb<{ first_name: string; email: string; erased_at: Date | null }[]>`
      select first_name, email, erased_at from patients where tenant_id = ${event.tenantId} and id = ${request.patient_id}
    `;
    if (!patient || patient.erased_at) {
      await tenantDb`update data_requests set status = 'failed', updated_at = now() where tenant_id = ${event.tenantId} and id = ${requestId}`;
      return "delivered";
    }

    const token = createOpaqueToken();
    const expiresAt = new Date(at.getTime() + EXPORT_VALID_DAYS * DAY_MS);
    const existing = await tenantDb<{ id: string }[]>`
      select id from data_exports where tenant_id = ${event.tenantId} and request_id = ${requestId} for update
    `;
    if (existing.length > 0) {
      await tenantDb`
        update data_exports set token_hash = ${sha256(token)}, expires_at = ${expiresAt}, used_at = null
        where tenant_id = ${event.tenantId} and id = ${existing[0]!.id}
      `;
    } else {
      const keyVersion = await loadDataKeys(postgresDataKeyStore(tenantDb), event.tenantId, { forWrite: true });
      const bytes = sealBytes(event.tenantId, buildExportZip(await collectCustomerExport(tenantDb, event.tenantId, request.patient_id, at)));
      const exportId = randomUUID();
      const storageKey = fileStoreKey(event.tenantId, "export", exportId);
      await (store ?? getFileStore)().put(storageKey, bytes);
      await tenantDb`
        insert into data_exports (id, tenant_id, request_id, storage_key, key_version, token_hash, expires_at, byte_size)
        values (${exportId}, ${event.tenantId}, ${requestId}, ${storageKey}, ${keyVersion}, ${sha256(token)}, ${expiresAt}, ${bytes.length})
      `;
    }

    const outcome = await sink.deliver(tenantDb, {
      tenantId: event.tenantId,
      appointmentId: null,
      patientId: request.patient_id,
      channel: "email",
      message: {
        semanticKey: `local:privacy:export:${requestId}`,
        templateKey: "privacy.export",
        body: JSON.stringify({ url: `${appOrigin()}/api/portal/privacy/export/${token}`, validDays: EXPORT_VALID_DAYS }),
        scheduledAt: at,
      },
    }, at);
    // The sink answers "delivered" or "duplicate", or an object for a retry or a permanent failure.
    const kind = typeof outcome === "string" ? outcome : outcome.outcome;
    // The request stays "processing" and the export row stays, so the next attempt only makes a new link.
    if (kind === "retry") return deliveryToHandlerOutcome(outcome);
    const sent = kind === "delivered" || kind === "duplicate";
    await tenantDb`
      update data_requests set status = ${sent ? "completed" : "failed"}, completed_at = ${sent ? at : null}, version = version + 1, updated_at = now()
      where tenant_id = ${event.tenantId} and id = ${requestId}
    `;
    await tenantDb`
      insert into audit_events (tenant_id, actor_type, action, outcome, metadata)
      values (${event.tenantId}, 'system', ${sent ? "privacy.export.built" : "privacy.export.not_delivered"}, ${sent ? "success" : "failed"}, ${tenantDb.json({ requestId, patientId: request.patient_id })})
    `;
    return deliveryToHandlerOutcome(outcome);
  };
}

/**
 * Carries out an approved erasure, then emails the customer a plain account of what was removed and what was kept.
 * The email address is read before it is cleared. A failed send that should be retried undoes the whole run (it throws
 * so nothing is committed) and tries again later; a message that cannot be delivered at all leaves the erasure done.
 */
export function erasureApprovedHandler({ sink, now }: PrivacyHandlerDependencies): EventHandler {
  return async (tenantDb, event) => {
    const requestId = requestIdOf(event.payload);
    if (!requestId) return { outcome: "dead", code: "invalid_payload" };
    const at = now();
    const rows = await lockRequest(tenantDb, event.tenantId, requestId);
    if (!rows || rows.type !== "erasure" || rows.status === "completed" || rows.status === "refused") return "delivered";
    const result = await eraseCustomer(tenantDb, event.tenantId, requestId, at);
    if (!result.performed || !result.recipient) return "delivered";
    const outcome = await sink.deliver(tenantDb, {
      tenantId: event.tenantId,
      appointmentId: null,
      patientId: result.patientId,
      channel: "email",
      message: {
        semanticKey: `local:privacy:erasure:${requestId}`,
        templateKey: "privacy.erasure",
        body: JSON.stringify({ removed: result.summary.removed, kept: result.summary.kept }),
        scheduledAt: at,
      },
      recipient: result.recipient,
    }, at);
    const kind = typeof outcome === "string" ? outcome : outcome.outcome;
    // Throwing rolls the erasure back too, so a retry starts clean and still has the address to write to.
    if (kind === "retry") throw new Error("erasure_notice_retry");
    if (kind === "dead") {
      // The notice cannot be delivered at all. The erasure itself is done and stays done; staff are told through the log.
      await tenantDb`
        insert into audit_events (tenant_id, actor_type, action, outcome, metadata)
        values (${event.tenantId}, 'system', 'privacy.erasure.notice_not_delivered', 'failed', ${tenantDb.json({ requestId, code: typeof outcome === "string" ? "unknown" : outcome.code })})
      `;
    }
    return "delivered";
  };
}

/** Tells the business that a customer's request is past its due date. */
export function requestOverdueHandler({ sink, now }: PrivacyHandlerDependencies): EventHandler {
  return async (tenantDb, event) => {
    const requestId = requestIdOf(event.payload);
    if (!requestId) return { outcome: "dead", code: "invalid_payload" };
    const rows = await tenantDb<{ patient_id: string; type: string; status: string; due_at: Date; email: string | null; name: string }[]>`
      select request.patient_id, request.type, request.status, request.due_at, tenant.email, tenant.name
      from data_requests as request join tenants as tenant on tenant.id = request.tenant_id
      where request.tenant_id = ${event.tenantId} and request.id = ${requestId}
    `;
    const row = rows[0];
    if (!row || !["requested", "approved", "processing"].includes(row.status)) return "delivered";
    const email = row.email?.trim();
    if (!email) return { outcome: "dead", code: "no_destination" };
    const at = now();
    const kind = row.type === "export" ? "download" : row.type;
    return deliveryToHandlerOutcome(await sink.deliver(tenantDb, {
      tenantId: event.tenantId,
      appointmentId: null,
      patientId: row.patient_id,
      channel: "email",
      message: {
        semanticKey: `local:privacy:overdue:${requestId}`,
        templateKey: "privacy.overdue",
        body: JSON.stringify({
          requestKind: kind,
          dueOn: row.due_at.toISOString().slice(0, 10),
          staffUrl: `${appOrigin()}/dashboard`,
        }),
        scheduledAt: at,
      },
      recipient: { email, name: row.name },
    }, at));
  };
}
