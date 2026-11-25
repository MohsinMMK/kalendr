import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { requireDatabase, withTenant } from "@/db/client";
import { patientRecordAccess } from "@/db/schema";
import { maskContact } from "@/lib/patient-contact";
import type {
  PortalPerson,
  PortalRecord,
  PortalRecordAccess,
  PortalRecordDetail,
  PortalSnapshot,
  PortalProvider,
  PortalVisit,
  VisitRecordKind,
} from "@/lib/visit-records";
import { profileWords } from "@/lib/terminology";

import { ApiError } from "./api-error";
import { customerProfile, featureOffError, loadBusinessProfile, loadBusinessProfileIn } from "./business-profile";
import type { PatientAccount } from "./patient-auth";
import { loadMediaUrlsIn } from "./media";
import { loadRecordKeys, openText } from "./record-crypto";
import { loadRecordFiles, readRecordFile, writeRecordAudit, type RecordFileContent } from "./visit-records";

const maxIdentityAttempts = 5;

interface PersonRow extends Record<string, unknown> {
  tenant_id: string;
  clinic_slug: string;
  clinic_name: string;
  patient_id: string;
}

const iso = (value: Date | string) => new Date(value).toISOString();

async function loadPeople(accountId: string): Promise<PersonRow[]> {
  return requireDatabase().execute<PersonRow>(sql`select * from kalendr_portal_people(${accountId})`);
}

function hasConfirmedAccess(accountId: string): ReturnType<typeof sql> {
  return sql`exists (
    select 1 from patient_record_access as access
    where access.tenant_id = record.tenant_id and access.patient_id = record.patient_id
      and access.account_id = ${accountId} and access.confirmed_at is not null
  )`;
}

function accessState(row: { date_of_birth: string | null; confirmed_at: unknown; requested_at: unknown; failed_attempts: number | null }): PortalRecordAccess {
  if (row.confirmed_at) return "open";
  if (row.requested_at) return "requested";
  if (!row.date_of_birth || (row.failed_attempts ?? 0) >= maxIdentityAttempts) return "ask_clinic";
  return "date_of_birth";
}

