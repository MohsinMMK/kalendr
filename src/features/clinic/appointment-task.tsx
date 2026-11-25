"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, CalendarOff, ChevronLeft, ChevronRight, CircleCheck, FilePlus2, TriangleAlert, Video } from "lucide-react";
import Link from "next/link";

import { DatePicker } from "@/components/date-picker";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { PersonAvatar } from "@/components/person-avatar";
import { Button } from "@/components/ui/button";
import { Card, CardPanel } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Frame, FrameFooter, FrameHeader, FramePanel } from "@/components/ui/frame";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { toastManager } from "@/components/ui/toast";
import { useBusinessProfile, useTerms } from "@/features/terms/business-profile-context";
import { bookingOriginLine } from "@/lib/booking-source";
import { heardFromLabels } from "@/lib/heard-from";
import { isClinicalBusinessType } from "@/lib/business-types";
import type { Appointment, AppointmentStatus, TimeSlot } from "@/lib/domain";
import type { TermWords } from "@/lib/terminology";

import { useAppointmentMoreActions } from "./appointment-more-actions";
import { useUseCreditAction } from "./use-credit-action";
import { CancelReasonNotes } from "./cancel-reason";
import { AppointmentRatingNote } from "./rating-notes";
import { ApprovalCard, RequestOutcomeBanner } from "./approval-card";
import { BookingFormAnswers } from "./booking-form-answers";
import { AppointmentRoutingCard } from "@/features/routing/appointment-routing-card";
import { BookingHistory } from "./booking-history";
import { appointmentDateTime, appointmentDay, appointmentDuration, appointmentTime, channelLabel, statusLabel } from "./clinic-format";
import { clinicDayBounds, useCatalogLookups } from "./clinic-catalog";
import { useStaffAccess } from "./staff-access";
import { VisitInvoicePanel } from "./visit-invoice-panel";
import { appointmentEndForSlot, appointmentHasConflict, compatibleSlots, usePreviewAppointments, visitStartConflict } from "./preview-appointments";
import { addClinicDays, clinicDateKey, isClinicDateKey, slotAvailabilityIssue } from "./schedule-availability";
import { LimitOverridePrompt, useLimitOverride } from "./limit-override";
import { fetchAvailabilitySlots, staffMutation, useOptionalStaffSnapshot } from "./staff-snapshot-provider";
import type { ScheduleView } from "./schedule-view";
import { appointmentStatusTone, Fact, OpeningButton, TaskSteps } from "./task-ui";
import { OpeningsCalendar, OpeningsViewControl, useOpeningsView } from "./clinic-calendar";
import { patientName } from "./patient-directory";
import { PatientDetailsDialog } from "./patient-details-dialog";
import { staffBookingSources } from "./use-visit-edits";
import { SeriesScopeDialog } from "./series-scope";
import { SeriesPanel } from "./series-view";
import { VisitCustomProperties, VisitNotesField, VisitPractitionerField, VisitReasonField, VisitRoomField, VisitServiceField, VisitSourceField, VisitTimeField } from "./visit-editors";
import { ScrollArea } from "@/components/ui/scroll-area";

type Action = "reschedule" | "suggest" | "approve" | "checkin" | "start" | "complete" | "form_received" | "cancel" | "decline" | "no_show";
type Stage = "overview" | "choose" | "review" | "result";

function actionLabel(action: Action, t: TermWords): string {
  return { reschedule: "Reschedule", suggest: "Suggest another time", approve: "Approve request", checkin: `Check in ${t.customer}`, start: `Start ${t.appointment}`, complete: `Complete ${t.appointment}`, form_received: "Mark form received", cancel: `Cancel ${t.appointment}`, decline: "Decline request", no_show: "Mark no-show" }[action];
}

function reviewTitle(action: Action): string {
  return { reschedule: "Review reschedule", suggest: "Review suggested time", approve: "Review approval", checkin: "Review check-in", start: "Review start", complete: "Review completion", form_received: "Review form receipt", cancel: "Review cancellation", decline: "Review decline", no_show: "Review no-show" }[action];
}

function AppointmentFacts({ appointment, serviceName, inAppointment = false, showStatus = true, practitionerName, resourceName, editable = false }: { appointment: Appointment; serviceName: string; inAppointment?: boolean; showStatus?: boolean; practitionerName: string; resourceName: string; editable?: boolean }) {
  const t = useTerms();
  const profile = useBusinessProfile();
  return <dl className="grid gap-4 sm:grid-cols-2">
    {editable ? (
      <>
        <Fact label="Time"><span className="flex flex-wrap items-center gap-x-1.5"><span className="tabular-nums">{appointmentDay(appointment.startsAt)}</span><VisitTimeField key={`${appointment.id}-time`} appointment={appointment} /></span></Fact>
        <Fact label="Service"><VisitServiceField appointment={appointment} /></Fact>
        <Fact label={t.Practitioner}><VisitPractitionerField appointment={appointment} label={t.Practitioner} /></Fact>
        <Fact label={isClinicalBusinessType(profile.businessType) ? "Room or chair" : t.Resource}><VisitRoomField appointment={appointment} label={isClinicalBusinessType(profile.businessType) ? "Room or chair" : t.Resource} /></Fact>
      </>
    ) : (
      <>
        <Fact label="Time"><span className="tabular-nums">{appointmentDateTime(appointment.startsAt)}</span> <span className="font-normal text-muted-foreground tabular-nums">· {appointmentDuration(appointment)} min</span></Fact>
        <Fact label="Service">{serviceName}</Fact>
        <Fact label={t.Practitioner}>{practitionerName}</Fact>
        <Fact label={isClinicalBusinessType(profile.businessType) ? "Room or chair" : t.Resource}>{resourceName}</Fact>
      </>
    )}
    {appointment.heardFrom ? <Fact label="Found you through">{heardFromLabels[appointment.heardFrom]}</Fact> : null}
    {showStatus ? <Fact label="Status">{inAppointment ? `In ${t.appointment}` : statusLabel(appointment.status)}</Fact> : null}
  </dl>;
}

