/** @vitest-environment node */

import { createHash, randomUUID } from "node:crypto";

import { strFromU8, unzipSync } from "fflate";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { isolatedDatabaseReady } from "@/test/isolated-database";
import { createBooking, createCustomer, createTenant, revokeWorkerOnlyFunctions, staffContext, type TenantFixture } from "@/test/privacy-fixture";

vi.mock("server-only", () => ({}));

import { requireFreshPatientSession, type PatientAccount } from "@/server/patient-auth";
import { canSendMarketing, currentConsents, hasConsent, recordConsent, withdrawConsent } from "@/server/privacy/consent";
import { canSendMarketingTenantDb } from "@/server/privacy/gate";
import { consumeExportDownload, createPortalRequest, getPortalPrivacy, setPortalConsent } from "@/server/privacy/portal";
import { decideRequest, listStaffRequests } from "@/server/privacy/requests";
import { getRetentionSettings, saveRetentionSettings } from "@/server/privacy/retention-settings";
import { listBreachAffected } from "@/server/privacy/breach";
import { processNextOutboxEvent } from "@/worker/outbox-worker";
import { alertOverduePrivacyRequests, applyPrivacyRetention } from "@/worker/jobs";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const workerUrl = process.env.WORKER_DATABASE_URL;
const describeLocal = isolatedDatabaseReady(runtimeUrl, ownerUrl, workerUrl) ? describe : describe.skip;

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

