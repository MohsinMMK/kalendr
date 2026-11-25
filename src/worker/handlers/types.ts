import type postgres from "postgres";

/** A transaction that has already set app.tenant_id, so row-level security limits it to one business. */
/** How many times the worker tries an outbox event before it is dead-lettered. */
export const MAX_ATTEMPTS = 8;

export type TenantDb = postgres.TransactionSql;

/** One outbox row, read inside its business's scope after the worker leased it. */
export interface OutboxEvent {
  id: string;
  tenantId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
  dedupeKey: string;
  attemptCount: number;
}

/**
 * What a handler decided:
 * - "delivered": the event is finished. This includes events it chose to drop, such as a
 *   reminder for an appointment that has since moved.
 * - "retry": try again later, on the 5, 10, 20 second… schedule.
 * - "dead": stop trying; staff see it under Failed on the Messages screen.
 * The object form adds a short reason code that is stored as last_error_code. Never put
 * customer data in a code.
 */
export type HandlerOutcome =
  | "delivered"
  | "retry"
  | "dead"
  | { outcome: "retry" | "dead"; code: string };

export type EventHandler = (tenantDb: TenantDb, event: OutboxEvent) => Promise<HandlerOutcome>;
