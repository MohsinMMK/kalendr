/** @vitest-environment node */

import { randomUUID } from "node:crypto";

import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { isolatedDatabaseReady } from "@/test/isolated-database";
import { createBooking, createCustomer, createTenant, revokeWorkerOnlyFunctions, staffContext } from "@/test/privacy-fixture";

vi.mock("server-only", () => ({}));

import { createPortalRequest } from "@/server/privacy/portal";
import { decideRequest, listStaffRequests } from "@/server/privacy/requests";
import { processNextOutboxEvent } from "@/worker/outbox-worker";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const describeLocal = isolatedDatabaseReady(runtimeUrl, ownerUrl, workerUrl) ? describe : describe.skip;

describeLocal("erasure in PostgreSQL", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  let runtime: postgres.Sql;

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 2, prepare: false, onnotice: () => undefined });
    worker = postgres(workerUrl!, { max: 2, prepare: false, onnotice: () => undefined });
    runtime = postgres(runtimeUrl!, { max: 2, prepare: false, onnotice: () => undefined });
    await revokeWorkerOnlyFunctions(owner, runtime);
  });
  afterAll(async () => {
    await Promise.all([owner.end(), worker.end(), runtime.end()]);
  });

  it("(c) removes the name and phone everywhere except the retained payment, and keeps the audit trail whole", async () => {
    const f = await createTenant(owner, "erase");
    const tenantId = f.tenantId;
    const customer = await createCustomer(owner, tenantId);
    const other = await createCustomer(owner, tenantId);
    const fullName = `${customer.firstName} ${customer.lastName}`;
    const needles = [customer.firstName, customer.lastName, customer.phone, customer.email];

    // What the business holds about this customer.
    const bookingId = await createBooking(owner, f, customer.id, { notes: `${fullName} is nervous about needles` });
    const otherBookingId = await createBooking(owner, f, other.id, { notes: "Unrelated note" });
    await owner`insert into payments (tenant_id, appointment_id, amount_minor, currency, method) values (${tenantId}, ${bookingId}, 50000, 'INR', 'upi')`;
    // A link retired by a move still shows the booking's new time, so erasure has to remove it.
    await owner`insert into retired_manage_tokens (tenant_id, token_hash, appointment_id, patient_id) values (${tenantId}, ${randomUUID().replaceAll("-", "").padEnd(64, "0")}, ${bookingId}, ${customer.id})`;
    await owner`
      insert into forms (tenant_id, appointment_id, patient_id, definition_key, definition_version, status, response_ciphertext)
      values (${tenantId}, ${bookingId}, ${customer.id}, 'intake', 1, 'submitted', ${`answers from ${fullName}`})`;
    // A routing form answer (feature 46) that names the customer: erasure must clear it too, and the scan below proves it.
    const [routingForm] = await owner<{ id: string }[]>`insert into routing_forms (tenant_id, name, slug, definition) values (${tenantId}, 'Which visit', 'which-visit', '{}'::jsonb) returning id`;
    await owner`insert into routing_form_versions (tenant_id, form_id, version, name, definition) values (${tenantId}, ${routingForm!.id}, 1, 'Which visit', '{}'::jsonb)`;
    await owner`
      insert into routing_responses (tenant_id, form_id, form_version, token_hash, answers_ciphertext, patient_id, appointment_id, outcome, expires_at, answered_at)
      values (${tenantId}, ${routingForm!.id}, 1, ${randomUUID().replaceAll("-", "").padEnd(64, "0")}, ${`routing answers from ${fullName} ${customer.email}`}, ${customer.id}, ${bookingId}, 'booked', now() + interval '1 day', now())`;
    await owner`
      insert into reviews (tenant_id, appointment_id, practitioner_id, service_id, rating, comment, display_name)
      values (${tenantId}, ${bookingId}, ${f.practitionerId}, ${f.serviceId}, 5, ${`${fullName} was happy`}, ${`${customer.firstName} ${customer.lastName.slice(0, 1)}.`})`;
    await owner`insert into waitlist_entries (tenant_id, patient_id, service_id, location_id, date_from, date_to, time_preference) values (${tenantId}, ${customer.id}, ${f.serviceId}, ${f.locationId}, current_date, current_date + 7, 'any')`;
    await owner`insert into recalls (tenant_id, patient_id, service_id, due_at) values (${tenantId}, ${customer.id}, ${f.serviceId}, now() + interval '30 days')`;
    const [oldRecord] = await owner<{ id: string }[]>`
      insert into visit_records (tenant_id, patient_id, kind, title_ciphertext, body_ciphertext, created_at)
      values (${tenantId}, ${customer.id}, 'note', 'sealed', 'sealed', now() - interval '8 years') returning id`;
    await owner`insert into visit_records (tenant_id, patient_id, kind, title_ciphertext, body_ciphertext) values (${tenantId}, ${customer.id}, 'report', 'sealed', 'sealed')`;
    const oldFileKey = `tenant/${tenantId}/record/old-${randomUUID()}`;
    await owner`
      insert into visit_record_files (tenant_id, record_id, storage_key, name_ciphertext, content_type, byte_size, sha256)
      values (${tenantId}, ${oldRecord!.id}, ${oldFileKey}, 'sealed', 'application/pdf', 10, ${"a".repeat(64)})`;
    await owner`insert into outbox_events (tenant_id, aggregate_type, aggregate_id, event_type, payload, dedupe_key, status)
      values (${tenantId}, 'appointment', ${bookingId}, 'appointment.quick_message', ${owner.json({ text: `Hello ${fullName}` })}, ${`old-${randomUUID()}`}, 'delivered')`;
    await owner`insert into idempotency_keys (tenant_id, route, key, request_hash, response_body) values (${tenantId}, 'staff.some.route', ${`k-${randomUUID()}`}, 'h', ${owner.json({ customerName: fullName })})`;
    await owner`insert into consent_records (tenant_id, patient_id, purpose, granted, wording_version, source, actor_type) values (${tenantId}, ${customer.id}, 'marketing_messages', true, '2026-11', 'portal', 'patient')`;
    // Old activity-log rows that carry personal details, as older features wrote them.
    await owner`insert into audit_events (tenant_id, appointment_id, actor_type, actor_user_id, action, outcome, metadata)
      values (${tenantId}, ${bookingId}, 'staff', 'staff-1', 'appointment.edited', 'success', ${owner.json({ name: fullName, phone: customer.phone, version: 2 })})`;
    await owner`insert into audit_events (tenant_id, actor_type, actor_user_id, action, outcome, metadata)
      values (${tenantId}, 'staff', 'staff-1', 'legacy.call', 'success', ${owner.json({ text: `called ${fullName} on ${customer.phone}` })})`;
    await owner`insert into audit_events (tenant_id, appointment_id, actor_type, action, outcome, metadata)
      values (${tenantId}, ${otherBookingId}, 'staff', 'appointment.edited', 'success', ${owner.json({ name: `${other.firstName} ${other.lastName}` })})`;
    // A finished download request with its file, and the customer's portal sign-in.
    const [earlier] = await owner<{ id: string }[]>`insert into data_requests (tenant_id, patient_id, type, status, note) values (${tenantId}, ${customer.id}, 'export', 'completed', 'earlier') returning id`;
    const exportKey = `tenant/${tenantId}/export/${randomUUID()}`;
    await owner`insert into data_exports (tenant_id, request_id, storage_key, token_hash, expires_at, byte_size) values (${tenantId}, ${earlier!.id}, ${exportKey}, ${randomUUID().replaceAll("-", "").padEnd(64, "0")}, now() + interval '3 days', 10)`;
    const [account] = await owner<{ id: string }[]>`insert into patient_accounts (contact_kind, contact_value) values ('email', ${customer.email}) returning id`;
    await owner`insert into patient_record_access (tenant_id, patient_id, account_id, confirmed_at) values (${tenantId}, ${customer.id}, ${account!.id}, now())`;

    const auditBefore = await owner<{ id: string }[]>`select id from audit_events where tenant_id = ${tenantId}`;

    // The customer asks, staff approve (with a second-factor check), the worker does it.
    const portalAccount = { id: account!.id, contactKind: "email" as const, contactValue: customer.email };
    const { request } = await createPortalRequest(portalAccount, { clinicSlug: f.slug, patientId: customer.id, type: "erasure", note: "Please erase me" });
    const staff = staffContext(f);
    const decided = await decideRequest(staff, request.id, { decision: "approve", reason: "verified", version: request.version }, `approve-${randomUUID()}`);
    expect(decided).toMatchObject({ status: "approved", customerName: fullName });
    // Nothing has been changed yet: the web request only queued the work.
    expect((await owner<{ first_name: string }[]>`select first_name from patients where id = ${customer.id}`)[0]!.first_name).toBe(customer.firstName);

    const run = await processNextOutboxEvent(worker, { tenantId, workerId: "f7-erasure" });
    expect(run.kind).toBe("captured");
    if (run.kind !== "captured") throw new Error("not captured");
    expect(run.message.templateKey).toBe("privacy.erasure");
    const notice = JSON.parse(run.message.body) as { removed: string[]; kept: string[] };
    expect(notice.removed.join(" ")).toMatch(/phone number/);
    expect(notice.kept.join(" ")).toMatch(/Payment and refund records \(1\)/);
    expect(notice.kept.join(" ")).toMatch(/Visit notes and reports \(1\)/);
    expect(JSON.stringify(notice)).not.toContain(customer.firstName);

    // 1. Nothing personal is left in any table that belongs to the business, the activity log included.
    const tables = await owner<{ table_name: string }[]>`
      select table_name from information_schema.columns where table_schema = 'public' and column_name = 'tenant_id' order by table_name`;
    expect(tables.length).toBeGreaterThan(20);
    const leaks: string[] = [];
    for (const { table_name: table } of tables) {
      for (const needle of needles) {
        const found = await owner.unsafe<{ count: number }[]>(`select count(*)::int as count from "${table}" where tenant_id = $1 and "${table}"::text ilike $2`, [tenantId, `%${needle}%`]);
        if (found[0]!.count > 0) leaks.push(`${table}:${needle.slice(0, 6)}`);
      }
    }
    expect(leaks).toEqual([]);
    expect(await owner`select 1 from patient_accounts where id = ${account!.id}`).toHaveLength(0);

    // 2. What the law requires is kept: the payment, and the recent record. The expired record and files were removed.
    const [payment] = await owner<{ amount_minor: number }[]>`select amount_minor from payments where tenant_id = ${tenantId}`;
    expect(payment!.amount_minor).toBe(50000);
    const records = await owner<{ kind: string }[]>`select kind from visit_records where tenant_id = ${tenantId} and patient_id = ${customer.id}`;
    expect(records).toEqual([{ kind: "report" }]);
    const removals = await owner<{ aggregate_id: string }[]>`select aggregate_id from outbox_events where tenant_id = ${tenantId} and event_type = 'file.remove'`;
    expect(removals.map((row) => row.aggregate_id).sort()).toEqual([exportKey, oldFileKey].sort());

    // 3. The customer row stays, anonymised; other customers are untouched; the booking dates stay.
    const [erased] = await owner<{ first_name: string; phone: string; erased_at: Date | null; date_of_birth: string | null }[]>`select first_name, phone, erased_at, date_of_birth from patients where id = ${customer.id}`;
    expect(erased).toMatchObject({ first_name: "Erased", phone: "erased", date_of_birth: null });
    expect(erased!.erased_at).not.toBeNull();
    const [kept] = await owner<{ first_name: string }[]>`select first_name from patients where id = ${other.id}`;
    expect(kept!.first_name).toBe(other.firstName);
    expect(await owner`select 1 from appointments where id = ${bookingId}`).toHaveLength(1);
    expect(await owner`select 1 from retired_manage_tokens where appointment_id = ${bookingId}`).toHaveLength(0);
    expect((await owner<{ notes: string | null }[]>`select notes from appointments where id = ${otherBookingId}`)[0]!.notes).toBe("Unrelated note");
    expect((await owner<{ name: string }[]>`select metadata ->> 'name' as name from audit_events where appointment_id = ${otherBookingId}`)[0]!.name).toBe(`${other.firstName} ${other.lastName}`);

    // 4. The audit log lost no row, shows who approved, and has the personal fields replaced.
    const auditAfter = await owner<{ id: string }[]>`select id from audit_events where tenant_id = ${tenantId}`;
    const afterIds = new Set(auditAfter.map((row) => row.id));
    expect(auditBefore.every((row) => afterIds.has(row.id))).toBe(true);
    expect(auditAfter.length).toBeGreaterThan(auditBefore.length);
    const approval = await owner<{ actor_user_id: string; actor_type: string }[]>`select actor_user_id, actor_type from audit_events where tenant_id = ${tenantId} and action = 'privacy.request.approved'`;
    expect(approval).toEqual([{ actor_user_id: staff.userId, actor_type: "staff" }]);
    const scrubbed = await owner<{ metadata: Record<string, unknown> }[]>`select metadata from audit_events where tenant_id = ${tenantId} and action in ('appointment.edited', 'legacy.call') and (appointment_id = ${bookingId} or appointment_id is null)`;
    expect(JSON.stringify(scrubbed)).toContain("[erased]");
    expect(scrubbed.find((row) => row.metadata.version === 2)!.metadata).toMatchObject({ name: "[erased]", phone: "[erased]", version: 2 });
    expect(await owner`select 1 from audit_events where tenant_id = ${tenantId} and action = 'privacy.erasure.completed'`).toHaveLength(1);

    // 5. The customer's own account of it, and the staff view of it.
    const [done] = await owner<{ status: string; result_summary: { removed: string[]; kept: string[] }; note: string | null; completed_at: Date | null }[]>`
      select status, result_summary, note, completed_at from data_requests where id = ${request.id}`;
    expect(done).toMatchObject({ status: "completed", note: null });
    expect(done!.result_summary.kept.join(" ")).toMatch(/Payment/);
    const view = (await listStaffRequests(staff, { status: "closed" })).requests.find((row) => row.id === request.id);
    expect(view).toMatchObject({ status: "completed", customerName: "Erased customer", daysRemaining: null });
    expect(view!.summary!.removed.length).toBeGreaterThan(1);
    // The consent history survives, with no name on it.
    expect(await owner`select 1 from consent_records where patient_id = ${customer.id}`).not.toHaveLength(0);
  });

  it("lets only the worker role scrub the audit log, and only for an approved erasure", async () => {
    const f = await createTenant(owner, "scrub");
    const customer = await createCustomer(owner, f.tenantId);
    const [pending] = await owner<{ id: string }[]>`insert into data_requests (tenant_id, patient_id, type) values (${f.tenantId}, ${customer.id}, 'erasure') returning id`;
    await owner`insert into audit_events (tenant_id, actor_type, action, outcome, metadata) values (${f.tenantId}, 'staff', 'legacy.note', 'success', ${owner.json({ text: `about ${customer.firstName} ${customer.lastName}` })})`;
    const call = (db: postgres.Sql, requestId: string) => db.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${f.tenantId}, true)`;
      return tx`select kalendr_scrub_audit_personal(${requestId}, ${[`${customer.firstName} ${customer.lastName}`]})`;
    });
    await expect(call(runtime, pending!.id)).rejects.toMatchObject({ code: "42501" });
    await expect(call(worker, pending!.id)).rejects.toMatchObject({ code: "42501" });
    await expect(call(worker, "no-such-request")).rejects.toMatchObject({ code: "42501" });
    await owner`update data_requests set status = 'approved' where id = ${pending!.id}`;
    await expect(call(worker, pending!.id)).resolves.toBeDefined();
    expect(JSON.stringify(await owner`select metadata from audit_events where tenant_id = ${f.tenantId} and action = 'legacy.note'`)).toContain("[erased]");
    // Neither role can edit or delete audit rows by hand.
    await expect(worker`update audit_events set metadata = '{}'::jsonb where tenant_id = ${f.tenantId}`).rejects.toMatchObject({ code: "42501" });
    await expect(runtime`delete from audit_events where tenant_id = ${f.tenantId}`).rejects.toMatchObject({ code: "42501" });
  });
});
