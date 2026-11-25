/** @vitest-environment node */
import { describe, expect, it } from "vitest";

import { createFakeEmailProvider } from "../server/messaging/email-fake";
import { sealManageToken } from "../server/messaging/sealed-link";
import type { ProviderSendRequest } from "./delivery";
import { appointmentTemplateFor, createEmailAdapter, emailWhen } from "./email-adapter";
import type { TenantDb } from "./handlers";

const tenantId = "00000000-0000-4000-8000-000000000001";
const appointmentId = "00000000-0000-4000-8000-000000000002";
const patientId = "00000000-0000-4000-8000-000000000003";

interface Rows {
  tenant?: Record<string, unknown>;
  patient?: Record<string, unknown>;
  appointment?: Record<string, unknown>;
  suppressed?: string;
}

/** Answers the adapter's four reads by what each statement starts with. */
function fakeTenantDb(rows: Rows) {
  const statements: string[] = [];
  const tenantDb = ((strings: TemplateStringsArray) => {
    const text = strings.join("?").replace(/\s+/g, " ").trim();
    statements.push(text);
    if (text.includes("from tenants")) return Promise.resolve(rows.tenant ? [rows.tenant] : []);
    if (text.includes("from patients")) return Promise.resolve(rows.patient ? [rows.patient] : []);
    if (text.includes("from appointments")) return Promise.resolve(rows.appointment ? [rows.appointment] : []);
    if (text.includes("from message_suppressions")) return Promise.resolve(rows.suppressed ? [{ reason: rows.suppressed }] : []);
    return Promise.resolve([]);
  });
  // The rating link (feature 51) reads through the shared query runner: a finished visit, no review yet, nobody asked this month.
  const unsafe = (text: string) => Promise.resolve(text.includes("from appointments a") ? [{ status: "completed", ends_at: new Date("2026-12-14T05:30:00Z"), patient_id: "p1" }] : []);
  return { tenantDb: Object.assign(tenantDb, { unsafe }) as unknown as TenantDb, statements };
}

const tenant = {
  name: "Lotus Dental Studio",
  slug: "lotus-dental",
  email: "front-desk@lotus.example",
  phone: "+91 20 5555 0100",
  timezone: "Asia/Kolkata",
  business_type: "dental",
  terminology: {},
  features: {},
  logo_id: "00000000-0000-4000-8000-0000000000aa",
};
const appointment = {
  id: appointmentId,
  version: 1,
  status: "booked",
  starts_at: new Date("2026-12-14T05:00:00Z"),
  ends_at: new Date("2026-12-14T05:30:00Z"),
  clinic_moved_from: null,
  manage_token_ciphertext: sealManageToken(tenantId, appointmentId, "manage-token-1"),
  service_name: "Dental check-up",
  practitioner_name: "Dr. Asha Rao",
  location_name: "Main branch",
  location_address: "12 MG Road",
  location_city: "Pune",
  location_timezone: "Asia/Kolkata",
};

function request(tenantDb: TenantDb, templateKey = "appointment.created"): ProviderSendRequest {
  return { tenantDb, tenantId, appointmentId, patientId, channel: "email", templateKey, body: "", idempotencyKey: "email:semantic-1" };
}

const options = { origin: "https://app.kalendr.example", fallbackReplyTo: "help@kalendr.example" };

