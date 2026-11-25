import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import { SpanStatusCode, trace } from "@opentelemetry/api";
import { sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { schema, type KalendrSchema } from "@/db/schema";
import { env } from "@/server/env";
import { rememberErrorTenant, withRequestContext } from "@/server/request-context";

export type KalendrDatabase = PostgresJsDatabase<KalendrSchema>;
export type KalendrTransaction = Parameters<
  Parameters<KalendrDatabase["transaction"]>[0]
>[0];

interface DatabaseGlobals {
  client?: postgres.Sql;
  database?: KalendrDatabase;
}

const databaseGlobals = globalThis as typeof globalThis & DatabaseGlobals;

export function isDatabaseConfigured(): boolean {
  return Boolean(env().DATABASE_URL);
}

const databaseOverride = new AsyncLocalStorage<KalendrDatabase>();

/**
 * Runs `operation` with every getDatabase(), requireDatabase() and withTenant() inside it using `database`.
 * The worker has its own connection and no DATABASE_URL for the web app's pool; it wraps that connection with
 * drizzle and runs the shared booking code this way (feature 12, appointment import).
 */
export function runWithDatabase<T>(database: KalendrDatabase, operation: () => Promise<T>): Promise<T> {
  return databaseOverride.run(database, operation);
}

export function getDatabase(): KalendrDatabase | null {
  const override = databaseOverride.getStore();
  if (override) return override;
  const { DATABASE_URL: databaseUrl, DATABASE_POOL_MAX: poolSize } = env();
  if (!databaseUrl) return null;

  if (!databaseGlobals.client) {
    databaseGlobals.client = postgres(databaseUrl, {
      max: poolSize,
      connect_timeout: 10,
      idle_timeout: 20,
      max_lifetime: 60 * 30,
      prepare: false,
      transform: { undefined: null },
    });
  }

  if (!databaseGlobals.database) {
    databaseGlobals.database = drizzle(databaseGlobals.client, { schema });
  }

  return databaseGlobals.database;
}

export function requireDatabase(): KalendrDatabase {
  const database = getDatabase();
  if (!database) {
    throw new Error("DATABASE_URL is required for this operation");
  }
  return database;
}

const tracer = trace.getTracer("kalendr");

/**
 * Runs `operation` in one transaction scoped to a tenant by row-level security.
 * Logs written inside carry the tenant id, and the transaction is one trace span
 * (a no-op unless tracing is configured). An error thrown inside remembers its
 * tenant so the error report can name it.
 */
export async function withTenant<T>(
  tenantId: string,
  operation: (transaction: KalendrTransaction) => Promise<T>,
): Promise<T> {
  const database = requireDatabase();
  return withRequestContext({ tenantId }, () =>
    tracer.startActiveSpan("db.transaction", { attributes: { "db.system.name": "postgresql", "kalendr.tenant_id": tenantId } }, async (span) => {
      try {
        return await database.transaction(async (transaction) => {
          await transaction.execute(
            sql`select set_config('app.tenant_id', ${tenantId}, true)`,
          );
          return operation(transaction);
        });
      } catch (error) {
        rememberErrorTenant(error, tenantId);
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    }),
  );
}
