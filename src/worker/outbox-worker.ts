import { randomUUID } from "node:crypto";

import { SpanStatusCode, trace } from "@opentelemetry/api";
import type postgres from "postgres";

import { spanContextFromTraceParent } from "../server/tracing";
import { localCaptureSink, type MessageSink } from "./delivery";
import { createHandlers, type HandlerRegistry, type OutboxEvent } from "./handlers";
import { MAX_ATTEMPTS } from "./handlers/types";

export { MAX_ATTEMPTS };
import { retryDelayMs, type CaptureMessage } from "./policy";

/** A row this worker holds. The lease token is unique per claim, so a row re-claimed after its lease ran out can't be finished by the old holder. */
export interface ClaimedEvent {
  tenantId: string;
  id: string;
  leaseToken: string;
}

const LEASE_MS = 60_000;

export type WorkerResult =
  | { kind: "idle" }
  | { kind: "captured"; message: CaptureMessage }
  | { kind: "delivered" | "duplicate" | "skipped" | "dead_letter" | "retry" | "lease_lost" };

export interface ProcessOptions {
  handlers: HandlerRegistry;
  maxAttempts?: number;
  /** Called with an unexpected failure before it is recorded as a retry or dead letter. */
  reportError?: (error: unknown, context: { tenantId: string; jobId: string }) => void;
}

interface EventRow {
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: unknown;
  dedupe_key: string;
  attempt_count: number;
  trace_parent: string | null;
}

function leaseToken(workerId: string): string {
  return `${workerId.slice(0, 70)}:${randomUUID()}`;
}

