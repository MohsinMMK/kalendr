/** @vitest-environment node */

import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { resolvePermissions } from "@/lib/permissions";
import type { StaffContext, StaffRole } from "@/server/staff-context";

vi.mock("server-only", () => ({}));

import { withTenant } from "@/db/client";
import { createAppointment, getPortalManageSnapshot, listAvailability } from "@/server/appointment-repository";
import { getPatientAccount, issueLoginCode, patientSessionCookie, requestLoginCode, sessionCookieHeader, verifyLoginCode, endPatientSession, type PatientAccount } from "@/server/patient-auth";
import {
  confirmPortalIdentity,
  getPortalRecord,
  getPortalSnapshot,
  readPortalRecordFile,
  requestPortalConfirmation,
  resolvePortalVisit,
} from "@/server/patient-portal";
import {
  addVisitRecordFile,
  confirmRecordAccess,
  createVisitRecord,
  deleteDraftVisitRecord,
  editVisitRecord,
  getVisitRecord,
  listVisitRecords,
  readStaffRecordFile,
  removeVisitRecordFile,
  shareVisitRecord,
  withdrawVisitRecord,
} from "@/server/visit-records";
import { getStaffSnapshot } from "@/server/staff-repository";
import { processNextOutboxEvent } from "@/worker/outbox-worker";

const runtimeUrl = process.env.DATABASE_URL;
const ownerUrl = process.env.KALENDR_TEST_OWNER_URL;
const isLocal = (url: string | undefined) => {
  if (!url) return false;
  const parsed = new URL(url);
  return parsed.hostname === "127.0.0.1" && ["5544", "5545"].includes(parsed.port) && ["/kalendr_local", "/nira_local"].includes(parsed.pathname) // nira_local: a local cluster made before the rename (see scripts/local-db.sh);
};
const describeLocal = isLocal(runtimeUrl) && isLocal(ownerUrl) && process.env.KALENDR_PREVIEW_MODE === "false" ? describe : describe.skip;

const secretTitle = "SECRET-TITLE-biopsy";
const secretBody = "SECRET-BODY-result";
const pdf = new TextEncoder().encode("%PDF-1.4 SECRET-FILE-contents\n%%EOF");

function headersFor(cookieHeader: string): Headers {
  return new Headers({ cookie: cookieHeader.split(";")[0] ?? "" });
}

