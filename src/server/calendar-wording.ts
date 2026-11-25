import { sql } from "drizzle-orm";

import { answerValues, questionKey } from "@/lib/booking-answer-values";
import { formDefinitionDraftSchema, type FormAnswers } from "@/lib/booking-forms";
import { type EntryWording, type WordingValues, lengthText } from "@/lib/event-wording";

import { openText } from "./keys/records";
import { asString, type Runner } from "./workflows/runner";

/**
 * Everything the calendar wording (feature 50) needs for one appointment, read in one place for the web server and the
 * worker (both pass a `Runner`). The booking answers are only opened when the wording really uses a question and notes
 * are not hidden, so a business that never uses them never decrypts anything. Nothing here logs a name or an answer.
 */

export interface WordingContext {
  wording: EntryWording;
  values: WordingValues;
  /** Every question key the service's forms ask, so a hidden answer reads as empty instead of as an unknown placeholder. */
  questionKeys: string[];
  /** The place line a calendar's LOCATION field carries. */
  placeLine: string;
}

const builtIn = new Set(["service", "customer", "customer_first_name", "person", "business", "branch", "location", "length"]);
const usesQuestion = (...templates: (string | null)[]): boolean => templates.some((template) => template && [...template.matchAll(/\{([A-Za-z0-9_.-]{1,60})\}/g)].some((match) => !builtIn.has((match[1] ?? "").toLowerCase())));

function storedFields(value: unknown) {
  const parsed = formDefinitionDraftSchema.safeParse({ name: "stored", fields: value });
  return parsed.success ? parsed.data.fields : [];
}

/** `hidePlace`: a request on a service that hides its address until approved keeps the place out of the customer's invite. */
export async function loadWordingContext(run: Runner, tenantId: string, appointmentId: string, options: { hidePlace?: boolean; openAnswers?: boolean } = {}): Promise<WordingContext | null> {
  const [row] = await run(sql`
    select appointment.service_id, appointment.starts_at, appointment.ends_at,
      service.name as service_name, service.customer_event_title, service.staff_event_title, service.event_description,
      service.hide_notes_in_calendar, service.hide_details_in_calendar,
      patient.first_name, patient.last_name, practitioner.name as person,
      location.name as branch, location.address, location.city, tenant.name as business
    from appointments as appointment
    join services as service on service.tenant_id = appointment.tenant_id and service.id = appointment.service_id
    join patients as patient on patient.tenant_id = appointment.tenant_id and patient.id = appointment.patient_id
    join practitioners as practitioner on practitioner.tenant_id = appointment.tenant_id and practitioner.id = appointment.practitioner_id
    join locations as location on location.tenant_id = appointment.tenant_id and location.id = appointment.location_id
    join tenants as tenant on tenant.id = appointment.tenant_id
    where appointment.tenant_id = ${tenantId} and appointment.id = ${appointmentId}`);
  if (!row) return null;
  const wording: EntryWording = {
    customerTitle: typeof row.customer_event_title === "string" ? row.customer_event_title : null,
    staffTitle: typeof row.staff_event_title === "string" ? row.staff_event_title : null,
    description: typeof row.event_description === "string" ? row.event_description : null,
    hideNotes: row.hide_notes_in_calendar === true,
    hideDetails: row.hide_details_in_calendar === true,
  };
  const minutes = Math.max(1, Math.round((new Date(asString(row.ends_at)).getTime() - new Date(asString(row.starts_at)).getTime()) / 60_000));
  const address = [asString(row.address), asString(row.city)].filter(Boolean).join(", ");
  const place = [asString(row.branch), address].filter(Boolean).join(", ");
  const hide = options.hidePlace === true;

  // Question keys come from the service's current forms; answers only when a template uses one and notes are not hidden.
  const forms = await run(sql`
    select definition.fields from form_definitions as definition
    where definition.tenant_id = ${tenantId} and definition.is_current and definition.is_active
      and (definition.applies_to_all or exists (
        select 1 from form_definition_services as link
        where link.tenant_id = definition.tenant_id and link.form_definition_id = definition.id and link.service_id = ${asString(row.service_id)}))`);
  const fields = forms.flatMap((form) => storedFields(form.fields));
  const questionKeys = [...new Set(fields.map(questionKey))];
  let answers: Record<string, string> = {};
  if (options.openAnswers !== false && !wording.hideNotes && usesQuestion(wording.customerTitle, wording.staffTitle, wording.description)) {
    const [response] = await run(sql`
      select form.response_ciphertext from forms as form
      where form.tenant_id = ${tenantId} and form.appointment_id = ${appointmentId} and form.response_ciphertext is not null
      order by form.submitted_at desc nulls last limit 1`);
    if (typeof response?.response_ciphertext === "string") {
      try {
        const parsed: unknown = JSON.parse(openText(tenantId, response.response_ciphertext));
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) answers = answerValues(fields, parsed as FormAnswers);
      } catch {
        // Keys not loaded or a damaged row: the entry is written without answers rather than not at all.
      }
    }
  }
  return {
    wording,
    questionKeys,
    placeLine: hide ? "" : place,
    values: {
      service: asString(row.service_name),
      customer: `${asString(row.first_name)} ${asString(row.last_name)}`.trim(),
      customerFirstName: asString(row.first_name),
      person: asString(row.person),
      business: asString(row.business),
      branch: hide ? "" : asString(row.branch),
      location: hide ? "" : place,
      length: lengthText(minutes),
      answers,
    },
  };
}
