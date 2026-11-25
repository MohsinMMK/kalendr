import { demoPatients } from "@/lib/demo-data";
import { normalizeContact, type PatientContactKind } from "@/lib/patient-contact";
import { detectRecordContentType, cleanFileName, maxRecordFileBytes } from "@/lib/record-files";
import type {
  VisitRecordSummary,
  PortalPerson,
  PortalRecord,
  PortalRecordAccess,
  PortalRecordDetail,
  RecordAccessEntry,
  RecordAccessRequest,
  RecordsList,
  VisitRecordDetail,
  VisitRecordInput,
} from "@/lib/visit-records";

/**
 * The browser preview of records and the patient portal. Everything is fictional and lives in this tab, so there is
 * no account, encryption or access control to speak of here. The database version is in src/server.
 */

const stateKey = "kalendr-preview-records-v1";
const contactKey = "kalendr-preview-portal-contact-v1";
const maxPreviewBytes = 2 * 1_024 * 1_024;
const maxDobAttempts = 5;

export const previewPortalCode = "246810";
export const previewPortalEmail = "ananya.rao@example.com";
export const previewPortalPhone = "+91 98450 12345";
export const previewAnanyaDateOfBirth = "1992-03-14";
export const previewClinic = { slug: "indiranagar-dental", name: "Indiranagar Dental" };

const samplePdf = "data:application/pdf;base64,JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCA0MDAgMjAwXS9SZXNvdXJjZXM8PC9Gb250PDwvRjEgNSAwIFI+Pj4+L0NvbnRlbnRzIDQgMCBSPj4KZW5kb2JqCjQgMCBvYmoKPDwvTGVuZ3RoIDU5Pj4Kc3RyZWFtCkJUIC9GMSAxNCBUZiAzMCAxNTAgVGQgKFNhbXBsZSByZXBvcnQgLSBwcmV2aWV3IG9ubHkpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PC9UeXBlL0ZvbnQvU3VidHlwZS9UeXBlMS9CYXNlRm9udC9IZWx2ZXRpY2E+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTQgMDAwMDAgbiAKMDAwMDAwMDEwNSAwMDAwMCBuIAowMDAwMDAwMjE3IDAwMDAwIG4gCjAwMDAwMDAzMjQgMDAwMDAgbiAKdHJhaWxlcgo8PC9TaXplIDYvUm9vdCAxIDAgUj4+CnN0YXJ0eHJlZgozODcKJSVFT0YK";

const ananya = { id: "patient_ananya", name: "Ananya Rao" };
const kabir = { id: "patient_kabir", name: "Kabir Rao" };

interface AccessState {
  access: PortalRecordAccess;
  failedAttempts: number;
}

interface PreviewState {
  records: VisitRecordDetail[];
  requests: RecordAccessRequest[];
  access: Record<string, AccessState>;
}

function seedRecord(fields: Partial<VisitRecordDetail> & Pick<VisitRecordDetail, "id" | "patientId" | "patientName" | "kind" | "title" | "body" | "createdAt">): VisitRecordDetail {
  const shared = fields.status !== "draft";
  return {
    appointmentId: null,
    practitionerName: "Mira Sen",
    status: "shared",
    sharedAt: shared ? fields.createdAt : null,
    fileCount: fields.files?.length ?? 0,
    files: [],
    everShared: shared,
    accessLog: [
      ...(shared ? [{ id: `${fields.id}-share`, who: "Mira Sen", action: "Shared with patient", occurredAt: fields.createdAt }] : []),
      { id: `${fields.id}-create`, who: "Mira Sen", action: "Created", occurredAt: fields.createdAt },
    ],
    ...fields,
  };
}

function seedState(): PreviewState {
  return {
    records: [
      seedRecord({
        id: "record_ananya_note",
        patientId: ananya.id,
        patientName: ananya.name,
        kind: "note",
        title: "Cleaning visit summary",
        body: "Routine cleaning completed. Gums look healthy. Keep flossing daily and come back in six months.",
        createdAt: "2026-03-12T11:30:00+05:30",
      }),
      seedRecord({
        id: "record_ananya_report",
        patientId: ananya.id,
        patientName: ananya.name,
        kind: "report",
        title: "Dental X-ray report",
        body: "Report attached. No new concerns.",
        createdAt: "2026-03-12T12:00:00+05:30",
        files: [{
          id: "file_ananya_report",
          name: "Sample report.pdf",
          contentType: "application/pdf",
          byteSize: 567,
          createdAt: "2026-03-12T12:00:00+05:30",
          previewDataUrl: samplePdf,
        }],
      }),
      seedRecord({
        id: "record_kabir_note",
        patientId: kabir.id,
        patientName: kabir.name,
        practitionerName: "Dr. Rohan Shah",
        kind: "note",
        title: "First check-up",
        body: "Milk teeth are coming through normally. Review in one year.",
        createdAt: "2026-05-04T10:15:00+05:30",
      }),
      seedRecord({
        id: "record_priya_draft",
        patientId: "patient_priya",
        patientName: "Priya Patel",
        kind: "prescription",
        title: "Post-cleaning rinse",
        body: "Chlorhexidine mouth rinse, twice a day for seven days.",
        createdAt: "2026-08-31T09:50:00+05:30",
        status: "draft",
      }),
    ],
    requests: [{
      accessId: "access_varun",
      patientId: "patient_varun",
      patientName: "Varun Gupta",
      contact: "•••• 2233",
      requestedAt: "2026-08-31T09:20:00+05:30",
    }],
    access: {
      [ananya.id]: { access: "date_of_birth", failedAttempts: 0 },
      [kabir.id]: { access: "ask_clinic", failedAttempts: 0 },
    },
  };
}