async function inTenant<T>(database: postgres.Sql, tenantId: string, work: (tenantDb: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return database.begin(async (transaction) => {
    await transaction`select set_config('app.tenant_id', ${tenantId}, true)`;
    return work(transaction);
  }) as Promise<T>;
}

/**
 * Claims up to `batchSize` due rows across every business through the one narrow definer
 * function the worker may call. It returns ids only; everything else is read in tenant scope.
 */
export async function claimOutboxBatch(database: postgres.Sql, workerId: string, batchSize: number): Promise<ClaimedEvent[]> {
  const token = leaseToken(workerId);
  const rows = await database<{ tenant_id: string; id: string }[]>`
    select tenant_id, id from kalendr_claim_outbox(${token}, ${batchSize})
  `;
  return rows.map((row) => ({ tenantId: row.tenant_id, id: row.id, leaseToken: token }));
}

/**
 * Runs the handler for one claimed row inside a transaction scoped to its business. The
 * handler's writes and the row's new status commit together. A thrown error rolls the
 * handler's writes back and is recorded as a retry, or as a dead letter on the last attempt.
 */
export async function processClaimedEvent(
  database: postgres.Sql,
  claim: ClaimedEvent,
  options: ProcessOptions,
): Promise<WorkerResult> {
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  let attemptCount = 0;
  try {
    return await inTenant(database, claim.tenantId, async (tenantDb) => {
      const rows = await tenantDb`
        select aggregate_type, aggregate_id, event_type, payload, dedupe_key, attempt_count, trace_parent
        from outbox_events
        where tenant_id = ${claim.tenantId} and id = ${claim.id}
          and status = 'processing' and locked_by = ${claim.leaseToken}
        for update
      `;
      const row = rows[0] as EventRow | undefined;
      if (!row) return { kind: "lease_lost" } as const;
      attemptCount = row.attempt_count;

      const finish = async (status: "delivered" | "failed" | "dead_letter", code: string | null) => {
        const delayMs = status === "failed" ? retryDelayMs(attemptCount) : 0;
        await tenantDb`
          update outbox_events
          set status = ${status}, locked_at = null, locked_by = null, last_error_code = ${code},
            available_at = case when ${status} = 'failed'
              then now() + ${delayMs} * interval '1 millisecond' else available_at end,
            updated_at = now()
          where tenant_id = ${claim.tenantId} and id = ${claim.id}
        `;
      };

      // A worker that died mid-row on its last attempt leaves the row to expire; it is not tried a ninth time.
      if (attemptCount > maxAttempts) {
        await finish("dead_letter", "lease_expired_after_max_attempts");
        return { kind: "dead_letter" } as const;
      }
      const handler = options.handlers.get(row.event_type);
      if (!handler) {
        await finish("dead_letter", "invalid_event");
        return { kind: "dead_letter" } as const;
      }

      const queuedBy = spanContextFromTraceParent(row.trace_parent);
      return trace.getTracer("kalendr-worker").startActiveSpan(
        "outbox.process",
        {
          links: queuedBy ? [{ context: queuedBy }] : [],
          attributes: {
            "kalendr.tenant_id": claim.tenantId,
            "kalendr.event_type": row.event_type,
            "kalendr.attempt": attemptCount,
          },
        },
        async (span) => {
          try {
            const event: OutboxEvent = {
              id: claim.id,
              tenantId: claim.tenantId,
              aggregateType: row.aggregate_type,
              aggregateId: row.aggregate_id,
              eventType: row.event_type,
              payload: row.payload,
              dedupeKey: row.dedupe_key,
              attemptCount,
            };
            const outcome = await handler(tenantDb, event);
            const kind = typeof outcome === "string" ? outcome : outcome.outcome;
            const code = typeof outcome === "string" ? null : safeCode(outcome.code);
            let result: WorkerResult;
            if (kind === "delivered") {
              await finish("delivered", null);
              result = { kind: "delivered" };
            } else if (kind === "retry" && attemptCount < maxAttempts) {
              await finish("failed", code ?? "retry");
              result = { kind: "retry" };
            } else {
              await finish("dead_letter", code ?? (kind === "retry" ? "retries_exhausted" : "rejected"));
              result = { kind: "dead_letter" };
            }
            span.setAttribute("kalendr.outcome", result.kind);
            return result;
          } catch (error) {
            span.setStatus({ code: SpanStatusCode.ERROR });
            throw error;
          } finally {
            span.end();
          }
        },
      );
    });
  } catch (error) {
    options.reportError?.(error, { tenantId: claim.tenantId, jobId: claim.id });
    const recorded = await recordFailure(database, claim, maxAttempts, error);
    if (!recorded) return { kind: "lease_lost" };
    return { kind: recorded };
  }
}

async function recordFailure(
  database: postgres.Sql,
  claim: ClaimedEvent,
  maxAttempts: number,
  error: unknown,
): Promise<"retry" | "dead_letter" | null> {
  const code = safeErrorCode(error);
  return inTenant(database, claim.tenantId, async (tenantDb) => {
    const rows = await tenantDb<{ attempt_count: number }[]>`
      select attempt_count from outbox_events
      where tenant_id = ${claim.tenantId} and id = ${claim.id}
        and status = 'processing' and locked_by = ${claim.leaseToken}
      for update
    `;
    const row = rows[0];
    if (!row) return null;
    const deadLetter = row.attempt_count >= maxAttempts;
    await tenantDb`
      update outbox_events
      set status = ${deadLetter ? "dead_letter" : "failed"},
        available_at = now() + ${retryDelayMs(row.attempt_count)} * interval '1 millisecond',
        locked_at = null, locked_by = null, last_error_code = ${code}, updated_at = now()
      where tenant_id = ${claim.tenantId} and id = ${claim.id}
    `;
    return deadLetter ? "dead_letter" : "retry";
  });
}

/**
 * Hands rows this worker claimed but never started back to the queue, as if the claim had not
 * happened. Used on shutdown so the rows don't wait out the 60 second lease.
 */
export async function releaseClaims(database: postgres.Sql, claims: readonly ClaimedEvent[]): Promise<number> {
  let released = 0;
  for (const claim of claims) {
    released += await inTenant(database, claim.tenantId, async (tenantDb) => {
      const rows = await tenantDb`
        update outbox_events
        set status = case when attempt_count > 1 then 'failed'::outbox_status else 'pending'::outbox_status end,
          attempt_count = greatest(attempt_count - 1, 0),
          locked_at = null, locked_by = null, updated_at = now()
        where tenant_id = ${claim.tenantId} and id = ${claim.id}
          and status = 'processing' and locked_by = ${claim.leaseToken}
        returning id
      `;
      return rows.length;
    });
  }
  return released;
}

export interface BatchOptions extends ProcessOptions {
  workerId: string;
  batchSize: number;
  concurrency: number;
  /** Checked before each row starts. Once it returns true, unstarted rows are released. */
  shouldStop?: () => boolean;
  onResult?: (claim: ClaimedEvent, result: WorkerResult) => void;
}

/** Claims one batch and works through it with up to `concurrency` rows at a time. Returns how many rows it claimed. */
export async function runOutboxBatch(database: postgres.Sql, options: BatchOptions): Promise<number> {
  const claims = await claimOutboxBatch(database, options.workerId, options.batchSize);
  const queue = [...claims];
  const unstarted: ClaimedEvent[] = [];
  const lane = async () => {
    for (let claim = queue.shift(); claim; claim = queue.shift()) {
      if (options.shouldStop?.()) {
        unstarted.push(claim, ...queue.splice(0));
        return;
      }
      const result = await processClaimedEvent(database, claim, options);
      options.onResult?.(claim, result);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency, claims.length)) }, lane));
  if (unstarted.length > 0) await releaseClaims(database, unstarted);
  return claims.length;
}

