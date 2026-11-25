"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, CalendarOff, CircleCheck, CircleX, Clock3, Pencil, Repeat2, TriangleAlert } from "lucide-react";

import { RowButton } from "@/components/row-button";
import { DateField } from "@/components/date-picker";
import { SelectField, TextField } from "@/components/form-fields";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardPanel } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useBusinessProfile, useTerms } from "@/features/terms/business-profile-context";
import { isClinicalBusinessType } from "@/lib/business-types";
import { demoClinic, demoResources, demoServices } from "@/lib/demo-data";
import type { Appointment, AuditEvent, Patient, TimeSlot } from "@/lib/domain";
import { practitionerOffersService, previewDoctors } from "@/lib/preview-doctors";
import type { TermWords } from "@/lib/terminology";

import { useCatalogLookups } from "./clinic-catalog";
import { appointmentDateTime } from "./clinic-format";
import { appointmentEndForSlot, compatibleSlots } from "./preview-appointments";
import { addClinicDays, clinicDateKey, clinicDateTime, clinicTimeMinutes, isClinicDateKey, scheduleBlockAffectsAppointment, visitFitsRules, workingHoursToRules } from "./schedule-availability";
import type { RecurringSeries, ScheduleAvailability, ScheduleBlock } from "./schedule-availability";

type Mode = "overview" | "block" | "block_review" | "recurring" | "recurring_review";

interface SchedulePlanningProps {
  appointments: Appointment[];
  patients: Patient[];
  locationId: string;
  selectedDay: string;
  availability: ScheduleAvailability;
  previewClock: string;
  addScheduleBlock: (block: ScheduleBlock) => boolean;
  /** Saves changes to a block that already exists. Without it, blocks can only be added and removed. */
  updateScheduleBlock?: (block: ScheduleBlock) => boolean;
  removeScheduleBlock: (id: string) => boolean;
  addRecurringSeries: (series: RecurringSeries, occurrences: Appointment[]) => boolean;
  recordAudits: (events: AuditEvent[]) => boolean;
  auditCount: number;
}

const activeStatuses = new Set<Appointment["status"]>(["requested", "booked", "checked_in"]);

function minutesToClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function patientName(appointment: Appointment, patients: Patient[], t: TermWords): string {
  const patient = patients.find((item) => item.id === appointment.patientId);
  return patient ? `${patient.firstName} ${patient.lastName}`.trim() : t.Customer;
}

function affectedBookings(appointments: Appointment[], predicate: (appointment: Appointment) => boolean): Appointment[] {
  return appointments.filter((appointment) => activeStatuses.has(appointment.status) && predicate(appointment));
}

