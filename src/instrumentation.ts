import type { Instrumentation } from "next";

/**
 * Runs once when a server process starts (Next.js calls this before any request).
 *
 * 1. Checks the environment and stops the process with a message naming each
 *    missing or wrong variable.
 * 2. Starts OpenTelemetry tracing, only when OTEL_EXPORTER_OTLP_ENDPOINT is set.
 * 3. Starts Sentry error reporting, only when SENTRY_DSN is set.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startServerMonitoring } = await import("./server/monitoring");
  await startServerMonitoring();
}

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { reportRequestError } = await import("./server/monitoring");
  reportRequestError(error, request, context);
};