describeLocal("privacy centre in PostgreSQL", () => {
  let owner: postgres.Sql;
  let worker: postgres.Sql;
  let runtime: postgres.Sql;
  let a: TenantFixture;
  let b: TenantFixture;

  /** Runs work as a database role inside one business's row-level scope. */
  const scoped = <T>(sql: postgres.Sql, tenantId: string, work: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> =>
    sql.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${tenantId}, true)`;
      return work(tx);
    }) as Promise<T>;

  async function accountFor(email: string): Promise<PatientAccount> {
    const [row] = await owner<{ id: string }[]>`
      insert into patient_accounts (contact_kind, contact_value) values ('email', ${email}) returning id`;
    return { id: row!.id, contactKind: "email", contactValue: email };
  }

  async function runWorker(tenantId: string) {
    return processNextOutboxEvent(worker, { tenantId, workerId: `f7-${randomUUID().slice(0, 6)}` });
  }

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 2, prepare: false, onnotice: () => undefined });
    worker = postgres(workerUrl!, { max: 2, prepare: false, onnotice: () => undefined });
    runtime = postgres(runtimeUrl!, { max: 2, prepare: false, onnotice: () => undefined });
    await revokeWorkerOnlyFunctions(owner, runtime);
    a = await createTenant(owner, "a");
    b = await createTenant(owner, "b");
  });

  afterAll(async () => {
    await Promise.all([owner.end(), worker.end(), runtime.end()]);
  });

  it("(a) gives a customer their own data, in a link that works once and then expires", async () => {
    const customer = await createCustomer(owner, a.tenantId);
    await createBooking(owner, a, customer.id, { notes: "Prefers early mornings" });
    const [booking] = await owner<{ id: string }[]>`select id from appointments where tenant_id = ${a.tenantId} and patient_id = ${customer.id}`;
    await owner`insert into payments (tenant_id, appointment_id, amount_minor, currency, method) values (${a.tenantId}, ${booking!.id}, 50000, 'INR', 'cash')`;
    const account = await accountFor(customer.email);

    const created = await createPortalRequest(account, { clinicSlug: a.slug, patientId: customer.id, type: "export" });
    expect(created).toMatchObject({ created: true, request: { type: "export", status: "approved" } });

    const run = await runWorker(a.tenantId);
    expect(run.kind).toBe("captured");
    if (run.kind !== "captured") throw new Error("not captured");
    expect(run.message.templateKey).toBe("privacy.export");
    const { url, validDays } = JSON.parse(run.message.body) as { url: string; validDays: number };
    expect(validDays).toBe(7);
    const token = url.split("/").at(-1)!;

    // Only the hash of the token is stored, and the file is stored encrypted.
    const [stored] = await owner<{ token_hash: string; storage_key: string; expires_at: Date }[]>`select token_hash, storage_key, expires_at from data_exports where tenant_id = ${a.tenantId}`;
    expect(stored!.token_hash).toBe(sha(token));
    expect(JSON.stringify(stored)).not.toContain(token);
    const days = (stored!.expires_at.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);

    const download = await consumeExportDownload(token);
    const files = unzipSync(new Uint8Array(download.bytes));
    const json = JSON.parse(strFromU8(files["data.json"]!)) as { profile: { first_name: string; phone: string }; appointments: { notes: string }[]; payments: { amount_minor: number }[] };
    expect(json.profile).toMatchObject({ first_name: customer.firstName, phone: customer.phone });
    expect(json.appointments[0]!.notes).toBe("Prefers early mornings");
    expect(json.payments[0]!.amount_minor).toBe(50000);
    expect(strFromU8(files["summary.pdf"]!).startsWith("%PDF-")).toBe(true);

    // Once only.
    await expect(consumeExportDownload(token)).rejects.toMatchObject({ status: 410, code: "link_expired" });
    await expect(consumeExportDownload("x".repeat(43))).rejects.toMatchObject({ status: 410 });
    const [request] = await owner<{ status: string }[]>`select status from data_requests where id = ${created.request.id}`;
    expect(request!.status).toBe("completed");

    // Seven days later the same kind of link no longer works.
    const second = await createCustomer(owner, a.tenantId);
    const secondAccount = await accountFor(second.email);
    await createPortalRequest(secondAccount, { clinicSlug: a.slug, patientId: second.id, type: "export" });
    const secondRun = await runWorker(a.tenantId);
    if (secondRun.kind !== "captured") throw new Error("not captured");
    const secondToken = (JSON.parse(secondRun.message.body) as { url: string }).url.split("/").at(-1)!;
    await owner`update data_exports set expires_at = now() - interval '1 minute' where token_hash = ${sha(secondToken)}`;
    await expect(consumeExportDownload(secondToken)).rejects.toMatchObject({ status: 410 });
  });

  it("asks for a fresh sign-in code before an export or erasure", async () => {
    const account = await accountFor(`fresh-${randomUUID().slice(0, 6)}@example.com`);
    const old = `old-${randomUUID()}`;
    const fresh = `new-${randomUUID()}`;
    await owner`insert into patient_sessions (account_id, token_hash, expires_at, created_at) values (${account.id}, ${sha(old)}, now() + interval '1 day', now() - interval '1 hour')`;
    await owner`insert into patient_sessions (account_id, token_hash, expires_at) values (${account.id}, ${sha(fresh)}, now() + interval '1 day')`;
    await expect(requireFreshPatientSession(new Headers({ cookie: `kalendr_patient=${old}` }), 15)).rejects.toMatchObject({ status: 403, code: "fresh_code_required" });
    await expect(requireFreshPatientSession(new Headers(), 15)).rejects.toMatchObject({ code: "fresh_code_required" });
    await expect(requireFreshPatientSession(new Headers({ cookie: `kalendr_patient=${fresh}` }), 15)).resolves.toBeUndefined();
  });

  it("(b) withdrawing marketing stops campaigns but not appointment messages", async () => {
    const customer = await createCustomer(owner, a.tenantId);
    expect(await canSendMarketing(a.tenantId, customer.id)).toBe(false);
    expect(await hasConsent(a.tenantId, customer.id, "appointment_messages")).toBe(true);

    await recordConsent(a.tenantId, { patientId: customer.id, purpose: "marketing_messages", granted: true, source: "portal", actor: { type: "patient" } });
    expect(await canSendMarketing(a.tenantId, customer.id)).toBe(true);
    expect(await worker.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenantId}, true)`;
      return canSendMarketingTenantDb(tx, a.tenantId, customer.id);
    })).toBe(true);

    expect(await withdrawConsent(a.tenantId, customer.id, "marketing_messages", { source: "whatsapp_stop" })).toEqual({ changed: true });
    expect(await canSendMarketing(a.tenantId, customer.id)).toBe(false);
    expect(await worker.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${a.tenantId}, true)`;
      return canSendMarketingTenantDb(tx, a.tenantId, customer.id);
    })).toBe(false);
    // Reminders and booking messages still pass.
    expect(await hasConsent(a.tenantId, customer.id, "appointment_messages")).toBe(true);
    // A repeated STOP is not a new row.
    expect(await withdrawConsent(a.tenantId, customer.id, "marketing_messages", { source: "whatsapp_stop" })).toEqual({ changed: false });

    const rows = await owner<{ granted: boolean; source: string; actor_type: string; wording_version: string }[]>`
      select granted, source, actor_type, wording_version from consent_records where patient_id = ${customer.id} and purpose = 'marketing_messages' order by created_at`;
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ granted: false, source: "whatsapp_stop", actor_type: "provider" });
    expect(rows[0]!.wording_version).toMatch(/^\d{4}-\d{2}$/);

    // Withdrawing appointment messages switches the quick lookup off too, and the audit trail has no free text.
    await recordConsent(a.tenantId, { patientId: customer.id, purpose: "appointment_messages", granted: false, source: "portal", actor: { type: "patient" } });
    const [patient] = await owner<{ messaging_consent_at: Date | null }[]>`select messaging_consent_at from patients where id = ${customer.id}`;
    expect(patient!.messaging_consent_at).toBeNull();
    const states = await currentConsents(a.tenantId, customer.id);
    expect(states.find((state) => state.purpose === "appointment_messages")).toMatchObject({ granted: false, answered: true });
  });

  it("(e) refuses to change or remove a consent record, for every role", async () => {
    const customer = await createCustomer(owner, a.tenantId);
    await recordConsent(a.tenantId, { patientId: customer.id, purpose: "reviews", granted: false, source: "portal", actor: { type: "patient" } });
    const refused = /never changed or removed/;
    await expect(scoped(runtime, a.tenantId, (tx) => tx`update consent_records set granted = true where patient_id = ${customer.id}`)).rejects.toThrow(refused);
    await expect(scoped(runtime, a.tenantId, (tx) => tx`delete from consent_records where patient_id = ${customer.id}`)).rejects.toThrow(refused);
    await expect(scoped(worker, a.tenantId, (tx) => tx`update consent_records set granted = true where patient_id = ${customer.id}`)).rejects.toThrow(refused);
    await expect(scoped(worker, a.tenantId, (tx) => tx`delete from consent_records where patient_id = ${customer.id}`)).rejects.toThrow(refused);
    // The owner role is refused too, and so is anyone who sets the escape flag themselves without being the owner.
    await expect(scoped(owner, a.tenantId, (tx) => tx`update consent_records set granted = true where patient_id = ${customer.id}`)).rejects.toThrow(refused);
    await expect(scoped(owner, a.tenantId, (tx) => tx`delete from consent_records where patient_id = ${customer.id}`)).rejects.toThrow(refused);
    await expect(scoped(runtime, a.tenantId, async (tx) => {
      await tx`select set_config('kalendr.consent_erase', 'on', true)`;
      await tx`delete from consent_records where patient_id = ${customer.id}`;
    })).rejects.toThrow(refused);
    const [counted] = await owner<{ count: number }[]>`select count(*)::int as count from consent_records where patient_id = ${customer.id}`;
    const count = counted!.count;
    expect(count).toBe(1);

    // Only the erasure function removes them, and only for the business in scope and only the worker may call it.
    await expect(scoped(runtime, a.tenantId, (tx) => tx`select kalendr_erase_consent_records(${a.tenantId}, ${customer.id})`)).rejects.toMatchObject({ code: "42501" });
    await expect(scoped(worker, b.tenantId, (tx) => tx`select kalendr_erase_consent_records(${a.tenantId}, ${customer.id})`)).rejects.toMatchObject({ code: "42501" });
    const [erased] = await scoped(worker, a.tenantId, (tx) => tx<{ removed: number }[]>`select kalendr_erase_consent_records(${a.tenantId}, ${customer.id}) as removed`);
    expect(erased!.removed).toBe(1);
  });

  it("(f) keeps every new table private to its own business", async () => {
    const customerA = await createCustomer(owner, a.tenantId);
    const [request] = await owner<{ id: string }[]>`
      insert into data_requests (tenant_id, patient_id, type, requested_via) values (${a.tenantId}, ${customerA.id}, 'correction', 'portal') returning id`;
    await recordConsent(a.tenantId, { patientId: customerA.id, purpose: "reviews", granted: false, source: "portal", actor: { type: "patient" } });
    await owner`insert into privacy_notices (tenant_id, version, language, purposes) values (${a.tenantId}, ${`v-${randomUUID().slice(0, 6)}`}, 'en', '{}'::jsonb)`;
    await owner`insert into retention_policies (tenant_id, data_kind, keep_days, action) values (${a.tenantId}, 'message_log', 100, 'delete') on conflict do nothing`;
    const [exportRequest] = await owner<{ id: string }[]>`
      insert into data_requests (tenant_id, patient_id, type, status) values (${a.tenantId}, ${customerA.id}, 'export', 'completed') returning id`;
    await owner`insert into data_exports (tenant_id, request_id, storage_key, token_hash, expires_at, byte_size) values (${a.tenantId}, ${exportRequest!.id}, 'tenant/x/export/y', ${sha(randomUUID())}, now() + interval '1 day', 10)`;

    for (const table of ["consent_records", "privacy_notices", "data_requests", "data_exports", "retention_policies"]) {
      const seenByB = await scoped(runtime, b.tenantId, (tx) => tx.unsafe<{ count: number }[]>(`select count(*)::int as count from ${table} where tenant_id = '${a.tenantId}'`));
      expect(seenByB[0]!.count, `${table} leaks to another business`).toBe(0);
      const seenByA = await scoped(runtime, a.tenantId, (tx) => tx.unsafe<{ count: number }[]>(`select count(*)::int as count from ${table} where tenant_id = '${a.tenantId}'`));
      expect(seenByA[0]!.count, `${table} is empty for its own business`).toBeGreaterThan(0);
    }
    // B cannot write A's rows, change them or remove them.
    await expect(scoped(runtime, b.tenantId, (tx) => tx`insert into retention_policies (tenant_id, data_kind, keep_days, action) values (${a.tenantId}, 'finished_outbox', 10, 'delete')`)).rejects.toThrow();
    expect((await scoped(runtime, b.tenantId, (tx) => tx`update data_requests set note = 'x' where tenant_id = ${a.tenantId} returning id`)).length).toBe(0);
    expect((await scoped(runtime, b.tenantId, (tx) => tx`delete from retention_policies where tenant_id = ${a.tenantId} returning id`)).length).toBe(0);

    // The staff functions agree.
    const staffB = staffContext(b);
    const listed = await listStaffRequests(staffB, { status: "all" });
    expect(listed.requests.map((row) => row.id)).not.toContain(request!.id);
    await expect(decideRequest(staffB, request!.id, { decision: "refuse", reason: "duplicate", version: 1 }, `key-${randomUUID()}`)).rejects.toMatchObject({ status: 404 });
    const settingsB = await getRetentionSettings(staffB);
    expect(settingsB.policies.find((policy) => policy.dataKind === "message_log")).toMatchObject({ keepDays: 365, isDefault: true });
    await expect(listStaffRequests(staffContext(a, { role: "receptionist", permissions: ["appointments.book"] }), { status: "all" })).rejects.toMatchObject({ status: 403 });
  });

  it("(g) a double click asks once and decides once", async () => {
    const f = await createTenant(owner, "double");
    const customer = await createCustomer(owner, f.tenantId);
    const account = await accountFor(customer.email);
    const input = { clinicSlug: f.slug, patientId: customer.id, type: "erasure" as const, note: "Please remove me" };
    const [first, second] = await Promise.all([createPortalRequest(account, input), createPortalRequest(account, input)]);
    expect(first.request.id).toBe(second.request.id);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    const [counted] = await owner<{ count: number }[]>`select count(*)::int as count from data_requests where tenant_id = ${f.tenantId}`;
    const count = counted!.count;
    expect(count).toBe(1);

    const staff = staffContext(f);
    const key = `decide-${randomUUID()}`;
    const decision = { decision: "approve" as const, reason: "verified" as const, version: first.request.version };
    const [one, two] = await Promise.all([decideRequest(staff, first.request.id, decision, key), decideRequest(staff, first.request.id, decision, key)].map((promise) => promise.catch((error: unknown) => error)));
    // One wins; the other either replays the same answer or is told it lost the race. Never two decisions.
    const results = [one, two];
    expect(results.filter((result) => (result as { status?: string }).status === "approved")).not.toHaveLength(0);
    const approvals = await owner<{ id: string; actor_user_id: string; metadata: { reason: string } }[]>`
      select id, actor_user_id, metadata from audit_events where tenant_id = ${f.tenantId} and action = 'privacy.request.approved'`;
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ actor_user_id: staff.userId, metadata: { reason: "verified" } });
    const queued = await owner<{ id: string }[]>`select id from outbox_events where tenant_id = ${f.tenantId} and event_type = 'privacy.erasure.approved'`;
    expect(queued).toHaveLength(1);

    // A stale screen is told so, and the customer's own words stay out of the audit log.
    await expect(decideRequest(staff, first.request.id, decision, `again-${randomUUID()}`)).rejects.toMatchObject({ status: 409, code: "version_conflict" });
    const audits = await owner<{ metadata: unknown }[]>`select metadata from audit_events where tenant_id = ${f.tenantId}`;
    expect(JSON.stringify(audits)).not.toContain("Please remove me");
  });

  it("needs a recent second-factor check to approve an erasure", async () => {
    const f = await createTenant(owner, "stepup");
    const customer = await createCustomer(owner, f.tenantId);
    const account = await accountFor(customer.email);
    const { request } = await createPortalRequest(account, { clinicSlug: f.slug, patientId: customer.id, type: "erasure" });
    const stale = staffContext(f, { secondFactorAt: new Date(Date.now() - 60 * 60 * 1_000) });
    await expect(decideRequest(stale, request.id, { decision: "approve", reason: "verified", version: request.version }, `s-${randomUUID()}`)).rejects.toMatchObject({ status: 403 });
    await expect(decideRequest(staffContext(f, { secondFactorEnrolled: false }), request.id, { decision: "approve", reason: "verified", version: request.version }, `s-${randomUUID()}`)).rejects.toMatchObject({ status: 403 });
    const [unchanged] = await owner<{ status: string }[]>`select status from data_requests where id = ${request.id}`;
    expect(unchanged!.status).toBe("requested");
    // Refusing needs a reason from the fixed list, not the step-up.
    await expect(decideRequest(stale, request.id, { decision: "refuse", reason: "verified", version: 1 }, `s-${randomUUID()}`)).rejects.toMatchObject({ status: 400 });
    const refused = await decideRequest(stale, request.id, { decision: "refuse", reason: "identity_not_confirmed", note: "Please bring ID", version: 1 }, `s-${randomUUID()}`);
    expect(refused).toMatchObject({ status: "refused", decisionReason: "identity_not_confirmed", decisionNote: "Please bring ID" });
    const audit = await owner<{ metadata: Record<string, unknown> }[]>`select metadata from audit_events where tenant_id = ${f.tenantId} and action = 'privacy.request.refused'`;
    expect(audit[0]!.metadata).toMatchObject({ reason: "identity_not_confirmed" });
    expect(JSON.stringify(audit)).not.toContain("Please bring ID");
  });

  it("(h) never sends marketing to anyone under 18", async () => {
    const child = await createCustomer(owner, a.tenantId, { dateOfBirth: new Date(Date.now() - 10 * 365.25 * 86_400_000).toISOString().slice(0, 10) });
    const dependant = await createCustomer(owner, a.tenantId, { isDependent: true });
    for (const person of [child, dependant]) {
      await expect(recordConsent(a.tenantId, { patientId: person.id, purpose: "marketing_messages", granted: true, source: "portal", actor: { type: "guardian" } })).rejects.toMatchObject({ status: 403, code: "minor_no_marketing" });
      // Even a row written around the rules cannot open the gate.
      await owner`insert into consent_records (tenant_id, patient_id, purpose, granted, wording_version, source, actor_type) values (${a.tenantId}, ${person.id}, 'marketing_messages', true, 'legacy', 'import', 'system')`;
      expect(await canSendMarketing(a.tenantId, person.id)).toBe(false);
      expect(await worker.begin(async (tx) => {
        await tx`select set_config('app.tenant_id', ${a.tenantId}, true)`;
        return canSendMarketingTenantDb(tx, a.tenantId, person.id);
      })).toBe(false);
    }
    // Choices for a child through the portal need a guardian on file first, and the contact is stored sealed.
    const account = await accountFor(child.email);
    await expect(setPortalConsent(account, { clinicSlug: a.slug, patientId: child.id, purpose: "reviews", granted: true, wordingVersion: "2026-11" })).rejects.toMatchObject({ code: "guardian_required" });
    const saved = await setPortalConsent(account, {
      clinicSlug: a.slug, patientId: child.id, purpose: "reviews", granted: true, wordingVersion: "2026-11",
      guardian: { name: "Meera Parent", relationship: "mother", contact: "meera.parent@example.com" },
    });
    expect(saved.consents.find((state) => state.purpose === "reviews")).toMatchObject({ granted: true, answered: true });
    const [row] = await owner<{ guardian_name: string; guardian_contact_ciphertext: string; guardian_key_version: number }[]>`
      select guardian_name, guardian_contact_ciphertext, guardian_key_version from patients where id = ${child.id}`;
    expect(row!.guardian_name).toBe("Meera Parent");
    expect(row!.guardian_contact_ciphertext).not.toContain("meera.parent");
    expect(row!.guardian_key_version).toBeGreaterThan(0);
    const view = await getPortalPrivacy(account, "hi");
    const person = view.people.find((entry) => entry.patientId === child.id);
    expect(person).toMatchObject({ isMinor: true, guardianOnFile: true });
    expect(view.notices[a.slug]!.language).toBe("hi");
    const actors = await owner<{ actor_type: string }[]>`select actor_type from consent_records where patient_id = ${child.id} and source = 'portal'`;
    expect(actors[0]!.actor_type).toBe("guardian");
  });

  it("(d) the nightly job removes expired sign-in codes and old details, and records the counts", async () => {
    const f = await createTenant(owner, "retention");
    const customer = await createCustomer(owner, f.tenantId);
    await createBooking(owner, f, customer.id, { notes: "Old note", status: "cancelled", endsDaysAgo: 900 });
    await createBooking(owner, f, customer.id, { notes: "Recent note", status: "cancelled", endsDaysAgo: 5 });
    const staleHash = sha(`stale-${randomUUID()}`);
    const freshHash = sha(`fresh-${randomUUID()}`);
    await owner`insert into patient_login_codes (contact_hash, code_hash, expires_at, created_at) values (${staleHash}, 'x', now() - interval '2 days', now() - interval '2 days')`;
    await owner`insert into patient_login_codes (contact_hash, code_hash, expires_at) values (${freshHash}, 'x', now() + interval '10 minutes')`;

    const summary = await applyPrivacyRetention(worker);
    expect(summary.loginCodes).toBeGreaterThanOrEqual(1);
    expect(await owner`select 1 from patient_login_codes where contact_hash = ${staleHash}`).toHaveLength(0);
    expect(await owner`select 1 from patient_login_codes where contact_hash = ${freshHash}`).toHaveLength(1);
    const notes = await owner<{ notes: string | null }[]>`select notes from appointments where tenant_id = ${f.tenantId} order by ends_at`;
    expect(notes.map((row) => row.notes)).toEqual([null, "Recent note"]);
    const [audit] = await owner<{ metadata: { cancelledBookings: number } }[]>`
      select metadata from audit_events where tenant_id = ${f.tenantId} and action = 'privacy.retention.applied'`;
    expect(audit!.metadata.cancelledBookings).toBe(1);

    // The owner changes a period; sign-in codes are fixed; the change is audited with numbers only.
    const staff = staffContext(f);
    const saved = await saveRetentionSettings(staff, { policies: [{ dataKind: "message_log", keepDays: 90, action: "delete" }] });
    expect(saved.policies.find((policy) => policy.dataKind === "message_log")).toMatchObject({ keepDays: 90, isDefault: false });
    await expect(saveRetentionSettings(staff, { policies: [{ dataKind: "login_codes", keepDays: 30, action: "delete" }] })).rejects.toMatchObject({ status: 400 });
    await expect(saveRetentionSettings(staffContext(f, { secondFactorAt: null }), { policies: [{ dataKind: "message_log", keepDays: 60, action: "delete" }] })).rejects.toMatchObject({ status: 403 });
    const [changed] = await owner<{ metadata: { changes: Record<string, { from: number; to: number }> } }[]>`
      select metadata from audit_events where tenant_id = ${f.tenantId} and action = 'privacy.retention.updated'`;
    expect(changed!.metadata.changes.message_log).toEqual({ from: 365, to: 90 });
  });

  it("alerts the owner once when a request is overdue", async () => {
    const f = await createTenant(owner, "overdue");
    const customer = await createCustomer(owner, f.tenantId);
    const [request] = await owner<{ id: string }[]>`
      insert into data_requests (tenant_id, patient_id, type, created_at, due_at) values (${f.tenantId}, ${customer.id}, 'erasure', now() - interval '100 days', now() - interval '10 days') returning id`;
    expect((await alertOverduePrivacyRequests(worker)).rows).toBeGreaterThanOrEqual(1);
    await alertOverduePrivacyRequests(worker);
    await alertOverduePrivacyRequests(worker);
    const events = await owner<{ id: string }[]>`select id from outbox_events where tenant_id = ${f.tenantId} and event_type = 'privacy.request.overdue'`;
    expect(events).toHaveLength(1);
    const run = await runWorker(f.tenantId);
    expect(run.kind).toBe("captured");
    if (run.kind === "captured") {
      expect(run.message.templateKey).toBe("privacy.overdue");
      expect(JSON.parse(run.message.body)).toMatchObject({ requestKind: "erasure" });
    }
    const [row] = await owner<{ overdue_alerted_at: Date | null }[]>`select overdue_alerted_at from data_requests where id = ${request!.id}`;
    expect(row!.overdue_alerted_at).not.toBeNull();
    const listed = await listStaffRequests(staffContext(f), { status: "open" });
    expect(listed.requests[0]).toMatchObject({ overdue: true });
    expect(listed.requests[0]!.daysRemaining).toBeLessThan(0);
    expect(listed.counts).toMatchObject({ open: 1, overdue: 1 });
  });

  it("lists who a time window touched, for the worker role only", async () => {
    const f = await createTenant(owner, "breach");
    const customer = await createCustomer(owner, f.tenantId);
    const bookingId = await createBooking(owner, f, customer.id);
    await owner`insert into audit_events (tenant_id, appointment_id, actor_type, action, outcome, actor_user_id) values (${f.tenantId}, ${bookingId}, 'staff', 'appointment.status.completed', 'success', 'staff-user-1')`;
    const rows = await listBreachAffected(worker, new Date(Date.now() - 3_600_000), new Date(Date.now() + 3_600_000));
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ tenantId: f.tenantId, kind: "tenant" }),
      expect.objectContaining({ tenantId: f.tenantId, kind: "customer", subjectId: customer.id }),
      expect.objectContaining({ tenantId: f.tenantId, kind: "staff_user", subjectId: "staff-user-1" }),
    ]));
    // Ids only: nothing in the answer is a name or a contact.
    expect(JSON.stringify(rows)).not.toContain(customer.firstName);
    await expect(runtime`select * from kalendr_breach_affected(now() - interval '1 hour', now())`).rejects.toMatchObject({ code: "42501" });
  });
});
