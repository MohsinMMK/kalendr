import { MAX_ATTEMPTS } from "./types";
import { failJob, readEventPayload } from "../../server/imports/job-db";
import type { FileStore } from "../../server/file-store";
import { runCheck, runCommit, runUndo } from "../../server/imports/run";
import type { EventHandler } from "./types";

export interface ImportHandlerDependencies {
  /** The worker's database address. Only the appointment import needs it, for a small pool of its own. */
  databaseUrl?: string;
  store?: () => FileStore;
}

/**
 * Data import (feature 12): check, commit and undo, one chunk or batch per event. A failure inside a row is recorded on
 * that row and never reaches here. An error that does reach here rolls the batch back and the outbox retries it; on the
 * last attempt the job is marked failed (or, for an undo, put back to done) so it is never left waiting for an event
 * that will not come, and its file can be purged.
 */
export function importHandlers(dependencies: ImportHandlerDependencies = {}): ReadonlyArray<readonly [string, EventHandler]> {
  const deps = () => ({ databaseUrl: dependencies.databaseUrl, store: dependencies.store?.() });
  const handle = (run: typeof runCheck): EventHandler => async (tenantDb, event) => {
    const request = readEventPayload(event.payload);
    if (!request) return { outcome: "dead", code: "invalid_payload" };
    try {
      // A savepoint, so a database error inside the batch leaves the transaction usable for the failure note below.
      await tenantDb.savepoint((scope) => run(scope, event.tenantId, request, deps()));
      return "delivered";
    } catch (error) {
      if (event.attemptCount < MAX_ATTEMPTS) throw error;
      if (event.eventType === "import.undo") {
        await tenantDb`update import_jobs set status = 'done', updated_at = now() where tenant_id = ${event.tenantId} and id = ${request.jobId} and status = 'undoing'`;
      } else {
        await failJob(tenantDb, event.tenantId, request.jobId, "import_failed");
      }
      return { outcome: "dead", code: "import_batch_failed" };
    }
  };
  return [
    ["import.check", handle(runCheck)],
    ["import.commit", handle(runCommit)],
    ["import.undo", handle(runUndo)],
  ];
}
