"use client";

import { CustomerRatings } from "./rating-notes";
import { useState } from "react";
import { TriangleAlert } from "lucide-react";

import { PhoneField, SelectField, TextareaField, TextField } from "@/components/form-fields";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Timeline, TimelineContent, TimelineDate, TimelineHeader, TimelineIndicator, TimelineItem, TimelineSeparator, TimelineTitle } from "@/components/reui/timeline";
import { StatusBadge } from "@/components/status-badge";
import { Label } from "@/components/ui/label";
import { toastManager } from "@/components/ui/toast";
import { useFeatures, useTerms } from "@/features/terms/business-profile-context";
import type { Appointment, ContactChannel, Patient } from "@/lib/domain";

import { appointmentDateTime, statusLabel } from "./clinic-format";
import { matchingPatientContacts, patientName } from "./patient-directory";
import { OwesBadge } from "./outstanding-balance";
import { StaffApiError } from "./queries/http";
import { staffMutation } from "./staff-snapshot-provider";
import { appointmentStatusTone } from "./task-ui";

/** One past or upcoming visit, as the history timeline shows it. */
export interface PatientVisitEntry {
  id: string;
  startsAt: string;
  title: string;
  detail: string;
  status: Appointment["status"];
}

const HISTORY_LIMIT = 6;

/**
 * Turns a phone number typed any which way into the "+919876543210" form the
 * phone field reads. A number without a country code is taken as Indian, like
 * the field's default country. Anything unreadable is left for the person to fix.
 */
