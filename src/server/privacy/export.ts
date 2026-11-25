/**
 * Builds a customer's data export: one zip with a complete JSON file and a readable PDF. It reads inside the business's
 * own row-level-security scope (the worker passes its transaction) and returns bytes; the worker handler encrypts and
 * stores them. Nothing here sends anything.
 *
 * What goes in: profile, consent history, bookings, form answers, the record of messages sent, payments and refunds,
 * reviews, waitlist and follow-up entries, earlier privacy requests, and records the business has shared with the
 * customer (only once they have confirmed who they are, exactly as in the portal). File attachments are listed by name,
 * not included.
 *
 * No "server-only" import: the worker uses this file.
 */
import { strToU8, zipSync } from "fflate";
import type postgres from "postgres";

import { formatFieldValue, kindOf } from "../../lib/customer-field-values";
import { loadDataKeys } from "../keys/ring";
import { postgresDataKeyStore } from "../keys/postgres-store";
import { openText } from "../keys/records";
import { textOfStoredContent } from "../assistant/stored-format";
import { buildTextPdf, type PdfLine } from "./pdf";

type TenantDb = postgres.TransactionSql;

export interface CustomerExport {
  generatedAt: string;
  business: { name: string };
  profile: Record<string, unknown>;
  consents: { current: Record<string, boolean>; history: Record<string, unknown>[] };
  appointments: Record<string, unknown>[];
  formAnswers: Record<string, unknown>[];
  messages: Record<string, unknown>[];
  /** Chats with the booking assistant that were tied to this customer's number (feature 30): what each side wrote. */
  assistantChats?: Record<string, unknown>[];
  payments: Record<string, unknown>[];
  /** Numbered invoices and credit notes (feature 24). Kept as the business's tax record even after an erasure. */
  invoices?: Record<string, unknown>[];
  reviews: Record<string, unknown>[];
  waitlist: Record<string, unknown>[];
  classPlaces: Record<string, unknown>[];
  followUps: Record<string, unknown>[];
  privacyRequests: Record<string, unknown>[];
  sharedRecords: Record<string, unknown>[];
  /** Customer profiles (feature 27): the business's own labels, extra details and internal notes about this customer. */
  tags?: string[];
  extraDetails?: Record<string, unknown>[];
  businessNotes?: Record<string, unknown>[];
  notes: string[];
}