export function AppointmentTask({ appointmentId, returnTo = "schedule", returnDate, returnView = "staff", returnLocation, initialAction, initialStart, initialPractitioner }: { appointmentId: string; returnTo?: "dashboard" | "schedule" | "patients" | "bookings"; returnDate?: string; returnView?: ScheduleView; returnLocation?: string; initialAction?: "checkin" | "start" | "complete" | "form_received" | "reschedule" | "suggest"; initialStart?: string; initialPractitioner?: string }) {
  const { appointments, updateAppointment, auditEvents, recordAudit, patients, operations, recordVisitTiming, database } = usePreviewAppointments();
  const catalog = useCatalogLookups();
  const t = useTerms();
  const profile = useBusinessProfile();
  const staff = useOptionalStaffSnapshot();
  const access = useStaffAccess();
  const [remoteSlots, setRemoteSlots] = useState<{ key: string; slots: TimeSlot[] } | null>(null);
  const [openingsView, setOpeningsView] = useOpeningsView();
  const [pending, setPending] = useState(false);
  const [editingPatient, setEditingPatient] = useState(false);
  const canEditPatient = database && access.can("appointments.book");
  const appointment = appointments.find((item) => item.id === appointmentId);
  const appointmentVersion = staff?.snapshot?.appointments.find((item) => item.id === appointmentId)?.version;
  // Feature 17: asks "this one, this and following, or all" before moving or cancelling a visit of a repeating series.
  const [scopeFor, setScopeFor] = useState<"reschedule" | "cancel" | null>(null);
  const [action, setAction] = useState<Action | null>(initialAction ?? null);
  const [stage, setStage] = useState<Stage>(initialAction === "reschedule" || initialAction === "suggest" ? "choose" : initialAction ? "review" : "overview");
  const [selectedSlot, setSelectedSlot] = useState<TimeSlot | null>(null);
  const [dropTarget, setDropTarget] = useState(initialStart && Number.isFinite(Date.parse(initialStart)) ? { start: initialStart, practitionerId: initialPractitioner } : null);
  const [selectedDate, setSelectedDate] = useState(dropTarget ? clinicDateKey(new Date(dropTarget.start).toISOString()) : isClinicDateKey(returnDate ?? "") ? returnDate! : clinicDateKey(appointment?.startsAt ?? "2026-08-31T12:00:00+05:30"));
  const [showAllSlots, setShowAllSlots] = useState(false);
  const [error, setError] = useState("");
  const limitOverride = useLimitOverride(`${selectedSlot?.startsAt ?? ""}|${selectedSlot?.practitionerId ?? ""}`);
  const titleRef = useRef<HTMLSpanElement>(null);
  const returnHref = returnTo === "patients" && appointment ? `/patients?patient=${appointment.patientId}` : returnTo === "schedule" ? `/schedule?date=${isClinicDateKey(returnDate ?? "") ? returnDate : appointment ? clinicDateKey(appointment.startsAt) : selectedDate}&view=${returnView}&location=${returnLocation ?? appointment?.locationId ?? ""}` : `/${returnTo}`;

  const scheduling = action === "reschedule" || action === "suggest";
  const service = appointment ? catalog.getService(appointment.serviceId) : undefined;
  const more = useAppointmentMoreActions({ appointment, version: appointmentVersion, service, enabled: database && access.can("appointments.book"), refresh: async () => { await staff?.refresh(); } });
  const credit = useUseCreditAction({ appointment, serviceName: service?.name ?? t.Appointment, enabled: database && access.can("appointments.book"), refresh: async () => { await staff?.refresh(); } });
  const slotQuery = `${appointment?.id}|${appointment?.locationId}|${service?.id}|${selectedDate}`;
  const slotsLoading = database && scheduling && remoteSlots?.key !== slotQuery;

  const destructiveAction = action === "cancel" || action === "decline" || action === "no_show" ? action : null;
  const destructiveReview = stage === "review" && destructiveAction !== null;

  useEffect(() => {
    if (stage !== "overview" && !destructiveReview) titleRef.current?.focus();
  }, [destructiveReview, stage]);

  useEffect(() => {
    if (!database || !scheduling || !appointment || !service) return;
    const controller = new AbortController();
    const bounds = clinicDayBounds(selectedDate);
    void fetchAvailabilitySlots({
      clinicSlug: catalog.clinic.slug,
      locationId: appointment.locationId,
      serviceId: service.id,
      from: bounds.from,
      to: bounds.to,
      // Moving the visit keeps its length; a different service takes that service's usual length.
      ...(service.id === appointment.serviceId ? { keepDurationMinutes: Math.round((new Date(appointment.endsAt).getTime() - new Date(appointment.startsAt).getTime()) / 60_000) } : {}),
    }, controller.signal).then((nextSlots) => { if (!controller.signal.aborted) setRemoteSlots({ key: slotQuery, slots: nextSlots }); })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setRemoteSlots({ key: slotQuery, slots: [] });
        setError(cause instanceof Error ? cause.message : "Compatible openings could not be loaded.");
      });
    return () => controller.abort();
  }, [appointment, catalog.clinic.slug, database, scheduling, selectedDate, service, slotQuery]);

  if (!appointment) return <Empty>
    <EmptyHeader>
      <EmptyMedia variant="icon"><CalendarOff aria-hidden="true" /></EmptyMedia>
      <EmptyTitle role="heading" aria-level={1}>{t.Appointment} unavailable</EmptyTitle>
      <EmptyDescription>{database ? `This ${t.appointment} is not in the current ${t.business} window.` : `This ${t.appointment} is not in the preview schedule.`}</EmptyDescription>
    </EmptyHeader>
    <Button variant="outline" render={<Link href="/schedule" />}>Back to schedule</Button>
  </Empty>;

  const patient = patients.find((item) => item.id === appointment.patientId);
  const name = patient ? patientName(patient) : t.Customer;
  const previewSlots = service && !database ? compatibleSlots({ service, locationId: appointment.locationId, appointments, excludeAppointmentId: appointment.id, patientId: appointment.patientId, notBefore: operations.clockIso, dateKey: selectedDate, availability: operations.schedule }) : [];
  const slots = database ? (remoteSlots?.key === slotQuery ? remoteSlots.slots : []) : previewSlots;
  // A drop on the calendar lands here: go straight to review if the time is open, otherwise show what is.
  if (dropTarget && scheduling && !slotsLoading) {
    const match = slots.find((slot) => Date.parse(slot.startsAt) === Date.parse(dropTarget.start) && (!dropTarget.practitionerId || slot.practitionerId === dropTarget.practitionerId));
    setDropTarget(null);
    if (match) {
      setSelectedSlot(match);
      setStage("review");
    } else setError(`That time isn't open for this ${t.visit}. Choose another opening.`);
  }
  const timing = operations.visitTimings[appointment.id];
  const resourceLabel = appointment.resourceIds.map((id) => catalog.resourceName(id)).filter(Boolean).join(", ") || "None assigned";

  function begin(nextAction: Action) {
    if (appointment?.seriesId && database && access.can("series.manage") && (nextAction === "reschedule" || nextAction === "cancel")) { setScopeFor(nextAction); return; }
    startAction(nextAction);
  }

  function startAction(nextAction: Action) {
    setAction(nextAction);
    setStage(nextAction === "reschedule" || nextAction === "suggest" ? "choose" : "review");
    setSelectedSlot(null);
    setError("");
  }

  function commit() {
    if (!action || !appointment) return;
    if (database) {
      if (!appointmentVersion) {
        setError(`This ${t.appointment} changed since you opened it. Refresh and try again.`);
        return;
      }
      const statusByAction: Partial<Record<Action, AppointmentStatus>> = {
        approve: "booked", checkin: "checked_in", complete: "completed", cancel: "cancelled",
        decline: "cancelled", no_show: "no_show",
      };
      setPending(true);
      void (async () => {
        try {
          if (scheduling) {
            if (!selectedSlot) throw new Error("Choose a compatible opening before confirming.");
            await staffMutation(`/api/staff/appointments/${appointment.id}`, "PATCH", {
              action, startsAt: selectedSlot.startsAt, practitionerId: selectedSlot.practitionerId, expectedVersion: appointmentVersion, ...limitOverride.takeBody(),
            });
          } else if (action === "form_received" || action === "start") {
            await staffMutation(`/api/staff/appointments/${appointment.id}`, "PATCH", {
              action, expectedVersion: appointmentVersion,
            });
          } else {
            const status = statusByAction[action];
            if (!status) throw new Error("This action is not available.");
            await staffMutation(`/api/appointments/${appointment.id}/status`, "PATCH", {
              status, expectedVersion: appointmentVersion,
            });
          }
          await staff?.refresh();
          setError("");
          limitOverride.clear();
          setStage("result");
          toastManager.add({ title: `${actionLabel(action, t)} recorded`, description: `No ${t.customer} notification was sent.`, type: "success" });
        } catch (cause: unknown) {
          if (limitOverride.capture(cause)) return;
          setError(cause instanceof Error ? cause.message : `Could not save this ${t.appointment}. Refresh and try again.`);
        } finally {
          setPending(false);
        }
      })();
      return;
    }
    if (action === "approve" && appointmentHasConflict(appointment, appointments)) {
      setError(`Cannot approve this request while the ${t.customer}, ${t.practitioner} or ${t.resource} has another booking. Suggest another time.`);
      return;
    }
    const allowed = action === "approve" ? appointment.status === "requested" && !appointmentHasConflict(appointment, appointments)
      : action === "checkin" || action === "cancel" ? appointment.status === "booked"
      : action === "no_show" ? appointment.status === "booked" && Date.parse(operations.clockIso) >= Date.parse(appointment.startsAt)
      : action === "decline" ? appointment.status === "requested"
      : action === "start" ? appointment.status === "checked_in" && !timing?.startedAt
      : action === "complete" ? appointment.status === "checked_in" && Boolean(timing?.startedAt)
      : action === "form_received" ? ["requested", "booked", "checked_in"].includes(appointment.status) && appointment.formStatus !== "submitted"
      : appointment.status === "booked" || appointment.status === "requested";
    if (!allowed) {
      setError(`This action is no longer available for the ${t.appointment}. Review its current status.`);
      setStage("overview");
      return;
    }
    if (action === "approve" && service) {
      const issue = slotAvailabilityIssue({ id: appointment.id, startsAt: appointment.startsAt, endsAt: appointment.endsAt, practitionerId: appointment.practitionerId, resourceId: appointment.resourceIds[0] }, service, operations.schedule, t);
      if (issue) { setError(`Cannot approve this requested time: ${issue} Suggest another time.`); return; }
    }
    if (action === "start") {
      const conflict = visitStartConflict(appointment, appointments, operations.visitTimings, operations.clockIso);
      if (conflict) {
        setError(`Cannot start while another ${t.appointment} uses this ${t.practitioner} or ${t.resource} at the preview time. Review ${catalog.serviceName(conflict.serviceId)} first.`);
        return;
      }
      if (service) {
        const issue = slotAvailabilityIssue({ id: appointment.id, startsAt: operations.clockIso, endsAt: appointment.endsAt, practitionerId: appointment.practitionerId, resourceId: appointment.resourceIds[0] }, service, operations.schedule, t);
        if (issue) { setError(`Cannot start this ${t.visit}: ${issue} Resolve the availability change in Schedule before starting.`); return; }
      }
    }
    if (scheduling) {
      if (!selectedSlot || !service || !compatibleSlots({ service, locationId: appointment.locationId, appointments, excludeAppointmentId: appointment.id, patientId: appointment.patientId, notBefore: operations.clockIso, dateKey: selectedDate, availability: operations.schedule }).some((slot) => slot.startsAt === selectedSlot.startsAt && slot.practitionerId === selectedSlot.practitionerId && slot.resourceId === selectedSlot.resourceId)) {
        setError("That opening is no longer available. Choose another time.");
        setStage("choose");
        return;
      }
    }
    const saved = action === "start" || updateAppointment(appointment.id, (current) => {
      if (action === "approve" && current.status === "requested") return { ...current, status: "booked", confirmationStatus: "confirmed" };
      if (action === "checkin" && current.status === "booked") return { ...current, status: "checked_in" };
      if (action === "complete" && current.status === "checked_in") return { ...current, status: "completed" };
      if (action === "form_received") return { ...current, formStatus: "submitted" };
      if (action === "decline" && current.status === "requested") return { ...current, status: "cancelled", confirmationStatus: "declined" };
      if (action === "cancel" && current.status === "booked") return { ...current, status: "cancelled" };
      if (action === "no_show" && current.status === "booked") return { ...current, status: "no_show" };
      if (scheduling && selectedSlot && service && (current.status === "booked" || current.status === "requested")) {
        return { ...current, startsAt: selectedSlot.startsAt, endsAt: appointmentEndForSlot(selectedSlot, service), practitionerId: selectedSlot.practitionerId, resourceIds: selectedSlot.resourceId ? [selectedSlot.resourceId] : [], status: action === "suggest" ? "requested" : "booked", confirmationStatus: "needs_action", reminderStatus: "queued" };
      }
      return current;
    });
    if (!saved) {
      setError(`Could not save this ${t.appointment} in the browser. Try again.`);
      return;
    }
    if (action === "checkin" && !recordVisitTiming(appointment.id, { checkedInAt: operations.clockIso })) {
      updateAppointment(appointment.id, () => appointment);
      setError("Could not save check-in timing in this browser. Try again.");
      return;
    }
    if (action === "start" && !recordVisitTiming(appointment.id, { startedAt: operations.clockIso })) {
      setError(`Could not save ${t.visit} progress in this browser. Try again.`);
      return;
    }
    const occurredAt = operations.clockIso;
    if (!recordAudit({ id: `preview_${appointment.id}_${action}_${auditEvents.length + 1}`, clinicId: appointment.clinicId, appointmentId: appointment.id, actorLabel: "Preview staff", action: actionLabel(action, t), outcome: "success", occurredAt })) {
      setError("Action saved, but activity history could not be stored in this browser.");
    } else setError("");
    setStage("result");
    toastManager.add({ title: `${actionLabel(action, t)} recorded`, description: `No ${t.customer} notification was sent.`, type: "success" });
  }

  const inAppointment = Boolean(timing?.startedAt && appointment.status === "checked_in");
  const backLabel = returnTo === "dashboard" ? "Today" : returnTo === "patients" ? t.customers : returnTo;
  const showOverview = stage === "overview" || destructiveReview;
  const facts = <AppointmentFacts appointment={appointment} serviceName={service?.name ?? t.Appointment} inAppointment={inAppointment} showStatus={!showOverview} practitionerName={catalog.practitionerName(appointment.practitionerId)} resourceName={resourceLabel} editable={stage === "overview"} />;
  const closureNote = database ? `This action closes the ${t.appointment}. It remains visible in Schedule history and no longer reserves an opening.` : `This action closes the ${t.appointment} in this preview. It remains visible in Schedule history and no longer reserves an opening.`;
  const messageNote = database ? `No message will be sent. This action waits for the ${t.business} database before it is recorded.` : "No message will be sent. This action updates preview scheduling data in this browser session only.";
  const firstStepLabel = appointment.status === "requested" ? "Requested" : appointment.status === "pending_payment" ? "Awaiting payment" : "Booked";
  const visitSteps = database
    ? [firstStepLabel, "Checked in", "Completed"]
    : [firstStepLabel, "Checked in", `In ${t.appointment}`, "Completed"];
  const formUploadNote = isClinicalBusinessType(profile.businessType) ? "No form content or clinical record is uploaded." : "No form content is uploaded.";
  const visitCurrent = appointment.status === "completed" ? visitSteps.length - 1 : inAppointment ? 2 : appointment.status === "checked_in" ? 1 : 0;

  function changeDate(next: string) {
    setSelectedDate(next);
    setSelectedSlot(null);
    setShowAllSlots(false);
  }

  return <div className="flex flex-col gap-4 p-4 md:p-6">
    <Button size="sm" variant="ghost" className="-ms-2 self-start" render={<Link href={returnHref} />}><ArrowLeft aria-hidden="true" /> Back to {backLabel}</Button>
    <div className="flex items-center gap-3">
      {showOverview ? <PersonAvatar name={name} className="size-10" /> : null}
      <PageHeader
        className="min-w-0 flex-1"
        title={<span ref={titleRef} tabIndex={-1} className="outline-none">{showOverview ? name : stage === "result" ? "Task complete" : action === "reschedule" || action === "suggest" ? stage === "choose" ? "Choose a compatible time" : `Review ${t.appointment} change` : reviewTitle(action!)}</span>}
        description={showOverview ? service?.name ?? t.Appointment : <>{service?.name ?? t.Appointment} · {name}</>}
        titleAddon={<StatusBadge tone={appointmentStatusTone(appointment.status)}>{inAppointment ? `In ${t.appointment}` : statusLabel(appointment.status)}</StatusBadge>}
        bar={[
          ...(showOverview && appointment.deliveryMode === "video" && ["booked", "checked_in"].includes(appointment.status) ? [{ id: "video", label: "Join video visit", icon: <Video aria-hidden="true" />, onSelect: () => { window.open(`/visit/host/${encodeURIComponent(appointment.id)}`, "_blank", "noopener"); }, inline: <Button size="sm" variant="outline" className="shrink-0" render={<a href={`/visit/host/${encodeURIComponent(appointment.id)}`} target="_blank" rel="noopener" />}><Video aria-hidden="true" /> Join video visit</Button> }] : []),
          ...(showOverview && profile.features.records && access.can("records.view") ? [{ id: "record", label: "Add record", icon: <FilePlus2 aria-hidden="true" />, href: `/records?new=1&patient=${encodeURIComponent(appointment.patientId)}&visit=${encodeURIComponent(appointment.id)}` }] : []),
        ]}
        menu={showOverview ? [...more.menu, ...credit.menu] : []}
      />
    </div>
    {scheduling && stage !== "overview" ? <TaskSteps label={`${t.Appointment} task progress`} steps={["Choose time", "Review change", "Confirmation"]} current={stage === "choose" ? 0 : stage === "review" ? 1 : 2} complete={stage === "result"} /> : null}

    {showOverview ? <>
      {database && stage === "overview" && appointment.status === "requested" ? <ApprovalCard appointment={appointment} version={appointmentVersion} refresh={async () => { await staff?.refresh(); }} /> : null}
      <RequestOutcomeBanner appointment={appointment} />
      <CancelReasonNotes appointment={appointment} />
      {database && appointment.status === "completed" ? <AppointmentRatingNote appointmentId={appointment.id} /> : null}
      {error && !destructiveReview ? <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertDescription>{error}</AlertDescription></Alert> : null}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section aria-label={`${t.Appointment} context`}>
          <Frame>
            <FrameHeader className="px-3 py-2"><h2 className="text-sm font-medium">{t.Appointment} details</h2></FrameHeader>
            {["cancelled", "no_show", "declined", "expired", "reschedule_requested"].includes(appointment.status) ? null : (
              <FramePanel className="p-4">
                <TaskSteps label={`${t.Visit} progress`} steps={visitSteps} current={visitCurrent} complete={appointment.status === "completed"} />
              </FramePanel>
            )}
            <FramePanel className="p-4">{facts}</FramePanel>
          </Frame>
        </section>

        <section aria-label="Next actions" className="lg:row-span-3">
          <Frame>
            <FrameHeader className="px-3 py-2"><h2 className="text-sm font-medium">Next action</h2></FrameHeader>
            <FramePanel className="flex flex-col gap-2 p-3">
              {appointment.status === "requested" ? <>{database ? null : <Button className="w-full" onClick={() => begin("approve")}>Approve request</Button>}<Button className="w-full" variant="outline" onClick={() => begin("suggest")}>Suggest another time</Button></> : null}
              {appointment.status === "booked" ? <><Button className="w-full" onClick={() => begin("checkin")}>Check in {t.customer}</Button><Button className="w-full" variant="outline" onClick={() => begin("reschedule")}>Reschedule</Button></> : null}
              {appointment.status === "checked_in" && !database && !timing?.startedAt ? <Button className="w-full" onClick={() => begin("start")}>Start {t.appointment}</Button> : null}
              {appointment.status === "checked_in" && (database || timing?.startedAt) ? <Button className="w-full" onClick={() => begin("complete")}>Complete {t.appointment}</Button> : null}
              {["requested", "booked", "checked_in"].includes(appointment.status) && appointment.formStatus !== "submitted" ? <Button className="w-full" variant="outline" onClick={() => begin("form_received")}>Mark form received</Button> : null}
              {(appointment.status === "requested" && !database) || appointment.status === "booked" ? <Separator className="my-1" /> : null}
              {appointment.status === "requested" && !database ? <Button className="w-full" variant="destructive-outline" onClick={() => begin("decline")}>Decline request</Button> : null}
              {appointment.status === "booked" ? <>{Date.parse(operations.clockIso) >= Date.parse(appointment.startsAt) ? <Button className="w-full" variant="outline" onClick={() => begin("no_show")}>Mark no-show</Button> : null}<Button className="w-full" variant="destructive-outline" onClick={() => begin("cancel")}>Cancel {t.appointment}</Button></> : null}
              {!["requested", "booked", "checked_in"].includes(appointment.status) ? <p className="text-sm text-muted-foreground">{appointment.status === "reschedule_requested" ? `Waiting for the ${t.customer}. Use the more menu to cancel.` : `No further staff action is available for this ${t.appointment}.`}</p> : null}
            </FramePanel>
          </Frame>
        </section>

        <section aria-label="Preparation" className="lg:col-start-1">
          <Frame>
            <FrameHeader className="px-3 py-2"><h2 className="text-sm font-medium">Preparation</h2></FrameHeader>
            <FramePanel className="p-4">
              <dl className="grid gap-4 sm:grid-cols-2">
                <Fact label={`Reason for ${t.visit}`} className="sm:col-span-2"><VisitReasonField appointment={appointment} label={`Reason for ${t.visit}`} /></Fact>
                <Fact label="Booked through">{staffBookingSources.includes(appointment.bookingSource) ? <VisitSourceField appointment={appointment} label="Booked through" /> : bookingOriginLine(appointment)}</Fact>
                <Fact label="Preferred contact">
                  <span className="flex flex-wrap items-center gap-x-2">
                    <span className="tabular-nums">{patient ? channelLabel(patient.preferredChannel) : "Unknown"} · {patient?.phone}</span>
                    {patient && canEditPatient ? <button type="button" className="text-xs font-normal text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => setEditingPatient(true)}>Edit {t.customer} details</button> : null}
                  </span>
                </Fact>
                <Fact label="Accommodation">{patient?.accessibilityNeed ?? "None recorded"}</Fact>
                <Fact label="Notes for the team" className="sm:col-span-2"><VisitNotesField appointment={appointment} label="Notes for the team" /></Fact>
                <Fact label="Confirmation"><StatusBadge className="capitalize" tone={appointment.confirmationStatus === "confirmed" ? "success" : appointment.confirmationStatus === "declined" ? "danger" : "attention"}>{appointment.confirmationStatus.replaceAll("_", " ")}</StatusBadge></Fact>
                <Fact label="Reminder"><StatusBadge className="capitalize" tone={appointment.reminderStatus === "delivered" ? "success" : appointment.reminderStatus === "failed" ? "danger" : appointment.reminderStatus === "queued" ? "info" : "neutral"}>{appointment.reminderStatus.replaceAll("_", " ")}</StatusBadge></Fact>
                <Fact label="Form"><StatusBadge className="capitalize" tone={appointment.formStatus === "submitted" ? "success" : appointment.formStatus === "in_progress" ? "info" : appointment.formStatus === "not_started" ? "attention" : "neutral"}>{appointment.formStatus.replaceAll("_", " ")}</StatusBadge></Fact>
              </dl>
            </FramePanel>
            <VisitCustomProperties appointment={appointment} wrap={(rows) => (
              <FramePanel className="p-4">
                <h3 className="mb-2 text-xs text-muted-foreground">Properties</h3>
                {rows}
              </FramePanel>
            )} />
          </Frame>
        </section>
        {database ? <VisitInvoicePanel appointmentId={appointment.id} /> : null}
        {appointment.seriesId && database && access.can("appointments.book") ? <SeriesPanel seriesId={appointment.seriesId} appointmentId={appointment.id} /> : null}
        {patient && canEditPatient ? (
          <PatientDetailsDialog
            open={editingPatient}
            onOpenChange={setEditingPatient}
            patient={patient}
            patients={patients}
            onSaved={async () => { await staff?.refresh(); setEditingPatient(false); }}
          />
        ) : null}

        <BookingFormAnswers appointmentId={appointment.id} />

        {database ? <AppointmentRoutingCard appointmentId={appointment.id} /> : null}

        {database ? <BookingHistory key={appointment.id} appointmentId={appointment.id} /> : null}

        <section aria-label="Recent scheduling activity" className="lg:col-start-1">
          <Frame>
            <FrameHeader className="px-3 py-2"><h2 className="text-sm font-medium">Recent scheduling activity</h2></FrameHeader>
            {auditEvents.some((event) => event.appointmentId === appointment.id) ? (
              <FramePanel className="p-4">
                <ul className="flex flex-col gap-2">
                  {auditEvents.filter((event) => event.appointmentId === appointment.id).map((event) => <li key={event.id} className="flex flex-wrap items-baseline gap-x-2 text-sm"><span className="font-medium">{event.action}</span><span className="text-xs text-muted-foreground">{event.actorLabel}</span></li>)}
                </ul>
              </FramePanel>
            ) : null}
            <FrameFooter className="px-3 py-2"><p className="text-xs text-muted-foreground">{database ? `${t.Business} actions are stored with the ${t.appointment}. No ${t.customer} message is sent.` : `Preview actions remain in this browser session. No ${t.customer} message is sent.`}</p></FrameFooter>
          </Frame>
        </section>
      </div>
    </> : null}

    {stage === "choose" && scheduling ? (
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-4">
          {error ? <Alert variant="warning"><TriangleAlert aria-hidden="true" /><AlertDescription>{error}</AlertDescription></Alert> : null}
          <Frame>
            <FrameHeader className="flex-row flex-wrap items-center justify-between gap-2 px-3 py-2">
              <div className="flex items-center gap-1">
                <Button size="icon" variant="outline" aria-label="Previous reschedule date" onClick={() => changeDate(addClinicDays(selectedDate, -1))}><ChevronLeft aria-hidden="true" /></Button>
                <DatePicker aria-label="Opening date" className="w-auto" value={selectedDate} onValueChange={(next) => { if (isClinicDateKey(next)) changeDate(next); }} />
                <Button size="icon" variant="outline" aria-label="Next reschedule date" onClick={() => changeDate(addClinicDays(selectedDate, 1))}><ChevronRight aria-hidden="true" /></Button>
              </div>
              <OpeningsViewControl value={openingsView} onValueChange={setOpeningsView} />
            </FrameHeader>
            <FramePanel className="p-3">
              {slotsLoading ? (
                <div role="status" className="flex flex-col gap-3">
                  <p className="text-sm text-muted-foreground">Loading compatible openings…</p>
                  <div aria-hidden="true" className="grid grid-cols-2 gap-2 sm:grid-cols-3">{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-14" />)}</div>
                </div>
              ) : slots.length && openingsView === "calendar" ? (
                <OpeningsCalendar dateKey={selectedDate} slots={slots} selected={selectedSlot} practitioners={catalog.practitioners} onSelect={(slot) => { setSelectedSlot(slot); setStage("review"); setError(""); }} />
              ) : slots.length ? (
                <div className="flex flex-col gap-2">
                  <ScrollArea className="flex h-auto! max-h-[36rem] flex-col">
                  <div className="grid grid-cols-1 gap-2 p-px min-[26rem]:grid-cols-2 sm:grid-cols-3">
                    {(showAllSlots ? slots : slots.slice(0, 36)).map((slot) => {
                      const room = slot.resourceId ? catalog.resourceName(slot.resourceId) : `No ${t.resource} required`;
                      return <OpeningButton key={slot.id} selected={selectedSlot?.id === slot.id} day={appointmentDay(slot.startsAt)} time={appointmentTime(slot.startsAt)} meta={<>{catalog.practitionerName(slot.practitionerId)} · {room}</>} onClick={() => { setSelectedSlot(slot); setStage("review"); setError(""); }} />;
                    })}
                  </div>
                  </ScrollArea>
                  {!showAllSlots && slots.length > 36 ? <Button variant="ghost" className="w-full" onClick={() => setShowAllSlots(true)}>Show all {slots.length} openings</Button> : null}
                </div>
              ) : (
                <Empty className="p-4 md:p-6">
                  <EmptyHeader>
                    <EmptyMedia variant="icon"><CalendarOff aria-hidden="true" /></EmptyMedia>
                    <EmptyDescription>No openings on this date.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </FramePanel>
          </Frame>
        </div>
        <aside className="flex flex-col gap-2">
          <Frame>
            <FrameHeader className="px-3 py-2"><h2 className="text-sm font-medium">Current {t.appointment}</h2></FrameHeader>
            <FramePanel className="flex flex-col gap-1 p-4">
              <p className="text-sm font-medium tabular-nums">{appointmentDateTime(appointment.startsAt)}</p>
              <p className="text-xs text-muted-foreground">{catalog.practitionerName(appointment.practitionerId)} · {resourceLabel}</p>
            </FramePanel>
          </Frame>
          <Button variant="outline" onClick={() => setStage("overview")}>Back to {t.appointment}</Button>
        </aside>
      </div>
    ) : null}

    {stage === "review" && action && !destructiveReview ? (
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-4">
          {error ? <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertDescription>{error}</AlertDescription></Alert> : null}
          <LimitOverridePrompt override={limitOverride} actionLabel="Move anyway" pending={pending} onConfirm={commit} />
          {scheduling && selectedSlot ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <Card>
                <CardPanel className="flex flex-col gap-1">
                  <h2 className="text-xs text-muted-foreground">Current {t.appointment}</h2>
                  <p className="text-sm font-medium tabular-nums">{appointmentDateTime(appointment.startsAt)}</p>
                  <p className="text-xs text-muted-foreground">{catalog.practitionerName(appointment.practitionerId)} · {resourceLabel}</p>
                </CardPanel>
              </Card>
              <Card className="border-primary">
                <CardPanel className="flex flex-col gap-1">
                  <h2 className="text-xs font-medium text-primary">Proposed {t.appointment}</h2>
                  <p className="text-sm font-medium tabular-nums">{appointmentDateTime(selectedSlot.startsAt)}</p>
                  <p className="text-xs text-muted-foreground">{catalog.practitionerName(selectedSlot.practitionerId)} · {selectedSlot.resourceId ? catalog.resourceName(selectedSlot.resourceId) : `No ${t.resource} required`}</p>
                </CardPanel>
              </Card>
            </div>
          ) : (
            <Frame>
              <FrameHeader className="px-3 py-2"><h2 className="text-sm font-medium">{t.Appointment} details</h2></FrameHeader>
              <FramePanel className="p-4">{facts}</FramePanel>
            </Frame>
          )}
        </div>
        <aside>
          <Frame>
            <FrameHeader className="px-3 py-2"><h2 className="text-sm font-medium">Confirm this change</h2></FrameHeader>
            <FramePanel className="flex flex-col gap-2 p-4 text-sm">
              <p>{scheduling ? "Check the current and proposed time before confirming." : action === "start" ? `This moves the ${t.customer} from Checked in to In ${t.appointment}.` : action === "complete" ? `This marks the ${t.visit} completed and moves it out of the active flow.` : action === "form_received" ? database ? `This marks the scheduling form as received. ${formUploadNote}` : `This marks the scheduling form as received in this browser preview. ${formUploadNote}` : `Check the ${t.appointment} before confirming this change.`}</p>
              <p className="text-xs text-muted-foreground">{messageNote}</p>
            </FramePanel>
            <FrameFooter className="flex flex-col gap-2 px-3 py-3">
              <Button className="w-full" onClick={commit} loading={pending}>{scheduling ? action === "suggest" ? "Confirm suggested time" : "Confirm reschedule" : `Confirm ${actionLabel(action, t).toLowerCase()}`}</Button>
              <Button className="w-full" variant="outline" onClick={() => setStage(scheduling ? "choose" : "overview")}>Back</Button>
            </FrameFooter>
          </Frame>
        </aside>
      </div>
    ) : null}

    {stage === "result" && action ? (
      <Frame role="status" className="max-w-3xl">
        <FramePanel className="flex flex-col gap-4 p-4">
          <div className="flex items-start gap-3">
            <CircleCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-success-foreground" />
            <div>
              <h2 className="font-heading text-base font-semibold">{actionLabel(action, t)} recorded</h2>
              <p className="text-sm text-muted-foreground">{database ? `The ${t.business} ${t.appointment} has been updated. No ${t.customer} notification was sent.` : `The preview ${t.appointment} has been updated. No ${t.customer} notification was sent.`}</p>
              {error ? <p className="mt-1 text-sm text-destructive-foreground">{error}</p> : null}
            </div>
          </div>
          <Separator />
          {facts}
        </FramePanel>
        <FrameFooter className="flex flex-row px-3 py-2">
          <Button size="sm" render={<Link href={returnHref} />}>Return to {backLabel}<ArrowRight aria-hidden="true" /></Button>
        </FrameFooter>
      </Frame>
    ) : null}

    {appointment.seriesId && scopeFor ? (
      <SeriesScopeDialog
        action={scopeFor}
        appointment={appointment}
        open
        onOpenChange={(next) => { if (!next) setScopeFor(null); }}
        onThisOne={() => startAction(scopeFor)}
        onDone={async () => { await staff?.refresh(); setScopeFor(null); }}
      />
    ) : null}

    {more.dialogs}
    {credit.dialogs}

    {destructiveAction ? (
      <AlertDialog open={destructiveReview} onOpenChange={(next) => { if (!next && !pending) setStage("overview"); }}>
        <AlertDialogPopup finalFocus={stage === "result" ? titleRef : undefined}>
          <AlertDialogHeader>
            <AlertDialogTitle>{reviewTitle(destructiveAction)}</AlertDialogTitle>
            <AlertDialogDescription>{appointmentDateTime(appointment.startsAt)} · {name}. {closureNote} {messageNote}</AlertDialogDescription>
            {error ? <Alert variant="error" className="mt-2 text-start"><TriangleAlert aria-hidden="true" /><AlertDescription>{error}</AlertDescription></Alert> : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={pending} render={<Button variant="ghost" />}>Back</AlertDialogClose>
            <Button variant="destructive" onClick={commit} loading={pending}>{`Confirm ${actionLabel(destructiveAction, t).toLowerCase()}`}</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    ) : null}
  </div>;
}