export async function getPortalSnapshot(account: PatientAccount): Promise<PortalSnapshot> {
  const peopleRows = await loadPeople(account.id);
  const snapshot: PortalSnapshot = {
    contact: maskContact(account.contactKind, account.contactValue),
    people: [],
    visits: [],
    providers: [],
    records: [],
    profiles: {},
  };
  const tenants = [...new Map(peopleRows.map((row) => [row.tenant_id, row])).values()];
  for (const tenant of tenants) {
    const patientIds = peopleRows.filter((row) => row.tenant_id === tenant.tenant_id).map((row) => row.patient_id);
    const idList = sql.join(patientIds.map((id) => sql`${id}`), sql`, `);
    await withTenant(tenant.tenant_id, async (transaction) => {
      const profile = await loadBusinessProfileIn(transaction, tenant.tenant_id);
      snapshot.profiles[tenant.clinic_slug] = customerProfile(profile);
      const people = await transaction.execute<{
        id: string;
        first_name: string;
        last_name: string;
        is_dependent: boolean;
        date_of_birth: string | null;
        confirmed_at: unknown;
        requested_at: unknown;
        failed_attempts: number | null;
      }>(sql`
        select patient.id, patient.first_name, patient.last_name, patient.is_dependent, patient.date_of_birth::text as date_of_birth,
          access.confirmed_at, access.requested_at, access.failed_attempts
        from patients as patient
        left join patient_record_access as access
          on access.tenant_id = patient.tenant_id and access.patient_id = patient.id and access.account_id = ${account.id}
        where patient.tenant_id = ${tenant.tenant_id} and patient.id in (${idList})
        order by patient.is_dependent, patient.first_name
      `);
      snapshot.people.push(...people.map((row): PortalPerson => ({
        clinicSlug: tenant.clinic_slug,
        clinicName: tenant.clinic_name,
        patientId: row.id,
        name: `${row.first_name} ${row.last_name}`.trim(),
        isDependent: row.is_dependent,
        access: accessState(row),
      })));
      const visits = await transaction.execute<{
        id: string;
        patient_id: string;
        service_id: string;
        service_name: string;
        practitioner_id: string;
        practitioner_name: string;
        location_name: string;
        timezone: string;
        starts_at: Date | string;
        status: string;
      }>(sql`
        select appointment.id, appointment.patient_id, service.id as service_id, service.name as service_name,
          practitioner.id as practitioner_id, practitioner.name as practitioner_name,
          location.name as location_name, location.timezone, appointment.starts_at, appointment.status
        from appointments as appointment
        join services as service on service.tenant_id = appointment.tenant_id and service.id = appointment.service_id
        join practitioners as practitioner on practitioner.tenant_id = appointment.tenant_id and practitioner.id = appointment.practitioner_id
        join locations as location on location.tenant_id = appointment.tenant_id and location.id = appointment.location_id
        where appointment.tenant_id = ${tenant.tenant_id} and appointment.patient_id in (${idList})
          and appointment.status not in ('entered_in_error', 'expired')
        order by appointment.starts_at desc, appointment.id
        limit 200
      `);
      snapshot.visits.push(...visits.map((row): PortalVisit => ({
        id: row.id,
        clinicSlug: tenant.clinic_slug,
        clinicName: tenant.clinic_name,
        patientId: row.patient_id,
        serviceName: row.service_name,
        practitionerName: row.practitioner_name,
        practitionerId: row.practitioner_id,
        serviceId: row.service_id,
        locationName: row.location_name,
        startsAt: iso(row.starts_at),
        timezone: row.timezone,
        status: row.status,
        href: `/portal/visits/${encodeURIComponent(tenant.clinic_slug)}/${encodeURIComponent(row.id)}`,
      })));
      const seenIds = [...new Set(visits.map((row) => row.practitioner_id))];
      if (seenIds.length > 0) {
        const seen = await transaction.execute<{ id: string; title: string; specialty: string; photo_data_url: string | null; is_active: boolean }>(sql`
          select id, title, specialty, photo_data_url, is_active
          from practitioners
          where tenant_id = ${tenant.tenant_id} and id in (${sql.join(seenIds.map((id) => sql`${id}`), sql`, `)})
        `);
        const { practitionerPhotos } = await loadMediaUrlsIn(transaction, tenant.tenant_id, tenant.clinic_slug);
        snapshot.providers?.push(...seen.map((row): PortalProvider => ({
          clinicSlug: tenant.clinic_slug,
          id: row.id,
          role: [row.title, row.specialty].filter(Boolean).join(" · "),
          photoUrl: practitionerPhotos.get(row.id) ?? row.photo_data_url,
          isActive: row.is_active,
        })));
      }
      if (!profile.features.records) return;
      await loadRecordKeys(transaction, tenant.tenant_id);
      const records = await transaction.execute<{
        id: string;
        patient_id: string;
        kind: VisitRecordKind;
        title_ciphertext: string;
        practitioner_name: string | null;
        shared_at: Date | string;
        file_count: number;
      }>(sql`
        select record.id, record.patient_id, record.kind, record.title_ciphertext, practitioner.name as practitioner_name,
          record.shared_at,
          (select count(*)::int from visit_record_files as file
            where file.tenant_id = record.tenant_id and file.record_id = record.id
              and file.scan_status in ('clean', 'skipped')) as file_count
        from visit_records as record
        left join practitioners as practitioner
          on practitioner.tenant_id = record.tenant_id and practitioner.id = record.practitioner_id
        where record.tenant_id = ${tenant.tenant_id} and record.patient_id in (${idList})
          and record.status = 'shared' and ${hasConfirmedAccess(account.id)}
        order by record.shared_at desc, record.id
        limit 200
      `);
      snapshot.records.push(...records.map((row): PortalRecord => ({
        id: row.id,
        clinicSlug: tenant.clinic_slug,
        clinicName: tenant.clinic_name,
        patientId: row.patient_id,
        kind: row.kind,
        title: openText(tenant.tenant_id, row.title_ciphertext),
        practitionerName: row.practitioner_name,
        sharedAt: iso(row.shared_at),
        fileCount: row.file_count,
      })));
    });
  }
  return snapshot;
}