function readState(): PreviewState {
  try {
    const raw = window.sessionStorage.getItem(stateKey);
    if (raw) return JSON.parse(raw) as PreviewState;
  } catch (error: unknown) {
    console.error("Could not read preview records", error);
  }
  return seedState();
}

function writeState(state: PreviewState): void {
  try {
    window.sessionStorage.setItem(stateKey, JSON.stringify(state));
  } catch {
    throw new Error("This preview has no room left in the browser tab. Remove a file and try again.");
  }
}

function update<T>(change: (state: PreviewState) => T): T {
  const state = readState();
  const result = change(state);
  writeState(state);
  return result;
}

function findRecord(state: PreviewState, id: string): VisitRecordDetail {
  const record = state.records.find((item) => item.id === id);
  if (!record) throw new Error("Record not found.");
  return record;
}

function requireDraft(record: VisitRecordDetail): void {
  if (record.status === "shared") throw new Error("The patient can see this. Withdraw it before changing it.");
}

function log(record: VisitRecordDetail, who: string, action: string, occurredAt: string): void {
  const entry: RecordAccessEntry = { id: `log-${record.id}-${record.accessLog?.length ?? 0}`, who, action, occurredAt };
  record.accessLog = [entry, ...(record.accessLog ?? [])];
}

function summaryOf(record: VisitRecordDetail): VisitRecordSummary {
  const summary: Partial<VisitRecordDetail> = { ...record };
  delete summary.body;
  delete summary.files;
  delete summary.everShared;
  delete summary.accessLog;
  return summary as VisitRecordSummary;
}
const byNewest = (left: { createdAt: string }, right: { createdAt: string }) => right.createdAt.localeCompare(left.createdAt);

export function previewListRecords(): RecordsList {
  const state = readState();
  return { records: state.records.map(summaryOf).sort(byNewest), accessRequests: state.requests };
}

export function previewGetRecord(id: string): VisitRecordDetail {
  return findRecord(readState(), id);
}

export function previewCreateRecord(input: VisitRecordInput & { patientName: string; practitionerName: string | null }, now: string): { id: string } {
  return update((state) => {
    const id = `record_${crypto.randomUUID()}`;
    const record = seedRecord({ ...input, id, createdAt: now, status: "draft", accessLog: [] });
    log(record, "You", "Created", now);
    state.records.push(record);
    return { id };
  });
}

export function previewEditRecord(id: string, input: Pick<VisitRecordInput, "kind" | "title" | "body">, now: string): void {
  update((state) => {
    const record = findRecord(state, id);
    requireDraft(record);
    Object.assign(record, input);
    log(record, "You", "Edited", now);
  });
}

export function previewShareRecord(id: string, now: string): void {
  update((state) => {
    const record = findRecord(state, id);
    record.status = "shared";
    record.sharedAt = now;
    record.everShared = true;
    log(record, "You", "Shared with patient", now);
  });
}

export function previewWithdrawRecord(id: string, now: string): void {
  update((state) => {
    const record = findRecord(state, id);
    record.status = "draft";
    record.sharedAt = null;
    log(record, "You", "Withdrawn from patient", now);
  });
}

export function previewDeleteRecord(id: string): void {
  update((state) => {
    const record = findRecord(state, id);
    if (record.status === "shared" || record.everShared) throw new Error("A document that was shared stays on file.");
    state.records = state.records.filter((item) => item.id !== id);
  });
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("That file could not be read."));
    reader.readAsDataURL(file);
  });
}

export async function previewAddFile(id: string, file: File, now: string): Promise<void> {
  if (file.size > maxRecordFileBytes) throw new Error("Files can be up to 15 MB.");
  if (file.size > maxPreviewBytes) throw new Error("The preview keeps files in this browser tab, so it takes up to 2 MB.");
  const contentType = detectRecordContentType(new Uint8Array(await file.arrayBuffer()));
  if (!contentType) throw new Error("Upload a PDF, JPG, or PNG.");
  const previewDataUrl = await readAsDataUrl(file);
  update((state) => {
    const record = findRecord(state, id);
    requireDraft(record);
    record.files.push({ id: `file_${crypto.randomUUID()}`, name: cleanFileName(file.name), contentType, byteSize: file.size, createdAt: now, previewDataUrl });
    record.fileCount = record.files.length;
    log(record, "You", "Added a file", now);
  });
}