export interface WorkerOptions {
  tenantId: string;
  workerId: string;
  maxAttempts?: number;
  now?: () => Date;
  sink?: MessageSink;
  reportError?: (error: unknown, context: { tenantId: string; jobId: string }) => void;
}

/**
 * Claims and handles the next due row of one business, in tenant scope and without the
 * definer function. Kept for tests and for one-business runs; the worker uses `runOutboxBatch`.
 */
export async function processNextOutboxEvent(database: postgres.Sql, options: WorkerOptions): Promise<WorkerResult> {
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  if (!options.tenantId || !options.workerId || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 32) {
    throw new Error("Invalid outbox worker configuration");
  }
  const token = leaseToken(options.workerId);
  const claimed = await inTenant(database, options.tenantId, async (tenantDb) => {
    const rows = await tenantDb<{ id: string }[]>`
      with due as (
        select id from outbox_events
        where tenant_id = ${options.tenantId}
          and ((status in ('pending', 'failed') and available_at <= now())
            or (status = 'processing' and locked_at < now() - ${LEASE_MS} * interval '1 millisecond'))
        order by available_at, id
        for update skip locked
        limit 1
      )
      update outbox_events as event
      set status = 'processing', locked_at = now(), locked_by = ${token},
        attempt_count = event.attempt_count + 1, updated_at = now()
      from due
      where event.tenant_id = ${options.tenantId} and event.id = due.id
      returning event.id
    `;
    return rows[0];
  });
  if (!claimed) return { kind: "idle" };

  // Watch what the sink did so callers can see the message that was captured.
  const baseSink = options.sink ?? localCaptureSink;
  let sent: { outcome: string; message: CaptureMessage } | undefined;
  const sink: MessageSink = {
    mode: baseSink.mode,
    async deliver(tenantDb, outgoing, now) {
      const outcome = await baseSink.deliver(tenantDb, outgoing, now);
      sent = { outcome: typeof outcome === "string" ? outcome : outcome.outcome, message: outgoing.message };
      return outcome;
    },
  };
  const result = await processClaimedEvent(
    database,
    { tenantId: options.tenantId, id: claimed.id, leaseToken: token },
    { handlers: createHandlers({ sink, now: options.now ?? (() => new Date()) }), maxAttempts, reportError: options.reportError },
  );
  if (result.kind !== "delivered") return result;
  if (!sent) return { kind: "skipped" };
  if (sent.outcome === "duplicate") return { kind: "duplicate" };
  return { kind: "captured", message: sent.message };
}

const CODE_PATTERN = /^[a-z0-9_.:-]{1,120}$/;

function safeCode(code: string): string {
  return CODE_PATTERN.test(code) ? code : "handler_error";
}

function safeErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9]{5}$/.test(code)) return `sql_${code}`;
  }
  return "processing_error";
}