async function requirePerson(account: PatientAccount, clinicSlug: string, patientId: string): Promise<PersonRow> {
  const person = (await loadPeople(account.id)).find((row) => row.clinic_slug === clinicSlug && row.patient_id === patientId);
  if (!person) throw new ApiError(404, "patient_not_found", "That person isn't linked to this sign-in.");
  return person;
}

/**
 * Proves the signed-in person may see this patient's documents. Holding a phone or inbox isn't enough, because
 * families share both. With no date of birth on file, or after too many wrong tries, only the clinic can confirm.
 */
export async function confirmPortalIdentity(account: PatientAccount, clinicSlug: string, patientId: string, dateOfBirth: string): Promise<void> {
  const person = await requirePerson(account, clinicSlug, patientId);
  const outcome = await withTenant(person.tenant_id, async (transaction) => {
    const access = await lockAccessRow(transaction, person, account.id);
    if (access.confirmed_at) return "ok" as const;
    const [patient] = await transaction.execute<{ date_of_birth: string | null }>(sql`
      select date_of_birth::text as date_of_birth from patients where tenant_id = ${person.tenant_id} and id = ${patientId}
    `);
    if (!patient?.date_of_birth || access.failed_attempts >= maxIdentityAttempts) return "ask_clinic" as const;
    const actor = { type: "patient" as const, id: account.id };
    if (patient.date_of_birth !== dateOfBirth) {
      await transaction.update(patientRecordAccess).set({ failedAttempts: access.failed_attempts + 1, updatedAt: new Date() })
        .where(and(eq(patientRecordAccess.tenantId, person.tenant_id), eq(patientRecordAccess.id, access.id)));
      await writeRecordAudit(transaction, person.tenant_id, actor, "record.access.date_of_birth", { patientId }, "denied");
      return access.failed_attempts + 1 >= maxIdentityAttempts ? "ask_clinic" as const : "wrong" as const;
    }
    await transaction.update(patientRecordAccess).set({ confirmedAt: new Date(), confirmedMethod: "date_of_birth", updatedAt: new Date() })
      .where(and(eq(patientRecordAccess.tenantId, person.tenant_id), eq(patientRecordAccess.id, access.id)));
    await writeRecordAudit(transaction, person.tenant_id, actor, "record.access.date_of_birth", { patientId });
    return "ok" as const;
  });
  // Thrown out here so the failed attempt above commits.
  if (outcome === "ok") return;
  const t = profileWords(await loadBusinessProfile(person.tenant_id));
  if (outcome === "wrong") throw new ApiError(400, "identity_mismatch", `That date of birth doesn't match the ${t.business}'s record.`);
  throw new ApiError(409, "identity_needs_clinic", `Please ask the ${t.business} to confirm you.`);
}

async function lockAccessRow(transaction: Parameters<Parameters<typeof withTenant>[1]>[0], person: PersonRow, accountId: string) {
  await transaction.insert(patientRecordAccess)
    .values({ tenantId: person.tenant_id, patientId: person.patient_id, accountId })
    .onConflictDoNothing();
  const rows = await transaction.execute<{ id: string; confirmed_at: unknown; failed_attempts: number }>(sql`
    select id, confirmed_at, failed_attempts from patient_record_access
    where tenant_id = ${person.tenant_id} and patient_id = ${person.patient_id} and account_id = ${accountId}
    for update
  `);
  const row = rows[0];
  if (!row) throw new Error("Patient access row is missing");
  return row;
}

export async function requestPortalConfirmation(account: PatientAccount, clinicSlug: string, patientId: string): Promise<void> {
  const person = await requirePerson(account, clinicSlug, patientId);
  await withTenant(person.tenant_id, async (transaction) => {
    const access = await lockAccessRow(transaction, person, account.id);
    if (access.confirmed_at) return;
    await transaction.update(patientRecordAccess).set({ requestedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(patientRecordAccess.tenantId, person.tenant_id), eq(patientRecordAccess.id, access.id)));
    await writeRecordAudit(transaction, person.tenant_id, { type: "patient", id: account.id }, "record.access.request", { patientId });
  });
}