/** Opens sealed text, or says it could not, so one unreadable item never blocks the rest of the export. */
function tryOpen(tenantId: string, sealed: string): string | null {
  try {
    return openText(tenantId, sealed);
  } catch {
    return null;
  }
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function collectCustomerExport(tenantDb: TenantDb, tenantId: string, patientId: string, now: Date): Promise<CustomerExport> {
  await loadDataKeys(postgresDataKeyStore(tenantDb), tenantId);
  const [tenant] = await tenantDb<{ name: string }[]>`select name from tenants where id = ${tenantId}`;
  const [patient] = await tenantDb<Record<string, unknown>[]>`
    select first_name, last_name, phone, email, date_of_birth::text as date_of_birth, preferred_channel, accessibility_need,
      is_dependent, guardian_name, guardian_relationship, guardian_consented_at, privacy_accepted_at, messaging_consent_at, created_at
    from patients where tenant_id = ${tenantId} and id = ${patientId}
  `;
  if (!patient || !tenant) throw new Error("export_customer_missing");

  const history = await tenantDb<Record<string, unknown>[]>`
    select purpose, granted, wording_version, source, actor_type, created_at from consent_records
    where tenant_id = ${tenantId} and patient_id = ${patientId} order by created_at, id
  `;
  const latest = new Map<string, boolean>();
  for (const row of history) latest.set(String(row.purpose), Boolean(row.granted));

  const appointments = await tenantDb<(Record<string, unknown> & { id: string })[]>`
    select appointment.id, appointment.starts_at, appointment.ends_at, appointment.status, appointment.booking_source,
      appointment.reason_for_visit, appointment.notes, appointment.custom_fields, appointment.price_minor, appointment.created_at,
      service.name as service, practitioner.name as practitioner, location.name as location
    from appointments as appointment
    join services as service on service.tenant_id = appointment.tenant_id and service.id = appointment.service_id
    join practitioners as practitioner on practitioner.tenant_id = appointment.tenant_id and practitioner.id = appointment.practitioner_id
    join locations as location on location.tenant_id = appointment.tenant_id and location.id = appointment.location_id
    where appointment.tenant_id = ${tenantId} and appointment.patient_id = ${patientId}
    order by appointment.starts_at
  `;
  const appointmentIds = appointments.map((row) => row.id);
  const idList = appointmentIds.length > 0 ? appointmentIds : [""];

  const forms = await tenantDb<{ definition_key: string; definition_version: number; response_ciphertext: string | null; submitted_at: Date | null; appointment_id: string }[]>`
    select definition_key, definition_version, response_ciphertext, submitted_at, appointment_id from forms
    where tenant_id = ${tenantId} and patient_id = ${patientId} and response_ciphertext is not null order by created_at
  `;
  const messages = await tenantDb<Record<string, unknown>[]>`
    select appointment_id, channel, template_key, status, scheduled_at, sent_at, delivered_at, failure_code from notifications
    where tenant_id = ${tenantId} and appointment_id in ${tenantDb(idList)} order by scheduled_at
  `;
  const chatRows = await tenantDb<{ id: string; channel: string; created_at: Date }[]>`
    select id, channel, created_at from assistant_conversations where tenant_id = ${tenantId} and patient_id = ${patientId} order by created_at
  `;
  const assistantChats: Record<string, unknown>[] = [];
  for (const chat of chatRows) {
    const turns = await tenantDb<{ kind: string; content_ciphertext: string; created_at: Date }[]>`
      select kind, content_ciphertext, created_at from assistant_messages
      where tenant_id = ${tenantId} and conversation_id = ${chat.id} and kind in ('customer', 'assistant') order by seq
    `;
    const lines = turns.flatMap((turn) => {
      const blocks = parseJson(tryOpen(tenantId, turn.content_ciphertext));
      const text = textOfStoredContent(blocks);
      return text && !text.startsWith("[SERVER NOTE]") ? [{ from: turn.kind === "customer" ? "you" : "assistant", at: turn.created_at, text }] : [];
    });
    assistantChats.push({ channel: chat.channel, startedAt: chat.created_at, lines });
  }
  const payments = await tenantDb<Record<string, unknown>[]>`
    select payment.id, payment.appointment_id, payment.amount_minor, payment.currency, payment.method, payment.created_at,
      coalesce((select json_agg(json_build_object('amountMinor', refund.amount_minor, 'reason', refund.reason, 'at', refund.created_at) order by refund.created_at)
        from payment_refunds as refund where refund.tenant_id = payment.tenant_id and refund.payment_id = payment.id), '[]'::json) as refunds
    from payments as payment
    where payment.tenant_id = ${tenantId} and (payment.appointment_id in ${tenantDb(idList)} or payment.patient_id = ${patientId}) order by payment.created_at
  `;
  const invoices = await tenantDb<Record<string, unknown>[]>`
    select invoice.number, invoice.issued_at, invoice.kind, invoice.currency, invoice.total_minor, invoice.appointment_id,
      coalesce((select json_agg(json_build_object('number', note.number, 'totalMinor', note.total_minor, 'at', note.issued_at) order by note.issued_at)
        from credit_notes as note where note.tenant_id = invoice.tenant_id and note.invoice_id = invoice.id), '[]'::json) as credit_notes
    from invoices as invoice where invoice.tenant_id = ${tenantId} and invoice.patient_id = ${patientId} order by invoice.issued_at
  `;
  const reviews = await tenantDb<Record<string, unknown>[]>`
    select appointment_id, rating, comment, display_name, created_at from reviews
    where tenant_id = ${tenantId} and appointment_id in ${tenantDb(idList)} order by created_at
  `;
  const waitlist = await tenantDb<Record<string, unknown>[]>`
    select date_from::text as date_from, date_to::text as date_to, time_preference, status, created_at from waitlist_entries
    where tenant_id = ${tenantId} and patient_id = ${patientId} order by created_at
  `;
  const classPlaces = await tenantDb<Record<string, unknown>[]>`
    select session.starts_at, service.name as class_name, enrolment.status, enrolment.created_at
    from class_enrolments as enrolment
    join class_sessions as session on session.tenant_id = enrolment.tenant_id and session.id = enrolment.session_id
    join services as service on service.tenant_id = session.tenant_id and service.id = session.service_id
    where enrolment.tenant_id = ${tenantId} and enrolment.patient_id = ${patientId} order by session.starts_at
  `;
  const followUps = await tenantDb<Record<string, unknown>[]>`
    select due_at, status, last_contacted_at from recalls where tenant_id = ${tenantId} and patient_id = ${patientId} order by due_at
  `;
  const tags = await tenantDb<{ name: string }[]>`
    select tag.name from customer_tag_links as link join customer_tags as tag on tag.tenant_id = link.tenant_id and tag.id = link.tag_id
    where link.tenant_id = ${tenantId} and link.patient_id = ${patientId} order by lower(tag.name)
  `;
  // Every answer is listed, including those of fields the business has since archived, in the words people read ("Yes", "A, B").
  const extraRows = await tenantDb<{ field: string; kind: string; value: string }[]>`
    select field.label as field, field.kind, value.value from customer_field_values as value
    join customer_field_definitions as field on field.tenant_id = value.tenant_id and field.id = value.field_id
    where value.tenant_id = ${tenantId} and value.patient_id = ${patientId} order by field.position, field.label
  `;
  const extraDetails = extraRows.map((row) => ({ field: row.field, value: formatFieldValue({ kind: kindOf(row.kind), choices: [], label: row.field }, row.value) }));
  const businessNotes = await tenantDb<Record<string, unknown>[]>`
    select body, created_at from customer_notes where tenant_id = ${tenantId} and patient_id = ${patientId} order by created_at
  `;
  const requests = await tenantDb<Record<string, unknown>[]>`
    select type, status, requested_via, created_at, due_at, decided_at, decision_reason, completed_at from data_requests
    where tenant_id = ${tenantId} and patient_id = ${patientId} order by created_at
  `;

  const confirmed = await tenantDb<{ id: string }[]>`
    select id from patient_record_access where tenant_id = ${tenantId} and patient_id = ${patientId} and confirmed_at is not null limit 1
  `;
  const notes: string[] = [];
  const sharedRecords: Record<string, unknown>[] = [];
  if (confirmed.length > 0) {
    const records = await tenantDb<{ id: string; kind: string; title_ciphertext: string; body_ciphertext: string; shared_at: Date | null }[]>`
      select id, kind, title_ciphertext, body_ciphertext, shared_at from visit_records
      where tenant_id = ${tenantId} and patient_id = ${patientId} and status = 'shared' order by shared_at
    `;
    for (const record of records) {
      const files = await tenantDb<{ name_ciphertext: string; content_type: string; byte_size: number }[]>`
        select name_ciphertext, content_type, byte_size from visit_record_files
        where tenant_id = ${tenantId} and record_id = ${record.id} and scan_status <> 'infected'
      `;
      sharedRecords.push({
        kind: record.kind,
        sharedAt: record.shared_at,
        title: tryOpen(tenantId, record.title_ciphertext),
        body: tryOpen(tenantId, record.body_ciphertext),
        attachments: files.map((file) => ({ name: tryOpen(tenantId, file.name_ciphertext), contentType: file.content_type, bytes: file.byte_size })),
      });
    }
    notes.push("Attached files are listed by name. Ask the business for a copy of a file itself.");
  } else {
    notes.push("Records shared with you appear here once you have confirmed your identity in the portal.");
  }
  notes.push("The PDF can only show Western European letters. The JSON file is the complete copy.");

  return {
    generatedAt: now.toISOString(),
    business: { name: tenant.name },
    profile: patient,
    consents: {
      current: Object.fromEntries(["appointment_messages", "marketing_messages", "reviews", "records_sharing"].map((purpose) => [purpose, latest.get(purpose) ?? purpose !== "marketing_messages"])),
      history,
    },
    appointments,
    formAnswers: forms.map((form) => ({
      appointmentId: form.appointment_id,
      form: form.definition_key,
      version: form.definition_version,
      submittedAt: form.submitted_at,
      answers: parseJson(tryOpen(tenantId, form.response_ciphertext ?? "")),
    })),
    messages,
    assistantChats,
    payments,
    invoices,
    reviews,
    waitlist,
    classPlaces,
    followUps,
    privacyRequests: requests,
    sharedRecords,
    tags: tags.map((tag) => tag.name),
    extraDetails,
    businessNotes,
    notes,
  };
}

const show = (value: unknown): string => value === null || value === undefined || value === "" ? "-" : value instanceof Date ? value.toISOString() : typeof value === "object" ? JSON.stringify(value) : String(value);

/** The readable copy: short labelled lines, one section per kind of data. */
export function exportReadableLines(data: CustomerExport): PdfLine[] {
  const lines: PdfLine[] = [
    { text: `Your information held by ${data.business.name}`, heading: true },
    { text: `Prepared ${data.generatedAt.slice(0, 10)}` },
    { text: "" },
    { text: "About you", heading: true },
  ];
  for (const [key, value] of Object.entries(data.profile)) lines.push({ text: `${key}: ${show(value)}` });
  lines.push({ text: "" }, { text: "Your choices", heading: true });
  for (const [purpose, granted] of Object.entries(data.consents.current)) lines.push({ text: `${purpose}: ${granted ? "yes" : "no"}` });
  const section = (title: string, rows: Record<string, unknown>[]) => {
    lines.push({ text: "" }, { text: `${title} (${rows.length})`, heading: true });
    rows.forEach((row, index) => {
      lines.push({ text: `${index + 1}. ${Object.entries(row).map(([key, value]) => `${key}: ${show(value)}`).join("; ")}` });
    });
  };
  section("Bookings", data.appointments);
  section("Form answers", data.formAnswers);
  section("Messages sent to you", data.messages);
  section("Chats with the booking assistant", data.assistantChats ?? []);
  section("Payments and refunds", data.payments);
  section("Reviews", data.reviews);
  section("Waiting list", data.waitlist);
  section("Places in classes", data.classPlaces);
  section("Follow-ups", data.followUps);
  section("Privacy requests", data.privacyRequests);
  section("Records shared with you", data.sharedRecords);
  if (data.tags && data.tags.length > 0) section("Labels the business gave you", data.tags.map((name) => ({ label: name })));
  section("Extra details the business keeps", data.extraDetails ?? []);
  section("Notes the business keeps about you", data.businessNotes ?? []);
  lines.push({ text: "" });
  for (const note of data.notes) lines.push({ text: note });
  return lines;
}

/** The zip: README.txt, data.json (complete) and summary.pdf (readable). */
export function buildExportZip(data: CustomerExport): Uint8Array {
  const readme = [
    `This is a copy of the information ${data.business.name} holds about you.`,
    "",
    "data.json  The complete copy, in a format other services can read.",
    "summary.pdf  The same information laid out to read.",
    "",
    ...data.notes,
  ].join("\n");
  return zipSync({
    "README.txt": strToU8(readme),
    "data.json": strToU8(JSON.stringify(data, null, 2)),
    "summary.pdf": buildTextPdf(`Your information held by ${data.business.name}`, exportReadableLines(data)),
  });
}
