"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Accessibility, ArrowUpRight, BellOff, CalendarClock, CalendarDays, Clock, CalendarX, CircleCheck, CircleX, DoorOpen, Ellipsis, FileCheck, FileWarning, History, LogIn, type LucideIcon, MessageCircleQuestion, Phone, Play, StickyNote, Tag, UserRound, UserX, X } from "lucide-react";

import { ActionMenuButton, type ActionMenuEntry } from "@/components/action-bar";
import { PersonAvatar } from "@/components/person-avatar";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverClose, PopoverDescription, PopoverPopup, PopoverTitle } from "@/components/ui/popover";
import { useTerms } from "@/features/terms/business-profile-context";
import type { Appointment, Patient } from "@/lib/domain";
import type { TermWords } from "@/lib/terminology";

import { CustomerLink, PractitionerLink, ResourceLink, ServiceLink } from "./entity-links";
import { appointmentDateTime, appointmentDay, appointmentDuration, appointmentTime, statusLabel } from "./clinic-format";
import { patientName } from "./patient-directory";
import { appointmentStatusTone } from "./task-ui";

type VisitAction = "approve" | "suggest" | "decline" | "checkin" | "start" | "complete" | "reschedule" | "form_received" | "no_show" | "cancel";
interface VisitChange { action: VisitAction; label: string; icon: LucideIcon; destructive?: boolean }

/** What staff can do to this visit right now: the usual next step, one other common step, and the rest for the ⋯ menu. */
function visitChanges(appointment: Appointment, started: boolean, clockIso: string, t: TermWords): { primary?: VisitChange; secondary?: VisitChange; more: VisitChange[] } {
  const form: VisitChange[] = appointment.formStatus === "not_started" || appointment.formStatus === "in_progress" ? [{ action: "form_received", label: "Mark form received", icon: FileCheck }] : [];
  switch (appointment.status) {
    case "requested":
      return {
        primary: { action: "approve", label: "Approve", icon: CircleCheck },
        secondary: { action: "suggest", label: "Suggest a time", icon: CalendarClock },
        more: [...form, { action: "decline", label: "Decline request", icon: CircleX, destructive: true }],
      };
    case "booked":
      return {
        primary: { action: "checkin", label: "Check in", icon: LogIn },
        secondary: { action: "reschedule", label: "Reschedule", icon: CalendarClock },
        more: [
          ...form,
          ...(Date.parse(clockIso) >= Date.parse(appointment.startsAt) ? [{ action: "no_show" as const, label: "Mark no-show", icon: UserX, destructive: true }] : []),
          { action: "cancel", label: `Cancel ${t.appointment}`, icon: CalendarX, destructive: true },
        ],
      };
    case "checked_in":
      return {
        primary: started ? { action: "complete", label: "Complete", icon: CircleCheck } : { action: "start", label: "Start", icon: Play },
        more: form,
      };
    default:
      return { more: [] };
  }
}

/** Things that need a look before the visit, shown only when there is one. */
function attentionLines(appointment: Appointment, patient: Patient | undefined): { icon: LucideIcon; text: string }[] {
  const lines: { icon: LucideIcon; text: string }[] = [];
  if (appointment.status === "booked" && appointment.confirmationStatus === "needs_action") lines.push({ icon: MessageCircleQuestion, text: "Hasn't confirmed yet" });
  if (appointment.formStatus === "not_started" || appointment.formStatus === "in_progress") lines.push({ icon: FileWarning, text: appointment.formStatus === "in_progress" ? "Form started, not sent" : "Form not filled in yet" });
  if (appointment.reminderStatus === "failed") lines.push({ icon: BellOff, text: "Reminder failed to send" });
  if (patient?.accessibilityNeed) lines.push({ icon: Accessibility, text: patient.accessibilityNeed });
  return lines;
}

function Line({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: ReactNode }) {
  return <li className="flex min-w-0 items-start gap-2.5">
    <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    <span className="sr-only">{label}: </span>
    <span className="min-w-0 flex-1 wrap-break-word">{children}</span>
  </li>;
}

/**
 * A visit at a glance: who, when, what and with whom, anything that needs attention, and the next step.
 * Editing every detail lives on the full appointment page; this card is for looking and moving the visit on.
 */
