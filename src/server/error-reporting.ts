import * as Sentry from "@sentry/nextjs";
import { trace } from "@opentelemetry/api";

import { env } from "./env";
import { errorSummary, logger } from "./logger";
import { currentRequestContext, type RequestContext } from "./request-context";

/**
 * Logs a server-side failure and, when SENTRY_DSN is set, reports it with the request
 * id, tenant id, route and trace id as tags. Only call this for failures the server
 * caused: validation and permission errors are expected and are never reported.
 */
export function reportServerError(error: unknown, context: RequestContext = {}): void {
  const tags = { ...currentRequestContext(), ...definedOnly(context) };
  const traceId = trace.getActiveSpan()?.spanContext().traceId;
  logger().error({ ...tags, ...(traceId ? { traceId } : {}), ...errorSummary(error) }, "request failed");
  if (!env().SENTRY_DSN) return;
  Sentry.withScope((scope) => {
    if (tags.requestId) scope.setTag("request_id", tags.requestId);
    if (tags.tenantId) scope.setTag("tenant_id", tags.tenantId);
    if (tags.route) scope.setTag("route", tags.route);
    if (tags.jobId) scope.setTag("job_id", tags.jobId);
    if (tags.errorDigest) scope.setTag("error_digest", tags.errorDigest);
    if (traceId) scope.setTag("trace_id", traceId);
    Sentry.captureException(error);
  });
}

function definedOnly(context: RequestContext): RequestContext {
  return Object.fromEntries(Object.entries(context).filter(([, value]) => value !== undefined)) as RequestContext;
}
