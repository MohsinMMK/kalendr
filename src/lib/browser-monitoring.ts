/**
 * Browser error reporting. Off unless NEXT_PUBLIC_SENTRY_DSN was set when the app was
 * built; when off, the Sentry SDK is never downloaded. When on, events pass through
 * the same scrubbing as the server: no request data, user, console output or contact
 * details. No session replay and no browser tracing.
 */
type SentryModule = typeof import("@sentry/nextjs");

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
let loading: Promise<SentryModule> | null = null;

export function startBrowserMonitoring(): Promise<SentryModule> | null {
  if (!dsn) return null;
  loading ??= Promise.all([import("@sentry/nextjs"), import("./sentry-scrub")]).then(([Sentry, scrub]) => {
    Sentry.init({
      ...scrub.sharedSentryOptions,
      dsn,
      environment: process.env.NODE_ENV,
    });
    return Sentry;
  });
  return loading;
}

export function reportClientError(error: unknown): void {
  void startBrowserMonitoring()?.then((Sentry) => Sentry.captureException(error));
}
