/**
 * Links a background job's trace to the request that queued it. The request stores its
 * W3C traceparent on the outbox row; the worker starts its own trace with a link back.
 * With tracing off there is no valid span, so nothing is stored.
 */
import { trace, TraceFlags, type SpanContext } from "@opentelemetry/api";

const TRACE_PARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** The active span as a traceparent header value, or null when tracing is off. */
export function currentTraceParent(): string | null {
  const span = trace.getActiveSpan();
  if (!span) return null;
  const context = span.spanContext();
  if (!trace.isSpanContextValid(context)) return null;
  const sampled = (context.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED;
  return `00-${context.traceId}-${context.spanId}-${sampled ? "01" : "00"}`;
}

/** Parses a stored traceparent. Anything malformed is ignored. */
export function spanContextFromTraceParent(value: string | null | undefined): SpanContext | null {
  const match = value ? TRACE_PARENT.exec(value) : null;
  if (!match) return null;
  const context: SpanContext = {
    traceId: match[1]!,
    spanId: match[2]!,
    traceFlags: Number.parseInt(match[3]!, 16),
    isRemote: true,
  };
  return trace.isSpanContextValid(context) ? context : null;
}