export function toE164(value: string): string {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return "";
  if (trimmed.startsWith("+")) return `+${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length === 10) return `+91${digits}`;
  return trimmed;
}

const channelOptions = [
  { value: "sms", label: "SMS" },
  { value: "email", label: "Email" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "phone", label: "Phone call" },
];

interface PatientDraft {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  dateOfBirth: string;
  preferredChannel: ContactChannel;
  accessibilityNeed: string;
  /** Booked for by someone else: a child, an older parent, someone in their care. */
  isDependent: boolean;
  messagingConsent: boolean;
}

function draftFrom(patient?: Patient): PatientDraft {
  return {
    firstName: patient?.firstName ?? "",
    lastName: patient?.lastName ?? "",
    phone: toE164(patient?.phone ?? ""),
    email: patient?.email ?? "",
    dateOfBirth: patient?.dateOfBirth ?? "",
    preferredChannel: patient?.preferredChannel ?? "sms",
    accessibilityNeed: patient?.accessibilityNeed ?? "",
    isDependent: patient?.isDependent ?? false,
    messagingConsent: Boolean(patient?.messagingConsentAt),
  };
}

function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * Adds a patient from the front desk, or corrects an existing one. Pass `patient` to edit.
 * Only changed fields are sent, so the audit log lists exactly what was corrected.
 */
export function PatientDetailsDialog({ open, onOpenChange, patient, patients, visits, onSaved }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  patient?: Patient;
  /** The directory, used to warn about a likely duplicate before adding. */
  patients: Patient[];
  /** The patient's visits, newest first. Shown as a timeline when editing. */
  visits?: PatientVisitEntry[];
  onSaved: (patient: Patient) => void | Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-xl">
        {open ? <PatientDetailsForm key={patient?.id ?? "new"} patient={patient} patients={patients} visits={visits} onCancel={() => onOpenChange(false)} onSaved={onSaved} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function PatientDetailsForm({ patient, patients, visits, onCancel, onSaved }: {
  patient?: Patient;
  patients: Patient[];
  visits?: PatientVisitEntry[];
  onCancel: () => void;
  onSaved: (patient: Patient) => void | Promise<void>;
}) {
  const t = useTerms();
  const features = useFeatures();
  const initial = draftFrom(patient);
  const [draft, setDraft] = useState(initial);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<"firstName" | "lastName" | "phone" | "email", string>>>({});
  /** Who the server says already has this phone or email. Set, the next submit is "Add anyway". */
  const [serverMatches, setServerMatches] = useState<string[] | null>(null);
  const editing = Boolean(patient);
  const set = <K extends keyof PatientDraft>(key: K, value: PatientDraft[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    if (key === "phone" || key === "email") setServerMatches(null);
    if (key in fieldErrors) setFieldErrors((current) => ({ ...current, [key]: undefined }));
  };
  const localMatches = editing || draft.isDependent ? [] : matchingPatientContacts(patients, draft.phone, draft.email).slice(0, 3).map(patientName);
  const duplicates = serverMatches ?? localMatches;
  const changed = (Object.keys(draft) as (keyof PatientDraft)[]).filter((key) => draft[key] !== initial[key]);

  function check(): boolean {
    const next: typeof fieldErrors = {};
    if (!draft.firstName.trim()) next.firstName = "Enter a first name.";
    if (draft.phone.replace(/\D/g, "").length < 7) next.phone = "Enter a phone number.";
    const email = draft.email.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) next.email = "Enter an email like name@example.com, or leave it blank.";
    else if (!email && draft.preferredChannel === "email") next.email = "Add an email, or choose another preferred contact.";
    setFieldErrors(next);
    return Object.keys(next).length === 0;
  }

  async function submit() {
    setError("");
    if (!check()) return;
    if (draft.dateOfBirth && draft.dateOfBirth > todayKey()) {
      setError("Date of birth can't be in the future.");
      return;
    }
    if (editing && !changed.length) {
      onCancel();
      return;
    }
    const trimmed = {
      firstName: draft.firstName.trim(),
      lastName: draft.lastName.trim(),
      phone: draft.phone.trim(),
      email: draft.email.trim(),
      preferredChannel: draft.preferredChannel,
      messagingConsent: draft.messagingConsent,
      isDependent: draft.isDependent,
    };
    setPending(true);
    try {
      let saved: Patient;
      if (patient) {
        const body: Record<string, unknown> = {};
        for (const key of changed) {
          if (key === "dateOfBirth") body.dateOfBirth = draft.dateOfBirth || null;
          else if (key === "accessibilityNeed") body.accessibilityNeed = draft.accessibilityNeed.trim() || null;
          else body[key] = trimmed[key];
        }
        saved = await staffMutation<Patient>(`/api/staff/patients/${encodeURIComponent(patient.id)}`, "PATCH", body);
      } else {
        saved = await staffMutation<Patient>("/api/staff/patients", "POST", {
          ...trimmed,
          // Staff saw the warning and chose "Add anyway".
          ...(duplicates.length ? { allowDuplicate: true } : {}),
          ...(draft.dateOfBirth ? { dateOfBirth: draft.dateOfBirth } : {}),
          ...(draft.accessibilityNeed.trim() ? { accessibilityNeed: draft.accessibilityNeed.trim() } : {}),
        });
      }
      toastManager.add({ title: editing ? `${t.Customer} details saved` : `${t.Customer} added`, description: patientName(saved), type: "success" });
      await onSaved(saved);
    } catch (cause: unknown) {
      if (cause instanceof StaffApiError && cause.code === "possible_duplicate") {
        setServerMatches(duplicateNames(cause.details));
        return;
      }
      setError(cause instanceof Error ? cause.message : `The ${t.customer} could not be saved.`);
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="contents" noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <DialogHeader>
        <DialogTitle>{patient ? `Edit ${patientName(patient)}` : `Add ${t.customer}`}</DialogTitle>
        <DialogDescription>{patient ? "Correct contact details and preferences. Changes are recorded in Activity." : "For someone who calls or comes in before booking. You can book them straight after."}</DialogDescription>
      </DialogHeader>
      <DialogPanel className="grid gap-4 sm:grid-cols-2">
        {error ? <Alert variant="error" className="sm:col-span-2"><TriangleAlert aria-hidden="true" /><AlertDescription>{error}</AlertDescription></Alert> : null}
        {duplicates.length ? (
          <Alert role={serverMatches ? "alert" : "note"} variant="warning" className="sm:col-span-2">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>Possible existing {t.customer}</AlertTitle>
            <AlertDescription>{duplicates.join(", ")} already {duplicates.length === 1 ? "uses" : "use"} this phone or email. Check before adding another record, or choose Add anyway.</AlertDescription>
          </Alert>
        ) : null}
        <TextField id="patient-first-name" label="First name" value={draft.firstName} onChange={(event) => set("firstName", event.target.value)} error={fieldErrors.firstName} required maxLength={80} autoComplete="off" />
        <TextField id="patient-last-name" label="Last name (optional)" value={draft.lastName} onChange={(event) => set("lastName", event.target.value)} error={fieldErrors.lastName} maxLength={80} autoComplete="off" />
        <PhoneField id="patient-phone" label="Phone" value={draft.phone} onChange={(next) => set("phone", next)} error={fieldErrors.phone} required autoComplete="off" />
        <TextField id="patient-email" label="Email" type="email" value={draft.email} onChange={(event) => set("email", event.target.value)} error={fieldErrors.email} optional maxLength={254} autoComplete="off" />
        {features.dateOfBirth ? <TextField id="patient-dob" label="Date of birth" optional type="date" max={todayKey()} value={draft.dateOfBirth} onChange={(event) => set("dateOfBirth", event.target.value)} /> : null}
        <SelectField id="patient-channel" label="Preferred contact" value={draft.preferredChannel} onValueChange={(next) => set("preferredChannel", next as ContactChannel)} options={channelOptions} />
        <TextareaField id="patient-access" fieldClassName="sm:col-span-2" label="Accessibility or communication needs" optional rows={2} maxLength={500} value={draft.accessibilityNeed} onChange={(event) => set("accessibilityNeed", event.target.value)} placeholder="For example: needs step-free access, prefers Urdu" />
        {features.dependents ? (
          <Label className="flex cursor-pointer items-start gap-3 sm:col-span-2">
            <Checkbox className="mt-0.5" checked={draft.isDependent} onCheckedChange={(checked) => set("isDependent", checked)} />
            <span className="flex flex-col gap-0.5">
              <span>Dependent</span>
              <span className="text-xs font-normal text-muted-foreground">Someone else books and is contacted for them, such as a parent or carer.</span>
            </span>
          </Label>
        ) : null}
        <Label className="flex cursor-pointer items-start gap-3 sm:col-span-2">
          <Checkbox className="mt-0.5" checked={draft.messagingConsent} onCheckedChange={(checked) => set("messagingConsent", checked)} />
          <span className="flex flex-col gap-0.5">
            <span>{t.Customer} agreed to reminders by text or WhatsApp</span>
            <span className="text-xs font-normal text-muted-foreground">Without it, reminders go by email only.</span>
          </span>
        </Label>
        {editing && patient ? <OwesBadge patientId={patient.id} className="justify-self-start sm:col-span-2" /> : null}
        {editing && patient ? <CustomerRatings patientId={patient.id} className="sm:col-span-2" /> : null}
        {editing && visits ? <VisitTimeline visits={visits} noun={t.appointments} /> : null}
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" disabled={pending} />}>Cancel</DialogClose>
        <Button type="submit" loading={pending}>{patient ? "Save changes" : duplicates.length ? "Add anyway" : `Add ${t.customer}`}</Button>
      </DialogFooter>
    </form>
  );
}

/** The names in a `possible_duplicate` refusal's details. */
function duplicateNames(details: unknown): string[] {
  const matches = typeof details === "object" && details !== null && "matches" in details ? (details as { matches: unknown }).matches : null;
  const names = Array.isArray(matches) ? matches.flatMap((match) => (typeof match === "object" && match !== null && typeof (match as { name?: unknown }).name === "string" ? [(match as { name: string }).name] : [])) : [];
  return names.length ? names : ["Someone"];
}

function VisitTimeline({ visits, noun }: { visits: PatientVisitEntry[]; noun: string }) {
  const shown = visits.slice(0, HISTORY_LIMIT);
  return (
    <section className="flex flex-col gap-3 sm:col-span-2" aria-label="Visit history">
      <div>
        <h3 className="text-sm font-medium">Visit history</h3>
        <p className="text-xs text-muted-foreground">{visits.length ? `The latest ${shown.length} of ${visits.length} ${noun}.` : `No ${noun} yet.`}</p>
      </div>
      {shown.length ? (
        <Timeline value={1} className="ps-1">
          {shown.map((visit) => (
            <TimelineItem key={visit.id} step={visit.status === "completed" ? 1 : 2}>
              <TimelineIndicator />
              <TimelineSeparator />
              <TimelineDate dateTime={visit.startsAt}>{appointmentDateTime(visit.startsAt)}</TimelineDate>
              <TimelineHeader className="flex flex-wrap items-center justify-between gap-2">
                <TimelineTitle>{visit.title}</TimelineTitle>
                <StatusBadge tone={appointmentStatusTone(visit.status)}>{statusLabel(visit.status)}</StatusBadge>
              </TimelineHeader>
              <TimelineContent>{visit.detail}</TimelineContent>
            </TimelineItem>
          ))}
        </Timeline>
      ) : null}
    </section>
  );
}