export function SchedulePlanningPanel({ appointments, patients, locationId, selectedDay, availability, previewClock, addScheduleBlock, updateScheduleBlock, removeScheduleBlock, addRecurringSeries, recordAudits, auditCount }: SchedulePlanningProps) {
  const t = useTerms();
  const profile = useBusinessProfile();
  // Logic below uses the sample records as stored; names shown come from the catalog, in the business's own words.
  const names = useCatalogLookups();
  const resourceLabel = isClinicalBusinessType(profile.businessType) ? "Room or chair" : t.Resource;
  const availablePractitioners = previewDoctors().filter((item) => item.isActive !== false && item.locationIds.includes(locationId));
  const availableResources = demoResources.filter((item) => item.locationId === locationId);
  const [mode, setMode] = useState<Mode>("overview");
  const [blockTargetType, setBlockTargetType] = useState<ScheduleBlock["targetType"]>("practitioner");
  const [blockTargetId, setBlockTargetId] = useState(availablePractitioners[0]?.id ?? "");
  const [blockDate, setBlockDate] = useState(selectedDay);
  const [blockStart, setBlockStart] = useState("12:00");
  const [blockEnd, setBlockEnd] = useState("13:00");
  const [blockReason, setBlockReason] = useState("");
  const [removeBlockId, setRemoveBlockId] = useState("");
  const [editBlockId, setEditBlockId] = useState("");
  const [recurringPatientId, setRecurringPatientId] = useState("");
  const [recurringServiceId, setRecurringServiceId] = useState("");
  const [recurringPractitionerId, setRecurringPractitionerId] = useState("");
  const [recurringResourceId, setRecurringResourceId] = useState("");
  const [recurringDate, setRecurringDate] = useState(selectedDay);
  const [recurringTime, setRecurringTime] = useState("11:30");
  const [recurringWeeks, setRecurringWeeks] = useState(3);
  const [acknowledged, setAcknowledged] = useState(false);
  const [message, setMessage] = useState("");

  const blockDraft: ScheduleBlock = { id: editBlockId || `block_preview_${availability.blocks.length + 1}_${blockDate}_${blockStart}_${blockTargetId}`, targetType: blockTargetType, targetId: blockTargetId, startsAt: clinicDateTime(blockDate, blockStart), endsAt: clinicDateTime(blockDate, blockEnd), reason: blockReason.trim() };
  const blockAffected = affectedBookings(appointments, (appointment) => scheduleBlockAffectsAppointment(blockDraft, appointment));
  const recurringPatient = patients.find((item) => item.id === recurringPatientId);
  const recurringService = demoServices.find((item) => item.id === recurringServiceId);
  const patientType = recurringPatient && appointments.some((item) => item.patientId === recurringPatient.id) ? "returning" : "new";
  const recurringEligibleServices = demoServices.filter((item) => item.locationIds.includes(locationId) && item.patientTypes.includes(patientType));
  const recurringEligiblePractitioners = recurringService ? availablePractitioners.filter((item) => practitionerOffersService(item.id, recurringService)) : [];
  const recurringEligibleResources = recurringService ? availableResources.filter((item) => !recurringService.resourceKind || item.kind === recurringService.resourceKind) : [];
  const recurringPreview = recurringService && recurringPatient && recurringPractitionerId && recurringResourceId && isClinicDateKey(recurringDate) && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(recurringTime) ? Array.from({ length: recurringWeeks }, (_, index) => {
    const day = addClinicDays(recurringDate, index * 7);
    const opening = compatibleSlots({ service: recurringService, locationId, appointments, patientId: recurringPatient.id, notBefore: previewClock, dateKey: day, availability }).find((slot) => clinicTimeMinutes(slot.startsAt) === Number(recurringTime.slice(0, 2)) * 60 + Number(recurringTime.slice(3, 5)) && slot.practitionerId === recurringPractitionerId && slot.resourceId === recurringResourceId);
    return { day, opening };
  }) : [];
  const recurringReady = recurringPreview.length === recurringWeeks && recurringPreview.every((item) => Boolean(item.opening));
  const planningIssues = [
    ...availability.blocks.flatMap((block) => affectedBookings(appointments, (appointment) => scheduleBlockAffectsAppointment(block, appointment)).map((appointment) => ({ reason: block.reason, appointment }))),
    ...Object.entries(availability.workingHours).flatMap(([id, savedHours]) => {
      const rules = workingHoursToRules(id, savedHours);
      return affectedBookings(appointments, (appointment) => appointment.practitionerId === id && !visitFitsRules(appointment, rules)).map((appointment) => ({ reason: "Outside saved working hours", appointment }));
    }),
  ];

  function reviewBlock() {
    if (!isClinicDateKey(blockDate) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(blockStart) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(blockEnd) || blockStart >= blockEnd || !blockReason.trim() || !blockTargetId) { setMessage("Choose a valid date, target, time range and reason before reviewing."); return; }
    setAcknowledged(false); setMessage(""); setMode("block_review");
  }

  function commitBlock() {
    if (blockAffected.length && !acknowledged) return;
    if (!(editBlockId && updateScheduleBlock ? updateScheduleBlock(blockDraft) : addScheduleBlock(blockDraft))) { setMessage("Could not save blocked time in this browser. Check the time range and try again."); return; }
    setEditBlockId("");
    setMessage(`Blocked time saved. ${blockAffected.length} existing booking${blockAffected.length === 1 ? "" : "s"} remain and need reschedule review.`); setMode("overview"); setBlockReason("");
  }

  function commitRecurring() {
    if (!recurringReady || !recurringPatient || !recurringService) { setMessage("Resolve every occurrence before confirming the series."); return; }
    const seriesId = `series_preview_${availability.recurringSeries.length + 1}_${appointments.length + 1}`;
    const occurrences: Appointment[] = recurringPreview.map(({ opening }, index) => {
      const slot = opening as TimeSlot;
      return { id: `apt_${seriesId}_${index + 1}`, clinicId: demoClinic.id, locationId, patientId: recurringPatient.id, practitionerId: slot.practitionerId, serviceId: recurringService.id, resourceIds: slot.resourceId ? [slot.resourceId] : [], startsAt: slot.startsAt, endsAt: appointmentEndForSlot(slot, recurringService), status: "booked", confirmationStatus: "needs_action", bookingSource: "staff", formStatus: "not_assigned", reminderStatus: "not_scheduled", manageToken: `preview-${seriesId}-${index + 1}` };
    });
    if (!addRecurringSeries({ id: seriesId, appointmentIds: occurrences.map((item) => item.id), patientId: recurringPatient.id, serviceId: recurringService.id, weeks: recurringWeeks }, occurrences)) { setMessage("One or more openings changed. Review the series again before confirming."); setMode("recurring_review"); return; }
    const auditSaved = recordAudits(occurrences.map((appointment, index) => ({ id: `audit_${seriesId}_${index + 1}_${auditCount}`, clinicId: demoClinic.id, appointmentId: appointment.id, actorLabel: "Preview staff", action: `Created recurring ${t.appointment}`, outcome: "success", occurredAt: previewClock })));
    setMessage(`${occurrences.length} recurring ${t.appointments} saved in this browser preview. Confirmation is pending; no reminders were sent.${auditSaved ? "" : " Activity history could not be stored."}`); setMode("overview");
  }

  function editBlock(block: ScheduleBlock) {
    setEditBlockId(block.id);
    setBlockTargetType(block.targetType);
    setBlockTargetId(block.targetId);
    setBlockDate(clinicDateKey(block.startsAt));
    setBlockStart(minutesToClock(clinicTimeMinutes(block.startsAt)));
    setBlockEnd(minutesToClock(clinicTimeMinutes(block.endsAt)));
    setBlockReason(block.reason);
    setAcknowledged(false);
    setMessage("");
    setRemoveBlockId("");
    setMode("block");
  }

  const planningTools = [
    { label: "Block time or leave", icon: CalendarOff, open: () => { setEditBlockId(""); setMode("block"); setBlockDate(selectedDay); } },
    { label: "Recurring series", icon: Repeat2, open: () => { setMode("recurring"); setRecurringDate(selectedDay); } },
  ];

  return <div className="flex flex-col gap-4 text-sm">
    {mode !== "overview" ? <div className="flex flex-col items-start gap-1">
      <Button variant="ghost" size="sm" className="-ms-2" onClick={() => { const next = mode.endsWith("_review") ? mode.replace("_review", "") as Mode : "overview"; if (next === "overview") setEditBlockId(""); setMode(next); setMessage(""); }}><ArrowLeft aria-hidden="true" /> Back</Button>
      <h2 className="font-medium">{mode.startsWith("block") ? (editBlockId ? "Edit blocked time" : "Blocked time") : `Recurring ${t.appointments}`}</h2>
    </div> : null}
      {message ? <Alert role="status" variant="info"><AlertDescription>{message}</AlertDescription></Alert> : null}

      {mode === "overview" ? <>
        <div className="flex flex-col divide-y rounded-lg border">
          <RowButton render={<Link href="/doctors" />} className="min-h-12 items-center gap-3 px-3 py-2">
            <Clock3 className="text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1 font-medium">Working hours</span>
            <ArrowRight className="text-muted-foreground" aria-hidden="true" />
          </RowButton>
          {planningTools.map(({ label, icon: Icon, open }) => <RowButton key={label} onClick={() => { open(); setMessage(""); }} className="min-h-12 items-center gap-3 px-3 py-2">
            <Icon className="text-muted-foreground" aria-hidden="true" />
            <span className="min-w-0 flex-1 font-medium">{label}</span>
            <ArrowRight className="text-muted-foreground" aria-hidden="true" />
          </RowButton>)}
        </div>
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">Blocked times ({availability.blocks.length})</h3>
          {availability.blocks.length ? availability.blocks.map((block) => <Card key={block.id}>
            <CardPanel className="flex flex-col gap-2 p-3">
              <div>
                <p className="font-medium">{block.reason}</p>
                <p className="text-xs text-muted-foreground">{appointmentDateTime(block.startsAt)} · {block.targetType === "practitioner" ? names.practitionerName(block.targetId) : names.resourceName(block.targetId)}</p>
              </div>
              {removeBlockId === block.id ? <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="destructive" onClick={() => { if (removeScheduleBlock(block.id)) { setRemoveBlockId(""); setMessage("Block removed; openings are available again where other rules allow."); } else setMessage("Could not remove the block in this browser."); }}>Confirm remove</Button>
                <Button size="sm" variant="outline" onClick={() => setRemoveBlockId("")}>Keep block</Button>
              </div> : <div className="flex items-center gap-2">
                {updateScheduleBlock ? <Button size="sm" variant="outline" aria-label={`Edit block ${block.reason}`} onClick={() => editBlock(block)}><Pencil aria-hidden="true" /> Edit</Button> : null}
                <Button size="sm" variant="destructive-outline" onClick={() => setRemoveBlockId(block.id)}>Remove block</Button>
              </div>}
            </CardPanel>
          </Card>) : <p className="text-xs text-muted-foreground">None</p>}
        </section>
        {planningIssues.length ? <Alert variant="warning">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Needs reschedule review ({planningIssues.length})</AlertTitle>
          <AlertDescription>
            <ul className="flex flex-col gap-1">{planningIssues.map(({ reason, appointment }, index) => <li key={`${index}_${appointment.id}`}>{patientName(appointment, patients, t)} · {appointmentDateTime(appointment.startsAt)} · {reason}</li>)}</ul>
          </AlertDescription>
        </Alert> : null}
        {availability.recurringSeries.length ? <p className="text-xs text-muted-foreground">{availability.recurringSeries.length} recurring series saved.</p> : null}
      </> : null}

      {mode === "block" ? <>
        <SelectField label="Block" value={blockTargetType} onValueChange={(next) => { const type = next as ScheduleBlock["targetType"]; setBlockTargetType(type); setBlockTargetId(type === "practitioner" ? availablePractitioners[0]?.id ?? "" : availableResources[0]?.id ?? ""); }} options={[{ value: "practitioner", label: t.Practitioner }, { value: "resource", label: resourceLabel }]} />
        <SelectField label="Target" value={blockTargetId} onValueChange={setBlockTargetId} options={blockTargetType === "practitioner" ? availablePractitioners.map((item) => ({ value: item.id, label: names.practitionerName(item.id) })) : availableResources.map((item) => ({ value: item.id, label: names.resourceName(item.id) }))} />
        <DateField label="Date" value={blockDate} onValueChange={setBlockDate} />
        <div className="grid grid-cols-2 gap-2">
          <TextField label="From" type="time" value={blockStart} onChange={(event) => setBlockStart(event.target.value)} />
          <TextField label="Until" type="time" value={blockEnd} onChange={(event) => setBlockEnd(event.target.value)} />
        </div>
        <TextField label="Reason" value={blockReason} onChange={(event) => setBlockReason(event.target.value)} maxLength={80} placeholder="Leave, meeting or maintenance" />
        <Button onClick={reviewBlock}>Review blocked time</Button>
      </> : null}
      {mode === "block_review" ? <>
        <p className="tabular-nums">{blockDraft.reason} · {appointmentDateTime(blockDraft.startsAt)}–{new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(new Date(blockDraft.endsAt))}</p>
        <AffectedList appointments={blockAffected} patients={patients} />
        {blockAffected.length ? <Acknowledgement checked={acknowledged} onChange={setAcknowledged} /> : null}
        <p className="text-xs text-muted-foreground">Existing bookings stay and get flagged for review.</p>
        <Button disabled={blockAffected.length > 0 && !acknowledged} onClick={commitBlock}>Confirm blocked time</Button>
      </> : null}

      {mode === "recurring" ? <>
        <p className="text-xs text-muted-foreground">2–6 weekly {t.visits}. Every one needs an opening.</p>
        <SelectField label={t.Customer} value={recurringPatientId} onValueChange={(next) => { setRecurringPatientId(next); setRecurringServiceId(""); }} options={[{ value: "", label: `Choose ${t.customer}` }, ...patients.map((item) => ({ value: item.id, label: `${item.firstName} ${item.lastName}`.trim() }))]} />
        <SelectField label="Service" value={recurringServiceId} onValueChange={(next) => { setRecurringServiceId(next); setRecurringPractitionerId(""); setRecurringResourceId(""); }} options={[{ value: "", label: "Choose service" }, ...recurringEligibleServices.map((item) => ({ value: item.id, label: `${names.serviceName(item.id)} · ${item.durationMinutes} min` }))]} />
        <SelectField label={t.Practitioner} value={recurringPractitionerId} onValueChange={setRecurringPractitionerId} options={[{ value: "", label: `Choose ${t.practitioner}` }, ...recurringEligiblePractitioners.map((item) => ({ value: item.id, label: names.practitionerName(item.id) }))]} />
        <SelectField label={resourceLabel} value={recurringResourceId} onValueChange={setRecurringResourceId} options={[{ value: "", label: `Choose ${t.resource}` }, ...recurringEligibleResources.map((item) => ({ value: item.id, label: names.resourceName(item.id) }))]} />
        <div className="grid grid-cols-2 gap-2">
          <DateField label="First date" value={recurringDate} onValueChange={setRecurringDate} />
          <TextField label="Time" type="time" step="900" value={recurringTime} onChange={(event) => setRecurringTime(event.target.value)} />
        </div>
        <SelectField label={`Weekly ${t.visits}`} value={String(recurringWeeks)} onValueChange={(next) => setRecurringWeeks(Number(next))} options={[2, 3, 4, 5, 6].map((count) => ({ value: String(count), label: `${count} weeks` }))} />
        <Button disabled={!recurringPatient || !recurringService || !recurringPractitionerId || !recurringResourceId || !isClinicDateKey(recurringDate)} onClick={() => { setMessage(""); setMode("recurring_review"); }}>Review every occurrence</Button>
      </> : null}
      {mode === "recurring_review" ? <>
        <p className="text-xs text-muted-foreground">The series books only if every week is free.</p>
        <ol className="flex flex-col divide-y rounded-lg border">{recurringPreview.map(({ day, opening }, index) => <li key={day} className="flex items-center justify-between gap-2 px-3 py-2">
          <span className="tabular-nums">Week {index + 1} · {day} {recurringTime}</span>
          <Badge variant={opening ? "success" : "error"}>{opening ? <CircleCheck aria-hidden="true" /> : <CircleX aria-hidden="true" />}{opening ? "Available" : "Conflict"}</Badge>
        </li>)}</ol>
        {!recurringReady ? <Alert variant="error"><AlertDescription>Some weeks are not free. Change the time or the {t.resource}.</AlertDescription></Alert> : <p className="text-xs text-muted-foreground">No message is sent to the {t.customer}.</p>}
        <Button disabled={!recurringReady} onClick={commitRecurring}>Confirm {recurringWeeks} {t.appointments}</Button>
      </> : null}
  </div>;
}

function AffectedList({ appointments, patients }: { appointments: Appointment[]; patients: Patient[] }) {
  const t = useTerms();
  return <div className="flex flex-col gap-1 rounded-lg border p-3">
    <h3 className="font-medium">Affected bookings ({appointments.length})</h3>
    {appointments.length ? <ul className="flex flex-col gap-1">{appointments.map((appointment) => <li key={appointment.id}>{patientName(appointment, patients, t)} · {appointmentDateTime(appointment.startsAt)}</li>)}</ul> : <p className="text-muted-foreground">No existing booking is affected.</p>}
  </div>;
}

function Acknowledgement({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return <Label className="items-start font-normal"><Checkbox checked={checked} onCheckedChange={onChange} /><span>I have reviewed the affected bookings. They will stay scheduled and need separate rescheduling.</span></Label>;
}