export function AppointmentCard({ appointment, patients, started, clockIso, context }: { appointment: Appointment; patients: Patient[]; started: boolean; clockIso: string; context: string }) {
  const t = useTerms();
  const patient = patients.find((item) => item.id === appointment.patientId);
  const name = patient ? patientName(patient) : t.Customer;
  const href = `/appointments/${appointment.id}?${context}`;
  const actionHref = (action: VisitAction) => action === "approve" ? href : `${href}&action=${action}`;
  const { primary, secondary, more } = visitChanges(appointment, started, clockIso, t);
  const attention = attentionLines(appointment, patient);
  const start = appointmentTime(appointment.startsAt);
  const end = appointmentTime(appointment.endsAt);
  const length = appointmentDuration(appointment);
  const menu: ActionMenuEntry[] = [
    ...more.filter((change) => !change.destructive).map((change) => ({ id: change.action, label: change.label, icon: <change.icon aria-hidden="true" />, href: actionHref(change.action) })),
    { id: "profile", label: `${t.Customer} profile`, icon: <UserRound aria-hidden="true" />, href: `/patients?patient=${appointment.patientId}` },
    ...(more.some((change) => change.destructive) ? [{ kind: "separator" as const, id: "risky" }] : []),
    ...more.filter((change) => change.destructive).map((change) => ({ id: change.action, label: change.label, icon: <change.icon aria-hidden="true" />, href: actionHref(change.action), destructive: true })),
  ];

  return <div className="-m-4 flex flex-col text-sm">
    <header className="flex items-center gap-3 p-4 pb-3">
      <PersonAvatar name={name} className="size-9" />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <PopoverTitle className="truncate text-base leading-tight">{patient ? <CustomerLink id={patient.id} name={name} patient={patient} /> : name}</PopoverTitle>
        <StatusBadge tone={appointmentStatusTone(appointment.status)} className="shrink-0">{statusLabel(appointment.status)}</StatusBadge>
      </div>
      <div className="-me-2 flex shrink-0 items-center">
        <ActionMenuButton label={`More for ${t.visit}`} iconOnly variant="ghost" icon={<Ellipsis aria-hidden="true" />} items={menu} className="size-8" />
        <PopoverClose render={<Button size="icon-sm" variant="ghost" aria-label="Close" />}><X aria-hidden="true" /></PopoverClose>
      </div>
    </header>

    <PopoverDescription className="sr-only">{appointmentDay(appointment.startsAt)}, {start} to {end}, {length} min</PopoverDescription>
    <ul className="flex flex-col gap-2 border-t px-4 py-3" aria-label="When">
      <Line icon={CalendarDays} label="Date"><span className="font-medium">{appointmentDay(appointment.startsAt)}</span></Line>
      <Line icon={Clock} label="Time">
        <span className="flex items-center justify-between gap-2">
          <span className="tabular-nums">{start} – {end}</span>
          <Badge variant="outline" className="shrink-0 tabular-nums">{length} min</Badge>
        </span>
      </Line>
    </ul>

    <ul className="flex flex-col gap-2 border-t px-4 py-3" aria-label={`${t.Visit} details`}>
      <Line icon={Tag} label="Service">
        <ServiceLink id={appointment.serviceId} className="font-medium" />
        <span className="text-muted-foreground"> with <PractitionerLink id={appointment.practitionerId} className="text-foreground" /></span>
      </Line>
      {appointment.resourceIds.length ? <Line icon={DoorOpen} label={t.Resource}>{appointment.resourceIds.map((id, index) => <span key={id}>{index ? ", " : ""}<ResourceLink id={id} /></span>)}</Line> : null}
      {patient?.phone ? <Line icon={Phone} label="Phone"><a className="tabular-nums underline-offset-4 hover:underline" href={`tel:${patient.phone}`}>{patient.phone}</a></Line> : null}
      {appointment.notes ? <Line icon={StickyNote} label="Notes"><span className="line-clamp-2">{appointment.notes}</span></Line> : null}
      {appointment.clinicMovedFrom ? <Line icon={History} label="Moved">Moved from <span className="tabular-nums">{appointmentDateTime(appointment.clinicMovedFrom)}</span></Line> : null}
    </ul>

    {attention.length ? <ul aria-label="Needs attention" className="mx-4 mb-3 flex flex-col gap-1.5 rounded-lg bg-warning/8 px-3 py-2.5 text-warning-foreground">
      {attention.map((line) => <Line key={line.text} icon={line.icon} label="Needs attention">{line.text}</Line>)}
    </ul> : null}

    <footer className="flex items-center gap-2 border-t bg-muted/72 px-4 py-3">
      {primary ? <Button size="sm" render={<Link href={actionHref(primary.action)} />}><primary.icon aria-hidden="true" />{primary.label}</Button> : null}
      {secondary ? <Button size="sm" variant="outline" render={<Link href={actionHref(secondary.action)} />}><secondary.icon aria-hidden="true" />{secondary.label}</Button> : null}
      <Button size="sm" variant="ghost" className="ms-auto" render={<Link href={href} />}>Details<ArrowUpRight aria-hidden="true" /></Button>
    </footer>
  </div>;
}

/** Where a visit card points: the clicked appointment, or the point that was clicked. */
export type VisitAnchor = Element | { getBoundingClientRect: () => DOMRect };

/**
 * The visit card as a popover beside what was clicked. It is not modal: the rest of the page stays usable,
 * and a click elsewhere closes it while still doing what it was aimed at.
 */
export function AppointmentPopover({ appointment, anchor, patients, started, clockIso, context, side = "right", onClose }: { appointment: Appointment | null; anchor: VisitAnchor | null; patients: Patient[]; started: boolean; clockIso: string; context: string; side?: "right" | "bottom"; onClose: () => void }) {
  const t = useTerms();
  const patient = appointment ? patients.find((item) => item.id === appointment.patientId) : undefined;
  const name = patient ? patientName(patient) : t.Customer;
  return <Popover modal={false} open={appointment !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <PopoverPopup anchor={anchor ?? undefined} side={side} align={side === "right" ? "center" : "start"} sideOffset={8} className="w-[min(22rem,calc(100vw-2rem))]" aria-label={appointment ? `${t.Appointment} for ${name}` : undefined}>
      {appointment ? <AppointmentCard appointment={appointment} patients={patients} started={started} clockIso={clockIso} context={context} /> : null}
    </PopoverPopup>
  </Popover>;
}
