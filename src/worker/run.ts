import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

import * as Sentry from "@sentry/nextjs";
import postgres from "postgres";

import type { Channel } from "../server/channels/types";
import { sharedSentryOptions } from "../lib/sentry-scrub";
import { appOrigin, env, EnvironmentError } from "../server/env";
import { smsChannelFromEnv } from "../server/channels/sms-config";
import { whatsappChannelFromEnv } from "../server/channels/whatsapp-config";
import { emailSettingsFromEnv } from "../server/messaging/email-config";
import { createLogger, errorSummary } from "../server/logger";
import { withRequestContext } from "../server/request-context";
import { getVideoProvider } from "../server/video";
import { readWorkerConfiguration, type WorkerConfiguration } from "./config";
import { localCaptureSink, providerSink, type MessageSink, type ProviderAdapters } from "./delivery";
import { createEmailAdapter } from "./email-adapter";
import { localCapturePushSender, webPushSender, type PushSender } from "./push";
import { createHandlers } from "./handlers";
import { runCodeDeliveries, type CodeDeliveryDeps } from "./patient-code-delivery";
import { createSmsAdapter } from "./sms-adapter";
import { createWhatsAppAdapter } from "./whatsapp-adapter";
import { outboxHealth } from "./jobs";
import { runOutboxBatch } from "./outbox-worker";
import { planGatedSink } from "./plan-gate";
import { startScheduler, type Scheduler } from "./schedules";

const HEARTBEAT_INTERVAL_MS = 30_000;
const IDLE_WAIT_MS = 1_000;

/**
 * The provider adapters. Email (feature 2) is here when RESEND_API_KEY and EMAIL_FROM are set;
 * WhatsApp (feature 3) when its access token and phone number id are set. A channel with no
 * adapter sends nothing: routing falls back to the next channel, and a message already queued
 * for it goes to dead letter as provider_not_configured, where staff can see it.
 *
 * In local_capture mode only a loopback API URL (the capture server) is accepted for each
 * provider, so a local worker can never reach a real one.
 */
function providerAdapters(mode: WorkerConfiguration["mode"]): { adapters: ProviderAdapters; whatsapp: Channel | null; sms: Channel | null } {
  const localOnly = mode !== "production";
  const email = emailSettingsFromEnv({ localOnly });
  const whatsapp = whatsappChannelFromEnv({ localOnly });
  const sms = smsChannelFromEnv({ localOnly });
  const adapters: ProviderAdapters = {};
  if (email) adapters.email = createEmailAdapter({ ...email, origin: appOrigin() });
  // Templates Meta has not approved yet can be sent only to the capture server.
  if (whatsapp) adapters.whatsapp = createWhatsAppAdapter({ channel: whatsapp, origin: appOrigin(), allowUnapproved: whatsapp.mode === "capture" });
  if (sms) adapters.sms = createSmsAdapter({ channel: sms, origin: appOrigin(), allowUnapproved: localOnly });
  return { adapters, whatsapp, sms };
}

/**
 * Production sends through the adapters. Local capture records every message as captured,
 * except the channels that have a capture server configured (email, WhatsApp): those go through
 * the real adapter to the capture server, so browser tests can read what was sent.
 */
function messageSink(mode: WorkerConfiguration["mode"], adapters: ProviderAdapters): MessageSink {
  if (mode === "production") return providerSink(adapters);
  const routed = providerSink(adapters);
  return {
    mode: "local_capture",
    deliver: (tenantDb, outgoing, now) =>
      adapters[outgoing.channel] ? routed.deliver(tenantDb, outgoing, now) : localCaptureSink.deliver(tenantDb, outgoing, now),
  };
}

/** Web push: real only in production with a VAPID key pair; a local worker never reaches a push service. */
function pushSender(mode: WorkerConfiguration["mode"]): PushSender | undefined {
  const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: subject } = env();
  if (!publicKey || !privateKey || !subject) return undefined;
  return mode === "production" ? webPushSender({ publicKey, privateKey, subject }) : localCapturePushSender;
}

/** Starts error reporting and tracing only when their variables are set. */
async function startMonitoring(): Promise<void> {
  const settings = env();
  if (settings.OTEL_EXPORTER_OTLP_ENDPOINT) {
    const { registerOTel } = await import("@vercel/otel");
    registerOTel({ serviceName: `${settings.OTEL_SERVICE_NAME ?? "kalendr"}-worker` });
  }
  if (settings.SENTRY_DSN) {
    Sentry.init({
      ...sharedSentryOptions,
      dsn: settings.SENTRY_DSN,
      environment: settings.SENTRY_ENVIRONMENT ?? settings.NODE_ENV,
      release: settings.DEPLOYMENT_VERSION,
      enableOpenTelemetrySetup: false,
    });
  }
}

let workerLogger: ReturnType<typeof createLogger> | undefined;

function log() {
  workerLogger ??= createLogger({ service: "kalendr-worker" });
  return workerLogger;
}

function reportJobError(error: unknown, context: { tenantId: string; jobId: string }): void {
  log().error({ ...context, ...errorSummary(error) }, "outbox job failed");
  if (!env().SENTRY_DSN) return;
  Sentry.withScope((scope) => {
    scope.setTag("tenant_id", context.tenantId);
    scope.setTag("job_id", context.jobId);
    Sentry.captureException(error);
  });
}

function reportTimedJobError(job: string, error: unknown): void {
  log().error({ job, ...errorSummary(error) }, "timed job failed");
  if (env().SENTRY_DSN) Sentry.withScope((scope) => { scope.setTag("job", job); Sentry.captureException(error); });
}