describeLocal("patient accounts and visit records", () => {
  let owner: postgres.Sql;
  let fileDir: string;
  const suffix = randomUUID().slice(0, 8);
  const phone = `+91 90${String(Date.now()).slice(-8)}`;
  const email = `portal-${suffix}@example.com`;
  let tenantId = "";
  let otherTenantId = "";
  let patientId = "";
  let dependentId = "";
  let appointmentId = "";
  let practitionerId = "";
  const staff = (role: StaffRole, userId: string | null = null): StaffContext => ({
    tenantId,
    clinicSlug: "lotus-dental",
    clinicName: "Lotus Dental Studio",
    role,
    permissions: resolvePermissions(role, {}),
    membershipId: null,
    userId,
    userName: "Test",
    userEmail: "test@example.com",
    preview: false,
  });
  const signIn = async (kind: "email" | "phone", contact: string): Promise<{ account: PatientAccount; headers: Headers }> => {
    const code = await issueLoginCode(kind, contact);
    const headers = headersFor(sessionCookieHeader(await verifyLoginCode(kind, contact, code)));
    const account = await getPatientAccount(headers);
    if (!account) throw new Error("Expected a signed-in account");
    return { account, headers };
  };

  beforeAll(async () => {
    owner = postgres(ownerUrl!, { max: 1, prepare: false });
    fileDir = await mkdtemp(path.join(os.tmpdir(), "kalendr-records-"));
    process.env.KALENDR_FILE_STORE_DIR = fileDir;
    const [tenant] = await owner<{ id: string }[]>`select id from tenants where slug = 'lotus-dental'`;
    const [other] = await owner<{ id: string }[]>`select id from tenants where slug <> 'lotus-dental' order by slug limit 1`;
    tenantId = tenant!.id;
    otherTenantId = other!.id;
    const [link] = await owner<{ location_id: string; service_id: string; practitioner_id: string }[]>`
      select location.location_id, service.service_id, service.practitioner_id
      from practitioner_services as service
      join practitioner_locations as location
        on location.tenant_id = service.tenant_id and location.practitioner_id = service.practitioner_id
      where service.tenant_id = ${tenantId} limit 1
    `;
    practitionerId = link!.practitioner_id;
    const day = 24 * 60 * 60 * 1_000;
    const slots = await listAvailability({
      clinicSlug: "lotus-dental",
      locationId: link!.location_id,
      serviceId: link!.service_id,
      practitionerId,
      from: new Date(Date.now() + 20 * day).toISOString(),
      to: new Date(Date.now() + 27 * day).toISOString(),
    });
    const slot = slots.at(-1);
    if (!slot) throw new Error("Expected an open slot");
    const created = await createAppointment({
      clinicSlug: "lotus-dental",
      patientType: "new",
      bookingFor: "self",
      locationId: link!.location_id,
      serviceId: link!.service_id,
      practitionerId,
      slotId: randomUUID(),
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      firstName: "Portal",
      lastName: "Patient",
      phone,
      email,
      preferredChannel: "email",
      acceptedPrivacyNotice: true,
      messagingConsent: false,
    }, randomUUID(), randomUUID().replaceAll("-", ""));
    appointmentId = created.appointmentId;
    const [row] = await owner<{ patient_id: string }[]>`select patient_id from appointments where id = ${appointmentId}`;
    patientId = row!.patient_id;
    await owner`update patients set date_of_birth = '1990-04-12' where id = ${patientId}`;
    const [dependent] = await owner<{ id: string }[]>`
      insert into patients (tenant_id, first_name, last_name, phone, email, preferred_channel, is_dependent)
      values (${tenantId}, 'Kabir', 'Patient', ${phone}, ${email}, 'email', true) returning id
    `;
    dependentId = dependent!.id;
  });

  afterAll(async () => {
    await owner.begin(async (transaction) => {
      await transaction`delete from outbox_events where tenant_id = ${tenantId} and (aggregate_id = ${appointmentId} or aggregate_type = 'visit_record')`;
      await transaction`delete from notifications where tenant_id = ${tenantId} and appointment_id = ${appointmentId}`.catch(() => undefined);
      await transaction`delete from patient_record_access where tenant_id = ${tenantId} and patient_id in (${patientId}, ${dependentId})`;
      await transaction`delete from visit_records where tenant_id = ${tenantId} and patient_id in (${patientId}, ${dependentId})`;
      await transaction`delete from audit_events where tenant_id = ${tenantId} and appointment_id = ${appointmentId}`;
      await transaction`delete from appointments where id = ${appointmentId}`;
      await transaction`delete from idempotency_keys where tenant_id = ${tenantId} and created_at > now() - interval '5 minutes'`;
      await transaction`delete from consent_records where (select set_config('kalendr.consent_erase', 'on', true)) = 'on' and (tenant_id, patient_id) in (select tenant_id, id from patients where id in (${patientId}, ${dependentId}))`;
      await transaction`delete from patients where id in (${patientId}, ${dependentId})`;
    }).catch((error: unknown) => {
      console.error("portal test cleanup failed", error);
    });
    await owner.end();
    await rm(fileDir, { recursive: true, force: true });
    delete process.env.KALENDR_FILE_STORE_DIR;
  });

  it("limits code attempts, expires codes, and rate limits requests", async () => {
    const contact = `limits-${suffix}@example.com`;
    const code = await issueLoginCode("email", contact);
    const wrong = code === "000000" ? "000001" : "000000";
    // A wrong code asks for a growing wait before the next try (feature 8); the wait is cleared here so all five attempts are used.
    const clearWait = () => owner`update patient_login_codes set locked_until = null where consumed_at is null and attempt_count > 0 and created_at > now() - interval '5 minutes'`;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(verifyLoginCode("email", contact, wrong)).rejects.toMatchObject({ code: "invalid_code" });
      await clearWait();
    }
    // The right code no longer works once the attempts are used up.
    await expect(verifyLoginCode("email", contact, code)).rejects.toMatchObject({ code: "invalid_code" });
    const [hashRow] = await owner<{ count: number }[]>`select count(*)::int as count from patient_accounts where contact_value = ${contact}`;
    expect(hashRow!.count).toBe(0);

    const expiring = `expired-${suffix}@example.com`;
    const expiredCode = await issueLoginCode("email", expiring);
    await owner`update patient_login_codes set expires_at = now() - interval '1 second' where created_at > now() - interval '1 second' and attempt_count = 0 and consumed_at is null`;
    await expect(verifyLoginCode("email", expiring, expiredCode)).rejects.toMatchObject({ code: "invalid_code" });

    const busy = `busy-${suffix}@example.com`;
    for (let index = 0; index < 5; index += 1) await issueLoginCode("email", busy);
    await expect(issueLoginCode("email", busy)).rejects.toMatchObject({ status: 429, code: "too_many_codes" });
    await expect(requestLoginCode("email", "not-an-email")).rejects.toMatchObject({ status: 400 });
  });

  it("uses each code once, stores only hashes, and ends the session on sign-out", async () => {
    const contact = `once-${suffix}@example.com`;
    const code = await issueLoginCode("email", contact);
    const grant = await verifyLoginCode("email", contact, code);
    await expect(verifyLoginCode("email", contact, code)).rejects.toMatchObject({ code: "invalid_code" });
    const stored = await owner<{ token_hash: string }[]>`select token_hash from patient_sessions`;
    expect(stored.map((row) => row.token_hash)).not.toContain(grant.token);
    const codes = await owner<{ code_hash: string }[]>`select code_hash from patient_login_codes`;
    expect(codes.map((row) => row.code_hash)).not.toContain(code);
    const headers = headersFor(sessionCookieHeader(grant));
    expect(sessionCookieHeader(grant)).toContain("HttpOnly");
    expect(sessionCookieHeader(grant)).toContain(`${patientSessionCookie}=`);
    expect(await getPatientAccount(headers)).not.toBeNull();
    await endPatientSession(headers);
    expect(await getPatientAccount(headers)).toBeNull();
    await expect(getPatientAccount(new Headers({ cookie: `${patientSessionCookie}=forged` }))).resolves.toBeNull();
  });

  it("matches the same person however the number is written, and shows nothing to a stranger", async () => {
    const digits = phone.replace(/\D/g, "").slice(2);
    for (const written of [phone, digits, `0${digits}`]) {
      const { account } = await signIn("phone", written);
      const snapshot = await getPortalSnapshot(account);
      expect(snapshot.people.map((person) => person.patientId).sort()).toEqual([patientId, dependentId].sort());
      expect(snapshot.visits.map((visit) => visit.id)).toContain(appointmentId);
      expect(snapshot.contact).not.toContain(digits);
    }
    const stranger = await signIn("email", `stranger-${suffix}@example.com`);
    await expect(getPortalSnapshot(stranger.account)).resolves.toMatchObject({ people: [], visits: [], records: [] });
    await expect(resolvePortalVisit(stranger.account, "lotus-dental", appointmentId)).rejects.toMatchObject({ status: 404 });
    const mine = await signIn("email", email);
    const visit = await resolvePortalVisit(mine.account, "lotus-dental", appointmentId);
    expect((await getPortalManageSnapshot(visit.tenantId, visit.appointmentId)).appointment.id).toBe(appointmentId);
  });

  it("runs the record lifecycle: draft, file, share, withdraw, and no plaintext at rest", async () => {
    const context = staff("owner");
    const { id } = await createVisitRecord(context, { patientId, appointmentId, kind: "report", title: secretTitle, body: secretBody });
    const { account, headers } = await signIn("email", email);
    void headers;
    await confirmPortalIdentity(account, "lotus-dental", patientId, "1990-04-12");

    // A draft is invisible, even to a confirmed patient.
    expect((await getPortalSnapshot(account)).records).toEqual([]);
    await expect(getPortalRecord(account, "lotus-dental", id)).rejects.toMatchObject({ status: 404 });

    const file = await addVisitRecordFile(context, id, { name: "Blood report.pdf", bytes: pdf });
    expect(file.contentType).toBe("application/pdf");
    await expect(addVisitRecordFile(context, id, { name: "page.pdf", bytes: new TextEncoder().encode("<script>alert(1)</script>") }))
      .rejects.toMatchObject({ status: 415 });
    await expect(readPortalRecordFile(account, "lotus-dental", id, file.id)).rejects.toMatchObject({ status: 404 });

    await shareVisitRecord(context, id);
    const events = await owner`select payload from outbox_events where aggregate_id = ${id} and event_type = 'record.shared'`;
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0])).not.toContain("SECRET");

    const snapshot = await getPortalSnapshot(account);
    expect(snapshot.records).toMatchObject([{ id, title: secretTitle, fileCount: 1 }]);
    expect(await getPortalRecord(account, "lotus-dental", id)).toMatchObject({ body: secretBody });
    const opened = await readPortalRecordFile(account, "lotus-dental", id, file.id);
    expect(Buffer.from(opened.bytes).equals(Buffer.from(pdf))).toBe(true);
    expect(opened.name).toBe("Blood report.pdf");
    expect(Buffer.from((await readStaffRecordFile(context, id, file.id)).bytes).equals(Buffer.from(pdf))).toBe(true);

    // Shared records are locked until they're withdrawn.
    await expect(editVisitRecord(context, id, { kind: "note", title: "x", body: "y" })).rejects.toMatchObject({ code: "record_shared" });
    await expect(removeVisitRecordFile(context, id, file.id)).rejects.toMatchObject({ code: "record_shared" });
    await expect(deleteDraftVisitRecord(context, id)).rejects.toMatchObject({ code: "record_shared" });

    await withdrawVisitRecord(context, id);
    expect((await getPortalSnapshot(account)).records).toEqual([]);
    await expect(readPortalRecordFile(account, "lotus-dental", id, file.id)).rejects.toMatchObject({ status: 404 });
    await expect(deleteDraftVisitRecord(context, id)).rejects.toMatchObject({ code: "record_was_shared" });
    await editVisitRecord(context, id, { kind: "report", title: secretTitle, body: secretBody });
    await shareVisitRecord(context, id);

    const [row] = await owner<{ text: string }[]>`
      select concat(title_ciphertext, body_ciphertext) as text from visit_records where id = ${id}
    `;
    expect(row!.text).not.toContain("SECRET");
    const [fileRow] = await owner<{ name_ciphertext: string; storage_key: string }[]>`
      select name_ciphertext, storage_key from visit_record_files where id = ${file.id}
    `;
    expect(fileRow!.name_ciphertext).not.toContain("Blood");
    const onDisk = await readFile(path.join(fileDir, fileRow!.storage_key));
    expect(onDisk.includes("SECRET-FILE")).toBe(false);
    const audit = await owner<{ action: string; actor_type: string; metadata: unknown }[]>`
      select action, actor_type, metadata from audit_events where tenant_id = ${tenantId} and metadata->>'recordId' = ${id}
    `;
    const actions = audit.map((entry) => `${entry.actor_type}:${entry.action}`);
    for (const expected of ["staff:record.create", "staff:record.share", "staff:record.withdraw", "staff:record.file.view", "patient:record.view", "patient:record.file.view"]) {
      expect(actions).toContain(expected);
    }
    expect(JSON.stringify(audit)).not.toContain("SECRET");
    expect(JSON.stringify(audit)).not.toContain("Blood");
    const log = (await getVisitRecord(context, id)).accessLog;
    expect(log?.some((entry) => entry.who === "Patient" && entry.action === "Opened a file")).toBe(true);
  });

  it("turns a shared document into a patient update that carries no clinical detail", async () => {
    const context = staff("owner");
    const { id } = await createVisitRecord(context, { patientId, appointmentId: null, kind: "report", title: secretTitle, body: secretBody });
    await shareVisitRecord(context, id);
    const [event] = await owner<{ dedupe_key: string }[]>`select dedupe_key from outbox_events where tenant_id = ${tenantId} and aggregate_id = ${id} and event_type = 'record.shared'`;
    const semanticKey = `local:email:${createHash("sha256").update(event!.dedupe_key).digest("hex")}`;
    const runtime = postgres(runtimeUrl!, { max: 1, prepare: false });
    try {
      let captured = false;
      for (let step = 0; step < 50 && !captured; step += 1) {
        const result = await processNextOutboxEvent(runtime, { tenantId, workerId: `records-${suffix}` });
        if (result.kind === "idle") break;
        if (result.kind === "captured" && result.message.semanticKey === semanticKey) captured = true;
      }
      expect(captured).toBe(true);
    } finally {
      await runtime.end();
    }
    const rows = await owner`select template_key, appointment_id, semantic_key from notifications where tenant_id = ${tenantId} and semantic_key = ${semanticKey}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ template_key: "record.shared", appointment_id: null });
    expect(JSON.stringify(rows)).not.toContain("SECRET");
    const messages = (await getStaffSnapshot(context)).messages;
    expect(messages.some((message) => message.templateKey === "record.shared")).toBe(true);
  });

  it("keeps a family's documents apart: sharing a phone shows visits, not documents", async () => {
    const context = staff("owner");
    const { id } = await createVisitRecord(context, { patientId: dependentId, appointmentId: null, kind: "note", title: "Child note", body: "Note" });
    await shareVisitRecord(context, id);
    const relative = await signIn("phone", phone);
    const person = (await getPortalSnapshot(relative.account)).people.find((row) => row.patientId === dependentId);
    // No date of birth on file: only the clinic can open this.
    expect(person?.access).toBe("ask_clinic");
    expect((await getPortalSnapshot(relative.account)).records.some((record) => record.id === id)).toBe(false);
    await expect(getPortalRecord(relative.account, "lotus-dental", id)).rejects.toMatchObject({ status: 404 });
    await expect(confirmPortalIdentity(relative.account, "lotus-dental", dependentId, "2015-01-01")).rejects.toMatchObject({ code: "identity_needs_clinic" });

    await requestPortalConfirmation(relative.account, "lotus-dental", dependentId);
    const list = await listVisitRecords(context);
    const request = list.accessRequests.find((row) => row.patientId === dependentId);
    expect(request?.contact).not.toContain(phone);
    if (!request) throw new Error("Expected an access request");
    await confirmRecordAccess(context, request.accessId);
    expect((await getPortalSnapshot(relative.account)).records.some((record) => record.id === id)).toBe(true);
    await expect(confirmRecordAccess(context, request.accessId)).rejects.toMatchObject({ status: 404 });
  });

  it("locks date of birth after five wrong tries, and a stranger can't try at all", async () => {
    const { account } = await signIn("phone", phone);
    const stranger = await signIn("email", `dob-stranger-${suffix}@example.com`);
    await expect(confirmPortalIdentity(stranger.account, "lotus-dental", patientId, "1990-04-12")).rejects.toMatchObject({ status: 404 });
    await expect(requestPortalConfirmation(stranger.account, "lotus-dental", patientId)).rejects.toMatchObject({ status: 404 });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(confirmPortalIdentity(account, "lotus-dental", patientId, "2000-01-01")).rejects.toMatchObject({ code: "identity_mismatch" });
    }
    await expect(confirmPortalIdentity(account, "lotus-dental", patientId, "2000-01-01")).rejects.toMatchObject({ code: "identity_needs_clinic" });
    // The correct date doesn't help after the lock.
    await expect(confirmPortalIdentity(account, "lotus-dental", patientId, "1990-04-12")).rejects.toMatchObject({ code: "identity_needs_clinic" });
    const person = (await getPortalSnapshot(account)).people.find((row) => row.patientId === patientId);
    expect(person?.access).toBe("ask_clinic");
    const denied = await owner`select 1 from audit_events where tenant_id = ${tenantId} and action = 'record.access.date_of_birth' and outcome = 'denied'`;
    expect(denied.length).toBeGreaterThanOrEqual(5);
  });

  it("enforces roles: front desk is refused, doctors see only their own patients", async () => {
    const owners = staff("owner");
    const { id } = await createVisitRecord(owners, { patientId, appointmentId, kind: "note", title: "Roles", body: "Body" });
    for (const role of ["receptionist", "billing", "read_only"] as const) {
      await expect(listVisitRecords(staff(role))).rejects.toMatchObject({ status: 403 });
      await expect(getVisitRecord(staff(role), id)).rejects.toMatchObject({ status: 403 });
      await expect(createVisitRecord(staff(role), { patientId, appointmentId: null, kind: "note", title: "x", body: "y" })).rejects.toMatchObject({ status: 403 });
    }
    const users = await owner<{ auth_user_id: string; id: string }[]>`
      select auth_user_id, id from practitioners where tenant_id = ${tenantId} and auth_user_id is not null
    `;
    const treating = users.find((row) => row.id === practitionerId);
    const otherDoctor = users.find((row) => row.id !== practitionerId);
    if (!treating || !otherDoctor) throw new Error("Expected two linked doctors in the seed");
    const own = staff("practitioner", treating.auth_user_id);
    const notOwn = staff("practitioner", otherDoctor.auth_user_id);
    expect((await getVisitRecord(own, id)).accessLog).toBeNull();
    expect((await listVisitRecords(own)).records.some((record) => record.id === id)).toBe(true);
    await expect(getVisitRecord(notOwn, id)).rejects.toMatchObject({ status: 404 });
    expect((await listVisitRecords(notOwn)).records.some((record) => record.id === id)).toBe(false);
    await expect(createVisitRecord(notOwn, { patientId, appointmentId: null, kind: "note", title: "x", body: "y" })).rejects.toMatchObject({ status: 404 });
    const preview = { ...owners, preview: true };
    await expect(listVisitRecords(preview)).rejects.toMatchObject({ status: 409 });
  });

  it("isolates new tables per clinic under the runtime role", async () => {
    const [{ count } = { count: 0 }] = await owner<{ count: number }[]>`select count(*)::int as count from visit_records where tenant_id = ${tenantId}`;
    expect(count).toBeGreaterThan(0);
    const counts = async (tenant: string) => withTenant(tenant, async (transaction) => {
      const rows = await transaction.execute<{ records: number; files: number; access: number }>(sql`
        select (select count(*)::int from visit_records) as records,
          (select count(*)::int from visit_record_files) as files,
          (select count(*)::int from patient_record_access) as access
      `);
      return rows[0];
    });
    expect((await counts(tenantId))?.records).toBeGreaterThan(0);
    expect(await counts(otherTenantId)).toEqual({ records: 0, files: 0, access: 0 });
    const runtime = postgres(runtimeUrl!, { max: 1, prepare: false });
    try {
      const [unscoped] = await runtime<{ count: number }[]>`select count(*)::int as count from visit_records`;
      expect(unscoped!.count).toBe(0);
      await expect(runtime.begin(async (transaction) => {
        await transaction`select set_config('app.tenant_id', ${otherTenantId}, true)`;
        await transaction`insert into visit_records (tenant_id, patient_id, kind, title_ciphertext, body_ciphertext) values (${tenantId}, ${patientId}, 'note', 'x', 'y')`;
      })).rejects.toThrow();
      await expect(runtime`update audit_events set action = 'tampered'`).rejects.toThrow();
    } finally {
      await runtime.end();
    }
    // A ciphertext copied from one clinic doesn't open under another clinic's id.
    const [row] = await owner<{ title_ciphertext: string }[]>`select title_ciphertext from visit_records where tenant_id = ${tenantId} limit 1`;
    const { openText } = await import("@/server/record-crypto");
    expect(() => openText(otherTenantId, row!.title_ciphertext)).toThrow();
  });

  it("ends access the moment the clinic changes a patient's contact", async () => {
    const { account } = await signIn("email", email);
    expect((await getPortalSnapshot(account)).records.length).toBeGreaterThan(0);
    await owner`update patients set email = ${`moved-${suffix}@example.com`} where id in (${patientId}, ${dependentId})`;
    const after = await getPortalSnapshot(account);
    expect(after).toMatchObject({ people: [], visits: [], records: [] });
    await expect(resolvePortalVisit(account, "lotus-dental", appointmentId)).rejects.toMatchObject({ status: 404 });
    await owner`update patients set email = ${email} where id in (${patientId}, ${dependentId})`;
    const files = await readdir(fileDir, { recursive: true });
    expect(files.length).toBeGreaterThan(0);
  });
});