export function previewRemoveFile(id: string, fileId: string, now: string): void {
  update((state) => {
    const record = findRecord(state, id);
    requireDraft(record);
    record.files = record.files.filter((file) => file.id !== fileId);
    record.fileCount = record.files.length;
    log(record, "You", "Removed a file", now);
  });
}

export function previewConfirmAccess(accessId: string): void {
  update((state) => {
    const request = state.requests.find((item) => item.accessId === accessId);
    if (!request) throw new Error("This request is no longer open.");
    state.requests = state.requests.filter((item) => item.accessId !== accessId);
    const current = state.access[request.patientId];
    if (current) current.access = "open";
  });
}

/* Patient portal */

export function previewPortalContact(): string | null {
  try {
    return window.sessionStorage.getItem(contactKey);
  } catch {
    return null;
  }
}

export function previewPortalSignIn(kind: PatientContactKind, contact: string, code: string): void {
  if (!normalizeContact(kind, contact)) throw new Error(kind === "email" ? "Enter a valid email address." : "Enter a valid phone number.");
  if (code !== previewPortalCode) throw new Error("That code isn't right. Check it and try again.");
  window.sessionStorage.setItem(contactKey, kind === "email" ? contact.trim().toLowerCase() : contact.trim());
}

export function previewPortalSignOut(): void {
  try {
    window.sessionStorage.removeItem(contactKey);
  } catch (error: unknown) {
    console.error("Could not sign out of the preview", error);
  }
}

/** The preview's one family. Any other contact signs in to an empty portal, like a stranger would. */
export function previewPortalIsKnown(contact: string): boolean {
  return normalizeContact("email", contact) === previewPortalEmail || normalizeContact("phone", contact) === normalizeContact("phone", previewPortalPhone);
}

export function previewPortalPeople(contact: string): PortalPerson[] {
  if (!previewPortalIsKnown(contact)) return [];
  const { access } = readState();
  return [{ ...ananya, isDependent: false }, { ...kabir, isDependent: true }].map((person) => ({
    clinicSlug: previewClinic.slug,
    clinicName: previewClinic.name,
    patientId: person.id,
    name: person.name,
    isDependent: person.isDependent,
    access: access[person.id]?.access ?? "ask_clinic",
  }));
}

function toPortalRecord(record: VisitRecordDetail): PortalRecord {
  return {
    id: record.id,
    clinicSlug: previewClinic.slug,
    clinicName: previewClinic.name,
    patientId: record.patientId,
    kind: record.kind,
    title: record.title,
    practitionerName: record.practitionerName,
    sharedAt: record.sharedAt ?? record.createdAt,
    fileCount: record.fileCount,
  };
}

export function previewPortalRecords(contact: string): PortalRecord[] {
  const open = new Set(previewPortalPeople(contact).filter((person) => person.access === "open").map((person) => person.patientId));
  return readState().records.filter((record) => record.status === "shared" && open.has(record.patientId)).map(toPortalRecord);
}

export function previewPortalRecord(contact: string, id: string, now: string): PortalRecordDetail {
  const record = previewPortalRecords(contact).find((item) => item.id === id);
  if (!record) throw new Error("Document not found.");
  return update((state) => {
    const detail = findRecord(state, id);
    log(detail, "Patient", "Viewed", now);
    return { ...record, body: detail.body, files: detail.files };
  });
}

export function previewPortalConfirm(contact: string, patientId: string, dateOfBirth: string | undefined, now: string): void {
  const person = previewPortalPeople(contact).find((item) => item.patientId === patientId);
  if (!person) throw new Error("Not found.");
  update((state) => {
    const current = state.access[patientId] ?? (state.access[patientId] = { access: "ask_clinic", failedAttempts: 0 });
    if (!dateOfBirth) {
      current.access = "requested";
      state.requests.push({ accessId: `access_${patientId}`, patientId, patientName: person.name, contact: `•••• ${demoPatients.find((patient) => patient.id === patientId)?.phone.replace(/\D/g, "").slice(-4) ?? "0000"}`, requestedAt: now });
      return;
    }
    if (patientId === ananya.id && dateOfBirth === previewAnanyaDateOfBirth) {
      current.access = "open";
      return;
    }
    current.failedAttempts += 1;
    if (current.failedAttempts >= maxDobAttempts) current.access = "ask_clinic";
    writeState(state);
    throw new Error("That date doesn't match. Check it and try again.");
  });
}