/** A visit this account may act on, or a 404 that reveals nothing about visits belonging to anyone else. */
export async function resolvePortalVisit(account: PatientAccount, clinicSlug: string, appointmentId: string): Promise<{ tenantId: string; appointmentId: string }> {
  const people = (await loadPeople(account.id)).filter((row) => row.clinic_slug === clinicSlug);
  const notFound = () => new ApiError(404, "appointment_not_found", "Appointment not found.");
  const tenantId = people[0]?.tenant_id;
  if (!tenantId) throw notFound();
  const idList = sql.join(people.map((row) => sql`${row.patient_id}`), sql`, `);
  const rows = await withTenant(tenantId, (transaction) => transaction.execute(sql`
    select id from appointments where tenant_id = ${tenantId} and id = ${appointmentId} and patient_id in (${idList})
  `));
  if (!rows.length) throw notFound();
  return { tenantId, appointmentId };
}

async function requireTenantForRecord(account: PatientAccount, clinicSlug: string): Promise<{ tenantId: string; clinicName: string; patientIds: string[] }> {
  const people = (await loadPeople(account.id)).filter((row) => row.clinic_slug === clinicSlug);
  const first = people[0];
  if (!first) throw new ApiError(404, "record_not_found", "Record not found.");
  if (!(await loadBusinessProfile(first.tenant_id)).features.records) throw featureOffError("records");
  return { tenantId: first.tenant_id, clinicName: first.clinic_name, patientIds: people.map((row) => row.patient_id) };
}

function visibleRecordClause(tenantId: string, recordId: string, patientIds: string[], accountId: string) {
  return sql`
    record.tenant_id = ${tenantId} and record.id = ${recordId} and record.status = 'shared'
    and record.patient_id in (${sql.join(patientIds.map((id) => sql`${id}`), sql`, `)})
    and ${hasConfirmedAccess(accountId)}
  `;
}

export async function getPortalRecord(account: PatientAccount, clinicSlug: string, recordId: string): Promise<PortalRecordDetail> {
  const { tenantId, clinicName, patientIds } = await requireTenantForRecord(account, clinicSlug);
  return withTenant(tenantId, async (transaction) => {
    const rows = await transaction.execute<{
      id: string;
      patient_id: string;
      kind: VisitRecordKind;
      title_ciphertext: string;
      body_ciphertext: string;
      practitioner_name: string | null;
      shared_at: Date | string;
    }>(sql`
      select record.id, record.patient_id, record.kind, record.title_ciphertext, record.body_ciphertext,
        practitioner.name as practitioner_name, record.shared_at
      from visit_records as record
      left join practitioners as practitioner
        on practitioner.tenant_id = record.tenant_id and practitioner.id = record.practitioner_id
      where ${visibleRecordClause(tenantId, recordId, patientIds, account.id)}
    `);
    const row = rows[0];
    if (!row) throw new ApiError(404, "record_not_found", "Record not found.");
    await writeRecordAudit(transaction, tenantId, { type: "patient", id: account.id }, "record.view", { recordId });
    await loadRecordKeys(transaction, tenantId);
    const files = await loadRecordFiles(transaction, tenantId, recordId, { readyOnly: true });
    return {
      id: row.id,
      clinicSlug,
      clinicName,
      patientId: row.patient_id,
      kind: row.kind,
      title: openText(tenantId, row.title_ciphertext),
      practitionerName: row.practitioner_name,
      sharedAt: iso(row.shared_at),
      fileCount: files.length,
      body: openText(tenantId, row.body_ciphertext),
      files,
    };
  });
}

export async function readPortalRecordFile(account: PatientAccount, clinicSlug: string, recordId: string, fileId: string): Promise<RecordFileContent> {
  const { tenantId, patientIds } = await requireTenantForRecord(account, clinicSlug);
  return readRecordFile(tenantId, recordId, fileId, { type: "patient", id: account.id }, async (transaction) => {
    const rows = await transaction.execute(sql`
      select record.id from visit_records as record where ${visibleRecordClause(tenantId, recordId, patientIds, account.id)}
    `);
    if (!rows.length) throw new ApiError(404, "record_not_found", "Record not found.");
  });
}
