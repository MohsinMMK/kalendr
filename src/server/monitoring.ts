import * as Sentry from "@sentry/nextjs";
import { registerOTel } from "@vercel/otel";

import { redact, redactError, redactText } from "@/lib/redact";
import { sharedSentryOptions } from "@/lib/sentry-scrub";

import { assertStartupEnvironment, EnvironmentError } from "./env";
import { reportServerError } from "./error-reporting";
import { logger } from "./logger";

/** Called once from src/instrumentation.ts when a Node.js server process starts. */
export async function startServerMonitoring(): Promise<void> {
  let environment;
  try {
    environment = assertStartupEnvironment();
  } catch (error) {
    if (error instanceof EnvironmentError) {
      // The message names variables only, never their values.
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  redactConsole();

  // Tracing is off unless an OTLP endpoint is configured. @vercel/otel reads the
  // endpoint, headers and protocol from the standard OTEL_* variables.
  if (environment.OTEL_EXPORTER_OTLP_ENDPOINT) {
    registerOTel({ serviceName: environment.OTEL_SERVICE_NAME ?? "kalendr-web" });
  }

  // Error reporting is off unless a DSN is configured.
  if (environment.SENTRY_DSN) {
    Sentry.init({
      ...sharedSentryOptions,
      dsn: environment.SENTRY_DSN,
      environment: environment.SENTRY_ENVIRONMENT ?? environment.NODE_ENV,
      release: environment.DEPLOYMENT_VERSION,
      // Our own provider (above) owns OpenTelemetry. Sentry doesn't register a competing one.
      enableOpenTelemetrySetup: false,
    });
  }

  logger().info(
    { tracing: Boolean(environment.OTEL_EXPORTER_OTLP_ENDPOINT), errorReporting: Boolean(environment.SENTRY_DSN) },
    "server started",
  );
}

const consoleRedacted = Symbol.for("kalendr.consoleRedacted");

/**
 * Next.js prints errors a page or action threw with console.error, outside our logger, and
 * a database error there carries the values of the failing query. Route console.error and
 * console.warn through the same redaction as the logger.
 */
export function redactConsole(target: Pick<Console, "error" | "warn"> = console): void {
  const marked = target as typeof target & { [consoleRedacted]?: true };
  if (marked[consoleRedacted]) return;
  marked[consoleRedacted] = true;
  for (const method of ["error", "warn"] as const) {
    const original = target[method].bind(target);
    target[method] = (...args: unknown[]) => original(...args.map(redactConsoleArgument));
  }
}

function redactConsoleArgument(argument: unknown): unknown {
  if (argument instanceof Error) return redactError(argument);
  if (typeof argument === "string") return redactText(argument);
  return redact(argument);
}

/**
 * Errors Next.js caught while rendering a page, running a server action or the proxy.
 * API routes catch their own errors and report them through routeErrorResponse.
 */
export function reportRequestError(
  error: unknown,
  request: { method: string; headers: Record<string, string | string[] | undefined> },
  context: { routePath: string; routeType: string },
): void {
  const header = request.headers["x-request-id"];
  const requestId = typeof header === "string" && /^[A-Za-z0-9-]{8,80}$/.test(header) ? header : crypto.randomUUID();
  // The digest is the "Reference" the error screen shows, so a visitor's report can be matched.
  const digest = error && typeof error === "object" && "digest" in error ? (error as { digest: unknown }).digest : undefined;
  const errorDigest = typeof digest === "string" && /^[A-Za-z0-9-]{1,64}$/.test(digest) ? digest : undefined;
  // routePath is the file path pattern (/app/manage/[token]), so it holds no tokens or ids.
  reportServerError(error, { requestId, route: `${request.method} ${context.routePath}`, errorDigest });
}
