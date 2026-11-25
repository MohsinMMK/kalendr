import "server-only";

import { sql } from "drizzle-orm";

import { adminWorkerHealthSchema, type AdminWorkerHealth } from "@/lib/admin-contracts";

import { adminCall } from "./db";

export async function workerHealth(adminUserId: string): Promise<AdminWorkerHealth> {
  const rows = await adminCall((database) => database.execute<{ health: unknown }>(sql`select admin_worker_health(${adminUserId}) as health`));
  return adminWorkerHealthSchema.parse(rows[0]?.health);
}

/** Puts one dead-lettered event back in the queue. False when it was no longer dead (already retried by someone else). */
export async function retryDeadLetter(adminUserId: string, eventId: string, reason: string): Promise<boolean> {
  const rows = await adminCall((database) => database.execute<{ retried: boolean }>(sql`select admin_retry_dead_letter(${adminUserId}, ${eventId}, ${reason}) as retried`));
  return rows[0]?.retried === true;
}
