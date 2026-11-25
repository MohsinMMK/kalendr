import "server-only";

import { sql } from "drizzle-orm";

import { getDatabase } from "@/db/client";

import journal from "../../drizzle/meta/_journal.json";

import { errorSummary, logger } from "./logger";

/** The newest migration this build was made with. */
const expectedSchemaVersion = Math.max(...journal.entries.map((entry) => entry.when));

const CHECK_TIMEOUT_MS = 2_000;

export type ReadinessCheck = "ok" | "unavailable" | "not_configured" | "behind";

export interface Readiness {
  ready: boolean;
  checks: { database: ReadinessCheck; migrations: ReadinessCheck };
}

/**
 * Ready means the database answers and holds every migration this build expects.
 * The answer names checks only: no versions, hosts or error text.
 */
export async function checkReadiness(): Promise<Readiness> {
  const database = getDatabase();
  if (!database) {
    return { ready: false, checks: { database: "not_configured", migrations: "unavailable" } };
  }
  let applied: number | null;
  try {
    const rows = await withTimeout(
      database.execute<{ version: string | null }>(sql`select kalendr_schema_version()::text as version`),
      CHECK_TIMEOUT_MS,
    );
    applied = rows[0]?.version ? Number(rows[0].version) : null;
  } catch (error) {
    logger().warn({ route: "GET /api/ready", ...errorSummary(error) }, "readiness check failed");
    return { ready: false, checks: { database: "unavailable", migrations: "unavailable" } };
  }
  const migrations: ReadinessCheck = applied !== null && applied >= expectedSchemaVersion ? "ok" : "behind";
  return { ready: migrations === "ok", checks: { database: "ok", migrations } };
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("timed out"), { name: "TimeoutError" })), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
