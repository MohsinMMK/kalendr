import { env, EnvironmentError, type EnvironmentSource } from "../server/env";
import type { WorkerMode } from "./delivery";

export interface WorkerConfiguration {
  mode: WorkerMode;
  databaseUrl: string;
  concurrency: number;
  /** Rows claimed per round: enough to keep every lane busy. */
  batchSize: number;
  version: string;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Reads and checks the worker's settings. Names the bad variables, never their values.
 *
 * `local_capture` is the default and records messages without sending them, so it refuses a
 * production process and any database that isn't on this machine. `production` needs a
 * production process: it is the only mode that hands messages to provider adapters.
 */
export function readWorkerConfiguration(source: EnvironmentSource = process.env): WorkerConfiguration {
  const settings = env(source);
  const problems: string[] = [];
  const mode = settings.KALENDR_WORKER_MODE;
  const databaseUrl = settings.WORKER_DATABASE_URL;
  if (!databaseUrl) problems.push("WORKER_DATABASE_URL is required");

  if (mode === "local_capture") {
    if (settings.NODE_ENV === "production") {
      problems.push("KALENDR_WORKER_MODE=local_capture must not run with NODE_ENV=production");
    }
    if (databaseUrl) {
      const address = new URL(databaseUrl);
      if (address.hash || !LOOPBACK_HOSTS.has(address.hostname)) {
        problems.push("WORKER_DATABASE_URL must point at a loopback database host in local_capture mode");
      }
    }
  } else if (settings.NODE_ENV !== "production") {
    problems.push("KALENDR_WORKER_MODE=production needs NODE_ENV=production");
  }
  if (problems.length > 0 || !databaseUrl) throw new EnvironmentError(problems);

  return {
    mode,
    databaseUrl,
    concurrency: settings.WORKER_CONCURRENCY,
    batchSize: Math.min(100, settings.WORKER_CONCURRENCY * 4),
    version: settings.DEPLOYMENT_VERSION ?? "dev",
  };
}
