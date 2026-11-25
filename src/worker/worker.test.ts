/** @vitest-environment node */

import { describe, expect, it, vi } from "vitest";

import { readWorkerConfiguration } from "./config";
import { localCaptureSink, providerSink, type OutgoingMessage, type ProviderAdapter } from "./delivery";
import { createHandlers, type TenantDb } from "./handlers";
import { TIMED_JOBS } from "./schedules";

const LOCAL_URL = "postgresql://worker:secret-value@127.0.0.1:5544/kalendr_local";
const REMOTE_URL = "postgresql://worker:secret-value@db.example.com:5432/kalendr";

describe("readWorkerConfiguration", () => {
  it("defaults to local capture against a database on this machine", () => {
    expect(readWorkerConfiguration({ WORKER_DATABASE_URL: LOCAL_URL })).toMatchObject({
      mode: "local_capture",
      databaseUrl: LOCAL_URL,
      concurrency: 4,
      batchSize: 16,
    });
  });

  it("caps the batch at 100 rows", () => {
    expect(readWorkerConfiguration({ WORKER_DATABASE_URL: LOCAL_URL, WORKER_CONCURRENCY: "32" }).batchSize).toBe(100);
  });

  it("refuses local capture in a production process or against a remote database", () => {
    expect(() => readWorkerConfiguration({ WORKER_DATABASE_URL: LOCAL_URL, NODE_ENV: "production" })).toThrow(/local_capture must not run/);
    expect(() => readWorkerConfiguration({ WORKER_DATABASE_URL: REMOTE_URL })).toThrow(/loopback database host/);
  });

  it("only uses provider adapters in a production process", () => {
    expect(() => readWorkerConfiguration({ WORKER_DATABASE_URL: LOCAL_URL, KALENDR_WORKER_MODE: "production" })).toThrow(/needs NODE_ENV=production/);
  });

  it("needs its own database URL, and never repeats a URL or password in the error", () => {
    expect(() => readWorkerConfiguration({})).toThrow(/WORKER_DATABASE_URL is required/);
    try {
      readWorkerConfiguration({ WORKER_DATABASE_URL: REMOTE_URL });
    } catch (error) {
      expect(String(error)).not.toContain("secret-value");
      expect(String(error)).not.toContain("db.example.com");
    }
  });
});

describe("createHandlers", () => {
  it("has a handler for every event the app queues", () => {
    const handlers = createHandlers({ sink: localCaptureSink, now: () => new Date() });
    for (const eventType of [
      "appointment.created",
      "appointment.confirm",
      "appointment.reschedule",
      "appointment.suggest",
      "appointment.cancel",
      "appointment.reminder",
      "appointment.review_request",
      "appointment.status.booked",
      "appointment.status.cancelled",
      "appointment.status.completed",
      "record.shared",
      "file.scan",
      "file.remove",
      "import.check",
      "import.commit",
      "import.undo",
    ]) {
      expect(handlers.has(eventType), eventType).toBe(true);
    }
    expect(handlers.has("appointment.unknown")).toBe(false);
  });
});

describe("TIMED_JOBS", () => {
  it("runs each repeating job on the planned schedule", () => {
    expect(Object.fromEntries(TIMED_JOBS.map((job) => [job.name, job.cron]))).toEqual({
      "reminder-sweep": "* * * * *",
      "billing-sweep": "*/5 * * * *",
      "domain-sweep": "*/5 * * * *",
      "email-domain-sweep": "*/5 * * * *",
      "onboarding-sweep": "*/15 * * * *",
      "hold-expiry": "* * * * *",
      "waitlist-sweep": "* * * * *",
      "payment-hold-expiry": "* * * * *",
      "payment-refund-sweep": "*/10 * * * *",
      "payment-reconcile": "0 21 * * *",
      "calendar-renewal": "0 * * * *",
      "calendar-poll": "*/5 * * * *",
      "calendar-resnapshot": "15 * * * *",
      retention: "0 3 * * *",
      "privacy-retention": "20 3 * * *",
      "privacy-overdue": "0 4 * * *",
      "dead-letter-report": "0 * * * *",
      "storage-re-encrypt": "*/10 * * * *",
      "key-rotation": "30 2 * * *",
      "media-backfill": "*/15 * * * *",
      "storage-health": "5 * * * *",
      "staff-digest": "*/15 * * * *",
      "owner-summary": "10 * * * *",
      "import-file-purge": "40 * * * *",
      "workflow-sweep": "* * * * *",
      "workflow-reconcile": "* * * * *",
      "campaign-tick": "* * * * *",
      "customer-merge-purge": "40 3 * * *",
      "request-expire": "* * * * *",
      "request-reminder": "*/5 * * * *",
      "reschedule-expire": "*/5 * * * *",
      "package-credit-sweep": "30 2 * * *",
      "membership-grace-sweep": "10 * * * *",
    });
  });
});

/** A stand-in for the tenant transaction: records each statement and answers the notification lookup. */
function fakeTenantDb(existingStatus?: string) {
  const statements: { text: string; values: unknown[] }[] = [];
  const tenantDb = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    statements.push({ text, values });
    return Promise.resolve(text.startsWith("select status from notifications") && existingStatus ? [{ status: existingStatus }] : []);
  }) as unknown as TenantDb;
  return { tenantDb, statements };
}

