/** @vitest-environment node */

import { randomInt, randomUUID } from "node:crypto";

import Papa from "papaparse";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { isolatedDatabaseReady } from "@/test/isolated-database";

vi.mock("server-only", () => ({}));
vi.mock("@/server/file-store", async (original) => {
  const actual = await original<typeof import("@/server/file-store")>();
  const { memoryStore } = await import("./testing/memory-store");
  return { ...actual, getFileStore: () => memoryStore };
});

import { ApiError } from "@/server/api-error";
import { loadRecordKeys, openBytes } from "@/server/record-crypto";
import { withTenant } from "@/db/client";
import { claimOutboxBatch, processClaimedEvent } from "@/worker/outbox-worker";
import { purgeImportFiles } from "@/worker/import-jobs";

import type { ImportJobView, ImportMapping, ImportOptions } from "./contracts";
import { guessMapping } from "./map";
import {
  createImport, deleteImport, getImport, importErrorFile, listImportRows, listImports, startCheck, startCommit, startUndo, updateImport,
} from "./service";
import { csvOf, openHarness, urls, type Harness } from "./testing/harness";
import { memoryStore } from "./testing/memory-store";

const describeLocal = isolatedDatabaseReady(urls.runtime, urls.owner, urls.worker) ? describe : describe.skip;

const options = (patch: Partial<ImportOptions> = {}): ImportOptions => ({ dateFormat: "dd/mm/yyyy", duplicateRule: "skip", consentConfirmed: false, sendConfirmations: false, ...patch });

