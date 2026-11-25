/**
 * One way to run a query from both sides of the app: the web server's drizzle transaction and the worker's
 * postgres.js transaction. The workflow engine is written once against `Runner`.
 * No "server-only": the worker imports this.
 */
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type postgres from "postgres";

export type Row = Record<string, unknown>;
export type Runner = (query: SQL) => Promise<Row[]>;

const dialect = new PgDialect();

/** For the web server: pass the transaction `withTenant` gave you. */
export function drizzleRunner(transaction: { execute(query: SQL): PromiseLike<unknown> }): Runner {
  return async (query) => Array.from(await transaction.execute(query) as Iterable<Row>);
}

/** For the worker: pass a postgres.js transaction that has already set app.tenant_id. */
export function postgresRunner(database: postgres.Sql | postgres.TransactionSql): Runner {
  return async (query) => {
    const { sql: text, params } = dialect.sqlToQuery(query);
    // postgres.js types its parameters narrowly; drizzle has already turned every value into a plain one.
    const rows = await database.unsafe(text, params as postgres.ParameterOrJSON<never>[]);
    return Array.from(rows) as Row[];
  };
}

export const asString = (value: unknown): string => (typeof value === "string" ? value : String(value ?? ""));
export const asNumber = (value: unknown): number => Number(value ?? 0);
export const asDate = (value: unknown): Date => (value instanceof Date ? value : new Date(asString(value)));
