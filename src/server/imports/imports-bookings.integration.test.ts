/** @vitest-environment node */

import { createHash, randomInt, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { isolatedDatabaseReady } from "@/test/isolated-database";

vi.mock("server-only", () => ({}));
vi.mock("@/server/file-store", async (original) => {
  const actual = await original<typeof import("@/server/file-store")>();
  const { memoryStore } = await import("./testing/memory-store");
  return { ...actual, getFileStore: () => memoryStore };
});

import { createStaffAppointment, listAvailability } from "@/server/appointment-repository";

import type { ImportOptions } from "./contracts";
import { guessMapping } from "./map";
import { createImport, getImport, importErrorFile, listImportRows, startCheck, startCommit, startUndo, updateImport } from "./service";
import { csvOf, openHarness, urls, type Harness } from "./testing/harness";

const describeLocal = isolatedDatabaseReady(urls.runtime, urls.owner, urls.worker) ? describe : describe.skip;
const options = (patch: Partial<ImportOptions> = {}): ImportOptions => ({ dateFormat: "dd/mm/yyyy", duplicateRule: "skip", consentConfirmed: false, sendConfirmations: false, ...patch });

describeLocal("data import: appointments and services", () => {
  let h: Harness;
  const base = 9_300_000_000 + randomInt(0, 4_000) * 100_000;
  const jobIds: string[] = [];
  const patientIds: string[] = [];
  const serviceIds: string[] = [];
  let link: { location_id: string; service_id: string; practitioner_id: string; service_name: string; practitioner_name: string; timezone: string };
  let slots: Array<{ startsAt: string; endsAt: string }> = [];
  const workflowIds: string[] = [];

  const parts = (iso: string) => {
    const format = new Intl.DateTimeFormat("en-GB", { timeZone: link.timezone, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
    const map = Object.fromEntries(format.formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
    return { date: `${map.day}/${map.month}/${map.year}`, time: `${map.hour === "24" ? "00" : map.hour}:${map.minute}` };
  };
  const bookingRow = (phone: string, iso: string, extra: Partial<{ service: string; staff: string }> = {}) => {
    const when = parts(iso);
    return [phone, extra.service ?? link.service_name, extra.staff ?? link.practitioner_name, when.date, when.time];
  };

  async function patient(index: number, channel = "email"): Promise<string> {
    const [row] = await h.owner<{ id: string }[]>`
      insert into patients (tenant_id, first_name, last_name, phone, email, preferred_channel)
      values (${h.tenantA}, ${`Zorbakbook${index}`}, 'Booker', ${`+91 ${base + index}`}, ${`book${index}-${h.suffix}@example.com`}, ${channel}) returning id`;
    patientIds.push(row!.id);
    return row!.id;
  }

  async function runJob(bytes: Uint8Array, kind: "appointments" | "services", patch: Partial<ImportOptions> = {}) {
    const uploaded = await createImport(h.staffA, { bytes, kind });
    jobIds.push(uploaded.job.id);
    await updateImport(h.staffA, uploaded.job.id, { mapping: guessMapping(uploaded.headers, kind), options: options(patch), expectedVersion: uploaded.job.version });
    await startCheck(h.staffA, uploaded.job.id);
    const wait = async (states: string[]) => { await h.drain(async () => states.includes((await getImport(h.staffA, uploaded.job.id)).job.status), 60); return (await getImport(h.staffA, uploaded.job.id)).job; };
    return { id: uploaded.job.id, checked: await wait(["checked", "failed"]), wait };
  }

  /** Lets the worker handle every appointment event for these bookings, so any message they would send has been sent (captured). */
  async function settleAppointmentEvents(appointmentIds: string[]) {
    await h.drain(async () => {
      const [open] = await h.owner<{ count: number }[]>`
        select count(*)::int as count from outbox_events where tenant_id = ${h.tenantA} and aggregate_id = any(${appointmentIds}::text[])
          and status in ('pending', 'processing', 'failed')`;
      return open!.count === 0;
    }, 60);
  }

  beforeAll(async () => {
    h = await openHarness();
    const found = await h.owner<Array<typeof link>>`
      select location.location_id, service.service_id, service.practitioner_id, svc.name as service_name, person.name as practitioner_name, loc.timezone
      from practitioner_services as service
      join practitioner_locations as location on location.tenant_id = service.tenant_id and location.practitioner_id = service.practitioner_id
      join services as svc on svc.tenant_id = service.tenant_id and svc.id = service.service_id and svc.is_active
      join practitioners as person on person.tenant_id = service.tenant_id and person.id = service.practitioner_id and person.is_active
      join locations as loc on loc.tenant_id = service.tenant_id and loc.id = location.location_id and loc.is_active
      join service_locations as sl on sl.tenant_id = service.tenant_id and sl.service_id = service.service_id and sl.location_id = location.location_id
      where service.tenant_id = ${h.tenantA} limit 1`;
    link = found[0]!;
    const day = 86_400_000;
    const listed = await listAvailability({
      clinicSlug: h.staffA.clinicSlug, locationId: link.location_id, serviceId: link.service_id, practitionerId: link.practitioner_id,
      from: new Date(Date.now() + 40 * day).toISOString(), to: new Date(Date.now() + 54 * day).toISOString(),
    });
    // Openings at least two hours apart, so no two chosen times can overlap whatever the service's length or the time of day.
    slots = listed.filter((slot, index) => index === 0 || new Date(slot.startsAt).getTime() - new Date(listed[index - 1]!.startsAt).getTime() >= 0).reduce<typeof listed>((kept, slot) => {
      const last = kept[kept.length - 1];
      if (!last || new Date(slot.startsAt).getTime() - new Date(last.startsAt).getTime() >= 2 * 3_600_000) kept.push(slot);
      return kept;
    }, []);
    if (slots.length < 36) throw new Error("Expected open slots to import into");
    // Two message workflows (feature 5) are switched on for the business: a confirmation when booked and a reminder before the visit.
    for (const [name, trigger, offset] of [["Import test confirmation", "booked", 0], ["Import test reminder", "before_start", 60]] as const) {
      const [workflow] = await h.owner<{ id: string }[]>`
        insert into workflows (tenant_id, name, trigger, offset_minutes, active) values (${h.tenantA}, ${name}, ${trigger}, ${offset}, true) returning id`;
      await h.owner`insert into workflow_steps (tenant_id, workflow_id, position, channel, subject, body) values (${h.tenantA}, ${workflow!.id}, 0, 'email', 'Hello', 'Hello')`;
      workflowIds.push(workflow!.id);
    }
  });

  afterAll(async () => {
    if (!h) return;
    await h.owner.begin(async (tx) => {
      // Only what an import made: rows it skipped point at records that were already there, and those are never touched.
      const imported = await tx<{ entity_id: string }[]>`select entity_id from import_rows where job_id = any(${jobIds}::text[]) and status in ('created', 'undone') and entity_id is not null`;
      const ids = imported.map((row) => row.entity_id);
      const bookings = await tx<{ id: string }[]>`select id from appointments where tenant_id = ${h.tenantA} and (id = any(${ids}::text[]) or patient_id = any(${patientIds}::text[]))`;
      const bookingIds = bookings.map((row) => row.id);
      await tx`delete from outbox_events where tenant_id = ${h.tenantA} and (aggregate_id = any(${bookingIds}::text[]) or aggregate_id = any(${jobIds}::text[]))`;
      await tx`delete from notifications where tenant_id = ${h.tenantA} and appointment_id = any(${bookingIds}::text[])`;
      await tx`delete from scheduled_messages where tenant_id = ${h.tenantA} and (appointment_id = any(${bookingIds}::text[]) or workflow_id = any(${workflowIds}::text[]))`;
      await tx`delete from audit_events where tenant_id = ${h.tenantA} and (appointment_id = any(${bookingIds}::text[]) or metadata->>'importId' = any(${jobIds}::text[]))`;
      await tx`delete from resource_reservations where tenant_id = ${h.tenantA} and appointment_id = any(${bookingIds}::text[])`;
      await tx`delete from queue_tickets where tenant_id = ${h.tenantA} and appointment_id = any(${bookingIds}::text[])`;
      await tx`delete from appointments where tenant_id = ${h.tenantA} and id = any(${bookingIds}::text[])`;
      await tx`delete from idempotency_keys where tenant_id = ${h.tenantA} and (key like 'import:%' or created_at > now() - interval '30 minutes')`;
      await tx`delete from consent_records where (select set_config('kalendr.consent_erase', 'on', true)) = 'on' and (tenant_id, patient_id) in (select tenant_id, id from patients where tenant_id = ${h.tenantA} and id = any(${patientIds}::text[]))`;
      await tx`delete from patients where tenant_id = ${h.tenantA} and id = any(${patientIds}::text[])`;
      const mine = await tx<{ id: string }[]>`select id from services where tenant_id = ${h.tenantA} and id = any(${[...ids, ...serviceIds]}::text[]) and name like 'Zorbak%'`;
      for (const table of ["service_durations", "service_location_options", "service_locations", "practitioner_services"]) {
        await tx`delete from ${tx(table)} where tenant_id = ${h.tenantA} and service_id = any(${mine.map((row) => row.id)}::text[])`;
      }
      await tx`delete from services where tenant_id = ${h.tenantA} and id = any(${mine.map((row) => row.id)}::text[])`;
      await tx`delete from workflows where tenant_id = ${h.tenantA} and id = any(${workflowIds}::text[])`;
      await tx`delete from import_jobs where id = any(${jobIds}::text[])`;
    }).catch((error: unknown) => console.error("import test cleanup failed", error));
    await h.close();
  });

  it("books through the real commit, refuses clashes, sends no confirmation, and undoes quietly", async () => {
    const [a, b, c, taken, stranger] = [await patient(1), await patient(2), await patient(3), await patient(4), await patient(5)];
    expect([a, b, c, stranger]).toHaveLength(4);
    // An existing booking the file will clash with.
    const existing = await createStaffAppointment(h.staffA, {
      clinicSlug: h.staffA.clinicSlug, locationId: link.location_id, serviceId: link.service_id, practitionerId: link.practitioner_id,
      startsAt: slots[20]!.startsAt, source: "desk", patientId: taken,
    }, randomUUID(), createHash("sha256").update(randomUUID()).digest("hex"));
    const when = (slot: number) => slots[slot]!.startsAt;
    const rows = [
      ["Mobile", "Service", "Staff", "Date", "Time"],
      bookingRow(`+91 ${base + 1}`, when(2)),
      bookingRow(`+91 ${base + 2}`, when(6)),
      bookingRow(`+91 ${base + 3}`, when(10)),
      // The same staff member and time as row 1, inside the file: the first wins, the second clashes.
      bookingRow(`+91 ${base + 2}`, when(2)),
      // Clashes with the booking made above.
      bookingRow(`+91 ${base + 5}`, when(20)),
      // No customer with this number.
      bookingRow("+91 90000 11111", when(14)),
      // Nobody with this name, nothing with this name.
      bookingRow(`+91 ${base + 1}`, when(16), { staff: "Nobody Here" }),
      bookingRow(`+91 ${base + 1}`, when(16), { service: "No Such Service" }),
      // Already passed.
      bookingRow(`+91 ${base + 1}`, new Date(Date.now() - 86_400_000).toISOString()),
      // A time the service is not offered (middle of the night).
      [`+91 ${base + 1}`, link.service_name, link.practitioner_name, parts(when(24)).date, "03:00"],
    ];
    const { id, checked, wait } = await runJob(csvOf(rows), "appointments");
    expect(checked.status).toBe("checked");
    expect(checked.counts).toMatchObject({ ready: 3, error: 7, update: 0, skip: 0 });
    const errors = await listImportRows(h.staffA, id, { status: "error", limit: 50 });
    expect(errors.rows.map((row) => [row.rowNumber, row.errorCode])).toEqual([
      [4, "clash"], [5, "clash"], [6, "unknown_customer"], [7, "unknown_staff"], [8, "unknown_service"], [9, "past_time"], [10, "slot_unavailable"],
    ]);
    // A dry run books nothing.
    const [dry] = await h.owner<{ count: number }[]>`select count(*)::int as count from appointments where tenant_id = ${h.tenantA} and patient_id = any(${[a, b, c]}::text[])`;
    expect(dry!.count).toBe(0);

    await startCommit(h.staffA, id, checked.version);
    const done = await wait(["done", "failed"]);
    expect(done.status).toBe("done");
    expect(done.counts).toMatchObject({ created: 3, failed: 0, error: 7 });
    const booked = await h.owner<{ id: string; status: string; version: number; booking_source: string; reminder_status: string; ends_at: Date; starts_at: Date }[]>`
      select id, status::text, version, booking_source::text, reminder_status::text, starts_at, ends_at from appointments
      where tenant_id = ${h.tenantA} and patient_id = any(${[a, b, c]}::text[]) order by starts_at`;
    expect(booked.map((row) => row.status)).toEqual(["booked", "booked", "booked"]);
    expect(booked.map((row) => row.starts_at.toISOString())).toEqual([when(2), when(6), when(10)]);
    expect(booked.every((row) => row.reminder_status === "not_scheduled")).toBe(true);
    // The same reservation the desk makes: a clash would be refused by the database itself.
    const [reserved] = await h.owner<{ count: number }[]>`select count(*)::int as count from resource_reservations where tenant_id = ${h.tenantA} and appointment_id = any(${booked.map((row) => row.id)}::text[]) and state <> 'released'`;
    expect(reserved!.count).toBeGreaterThanOrEqual(3);
    const events = await h.owner<{ payload: { notifyCustomer?: boolean } }[]>`select payload from outbox_events where tenant_id = ${h.tenantA} and aggregate_id = any(${booked.map((row) => row.id)}::text[]) and event_type = 'appointment.created'`;
    expect(events).toHaveLength(3);
    expect(events.every((event) => event.payload.notifyCustomer === false)).toBe(true);

    // The real handlers run for those events, and no confirmation or reminder comes out, with two message workflows switched on.
    await settleAppointmentEvents(booked.map((row) => row.id));
    const [sent] = await h.owner<{ count: number }[]>`select count(*)::int as count from notifications where tenant_id = ${h.tenantA} and appointment_id = any(${booked.map((row) => row.id)}::text[])`;
    expect(sent!.count).toBe(0);
    const [planned] = await h.owner<{ count: number }[]>`select count(*)::int as count from scheduled_messages where tenant_id = ${h.tenantA} and appointment_id = any(${booked.map((row) => row.id)}::text[])`;
    expect(planned!.count).toBe(0);
    // The error file lists the seven rows that did not go in.
    const csv = (await importErrorFile(h.staffA, id)).csv.replace(/^﻿/, "").trim().split("\r\n");
    expect(csv).toHaveLength(8);
    expect(csv[0]).toBe("Mobile,Service,Staff,Date,Time,reason");

    // One of the three is edited afterwards (a person moved it), so undo leaves it. The others are cancelled, quietly.
    await h.owner`update appointments set version = version + 1 where id = ${booked[0]!.id}`;
    await startUndo(h.staffA, id);
    const undone = await wait(["undone"]);
    expect(undone.undo).toEqual({ removed: 2, kept: 1 });
    const after = await h.owner<{ id: string; status: string }[]>`select id, status::text from appointments where id = any(${booked.map((row) => row.id)}::text[]) order by starts_at`;
    expect(after.map((row) => row.status)).toEqual(["booked", "cancelled", "cancelled"]);
    const released = await h.owner<{ state: string }[]>`select state::text from resource_reservations where appointment_id = ${booked[1]!.id}`;
    expect(released.every((row) => row.state === "released")).toBe(true);
    await settleAppointmentEvents(booked.map((row) => row.id));
    const [afterUndo] = await h.owner<{ count: number }[]>`select count(*)::int as count from notifications where tenant_id = ${h.tenantA} and appointment_id = any(${booked.map((row) => row.id)}::text[])`;
    expect(afterUndo!.count).toBe(0);
    const [plannedAfter] = await h.owner<{ count: number }[]>`select count(*)::int as count from scheduled_messages where tenant_id = ${h.tenantA} and appointment_id = any(${booked.map((row) => row.id)}::text[]) and status <> 'cancelled'`;
    expect(plannedAfter!.count).toBe(0);
    // The booking that was already there is untouched.
    const [still] = await h.owner<{ status: string }[]>`select status::text from appointments where id = ${existing.appointmentId}`;
    expect(still!.status).toBe("booked");
  }, 180_000);

  it("sends the normal confirmation when the owner asks for it", async () => {
    const who = await patient(11);
    const slot = slots[26]!;
    const { id, checked, wait } = await runJob(csvOf([["Mobile", "Service", "Staff", "Date", "Time"], bookingRow(`+91 ${base + 11}`, slot.startsAt)]), "appointments", { sendConfirmations: true });
    expect(checked.counts.ready).toBe(1);
    await startCommit(h.staffA, id, checked.version);
    await wait(["done"]);
    const [made] = await h.owner<{ id: string; reminder_status: string }[]>`select id, reminder_status::text from appointments where tenant_id = ${h.tenantA} and patient_id = ${who}`;
    expect(made!.reminder_status).toBe("queued");
    await settleAppointmentEvents([made!.id]);
    const [sent] = await h.owner<{ count: number }[]>`select count(*)::int as count from notifications where tenant_id = ${h.tenantA} and appointment_id = ${made!.id}`;
    expect(sent!.count).toBeGreaterThan(0);
    // The control for the quiet test: with the owner's say-so, the same workflows do plan their messages.
    const [planned] = await h.owner<{ count: number }[]>`select count(*)::int as count from scheduled_messages where tenant_id = ${h.tenantA} and appointment_id = ${made!.id}`;
    expect(planned!.count).toBeGreaterThan(0);
  }, 90_000);

  it("a booking that was free at the check but taken before the import ran fails alone", async () => {
    const [p1, p2] = [await patient(21), await patient(22)];
    const { id, checked, wait } = await runJob(csvOf([
      ["Mobile", "Service", "Staff", "Date", "Time"],
      bookingRow(`+91 ${base + 21}`, slots[28]!.startsAt),
      bookingRow(`+91 ${base + 22}`, slots[34]!.startsAt),
    ]), "appointments");
    expect(checked.counts.ready).toBe(2);
    // Someone books the first time in between.
    await createStaffAppointment(h.staffA, {
      clinicSlug: h.staffA.clinicSlug, locationId: link.location_id, serviceId: link.service_id, practitionerId: link.practitioner_id,
      startsAt: slots[28]!.startsAt, source: "desk", patientId: p2,
    }, randomUUID(), createHash("sha256").update(randomUUID()).digest("hex"));
    await startCommit(h.staffA, id, checked.version);
    const done = await wait(["done"]);
    expect(done.counts).toMatchObject({ created: 1, failed: 1 });
    const failed = await listImportRows(h.staffA, id, { status: "failed", limit: 10 });
    expect(failed.rows[0]).toMatchObject({ rowNumber: 1, errorCode: "slot_unavailable" });
    const [mine] = await h.owner<{ count: number }[]>`select count(*)::int as count from appointments where tenant_id = ${h.tenantA} and patient_id = ${p1}`;
    expect(mine!.count).toBe(0);
  }, 90_000);

  it("imports services the way settings creates them, then undoes only the untouched ones", async () => {
    const rows = [
      ["Name", "Duration", "Price", "Category"],
      [`Zorbak Cut ${h.suffix}`, "30", "Rs 500", "Hair"],
      [`Zorbak Colour ${h.suffix}`, "1h 30m", "From 2000", "Hair"],
      [`Zorbak Beard ${h.suffix}`, "15 min", "", ""],
      [`zorbak cut ${h.suffix}`.toUpperCase(), "30", "500", "Hair"],
      [link.service_name, "30", "", ""],
      [`Zorbak Broken ${h.suffix}`, "soon", "", ""],
    ];
    const { id, checked, wait } = await runJob(csvOf(rows), "services");
    expect(checked.counts).toMatchObject({ ready: 3, skip: 2, error: 1, update: 0 });
    await startCommit(h.staffA, id, checked.version);
    const done = await wait(["done"]);
    expect(done.counts).toMatchObject({ created: 3, skipped: 2, failed: 0 });
    const made = await h.owner<{ id: string; name: string; slug: string; is_active: boolean; visibility: string; price_label: string | null; price_minor: number | null; durations: number; locations: number; staff: number }[]>`
      select s.id, s.name, s.slug, s.is_active, s.visibility, s.price_label, s.price_minor,
        (select count(*)::int from service_durations d where d.service_id = s.id and d.is_default) as durations,
        (select count(*)::int from service_locations l where l.service_id = s.id) as locations,
        (select count(*)::int from practitioner_services p where p.service_id = s.id) as staff
      from services s where s.tenant_id = ${h.tenantA} and s.id in (select entity_id from import_rows where job_id = ${id} and status = 'created') order by s.name`;
    expect(made).toHaveLength(3);
    expect(made.every((row) => row.slug.length > 0 && row.is_active && row.visibility === "listed" && row.durations === 1 && row.locations >= 1 && row.staff >= 1)).toBe(true);
    expect(made.find((row) => row.name.includes("Cut"))).toMatchObject({ price_label: "₹500", price_minor: 50_000 });
    expect(made.find((row) => row.name.includes("Colour"))).toMatchObject({ price_label: "From 2000", price_minor: null });
    serviceIds.push(...made.map((row) => row.id));

    // The owner edits one afterwards; undo leaves it.
    await h.owner`update services set version = version + 1, updated_at = now() + interval '1 minute' where id = ${made[0]!.id}`;
    await startUndo(h.staffA, id);
    const undone = await wait(["undone"]);
    expect(undone.undo).toEqual({ removed: 2, kept: 1 });
    const left = await h.owner<{ id: string }[]>`select id from services where id = any(${made.map((row) => row.id)}::text[])`;
    expect(left.map((row) => row.id)).toEqual([made[0]!.id]);
    // The service that was already there is untouched.
    const [old] = await h.owner<{ count: number }[]>`select count(*)::int as count from services where tenant_id = ${h.tenantA} and name = ${link.service_name}`;
    expect(old!.count).toBeGreaterThanOrEqual(1);
  }, 90_000);
});