/**
 * Writes this worker's row in worker_heartbeats and one log line that alerting reads: counts
 * only. Alert when the line is older than 90 seconds, when oldestPendingSeconds passes 600,
 * or when deadLetters goes up.
 */
async function heartbeat(database: postgres.Sql, workerId: string, configuration: WorkerConfiguration): Promise<void> {
  await database`
    insert into worker_heartbeats (worker_id, mode, version)
    values (${workerId}, ${configuration.mode}, ${configuration.version})
    on conflict (worker_id) do update set last_seen_at = now(), stopped_at = null
  `;
  log().info({ workerId, mode: configuration.mode, ...(await outboxHealth(database)) }, "worker heartbeat");
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

async function main(): Promise<void> {
  const configuration = readWorkerConfiguration();
  await startMonitoring();
  const database = postgres(configuration.databaseUrl, {
    max: configuration.concurrency + 2,
    prepare: false,
    connection: { application_name: "kalendr-worker" },
  });
  const workerId = `${configuration.mode}-${hostname()}-${randomUUID().slice(0, 8)}`.slice(0, 80);
  const { adapters, whatsapp, sms } = providerAdapters(configuration.mode);
  // Every send passes the plan check first (feature 14): channels the plan lacks, allowances, and the never-stopped rule.
  const sink = planGatedSink(messageSink(configuration.mode, adapters));
  const emailSettings = emailSettingsFromEnv({ localOnly: configuration.mode !== "production" });
  const handlers = createHandlers({
    databaseUrl: configuration.databaseUrl,
    sink,
    now: () => new Date(),
    // Routing only picks a channel that has an adapter. In local capture the unconfigured ones still count as available.
    available: configuration.mode === "production"
      ? { whatsapp: Boolean(adapters.whatsapp), sms: Boolean(adapters.sms) }
      : undefined,
    channels: { whatsapp: whatsapp ?? undefined },
    origin: appOrigin(),
    ...(emailSettings ? { email: { provider: emailSettings.provider, fallbackReplyTo: emailSettings.fallbackReplyTo } } : {}),
    allowUnapprovedTemplates: configuration.mode !== "production",
    video: getVideoProvider(),
    push: pushSender(configuration.mode),
    payments: { stripeSecretKey: env().STRIPE_CONNECT_SECRET_KEY },
  });
  // Customer sign-in codes and notices (feature 8): WhatsApp, then text, then email.
  const codeDeliveries: CodeDeliveryDeps = {
    workerId,
    whatsapp,
    sms,
    email: emailSettings ? { provider: emailSettings.provider, fallbackReplyTo: emailSettings.fallbackReplyTo } : null,
    allowUnapproved: configuration.mode !== "production",
    devConsole: configuration.mode !== "production",
  };
  const missing = (["email", "sms", "whatsapp"] as const).filter((channel) => !adapters[channel]);
  if (configuration.mode === "production" && missing.length > 0) {
    log().warn({ workerId, missing }, "some channels have no provider; their messages will go to dead letter as provider_not_configured");
  }

  // SIGTERM: stop claiming, finish the rows in hand, hand back the ones not started, then exit.
  const stopping = new AbortController();
  const stop = () => stopping.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  let scheduler: Scheduler | undefined;
  let heartbeatTimer: NodeJS.Timeout | undefined;
  try {
    await heartbeat(database, workerId, configuration);
    heartbeatTimer = setInterval(() => {
      heartbeat(database, workerId, configuration).catch((error: unknown) => {
        log().error({ workerId, ...errorSummary(error) }, "worker heartbeat failed");
      });
    }, HEARTBEAT_INTERVAL_MS);
    scheduler = await startScheduler(
      configuration.databaseUrl,
      database,
      (job, fields) => log().info({ workerId, job, ...fields }, "timed job finished"),
      reportTimedJobError,
    );
    log().info({ workerId, mode: configuration.mode, concurrency: configuration.concurrency }, "worker started");

    while (!stopping.signal.aborted) {
      const claimed = await runOutboxBatch(database, {
        workerId,
        batchSize: configuration.batchSize,
        concurrency: configuration.concurrency,
        handlers,
        reportError: reportJobError,
        shouldStop: () => stopping.signal.aborted,
        onResult: (claim, result) => {
          // Outcome only. No contact details, message body or row content.
          withRequestContext({ tenantId: claim.tenantId }, () =>
            log().info({ tenantId: claim.tenantId, outcome: result.kind }, "outbox event handled"));
        },
      });
      const codes = await runCodeDeliveries(database, codeDeliveries).catch((error: unknown) => {
        log().error({ workerId, ...errorSummary(error) }, "code delivery failed");
        return 0;
      });
      if (claimed === 0 && codes === 0) await sleep(IDLE_WAIT_MS, stopping.signal);
    }
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await scheduler?.stop().catch((error: unknown) => reportTimedJobError("pg-boss", error));
    await database`update worker_heartbeats set stopped_at = now(), last_seen_at = now() where worker_id = ${workerId}`
      .catch(() => undefined);
    await database.end({ timeout: 5 });
    await Sentry.flush(2_000);
    log().info({ workerId }, "worker stopped");
  }
}

main().catch((error: unknown) => {
  if (error instanceof EnvironmentError) {
    // Names the variables only, never their values.
    process.stderr.write(`${error.message}\n`);
  } else {
    // Never print raw database errors: query details may include customer data or credentials.
    log().error(errorSummary(error), "worker stopped after an error");
  }
  process.exitCode = 1;
});
