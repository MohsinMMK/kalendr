import "server-only";

import postgres from "postgres";

import { env } from "@/server/env";
import { errorSummary, logger } from "@/server/logger";

import { LIVE_CHANNEL, LiveHub, type LiveSignal } from "./hub";

/**
 * One listening connection per app server, apart from the query pool. postgres.js keeps it open
 * and reconnects with backoff; each time it is listening again every screen refetches, in case
 * a notice was missed while it was away.
 */
interface LiveGlobals {
  kalendrLiveHub?: LiveHub;
  kalendrLiveClient?: postgres.Sql;
  kalendrLiveListening?: Promise<void>;
}

const liveGlobals = globalThis as typeof globalThis & LiveGlobals;

function hub(): LiveHub {
  liveGlobals.kalendrLiveHub ??= new LiveHub();
  return liveGlobals.kalendrLiveHub;
}

function startListening(): Promise<void> {
  if (liveGlobals.kalendrLiveListening) return liveGlobals.kalendrLiveListening;
  const databaseUrl = env().DATABASE_URL;
  if (!databaseUrl) return Promise.reject(new Error("DATABASE_URL is required for live updates"));
  const client = postgres(databaseUrl, { max: 1, connect_timeout: 10, prepare: false });
  liveGlobals.kalendrLiveClient = client;
  let first = true;
  const listening = client
    .listen(
      LIVE_CHANNEL,
      (payload) => hub().receive(payload),
      () => {
        if (first) {
          first = false;
          return;
        }
        logger().info({ event: "live.reconnected" }, "Live updates listening again");
        hub().resyncAll();
      },
    )
    .then(() => undefined)
    .catch((error: unknown) => {
      // Let the next screen try again rather than keeping a failed start.
      liveGlobals.kalendrLiveListening = undefined;
      liveGlobals.kalendrLiveClient = undefined;
      void client.end({ timeout: 1 });
      logger().warn({ event: "live.listen_failed", ...errorSummary(error) }, "Live updates could not listen");
      throw error;
    });
  liveGlobals.kalendrLiveListening = listening;
  return listening;
}

/**
 * Hears about changes to one business. Resolves once the server is listening, so nothing that
 * happens after it resolves is missed. Returns the function that stops listening.
 */
export async function subscribeToLiveChanges(tenantId: string, listener: (signal: LiveSignal) => void): Promise<() => void> {
  const unsubscribe = hub().subscribe(tenantId, listener);
  try {
    await startListening();
  } catch (error) {
    unsubscribe();
    throw error;
  }
  return unsubscribe;
}