describeLocal("data import: customers", () => {
  let h: Harness;
  const base = 9_100_000_000 + randomInt(0, 4_000) * 100_000;
  const emailDomain = () => `import-${h.suffix}.example`;
  const logged: string[] = [];
  const spies: Array<ReturnType<typeof vi.spyOn>> = [];
  const existingIds: string[] = [];
  const jobIds: string[] = [];

  const formats = [
    (n: number) => String(n),
    (n: number) => `${String(n).slice(0, 5)} ${String(n).slice(5)}`,
    (n: number) => `+91 ${String(n).slice(0, 5)} ${String(n).slice(5)}`,
    (n: number) => `0${n}`,
    (n: number) => `+91-${n}`,
    (n: number) => `(+91) ${n}`,
    (n: number) => `91 ${n}`,
    (n: number) => `${n}.0`,
  ];
  const phoneOf = (k: number, style = k % formats.length) => formats[style]!(base + k);

  /** Builds the 2,000 row file and what it should turn into. */
  function buildFile() {
    const rows: string[][] = [];
    // 1,900 good rows. Row 1000 gets a last name that a test trigger refuses, to prove one bad row never blocks the rest.
    for (let k = 0; k < 1900; k += 1) {
      rows.push([`Zorbak${k}`, k === 1000 ? "Boom" : "Row", phoneOf(k), k < 50 ? `zorbak${k}@${emailDomain()}` : "", k % 3 === 0 ? "14/03/1990" : ""]);
    }
    // 50 duplicates inside the file: same phone in another format, same phone with another email, or same email only.
    const duplicates: string[][] = [];
    for (let i = 0; i < 20; i += 1) duplicates.push([`ZorbakDupA${i}`, "Dup", phoneOf(i, (i + 3) % 8), "", ""]);
    for (let i = 20; i < 35; i += 1) duplicates.push([`ZorbakDupB${i}`, "Dup", phoneOf(i, (i + 1) % 8), `other${i}@${emailDomain()}`, ""]);
    for (let i = 35; i < 50; i += 1) duplicates.push([`ZorbakDupC${i}`, "Dup", String(base + 5_000 + i), `ZORBAK${i}@${emailDomain()}`, ""]);
    // 10 customers the business already has: 5 match by phone (stored differently), 5 by email only.
    const existing: string[][] = [];
    for (let i = 0; i < 5; i += 1) existing.push([`ZorbakKnown${i}`, "Old", phoneOf(8_000 + i, 2), "", ""]);
    for (let i = 5; i < 10; i += 1) existing.push([`ZorbakKnown${i}`, "Old", String(base + 9_000 + i), `known${i}@${emailDomain()}`, ""]);
    // 40 bad rows: 10 of each kind.
    const bad: string[][] = [];
    for (let i = 0; i < 10; i += 1) bad.push([`ZorbakBad${i}`, "BadRow", "12345", "", ""]);
    for (let i = 10; i < 20; i += 1) bad.push([`ZorbakBad${i}`, "BadRow", phoneOf(6_000 + i), "not-an-email", ""]);
    for (let i = 20; i < 30; i += 1) bad.push([`ZorbakBad${i}`, "BadRow", phoneOf(6_000 + i), "", "31/02/1990"]);
    for (let i = 30; i < 40; i += 1) bad.push(["", "BadRow", phoneOf(6_000 + i), "", ""]);
    const extras = [...duplicates, ...existing, ...bad];
    const all = [...rows];
    extras.forEach((row, index) => all.splice(Math.min(all.length, 60 + index * 37), 0, row));
    expect(all).toHaveLength(2_000);
    return { header: ["First name", "Last name", "Mobile", "Email", "DOB"], rows: all };
  }

  async function upload(rows: string[][], kind: "customers" | "services" | "appointments" = "customers") {
    return createImport(h.staffA, { bytes: csvOf(rows), kind });
  }

  async function configure(job: ImportJobView, mapping: ImportMapping, patch: Partial<ImportOptions> = {}) {
    return updateImport(h.staffA, job.id, { mapping, options: options(patch), expectedVersion: job.version });
  }

  async function waitFor(id: string, status: string[]) {
    await h.drain(async () => status.includes((await getImport(h.staffA, id)).job.status));
    return (await getImport(h.staffA, id)).job;
  }

  beforeAll(async () => {
    h = await openHarness();
    // A test-only guard standing in for a row the database refuses: it proves one failing row never blocks the others.
    await h.owner`
      create or replace function import_test_boom() returns trigger language plpgsql as $$
      begin if new.last_name = 'Boom' then raise exception 'boom'; end if; return new; end $$`;
    await h.owner`drop trigger if exists import_test_boom on patients`;
    await h.owner`create trigger import_test_boom before insert on patients for each row execute function import_test_boom()`;
    for (let i = 0; i < 5; i += 1) {
      const [row] = await h.owner<{ id: string }[]>`
        insert into patients (tenant_id, first_name, last_name, phone, email, preferred_channel)
        values (${h.tenantA}, ${`ZorbakKnown${i}`}, 'Old', ${`0${base + 8_000 + i}`}, '', 'phone') returning id`;
      existingIds.push(row!.id);
    }
    for (let i = 5; i < 10; i += 1) {
      const [row] = await h.owner<{ id: string }[]>`
        insert into patients (tenant_id, first_name, last_name, phone, email, preferred_channel)
        values (${h.tenantA}, ${`ZorbakKnown${i}`}, 'Old', ${`+91 90000 0${i}${String(h.suffix).replace(/\D/g, "").slice(0, 3).padEnd(3, "0")}`}, ${`known${i}@${emailDomain()}`}, 'email') returning id`;
      existingIds.push(row!.id);
    }
    // Anything written to the console or stdout while it runs is collected. The import code does not call the logger at all
    // (no-logging.test.ts checks the source), and the worker's own line for each event carries an outcome only.
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      spies.push(vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(" ")); }));
    }
    spies.push(vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => { logged.push(String(chunk)); return true; }));
  });

  afterAll(async () => {
    for (const spy of spies) spy.mockRestore();
    if (!h) return;
    await h.owner.begin(async (tx) => {
      const imported = await tx<{ entity_id: string }[]>`select entity_id from import_rows where job_id = any(${jobIds}::text[]) and status in ('created', 'updated', 'undone') and entity_id is not null`;
      const patientIds = [...new Set([...imported.map((row) => row.entity_id), ...existingIds])];
      await tx`delete from outbox_events where tenant_id = ${h.tenantA} and aggregate_type = 'customer' and aggregate_id = any(${patientIds}::text[])`;
      await tx`delete from outbox_events where tenant_id = ${h.tenantA} and aggregate_type = 'import_job' and aggregate_id = any(${jobIds}::text[])`;
      await tx`delete from appointments where tenant_id = ${h.tenantA} and patient_id = any(${patientIds}::text[])`;
      await tx`delete from idempotency_keys where tenant_id = ${h.tenantA} and created_at > now() - interval '30 minutes' and route like 'staff.booking%'`;
      await tx`delete from consent_records where (select set_config('kalendr.consent_erase', 'on', true)) = 'on' and (tenant_id, patient_id) in (select tenant_id, id from patients where tenant_id = ${h.tenantA} and id = any(${patientIds}::text[]) and first_name like 'Zorbak%')`;
      await tx`delete from patients where tenant_id = ${h.tenantA} and id = any(${patientIds}::text[]) and first_name like 'Zorbak%'`;
      await tx`delete from audit_events where tenant_id = ${h.tenantA} and action like 'import.%' and metadata->>'importId' = any(${jobIds}::text[])`;
      await tx`delete from import_jobs where id = any(${jobIds}::text[])`;
    }).catch((error: unknown) => console.error("import test cleanup failed", error));
    await h.owner`drop trigger if exists import_test_boom on patients`;
    await h.owner`drop function if exists import_test_boom()`;
    await h.close();
  });

  it("imports a messy 2,000 row file through the real handlers, with exact totals and progress that is real", async () => {
    const file = buildFile();
    const started = Date.now();
    const uploaded = await upload([file.header, ...file.rows]);
    jobIds.push(uploaded.job.id);
    expect(uploaded.job).toMatchObject({ kind: "customers", fileFormat: "csv", status: "uploaded", rowCount: 2_000 });
    const mapping = guessMapping(uploaded.headers, "customers");
    expect(mapping).toMatchObject({ firstName: 0, lastName: 1, phone: 2, email: 3, dateOfBirth: 4 });

    // The stored file is ciphertext: neither a header, a name nor a number can be found in it.
    const stored = memoryStore.files.get(`tenant/${h.tenantA}/import/${uploaded.job.id}`);
    expect(stored).toBeDefined();
    expect(stored!.includes(Buffer.from("Zorbak"))).toBe(false);
    expect(stored!.includes(Buffer.from("First name"))).toBe(false);

    const configured = await configure(uploaded.job, mapping);
    expect(configured.job.status).toBe("mapped");
    expect(configured.preview).toHaveLength(5);
    expect(configured.preview[0]!.values).toMatchObject({ firstName: "Zorbak0", phone: `+91${base}`, email: `zorbak0@${emailDomain()}`, dateOfBirth: "1990-03-14" });

    await startCheck(h.staffA, uploaded.job.id);
    const checked = await waitFor(uploaded.job.id, ["checked", "failed"]);
    expect(checked.status).toBe("checked");
    expect(checked.counts).toMatchObject({ ready: 1_900, update: 0, skip: 60, error: 40 });
    const errorRows = await listImportRows(h.staffA, uploaded.job.id, { status: "error", limit: 200 });
    expect(errorRows.rows).toHaveLength(40);
    expect(new Set(errorRows.rows.map((row) => row.errorCode))).toEqual(new Set(["invalid_phone", "invalid_email", "invalid_date", "required_missing"]));
    const skipped = await listImportRows(h.staffA, uploaded.job.id, { status: "will_skip", limit: 200 });
    expect(skipped.rows.filter((row) => row.errorCode === "duplicate_in_file")).toHaveLength(50);
    expect(skipped.rows.filter((row) => row.errorCode === "duplicate_existing")).toHaveLength(10);
    // Paging gives every row once.
    const first = await listImportRows(h.staffA, uploaded.job.id, { status: "will_skip", limit: 25 });
    const second = await listImportRows(h.staffA, uploaded.job.id, { status: "will_skip", limit: 25, cursor: first.nextCursor ?? 0 });
    expect(new Set([...first.rows, ...second.rows].map((row) => row.rowNumber)).size).toBe(50);

    // Nothing has been imported yet, and the check never wrote a customer.
    const [before] = await h.owner<{ count: number }[]>`select count(*)::int as count from patients where tenant_id = ${h.tenantA} and first_name like 'Zorbak%'`;
    expect(before!.count).toBe(10);

    // Run exactly one batch, then look: the totals and rows are already true while the job is still running.
    let batches = 0;
    const paused = new Map(h.handlers);
    const realCommit = h.handlers.get("import.commit")!;
    paused.set("import.commit", async (tenantDb, event) => {
      batches += 1;
      return batches > 1 ? { outcome: "retry", code: "paused" } : realCommit(tenantDb, event);
    });
    await startCommit(h.staffA, uploaded.job.id, checked.version);
    await h.drain(async () => batches >= 2, 60, paused);
    const midway = (await getImport(h.staffA, uploaded.job.id)).job;
    expect(midway.status).toBe("running");
    expect(midway.counts.created).toBeGreaterThan(100);
    expect(midway.counts.created).toBeLessThan(1_900);
    const [progress] = await h.owner<{ count: number }[]>`select count(*)::int as count from import_rows where job_id = ${uploaded.job.id} and status = 'created'`;
    expect(progress!.count).toBe(midway.counts.created);

    // Release the paused retry and let it finish.
    await h.owner`update outbox_events set available_at = now() where tenant_id = ${h.tenantA} and aggregate_id = ${uploaded.job.id} and status = 'failed'`;
    const done = await waitFor(uploaded.job.id, ["done", "failed"]);
    const seconds = (Date.now() - started) / 1_000;
    expect(seconds).toBeLessThan(110);
    expect(done.status).toBe("done");
    // One row failed at the database (the guard) and the other 1,899 still went in.
    expect(done.counts).toMatchObject({ created: 1_899, updated: 0, skipped: 60, failed: 1, error: 40 });
    expect(done.undoUntil).not.toBeNull();
    const days = (new Date(done.undoUntil!).getTime() - new Date(done.finishedAt!).getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThan(7.01);

    // The duplicates were skipped, not created.
    const [dups] = await h.owner<{ count: number }[]>`select count(*)::int as count from patients where tenant_id = ${h.tenantA} and (first_name like 'ZorbakDup%')`;
    expect(dups!.count).toBe(0);
    const [made] = await h.owner<{ count: number; consented: number; privacy: number }[]>`
      select count(*)::int as count, count(messaging_consent_at)::int as consented, count(privacy_accepted_at)::int as privacy
      from patients where tenant_id = ${h.tenantA} and first_name like 'Zorbak%' and id <> all(${existingIds})`;
    expect(made!.count).toBe(1_899);
    // No messaging consent unless a column supplied it and the box was ticked; the privacy notice is never marked accepted.
    expect(made!.consented).toBe(0);
    expect(made!.privacy).toBe(0);
    // Every imported customer is in the webhook queue once, by id only.
    const [events] = await h.owner<{ count: number }[]>`
      select count(*)::int as count from outbox_events where tenant_id = ${h.tenantA} and event_type = 'customer.created' and payload ? 'customerId'
        and aggregate_id in (select entity_id from import_rows where job_id = ${uploaded.job.id} and status = 'created')`;
    expect(events!.count).toBe(1_899);
    // A phone is stored in one form: +91 and ten digits.
    const [badPhones] = await h.owner<{ count: number }[]>`select count(*)::int as count from patients where tenant_id = ${h.tenantA} and first_name like 'Zorbak%' and first_name !~ 'Known' and phone !~ '^\\+91[0-9]{10}$'`;
    expect(badPhones!.count).toBe(0);
  }, 180_000);

  it("gives back exactly the rows that failed, with a reason, and nothing else", async () => {
    const jobId = jobIds[0]!;
    const { csv, filename } = await importErrorFile(h.staffA, jobId);
    expect(filename).toBe("customers-rows-to-fix.csv");
    const parsed = Papa.parse<string[]>(csv.replace(/^﻿/, ""), { skipEmptyLines: true }).data;
    expect(parsed[0]).toEqual(["First name", "Last name", "Mobile", "Email", "DOB", "reason"]);
    const body = parsed.slice(1);
    // 40 rows the check refused, plus the one the database refused.
    expect(body).toHaveLength(41);
    expect(body.filter((row) => row[1] === "BadRow")).toHaveLength(40);
    expect(body.filter((row) => row[1] === "Boom")).toHaveLength(1);
    expect(body.every((row) => (row[5] ?? "").length > 10)).toBe(true);
    expect(body.some((row) => row[1] === "Row" || row[1] === "Dup" || row[1] === "Old")).toBe(false);
    // The original cells come back untouched.
    expect(body.find((row) => row[0] === "ZorbakBad0")?.slice(0, 5)).toEqual(["ZorbakBad0", "BadRow", "12345", "", ""]);
  });

  it("never wrote a cell value to the database or a log", async () => {
    const jobId = jobIds[0]!;
    const [stored] = await h.owner<{ text: string }[]>`
      select (select coalesce(string_agg(to_json(r)::text, ' '), '') from import_rows r where job_id = ${jobId})
        || (select to_json(j)::text from import_jobs j where id = ${jobId})
        || (select coalesce(string_agg(to_json(a)::text, ' '), '') from audit_events a where tenant_id = ${h.tenantA} and action like 'import.%' and metadata->>'importId' = ${jobId})
        || (select coalesce(string_agg(to_json(o)::text, ' '), '') from outbox_events o where tenant_id = ${h.tenantA} and aggregate_type = 'import_job' and aggregate_id = ${jobId}) as text`;
    expect(stored!.text.length).toBeGreaterThan(1_000);
    for (const secret of ["Zorbak", `${base}`, emailDomain(), "14/03/1990", "1990-03-14", "BadRow", "not-an-email"]) expect(stored!.text).not.toContain(secret);
    const everything = logged.join("\n");
    for (const secret of ["Zorbak", `${base}`, emailDomain()]) expect(everything).not.toContain(secret);
    const audits = await h.owner<{ action: string; metadata: Record<string, unknown> }[]>`
      select action, metadata from audit_events where tenant_id = ${h.tenantA} and action like 'import.%' and metadata->>'importId' = ${jobId} order by occurred_at`;
    expect(audits.map((row) => row.action)).toEqual(["import.started", "import.finished"]);
    expect(audits[1]!.metadata).toMatchObject({ kind: "customers", created: 1_899, skipped: 60, failed: 1, errors: 40 });
  });

  it("keeps business B out of business A's imports and file", async () => {
    const jobId = jobIds[0]!;
    await expect(getImport(h.staffB, jobId)).rejects.toMatchObject({ status: 404 });
    await expect(importErrorFile(h.staffB, jobId)).rejects.toMatchObject({ status: 404 });
    await expect(listImportRows(h.staffB, jobId, { limit: 10 })).rejects.toMatchObject({ status: 404 });
    await expect(startUndo(h.staffB, jobId)).rejects.toMatchObject({ status: 404 });
    expect((await listImports(h.staffB)).jobs.map((job) => job.id)).not.toContain(jobId);
    const seen = await h.worker.begin(async (tx) => {
      await tx`select set_config('app.tenant_id', ${h.tenantB}, true)`;
      const [rows] = await tx<{ count: number }[]>`select count(*)::int as count from import_rows where job_id = ${jobId}`;
      const [jobs] = await tx<{ count: number }[]>`select count(*)::int as count from import_jobs where id = ${jobId}`;
      return { rows: rows!.count, jobs: jobs!.count };
    });
    expect(seen).toEqual({ rows: 0, jobs: 0 });
    // B cannot make the ciphertext open either: the business is part of what is authenticated.
    const sealed = memoryStore.files.get(`tenant/${h.tenantA}/import/${jobId}`)!;
    await withTenant(h.tenantB, (tx) => loadRecordKeys(tx, h.tenantB, { forWrite: true }));
    expect(() => openBytes(h.tenantB, sealed)).toThrow();
    // A scoped to nothing sees no jobs at all.
    const unscoped = await h.worker<{ count: number }[]>`select count(*)::int as count from import_jobs`;
    expect(unscoped[0]!.count).toBe(0);
  });

  it("refuses a consent column without the ticked box, and records consent only when both are present", async () => {
    const rows = [["First name", "Last name", "Mobile", "Consent"], ...Array.from({ length: 6 }, (_, i) => [`ZorbakC${i}`, "Consent", String(base + 20_000 + i), i % 2 === 0 ? "Yes" : "No"])];
    const uploaded = await upload(rows);
    jobIds.push(uploaded.job.id);
    const mapping = guessMapping(uploaded.headers, "customers");
    expect(mapping.messagingConsent).toBe(3);
    await configure(uploaded.job, mapping, { consentConfirmed: false });
    await startCheck(h.staffA, uploaded.job.id);
    const checked = await waitFor(uploaded.job.id, ["checked"]);
    await expect(startCommit(h.staffA, uploaded.job.id, checked.version)).rejects.toMatchObject({ status: 400, code: "consent_not_confirmed" });
    const ticked = await updateImport(h.staffA, uploaded.job.id, { mapping, options: options({ consentConfirmed: true }), expectedVersion: checked.version });
    await startCheck(h.staffA, uploaded.job.id);
    const again = await waitFor(uploaded.job.id, ["checked"]);
    expect(again.version).toBe(ticked.job.version + 1);
    await startCommit(h.staffA, uploaded.job.id, again.version);
    expect((await waitFor(uploaded.job.id, ["done", "failed"])).counts.created).toBe(6);
    const made = await h.owner<{ first_name: string; consented: boolean }[]>`
      select first_name, messaging_consent_at is not null as consented from patients where tenant_id = ${h.tenantA} and first_name like 'ZorbakC%' order by first_name`;
    expect(made.map((row) => row.consented)).toEqual([true, false, true, false, true, false]);
  }, 60_000);

  it("fill-in-the-blanks completes empty fields and never overwrites", async () => {
    const [known] = await h.owner<{ id: string; last_name: string; email: string }[]>`
      select id, last_name, email from patients where id = ${existingIds[0]!}`;
    expect(known).toMatchObject({ last_name: "Old", email: "" });
    const rows = [
      ["First name", "Last name", "Mobile", "Email"],
      ["Changed", "Changed", phoneOf(8_000, 4), `filled@${emailDomain()}`],
      ["Changed", "Changed", phoneOf(8_001, 4), ""],
    ];
    const uploaded = await upload(rows);
    jobIds.push(uploaded.job.id);
    await configure(uploaded.job, guessMapping(uploaded.headers, "customers"), { duplicateRule: "fill_blanks" });
    await startCheck(h.staffA, uploaded.job.id);
    const checked = await waitFor(uploaded.job.id, ["checked"]);
    expect(checked.counts).toMatchObject({ ready: 0, update: 1, skip: 1, error: 0 });
    await startCommit(h.staffA, uploaded.job.id, checked.version);
    const done = await waitFor(uploaded.job.id, ["done"]);
    expect(done.counts).toMatchObject({ created: 0, updated: 1, skipped: 1 });
    const [after] = await h.owner<{ first_name: string; last_name: string; email: string }[]>`select first_name, last_name, email from patients where id = ${existingIds[0]!}`;
    expect(after).toEqual({ first_name: "ZorbakKnown0", last_name: "Old", email: `filled@${emailDomain()}` });
    const [untouched] = await h.owner<{ first_name: string; email: string }[]>`select first_name, email from patients where id = ${existingIds[1]!}`;
    expect(untouched).toEqual({ first_name: "ZorbakKnown1", email: "" });
  }, 60_000);

  it("undoes only what the import made, keeping customers used since and everything from earlier", async () => {
    const jobId = jobIds[0]!;
    const [usedRow] = await h.owner<{ entity_id: string }[]>`select entity_id from import_rows where job_id = ${jobId} and status = 'created' order by row_number limit 1`;
    // One imported customer is used afterwards: they get an appointment.
    const [link] = await h.owner<{ location_id: string; service_id: string; practitioner_id: string }[]>`
      select location.location_id, service.service_id, service.practitioner_id
      from practitioner_services as service
      join practitioner_locations as location on location.tenant_id = service.tenant_id and location.practitioner_id = service.practitioner_id
      where service.tenant_id = ${h.tenantA} limit 1`;
    await h.owner`
      insert into appointments (tenant_id, location_id, patient_id, practitioner_id, service_id, starts_at, ends_at, status, confirmation_status, booking_source,
        form_status, reminder_status, delivery_mode, manage_token_hash, manage_token_ciphertext, location_kind)
      select ${h.tenantA}, ${link!.location_id}, ${usedRow!.entity_id}, ${link!.practitioner_id}, ${link!.service_id},
        now() - interval '40 days', now() - interval '40 days' + interval '30 minutes', 'completed', 'confirmed', 'staff',
        'not_assigned', 'not_scheduled', 'in_person', ${`hash-${h.suffix}`}, 'x', 'in_person'`;
    const [oldBefore] = await h.owner<{ count: number }[]>`select count(*)::int as count from patients where id = any(${existingIds}::text[])`;
    const [importedBefore] = await h.owner<{ count: number }[]>`select count(*)::int as count from patients where tenant_id = ${h.tenantA} and id in (select entity_id from import_rows where job_id = ${jobId} and status = 'created')`;
    expect(importedBefore!.count).toBe(1_899);

    const queued = await startUndo(h.staffA, jobId);
    expect(queued.job.status).toBe("undoing");
    const undone = await waitFor(jobId, ["undone"]);
    expect(undone.undo).toEqual({ removed: 1_898, kept: 1 });
    const [importedAfter] = await h.owner<{ count: number }[]>`select count(*)::int as count from patients where tenant_id = ${h.tenantA} and id in (select entity_id from import_rows where job_id = ${jobId} and status in ('undone', 'created'))`;
    expect(importedAfter!.count).toBe(1);
    const [kept] = await h.owner<{ id: string }[]>`select id from patients where id = ${usedRow!.entity_id}`;
    expect(kept).toBeDefined();
    // The customers that were there before, and the ones the import skipped as duplicates, are untouched.
    const [oldAfter] = await h.owner<{ count: number }[]>`select count(*)::int as count from patients where id = any(${existingIds}::text[])`;
    expect(oldAfter!.count).toBe(oldBefore!.count);
    const [total] = await h.owner<{ count: number }[]>`select count(*)::int as count from patients where tenant_id = ${h.tenantA} and first_name like 'Zorbak%' and first_name !~ 'ZorbakC'`;
    expect(total!.count).toBe(10 + 1);
    const audits = await h.owner<{ action: string }[]>`select action from audit_events where tenant_id = ${h.tenantA} and metadata->>'importId' = ${jobId} order by occurred_at`;
    expect(audits.map((row) => row.action)).toEqual(["import.started", "import.finished", "import.undone"]);
    // Undo works once, and only inside the window.
    await expect(startUndo(h.staffA, jobId)).rejects.toMatchObject({ code: "undo_unavailable" });
  }, 180_000);

  it("refuses to start from a stale or unchecked job, and an expired undo window", async () => {
    const uploaded = await upload([["First name", "Mobile"], ["ZorbakS1", String(base + 30_000)]]);
    jobIds.push(uploaded.job.id);
    await expect(startCommit(h.staffA, uploaded.job.id, uploaded.job.version)).rejects.toMatchObject({ code: "check_needed" });
    await expect(startCheck(h.staffA, uploaded.job.id)).rejects.toMatchObject({ code: "mapping_needed" });
    await expect(updateImport(h.staffA, uploaded.job.id, { mapping: { firstName: 0 }, options: options(), expectedVersion: uploaded.job.version }))
      .rejects.toMatchObject({ status: 400, code: "validation_error" });
    await expect(updateImport(h.staffA, uploaded.job.id, { mapping: { firstName: 0, phone: 1 }, options: options(), expectedVersion: 99 })).rejects.toBeInstanceOf(ApiError);
    const configured = await updateImport(h.staffA, uploaded.job.id, { mapping: { firstName: 0, phone: 1 }, options: options(), expectedVersion: uploaded.job.version });
    await startCheck(h.staffA, uploaded.job.id);
    const checked = await waitFor(uploaded.job.id, ["checked"]);
    // Changing the choices after a check voids it.
    const changed = await updateImport(h.staffA, uploaded.job.id, { mapping: { firstName: 0, phone: 1 }, options: options({ dateFormat: "mm/dd/yyyy" }), expectedVersion: checked.version });
    expect(changed.job.status).toBe("mapped");
    await expect(startCommit(h.staffA, uploaded.job.id, checked.version)).rejects.toMatchObject({ code: "version_conflict" });
    expect(configured.job.version).toBeLessThan(changed.job.version);
    // A finished import past its undo window cannot be undone.
    await h.owner`update import_jobs set status = 'done', undo_until = now() - interval '1 hour' where id = ${uploaded.job.id}`;
    await expect(startUndo(h.staffA, uploaded.job.id)).rejects.toMatchObject({ code: "undo_unavailable" });
    await h.owner`update import_jobs set status = 'mapped' where id = ${uploaded.job.id}`;
    const fileKey = `tenant/${h.tenantA}/import/${uploaded.job.id}`;
    expect(memoryStore.files.has(fileKey)).toBe(true);
    await deleteImport(h.staffA, uploaded.job.id);
    await expect(getImport(h.staffA, uploaded.job.id)).rejects.toMatchObject({ status: 404 });
    // The stored file goes too, through the same removal event every other file uses.
    await h.drain(async () => !memoryStore.files.has(fileKey), 30);
  }, 60_000);

  it("marks a job failed when its batch keeps failing, instead of leaving it waiting", async () => {
    const uploaded = await upload([["First name", "Mobile"], ["ZorbakF1", String(base + 40_000)], ["ZorbakF2", String(base + 40_001)]]);
    jobIds.push(uploaded.job.id);
    await updateImport(h.staffA, uploaded.job.id, { mapping: { firstName: 0, phone: 1 }, options: options(), expectedVersion: uploaded.job.version });
    // A database refusal on every attempt, from the one row the check writes.
    await h.owner`
      create or replace function import_test_refuse_rows() returns trigger language plpgsql as $$
      begin if new.job_id = tg_argv[0] then raise exception 'refused'; end if; return new; end $$`;
    await h.owner.unsafe(`create trigger import_test_refuse_rows before insert on import_rows for each row execute function import_test_refuse_rows('${uploaded.job.id}')`);
    try {
      await startCheck(h.staffA, uploaded.job.id);
      // Every attempt fails; the last one marks the job. Retries are made due at once so the test does not wait.
      for (let round = 0; round < 12; round += 1) {
        await h.owner`update outbox_events set available_at = now() where tenant_id = ${h.tenantA} and aggregate_id = ${uploaded.job.id} and status = 'failed'`;
        for (const claim of await claimOutboxBatch(h.worker, `refuse-${h.suffix}`, 25)) await processClaimedEvent(h.worker, claim, { handlers: h.handlers });
        if ((await getImport(h.staffA, uploaded.job.id)).job.status === "failed") break;
      }
    } finally {
      await h.owner`drop trigger if exists import_test_refuse_rows on import_rows`;
      await h.owner`drop function if exists import_test_refuse_rows()`;
    }
    const failed = (await getImport(h.staffA, uploaded.job.id)).job;
    expect(failed).toMatchObject({ status: "failed", failureCode: "import_failed" });
    const [event] = await h.owner<{ status: string; last_error_code: string }[]>`select status::text, last_error_code from outbox_events where tenant_id = ${h.tenantA} and aggregate_id = ${uploaded.job.id}`;
    expect(event).toEqual({ status: "dead_letter", last_error_code: "import_batch_failed" });
    // A failed job can be removed, and the purge job takes its file.
    expect(memoryStore.files.has(`tenant/${h.tenantA}/import/${uploaded.job.id}`)).toBe(true);
    await purgeImportFiles(h.worker, { store: memoryStore });
    expect(memoryStore.files.has(`tenant/${h.tenantA}/import/${uploaded.job.id}`)).toBe(false);
  }, 60_000);

  it("purges stored files once the undo window has closed, the import failed, or an upload went stale, and not before", async () => {
    const make = async (label: string, status: string, patch: { undoUntil?: string; updatedAt?: string }) => {
      const id = randomUUID();
      const key = `tenant/${h.tenantA}/import/${id}`;
      await memoryStore.put(key, Buffer.from(`sealed-${label}`));
      await h.owner`
        insert into import_jobs (id, tenant_id, kind, file_format, file_key, file_bytes, status, undo_until, updated_at)
        values (${id}, ${h.tenantA}, 'customers', 'csv', ${key}, 10, ${status}, ${patch.undoUntil ?? null}, ${patch.updatedAt ?? new Date().toISOString()})`;
      jobIds.push(id);
      return { id, key };
    };
    const hour = 3_600_000;
    const cases = {
      failed: await make("failed", "failed", {}),
      undone: await make("undone", "undone", {}),
      closed: await make("closed", "done", { undoUntil: new Date(Date.now() - hour).toISOString() }),
      stale: await make("stale", "uploaded", { updatedAt: new Date(Date.now() - 3 * 24 * hour).toISOString() }),
      open: await make("open", "done", { undoUntil: new Date(Date.now() + hour).toISOString() }),
      running: await make("running", "running", { updatedAt: new Date(Date.now() - 5 * 24 * hour).toISOString() }),
      fresh: await make("fresh", "uploaded", {}),
    };
    const summary = await purgeImportFiles(h.worker, { store: memoryStore });
    expect(summary.files).toBeGreaterThanOrEqual(4);
    const kept = (key: string) => memoryStore.files.has(key);
    expect([cases.failed, cases.undone, cases.closed, cases.stale].map((job) => kept(job.key))).toEqual([false, false, false, false]);
    expect([cases.open, cases.running, cases.fresh].map((job) => kept(job.key))).toEqual([true, true, true]);
    const rows = await h.owner<{ id: string; file_key: string | null; status: string; failure_code: string | null }[]>`
      select id, file_key, status, failure_code from import_jobs where id = any(${Object.values(cases).map((job) => job.id)}::text[])`;
    const by = Object.fromEntries(rows.map((row) => [row.id, row]));
    expect(by[cases.closed.id]).toMatchObject({ file_key: null, status: "done" });
    expect(by[cases.stale.id]).toMatchObject({ file_key: null, status: "failed", failure_code: "expired" });
    expect(by[cases.open.id]!.file_key).not.toBeNull();
    // The purge reads across businesses through a definer function that returns ids only, and the web app's role cannot call it.
    await expect(h.runtime`select * from kalendr_import_tenants()`).rejects.toMatchObject({ code: "42501" });
  }, 60_000);

  it("refuses files that are not CSV or spreadsheets, whatever they are called", async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);
    await expect(createImport(h.staffA, { bytes: png, kind: "customers" })).rejects.toMatchObject({ status: 400, code: "unreadable_file" });
    await expect(createImport(h.staffA, { bytes: csvOf([["Name"], ["x"]]), kind: "owners" })).rejects.toMatchObject({ status: 400 });
    await expect(createImport(h.staffA, { bytes: new Uint8Array(10 * 1024 * 1024 + 1), kind: "customers" })).rejects.toMatchObject({ status: 413, code: "file_too_large" });
  });
});