describe("email adapter", () => {
  it("sends a branded booking email with the calendar file, the manage link and the semantic key", async () => {
    const provider = createFakeEmailProvider();
    const { tenantDb } = fakeTenantDb({ tenant, patient: { first_name: "Priya", email: "priya@example.com" }, appointment });
    const result = await createEmailAdapter({ provider, ...options }).send(request(tenantDb));
    expect(result).toEqual({ status: "sent", providerMessageId: "fake-email-1" });
    const [sent] = provider.sent;
    expect(sent).toMatchObject({ to: "priya@example.com", fromName: "Lotus Dental Studio", replyTo: "front-desk@lotus.example", idempotencyKey: "email:semantic-1" });
    expect(sent!.subject).toContain("Lotus Dental Studio");
    expect(sent!.text).toContain("https://app.kalendr.example/manage/manage-token-1");
    expect(sent!.html).toContain("https://app.kalendr.example/api/public/media/lotus-dental/");
    expect(sent!.attachments?.[0]?.filename).toBe("appointment.ics");
    expect(sent!.attachments?.[0]?.content).toContain("BEGIN:VCALENDAR");
    expect(sent!.attachments?.[0]?.content).toContain("Dental check-up");
  });

  it("sends a retried message with the same key, so the provider sends it once", async () => {
    const provider = createFakeEmailProvider();
    const { tenantDb } = fakeTenantDb({ tenant, patient: { first_name: "Priya", email: "priya@example.com" }, appointment });
    const adapter = createEmailAdapter({ provider, ...options });
    provider.failNext("transient");
    expect(await adapter.send(request(tenantDb))).toEqual({ status: "retry", code: "fake_unavailable" });
    await adapter.send(request(tenantDb));
    await adapter.send(request(tenantDb));
    expect(provider.attempts).toBe(3);
    expect(provider.sent).toHaveLength(1);
  });

  it("checks the suppression list before sending", async () => {
    const provider = createFakeEmailProvider();
    const { tenantDb } = fakeTenantDb({ tenant, patient: { first_name: "Priya", email: "priya@example.com" }, appointment, suppressed: "bounced" });
    expect(await createEmailAdapter({ provider, ...options }).send(request(tenantDb))).toEqual({ status: "skipped", code: "suppressed_bounced" });
    expect(provider.attempts).toBe(0);
  });

  it("skips a customer with no email, and falls back to the platform Reply-To", async () => {
    const provider = createFakeEmailProvider();
    const none = fakeTenantDb({ tenant, patient: { first_name: "Priya", email: null }, appointment });
    expect(await createEmailAdapter({ provider, ...options }).send(request(none.tenantDb))).toEqual({ status: "skipped", code: "no_destination" });
    const noBusinessEmail = fakeTenantDb({ tenant: { ...tenant, email: null }, patient: { first_name: "Priya", email: "priya@example.com" }, appointment });
    await createEmailAdapter({ provider, ...options }).send(request(noBusinessEmail.tenantDb));
    expect(provider.sent[0]?.replyTo).toBe("help@kalendr.example");
  });

  it("turns a permanent refusal into a dead letter with a short code", async () => {
    const provider = createFakeEmailProvider();
    provider.failNext("permanent");
    const { tenantDb } = fakeTenantDb({ tenant, patient: { first_name: "Priya", email: "priya@example.com" }, appointment });
    expect(await createEmailAdapter({ provider, ...options }).send(request(tenantDb))).toEqual({ status: "rejected", code: "fake_refused" });
  });

  it("sends the cancellation with a book-again link, and a review request without a calendar file", async () => {
    const provider = createFakeEmailProvider();
    const { tenantDb } = fakeTenantDb({ tenant, patient: { first_name: "Priya", email: "priya@example.com" }, appointment: { ...appointment, status: "cancelled" } });
    await createEmailAdapter({ provider, ...options }).send(request(tenantDb, "appointment.cancel"));
    expect(provider.sent[0]!.text).toContain("https://app.kalendr.example/book/lotus-dental");
    await createEmailAdapter({ provider, ...options }).send({ ...request(tenantDb, "appointment.review_request"), idempotencyKey: "email:review" });
    expect(provider.sent[1]!.attachments).toBeUndefined();
    expect(provider.sent[1]!.text).toMatch(/https:\/\/app\.kalendr\.example\/r\/[A-Za-z0-9_-]{43}/);
  });
});

describe("appointmentTemplateFor", () => {
  it("picks the email for each booking event", () => {
    const booked = { status: "booked" as const, clinic_moved_from: null };
    expect(appointmentTemplateFor("appointment.created", booked)).toBe("booking_confirmed");
    expect(appointmentTemplateFor("appointment.created", { ...booked, status: "requested" })).toBe("request_received");
    expect(appointmentTemplateFor("appointment.status.booked", booked)).toBe("request_approved");
    expect(appointmentTemplateFor("appointment.reschedule", booked)).toBe("rescheduled");
    expect(appointmentTemplateFor("appointment.reschedule", { ...booked, clinic_moved_from: new Date() })).toBe("moved_by_business");
    expect(appointmentTemplateFor("appointment.cancel", booked)).toBe("cancelled");
    expect(appointmentTemplateFor("appointment.status.completed", booked)).toBeNull();
    expect(appointmentTemplateFor("appointment.status.declined", { ...booked, status: "declined" as const })).toBe("request_declined");
    expect(appointmentTemplateFor("appointment.status.expired", { ...booked, status: "expired" as const })).toBe("request_expired");
    expect(appointmentTemplateFor("appointment.reschedule_requested", { ...booked, status: "reschedule_requested" as const })).toBe("reschedule_requested");
  });
});

describe("emailWhen", () => {
  it("writes the time in the place's own time zone", () => {
    expect(emailWhen(new Date("2026-12-14T05:00:00Z"), "Asia/Kolkata")).toMatch(/Mon, 14 Dec,? 2026, 10:30 am IST/i);
  });
});