const outgoing: OutgoingMessage = {
  tenantId: "00000000-0000-4000-8000-000000000001",
  appointmentId: "00000000-0000-4000-8000-000000000002",
  patientId: "00000000-0000-4000-8000-000000000003",
  channel: "email",
  message: {
    semanticKey: "local:email:abc123",
    templateKey: "appointment.created",
    body: "Lotus Dental Studio: Your appointment is scheduled for 12 Dec 2026, 10:00 am IST.",
    scheduledAt: new Date("2026-11-12T10:00:00Z"),
  },
};
const now = new Date("2026-11-12T10:00:01Z");

describe("providerSink", () => {
  it("dead-letters a message when no provider is connected for its channel", async () => {
    const { tenantDb, statements } = fakeTenantDb();
    expect(await providerSink({}).deliver(tenantDb, outgoing, now)).toEqual({ outcome: "dead", code: "provider_not_configured" });
    const insert = statements.find((statement) => statement.text.startsWith("insert into notifications"));
    expect(insert?.values).toContain("failed");
    expect(insert?.values).toContain("provider_not_configured");
  });

  it("hands the adapter ids and the rendered text only, with a key that is the same on every attempt", async () => {
    const send = vi.fn<ProviderAdapter["send"]>().mockResolvedValue({ status: "sent", providerMessageId: "fake-1" });
    const { tenantDb, statements } = fakeTenantDb();
    expect(await providerSink({ email: { send } }).deliver(tenantDb, outgoing, now)).toBe("delivered");
    expect(send).toHaveBeenCalledWith({
      tenantDb,
      tenantId: outgoing.tenantId,
      appointmentId: outgoing.appointmentId,
      patientId: outgoing.patientId,
      channel: "email",
      templateKey: "appointment.created",
      body: outgoing.message.body,
      idempotencyKey: "email:abc123",
    });
    const insert = statements.find((statement) => statement.text.startsWith("insert into notifications"));
    // The destination column holds a marker, never an address.
    expect(insert?.values).toContain("provider:email");
    expect(insert?.values).toContain("sending");
  });

  it("sends a booking message by email when its WhatsApp template is not approved yet", async () => {
    const whatsapp = vi.fn<ProviderAdapter["send"]>().mockResolvedValue({ status: "skipped", code: "template_not_approved" });
    const email = vi.fn<ProviderAdapter["send"]>().mockResolvedValue({ status: "sent", providerMessageId: "fake-2" });
    const { tenantDb, statements } = fakeTenantDb();
    expect(await providerSink({ whatsapp: { send: whatsapp }, email: { send: email } }).deliver(tenantDb, { ...outgoing, channel: "whatsapp" }, now)).toBe("delivered");
    expect(email).toHaveBeenCalledWith(expect.objectContaining({ channel: "email", idempotencyKey: "email:abc123" }));
    const inserts = statements.filter((statement) => statement.text.startsWith("insert into notifications"));
    expect(inserts[0]?.values).toEqual(expect.arrayContaining(["whatsapp", "cancelled", "template_not_approved"]));
    expect(inserts[1]?.values).toEqual(expect.arrayContaining(["email", "sending"]));
  });

  it("does not move a campaign message or a test send to email", async () => {
    const whatsapp = vi.fn<ProviderAdapter["send"]>().mockResolvedValue({ status: "skipped", code: "template_not_approved" });
    const email = vi.fn<ProviderAdapter["send"]>();
    const sink = providerSink({ whatsapp: { send: whatsapp }, email: { send: email } });
    await sink.deliver(fakeTenantDb().tenantDb, { ...outgoing, channel: "whatsapp", message: { ...outgoing.message, templateKey: "campaign.message" } }, now);
    await sink.deliver(fakeTenantDb().tenantDb, { ...outgoing, channel: "whatsapp", testRecipientPhone: "+910000000000" }, now);
    expect(email).not.toHaveBeenCalled();
  });

  it("records a deliberately skipped message as not sent, with its reason, and finishes the event", async () => {
    const send = vi.fn<ProviderAdapter["send"]>().mockResolvedValue({ status: "skipped", code: "suppressed_bounced" });
    const { tenantDb, statements } = fakeTenantDb();
    expect(await providerSink({ email: { send } }).deliver(tenantDb, outgoing, now)).toBe("delivered");
    const insert = statements.find((statement) => statement.text.startsWith("insert into notifications"));
    expect(insert?.values).toContain("cancelled");
    expect(insert?.values).toContain("suppressed_bounced");
  });

  it("does not send again once a message is on its way", async () => {
    const send = vi.fn<ProviderAdapter["send"]>();
    const { tenantDb } = fakeTenantDb("sending");
    expect(await providerSink({ email: { send } }).deliver(tenantDb, outgoing, now)).toBe("duplicate");
    expect(send).not.toHaveBeenCalled();
  });

  it("passes a provider's retry back to the worker and keeps codes short and safe", async () => {
    const retry = vi.fn<ProviderAdapter["send"]>().mockResolvedValue({ status: "retry", code: "rate_limited" });
    expect(await providerSink({ email: { send: retry } }).deliver(fakeTenantDb().tenantDb, outgoing, now)).toEqual({ outcome: "retry", code: "rate_limited" });
    const rejected = vi.fn<ProviderAdapter["send"]>().mockResolvedValue({ status: "rejected", code: "Bad address: someone@example.com" });
    expect(await providerSink({ email: { send: rejected } }).deliver(fakeTenantDb().tenantDb, outgoing, now)).toEqual({ outcome: "dead", code: "provider_error" });
  });
});
