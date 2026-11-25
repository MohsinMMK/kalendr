"use client";

import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ArrowLeft, ArrowRight, CalendarOff, Check, ChevronLeft, ChevronRight, CalendarClock, CircleCheck, Copy, SearchX, Stethoscope, TriangleAlert } from "lucide-react";
import Link from "next/link";

import { DateField } from "@/components/date-picker";
import { PhoneField, SelectField, TextareaField, TextField } from "@/components/form-fields";
import { PageHeader } from "@/components/page-header";
import { RowButton } from "@/components/row-button";
import { SearchField } from "@/components/search-field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PersonAvatar } from "@/components/person-avatar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Frame, FrameFooter, FrameHeader, FramePanel } from "@/components/ui/frame";
import { Label } from "@/components/ui/label";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { TogglePrimitive } from "@/components/ui/toggle";
import { ToggleGroupPrimitive } from "@/components/ui/toggle-group";
import { toastManager } from "@/components/ui/toast";
import { useBusinessProfile, useTerms } from "@/features/terms/business-profile-context";
import { bookingSourceLabels } from "@/lib/booking-source";
import { isClinicalBusinessType } from "@/lib/business-types";
import { demoAppointments } from "@/lib/demo-data";
import type { Appointment, ContactChannel, Patient, TimeSlot } from "@/lib/domain";
import { withArticle } from "@/lib/terminology";

import type { ScheduleView } from "./schedule-view";
import { cn } from "@/lib/utils";

import { appointmentDateTime, appointmentDay, appointmentTime } from "./clinic-format";
import { clinicDayBounds, useCatalogLookups } from "./clinic-catalog";
import { matchingPatientContacts, patientBookingContext, patientName as fullPatientName, searchPatients } from "./patient-directory";
import { OutstandingNotice } from "./outstanding-balance";
import { BookingDiscountControl, useBookingDiscount } from "./booking-discount";
import type { PatientSearchField } from "./patient-directory";
import { appointmentEndForSlot, compatibleSlots, usePreviewAppointments } from "./preview-appointments";
import { addClinicDays, clinicDateKey, isClinicDateKey } from "./schedule-availability";
import { LimitOverridePrompt, useLimitOverride } from "./limit-override";
import { useUpgradePrompt } from "@/features/billing/upgrade-prompt";
import { fetchAvailabilitySlots, staffMutation, useOptionalStaffSnapshot } from "./staff-snapshot-provider";
import { Fact, OpeningButton, TaskSteps } from "./task-ui";
import { OpeningsCalendar, OpeningsViewControl, useOpeningsView } from "./clinic-calendar";
import { RepeatControl, RepeatReview } from "./repeat-booking";
import { clockIn, draftSummary, draftToRule, noRepeat, type RepeatDraft } from "./repeat-model";
import { useStaffAccess } from "./staff-access";
import { ScrollArea } from "@/components/ui/scroll-area";

type Stage = "patient" | "slot" | "review" | "result";
type PatientMode = "existing" | "new";
/** How the booking reached the front desk. A walk-in is seen now and is checked in straight away. */
type DeskSource = "phone" | "desk" | "walk_in";
const walkInLookbackMs = 15 * 60_000;

export function NewAppointmentTask({ from = "dashboard", initialDate, initialView = "staff", initialLocation, initialService, initialStart, initialPractitioner, initialResource, initialPatient }: { from?: "dashboard" | "schedule"; initialDate?: string; initialView?: ScheduleView; initialLocation?: string; initialService?: string; initialStart?: string; initialPractitioner?: string; initialResource?: string; initialPatient?: string }) {
  const { appointments, patients, operations, addAppointment, recordAudit, database } = usePreviewAppointments();
  const t = useTerms();
  const profile = useBusinessProfile();
  const clinical = isClinicalBusinessType(profile.businessType);
  const catalog = useCatalogLookups();
  const staff = useOptionalStaffSnapshot();
  const [remoteSlots, setRemoteSlots] = useState<{ key: string; slots: TimeSlot[] } | null>(null);
  const [pending, setPending] = useState(false);
  const startingDate = isClinicDateKey(initialDate ?? "") ? initialDate! : database ? clinicDateKey(operations.clockIso) : clinicDateKey(demoAppointments[0].startsAt);
  const startingLocation = catalog.locations.some((item) => item.id === initialLocation) ? initialLocation! : catalog.locations[0]?.id ?? "";
  const returnHref = from === "schedule" ? `/schedule?date=${startingDate}&view=${initialView}&location=${startingLocation}` : "/dashboard";
  const [stage, setStage] = useState<Stage>("patient");
  const [mode, setMode] = useState<PatientMode>("existing");
  const [existingPatientId, setExistingPatientId] = useState(initialPatient ?? "");
  const [patientQuery, setPatientQuery] = useState("");
  const [patientSearchField, setPatientSearchField] = useState<PatientSearchField>("all");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [preferredChannel, setPreferredChannel] = useState<ContactChannel>("sms");
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [messagingConsent, setMessagingConsent] = useState(false);
  const [source, setSource] = useState<DeskSource>("desk");
  const [reasonForVisit, setReasonForVisit] = useState("");
  const [manageToken, setManageToken] = useState("");
  const [locationId, setLocationId] = useState(startingLocation);
  const [serviceId, setServiceId] = useState(initialService ?? "");
  const [practitionerId, setPractitionerId] = useState(initialPractitioner ?? "");
  const [selectedDate, setSelectedDate] = useState(startingDate);
  const [slot, setSlot] = useState<TimeSlot | null>(() => {
    const service = catalog.services.find((item) => item.id === initialService);
    const location = catalog.locations.find((item) => item.id === initialLocation) ?? catalog.locations[0];
    if (database || !service || !location || !initialStart || !initialPractitioner || !initialResource || !Number.isFinite(Date.parse(initialStart)) || clinicDateKey(initialStart) !== startingDate) return null;
    return compatibleSlots({ service, locationId: location.id, appointments, dateKey: startingDate, notBefore: operations.clockIso, availability: operations.schedule }).find((item) => item.startsAt === initialStart && item.practitionerId === initialPractitioner && item.resourceId === initialResource) ?? null;
  });
  const [showAllOpenings, setShowAllOpenings] = useState(false);
  const [openingsView, setOpeningsView] = useOpeningsView();
  const [createdAppointmentId, setCreatedAppointmentId] = useState("");
  // Feature 17: the "Repeat" control, and what a saved series reports back.
  const [repeat, setRepeat] = useState<RepeatDraft>(noRepeat);
  const [seriesResult, setSeriesResult] = useState<{ seriesId: string; visitCount: number; skippedCount: number; appointmentIds: string[] } | null>(null);
  const canRepeat = useStaffAccess().can("series.manage");
  const [error, setError] = useState("");
  const titleRef = useRef<HTMLSpanElement>(null);

  useEffect(() => { if (stage !== "patient") titleRef.current?.focus(); }, [stage]);

  const selectedPatient = patients.find((patient) => patient.id === existingPatientId);
  const patientResults = searchPatients(patients, patientQuery, patientSearchField);
  const matchingContacts = mode === "new" ? matchingPatientContacts(patients, phone, email).slice(0, 3) : [];
  const patientType = mode === "new" || !selectedPatient || !appointments.some((item) => item.patientId === selectedPatient.id) ? "new" : "returning";
  const eligibleServices = catalog.services.filter((item) => item.patientTypes.includes(patientType));
  const service = catalog.services.find((item) => item.id === serviceId);
  const limitOverride = useLimitOverride(`${service?.id ?? ""}|${slot?.startsAt ?? ""}|${slot?.practitionerId ?? ""}`);
  const upgrade = useUpgradePrompt();
  const discount = useBookingDiscount();
  const location = catalog.locations.find((item) => item.id === locationId);
  const walkIn = source === "walk_in";
  const todayKey = clinicDateKey(operations.clockIso);
  const openingsDate = walkIn ? todayKey : selectedDate;
  const notBefore = walkIn ? new Date(Date.parse(operations.clockIso) - walkInLookbackMs).toISOString() : operations.clockIso;
  const previewOpenings = service && !database ? compatibleSlots({ service, locationId, appointments, patientId: selectedPatient?.id, notBefore, dateKey: openingsDate, availability: operations.schedule }).filter((item) => !practitionerId || item.practitionerId === practitionerId) : [];
  const slotQuery = `${serviceId}|${locationId}|${openingsDate}|${practitionerId}|${walkIn ? "walk_in" : "booked"}`;
  const slotsLoading = database && Boolean(serviceId) && remoteSlots?.key !== slotQuery;
  const openings = database ? (remoteSlots?.key === slotQuery ? remoteSlots.slots : []).filter((item) => !practitionerId || item.practitionerId === practitionerId) : previewOpenings;

  useEffect(() => {
    if (!database || !serviceId || !locationId) return;
    const controller = new AbortController();
    const key = slotQuery;
    const bounds = clinicDayBounds(openingsDate);
    void fetchAvailabilitySlots({
      clinicSlug: catalog.clinic.slug,
      locationId,
      serviceId,
      practitionerId: practitionerId || "first_available",
      from: bounds.from,
      to: bounds.to,
      walkIn,
    }, controller.signal).then((slots) => {
      if (controller.signal.aborted) return;
      setRemoteSlots({ key, slots });
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setRemoteSlots({ key, slots: [] });
      setError(cause instanceof Error ? cause.message : "Compatible openings could not be loaded.");
    });
    return () => controller.abort();
  }, [catalog.clinic.slug, database, locationId, openingsDate, practitionerId, serviceId, slotQuery, walkIn]);
  const orderedOpenings = slot ? [...openings.filter((item) => item.startsAt === slot.startsAt && item.practitionerId === slot.practitionerId && item.resourceId === slot.resourceId), ...openings.filter((item) => item.startsAt !== slot.startsAt || item.practitionerId !== slot.practitionerId || item.resourceId !== slot.resourceId)] : openings;
  const displayedOpenings = showAllOpenings ? orderedOpenings : orderedOpenings.slice(0, 28);
  const repeatStartsOn = slot ? clinicDateKey(slot.startsAt) : selectedDate;
  const repeatRule = database && canRepeat && !walkIn ? draftToRule(repeat, repeatStartsOn) : null;
  const repeatingRule = repeatRule && "rule" in repeatRule ? repeatRule.rule : null;
  const patientName = mode === "existing" ? selectedPatient ? `${selectedPatient.firstName} ${selectedPatient.lastName}`.trim() : "" : `${firstName.trim()} ${lastName.trim()}`.trim();

  function nextFromPatient(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode === "existing" && !selectedPatient) {
      setError(`Choose an existing ${t.customer} before continuing.`);
      return;
    }
    const phoneDigits = phone.replace(/\D/g, "");
    if (mode === "new" && (firstName.trim().length < 2 || !lastName.trim() || phoneDigits.length < 8 || phoneDigits.length > 15 || !/^\+?[\d\s()-]+$/.test(phone.trim()) || ((preferredChannel === "email" || database) && !email.includes("@")))) {
      setError(database ? `Enter the new ${t.customer}'s name, a valid phone number, and email.` : `Enter the new ${t.customer}'s name and a valid phone number. Email is required when email is the preferred contact.`);
      return;
    }
    if (mode === "new" && profile.features.dateOfBirth && dateOfBirth && dateOfBirth > todayKey) {
      setError("Date of birth can't be in the future.");
      return;
    }
    if (service && !eligibleServices.some((item) => item.id === service.id)) { setServiceId(""); setSlot(null); }
    else if (slot && !openings.some((item) => item.startsAt === slot.startsAt && item.practitionerId === slot.practitionerId && item.resourceId === slot.resourceId)) setSlot(null);
    setError("");
    setStage("slot");
  }

  function nextFromSlot() {
    if (!service || !slot) {
      setError("Choose a service and compatible opening before reviewing.");
      return;
    }
    if (repeatRule && "error" in repeatRule) {
      setError(repeatRule.error);
      return;
    }
    setError("");
    setStage("review");
  }

  function commit() {
    if (!service || !slot || !location || (mode === "existing" && !selectedPatient)) {
      setError(`This ${t.appointment} is incomplete. Go back and check the details.`);
      return;
    }
    if (database) {
      if (mode === "new" && !email.trim().includes("@")) {
        setError(`Email is required when creating ${withArticle(`${t.business} ${t.customer}`)}.`);
        setStage("patient");
        return;
      }
      setPending(true);
      void (async () => {
        try {
          const result = await staffMutation<{ appointmentId: string; manageToken?: string }>(
            "/api/staff/appointments",
            "POST",
            {
              clinicSlug: catalog.clinic.slug,
              locationId,
              serviceId: service.id,
              practitionerId: slot.practitionerId,
              startsAt: slot.startsAt,
              source,
              ...limitOverride.takeBody(),
              ...discount.body(),
              ...(reasonForVisit.trim() ? { reasonForVisit: reasonForVisit.trim() } : {}),
              ...(mode === "existing"
                ? { patientId: selectedPatient!.id }
                : { newPatient: { firstName: firstName.trim(), lastName: lastName.trim(), phone: phone.trim(), email: email.trim(), preferredChannel, isDependent: false, messagingConsent, ...(profile.features.dateOfBirth && dateOfBirth ? { dateOfBirth } : {}) } }),
            },
            { idempotencyKey: crypto.randomUUID() },
          );
          await staff?.refresh();
          setCreatedAppointmentId(result.appointmentId);
          setManageToken(result.manageToken ?? "");
          setError("");
          limitOverride.clear();
          setStage("result");
        } catch (cause: unknown) {
          // A full limit stays on the review step, where staff can choose a reason and book anyway.
          if (limitOverride.capture(cause) || upgrade.fromError(cause)) return;
          // A refused code or package stays beside the Discount field, on the step that has it.
          if (discount.capture(cause)) { setStage("slot"); return; }
          setError(cause instanceof Error ? cause.message : `Could not save this ${t.appointment}. Choose another time.`);
          setStage("slot");
        } finally {
          setPending(false);
        }
      })();
      return;
    }
    const chosen = compatibleSlots({ service, locationId, appointments, patientId: selectedPatient?.id, notBefore, dateKey: openingsDate, availability: operations.schedule }).find((item) => item.startsAt === slot.startsAt && item.practitionerId === slot.practitionerId && item.resourceId === slot.resourceId && (!practitionerId || item.practitionerId === practitionerId));
    if (!chosen || !service.patientTypes.includes(patientType)) {
      setError("That opening is no longer compatible or available. Choose another time.");
      setStage("slot");
      return;
    }
    const sequence = appointments.length + 1;
    const id = `apt_preview_${sequence}`;
    const newPatient: Patient | undefined = mode === "new" ? {
      id: `patient_preview_${sequence}`,
      clinicId: catalog.clinic.id,
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      phone: phone.trim(),
      email: email.trim(),
      preferredChannel,
      isDependent: false,
      ...(profile.features.dateOfBirth && dateOfBirth ? { dateOfBirth } : {}),
      ...(messagingConsent ? { messagingConsentAt: operations.clockIso } : {}),
    } : undefined;
    const appointment: Appointment = {
      id,
      clinicId: catalog.clinic.id,
      locationId,
      patientId: newPatient?.id ?? selectedPatient!.id,
      practitionerId: chosen.practitionerId,
      serviceId: service.id,
      resourceIds: chosen.resourceId ? [chosen.resourceId] : [],
      startsAt: chosen.startsAt,
      endsAt: appointmentEndForSlot(chosen, service),
      status: walkIn ? "checked_in" : "booked",
      confirmationStatus: "confirmed",
      bookingSource: source === "desk" ? "staff" : source,
      ...(reasonForVisit.trim() ? { reasonForVisit: reasonForVisit.trim() } : {}),
      formStatus: "not_assigned",
      reminderStatus: "not_scheduled",
      manageToken: `preview-${id}`,
    };
    if (!addAppointment(appointment, newPatient)) {
      setError(`Could not save this ${t.appointment}, or the opening was taken. Choose another time.`);
      setStage("slot");
      return;
    }
    recordAudit({ id: `audit_${id}`, clinicId: catalog.clinic.id, appointmentId: id, actorLabel: "Preview staff", action: walkIn ? "Checked in walk-in" : `Created ${t.appointment}`, outcome: "success", occurredAt: operations.clockIso });
    setCreatedAppointmentId(id);
    setManageToken(appointment.manageToken);
    setError("");
    setStage("result");
  }

  const title = stage === "result" ? walkIn ? "Walk-in checked in" : seriesResult ? `${t.Appointments} added` : `${t.Appointment} added` : stage === "review" ? walkIn ? "Review walk-in" : `Review new ${t.appointment}` : stage === "slot" ? "Choose an opening" : `Add ${t.appointment}`;
  const stepIndex = stage === "patient" ? 0 : stage === "slot" ? 1 : stage === "review" ? 2 : 3;
  const roomName = slot ? slot.resourceId ? catalog.resourceName(slot.resourceId) : `No ${t.resource} required` : "";
  const notSelected = <span className="font-normal text-muted-foreground">Not selected</span>;
  const summary = (
    <aside className="hidden lg:block" aria-label={`${t.Appointment} summary`}>
      <Frame>
        <FrameHeader className="px-3 py-2"><h2 className="text-sm font-medium">{t.Appointment} summary</h2></FrameHeader>
        <FramePanel className="p-4">
          <dl className="flex flex-col gap-4">
            <Fact label={t.Customer}>{patientName || notSelected}</Fact>
            <Fact label="Booked through">{bookingSourceLabels[source === "desk" ? "staff" : source]}</Fact>
            <Fact label="Location">{location?.name ?? notSelected}</Fact>
            <Fact label="Service">{service ? `${service.name} · ${service.durationMinutes} min` : notSelected}</Fact>
            <Fact label="Date and time">{slot ? <span className="tabular-nums">{appointmentDateTime(slot.startsAt)}</span> : notSelected}</Fact>
            <Fact label={`${t.Practitioner} and ${t.resource}`}>{slot ? `${catalog.practitionerName(slot.practitionerId)} · ${roomName}` : notSelected}</Fact>
            {repeatingRule && slot ? <Fact label="Repeats">{draftSummary(repeat, repeatStartsOn, clockIn(slot.startsAt), { visit: t.visit, visits: t.visits })}</Fact> : null}
          </dl>
        </FramePanel>
      </Frame>
    </aside>
  );

  return <div className="flex flex-col gap-4 p-4 md:p-6">
    <Button size="sm" variant="ghost" className="-ms-2 self-start" render={<Link href={returnHref} />}><ArrowLeft aria-hidden="true" /> Back to {from === "schedule" ? "Schedule" : "Today"}</Button>
    <PageHeader
      title={<span ref={titleRef} tabIndex={-1} className="outline-none">{title}</span>}
      description={stage === "patient" ? `Find ${t.aCustomer} or add a new one.` : stage === "slot" ? `For ${patientName}` : stage === "review" ? database ? `Check the details before saving this ${t.business} ${t.appointment}.` : "Check the details before saving this browser preview." : database ? `Saved to this ${t.business}.` : "Saved in this browser session."}
    />
    <TaskSteps label={`New ${t.appointment} progress`} steps={[t.Customer, "Opening", "Review", "Saved"]} current={stepIndex} complete={stage === "result"} />
    {error ? <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertDescription>{error}</AlertDescription></Alert> : null}
    <LimitOverridePrompt override={limitOverride} actionLabel="Book anyway" pending={pending} onConfirm={commit} />

    {stage === "patient" ? (
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <form onSubmit={nextFromPatient} className="min-w-0">
          <Frame>
            <FrameHeader className="px-3 py-2">
              <SegmentedControl className="w-full sm:w-fit" render={<ToggleGroupPrimitive aria-label={`${t.Customer} type`} value={[mode]} onValueChange={(next: string[]) => { const value = next[0] as PatientMode | undefined; if (value) { setMode(value); setError(""); } }} />}>
                <SegmentedControlItem className="grow" render={<TogglePrimitive value="existing" />}>Existing {t.customer}</SegmentedControlItem>
                <SegmentedControlItem className="grow" render={<TogglePrimitive value="new" />}>New {t.customer}</SegmentedControlItem>
              </SegmentedControl>
            </FrameHeader>
            {mode === "existing" ? (
              <FramePanel className="flex flex-col gap-3 p-4">
                <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
                  <Field><FieldLabel>Search {t.customers}</FieldLabel><SearchField value={patientQuery} onChange={(event) => setPatientQuery(event.target.value)} placeholder="Name, phone or email" /></Field>
                  <SelectField label="Search in" size="default" value={patientSearchField} onValueChange={(next) => setPatientSearchField(next as PatientSearchField)} options={[{ value: "all", label: "All fields" }, { value: "name", label: "Name" }, { value: "phone", label: "Phone" }, { value: "email", label: "Email" }]} />
                </div>
                <div className="flex min-h-7 flex-wrap items-center justify-between gap-2">
                  <p aria-live="polite" className="text-xs text-muted-foreground tabular-nums">{patientResults.length} matching {patientResults.length === 1 ? t.customer : t.customers}</p>
                  {patientQuery ? <Button size="xs" variant="ghost" onClick={() => setPatientQuery("")}>Clear search</Button> : null}
                </div>
                {selectedPatient ? (
                  <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-primary bg-accent px-3 py-2">
                    <PersonAvatar name={fullPatientName(selectedPatient)} />
                    <div className="min-w-48 flex-1">
                      <p className="text-sm font-medium">Selected: {fullPatientName(selectedPatient)}</p>
                      <p className="text-xs text-muted-foreground tabular-nums wrap-anywhere">{selectedPatient.phone}</p>
                    </div>
                    <Button size="xs" variant="ghost" onClick={() => { setExistingPatientId(""); setError(""); }}>Clear selection</Button>
                  </div>
                ) : null}
                <OutstandingNotice patientId={existingPatientId || undefined} />
                <ScrollArea role="region" aria-label={`Matching ${t.customers}`} className="flex h-auto! max-h-80 flex-col rounded-lg">
                <div className="flex flex-col gap-1">
                  {patientResults.length ? patientResults.map((patient) => {
                    const context = patientBookingContext(patient.id, appointments, operations.clockIso);
                    const name = fullPatientName(patient);
                    const selected = existingPatientId === patient.id;
                    return (
                      <RowButton key={patient.id} variant="outline" aria-pressed={selected} onClick={() => { setExistingPatientId(patient.id); setError(""); }} className={cn("shrink-0 gap-3 border-transparent px-2 py-2 shadow-none not-disabled:not-active:not-aria-[haspopup]:before:shadow-none", selected ? "border-primary bg-accent" : "bg-transparent")}>
                        <PersonAvatar name={name} />
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium">{name}</span>
                          <span className="block text-xs text-muted-foreground tabular-nums whitespace-nowrap">{patient.phone}</span>
                          {patient.email ? <span className="block text-xs text-muted-foreground wrap-anywhere">{patient.email}</span> : null}
                          <span className="block text-xs text-muted-foreground tabular-nums">{context ? `${context.kind === "next" ? "Next" : "Last"} ${t.visit}: ${appointmentDateTime(context.appointment.startsAt)}` : `No upcoming or completed ${t.visit}`}</span>
                        </span>
                        {selected ? <Check aria-hidden="true" className="text-primary" /> : null}
                      </RowButton>
                    );
                  }) : (
                    <Empty className="p-4 md:p-6">
                      <EmptyHeader>
                        <EmptyMedia variant="icon"><SearchX aria-hidden="true" /></EmptyMedia>
                        <EmptyDescription>No {t.customers} match. Try another field or clear the search.</EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  )}
                </div>
                </ScrollArea>
              </FramePanel>
            ) : (
              <FramePanel className="grid gap-4 p-4 sm:grid-cols-2">
                <TextField label="First name" value={firstName} onChange={(event) => setFirstName(event.target.value)} required minLength={2} maxLength={80} autoComplete="given-name" />
                <TextField label="Last name" value={lastName} onChange={(event) => setLastName(event.target.value)} required maxLength={80} autoComplete="family-name" />
                <PhoneField label="Phone" value={phone} onChange={setPhone} required autoComplete="tel" />
                <TextField label="Email" optional={preferredChannel !== "email" && !database} value={email} onChange={(event) => setEmail(event.target.value)} required={preferredChannel === "email" || database} type="email" maxLength={254} autoComplete="email" />
                {profile.features.dateOfBirth ? <TextField label="Date of birth" optional value={dateOfBirth} onChange={(event) => setDateOfBirth(event.target.value)} type="date" max={todayKey} autoComplete="bday" /> : null}
                <SelectField label="Preferred contact" value={preferredChannel} onValueChange={(next) => setPreferredChannel(next as ContactChannel)} options={[{ value: "sms", label: "SMS" }, { value: "email", label: "Email" }, { value: "whatsapp", label: "WhatsApp" }, { value: "phone", label: "Phone call" }]} />
                <Label className="flex cursor-pointer items-start gap-3 sm:col-span-2">
                  <Checkbox className="mt-0.5" checked={messagingConsent} onCheckedChange={(checked) => setMessagingConsent(checked)} />
                  <span className="flex flex-col gap-0.5">
                    <span>{t.Customer} agreed to reminders by text or WhatsApp</span>
                    <span className="text-xs font-normal text-muted-foreground">Ask them first. Without it, reminders go by email only.</span>
                  </span>
                </Label>
                {matchingContacts.length ? (
                  <Alert role="note" variant="warning" className="sm:col-span-2">
                    <TriangleAlert aria-hidden="true" />
                    <AlertTitle>Possible existing {t.customer}</AlertTitle>
                    <AlertDescription>
                      <p>This contact matches a record. Check the identity before creating another.</p>
                      <div className="mt-1 flex w-full flex-col gap-2">
                        {matchingContacts.map((patient) => (
                          <div key={patient.id} className="flex flex-wrap items-center justify-between gap-2">
                            <span className="min-w-0">
                              <span className="block font-medium text-foreground">{fullPatientName(patient)}</span>
                              <span className="block text-xs tabular-nums">{patient.phone}</span>
                            </span>
                            <Button size="xs" variant="outline" onClick={() => { setExistingPatientId(patient.id); setPatientQuery(patient.phone); setPatientSearchField("phone"); setMode("existing"); setError(""); }}>Use existing {t.customer}</Button>
                          </div>
                        ))}
                      </div>
                    </AlertDescription>
                  </Alert>
                ) : null}
              </FramePanel>
            )}
            <FrameFooter className="flex flex-row justify-end px-3 py-2">
              <Button type="submit">Choose service and time <ArrowRight aria-hidden="true" /></Button>
            </FrameFooter>
          </Frame>
        </form>
        {summary}
      </div>
    ) : null}

    {stage === "slot" ? (
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <Frame>
            <FrameHeader className="flex-row flex-wrap items-center justify-between gap-2 px-3 py-2">
              <h2 id="booking-source-label" className="text-sm font-medium">How is this booked?</h2>
              <SegmentedControl className="w-full sm:w-fit" render={<ToggleGroupPrimitive aria-labelledby="booking-source-label" value={[source]} onValueChange={(next: string[]) => { const value = next[0] as DeskSource | undefined; if (value) { setSource(value); setSlot(null); setShowAllOpenings(false); setError(""); } }} />}>
                <SegmentedControlItem className="grow" render={<TogglePrimitive value="phone" />}>Phone call</SegmentedControlItem>
                <SegmentedControlItem className="grow" render={<TogglePrimitive value="desk" />}>At the desk</SegmentedControlItem>
                <SegmentedControlItem className="grow" render={<TogglePrimitive value="walk_in" />}>Walk-in now</SegmentedControlItem>
              </SegmentedControl>
            </FrameHeader>
            <FramePanel className="flex flex-col gap-3 p-4">
              {walkIn ? <p className="text-sm text-muted-foreground">Shows openings from 15 minutes ago to later today. The {t.customer} is checked in when you save, and no message is sent.</p> : null}
              <div className="grid gap-4 sm:grid-cols-2">
                <SelectField label="Location" value={locationId} onValueChange={(next) => { setLocationId(next); setSlot(null); }} options={catalog.locations.map((item) => ({ value: item.id, label: item.name }))} />
                <SelectField label="Service" value={serviceId} onValueChange={(next) => { setServiceId(next); setPractitionerId(""); setSlot(null); }} options={[{ value: "", label: "Choose a service" }, ...eligibleServices.filter((item) => item.locationIds.includes(locationId)).map((item) => ({ value: item.id, label: `${item.name} · ${item.durationMinutes} min` }))]} />
                <SelectField label={t.Practitioner} value={practitionerId} onValueChange={(next) => { setPractitionerId(next); setSlot(null); }} options={[{ value: "", label: `Any eligible ${t.practitioner}` }, ...catalog.practitioners.filter((item) => item.locationIds.includes(locationId) && (!service || service.practitionerIds.includes(item.id))).map((item) => ({ value: item.id, label: item.name }))]} />
                {walkIn ? <TextField label="Date" value="Today" readOnly disabled /> : <DateField label="Date" value={selectedDate} onValueChange={(next) => { if (isClinicDateKey(next)) { setSelectedDate(next); setSlot(null); setShowAllOpenings(false); } }} />}
                <TextareaField fieldClassName="sm:col-span-2" label={`Reason for ${t.visit}`} optional value={reasonForVisit} onChange={(event) => setReasonForVisit(event.target.value)} maxLength={300} rows={2} placeholder={clinical ? "For example: tooth pain on the lower left since Monday" : `For example: anything to know before the ${t.appointment}`} />
                {!repeatingRule ? <div className="sm:col-span-2"><BookingDiscountControl discount={discount} live={database} patientId={mode === "existing" ? existingPatientId || undefined : undefined} serviceId={serviceId || undefined} /></div> : null}
              </div>
            </FramePanel>
          </Frame>
          {database && canRepeat && !walkIn ? <RepeatControl draft={repeat} onChange={setRepeat} startsOn={repeatStartsOn} time={slot ? clockIn(slot.startsAt) : null} /> : null}
          <Frame>
            <FrameHeader className="flex-row flex-wrap items-center justify-between gap-2 px-3 py-2">
              <h2 className="text-sm font-medium tabular-nums">Openings ({openings.length})</h2>
              <div className="flex items-center gap-2">
                <OpeningsViewControl value={openingsView} onValueChange={setOpeningsView} />
                <Button size="icon-sm" variant="outline" aria-label="Previous opening date" disabled={walkIn} onClick={() => { setSelectedDate(addClinicDays(selectedDate, -1)); setSlot(null); setShowAllOpenings(false); }}><ChevronLeft aria-hidden="true" /></Button>
                <Button size="icon-sm" variant="outline" aria-label="Next opening date" disabled={walkIn} onClick={() => { setSelectedDate(addClinicDays(selectedDate, 1)); setSlot(null); setShowAllOpenings(false); }}><ChevronRight aria-hidden="true" /></Button>
              </div>
            </FrameHeader>
            <FramePanel className="flex flex-col gap-3 p-3">
              {service ? (
                <ScrollArea role="region" aria-label="Matching openings" className="flex h-auto! max-h-[32rem] flex-col rounded-lg">
                <div className="flex flex-col gap-2 p-px">
                  {slotsLoading ? (
                    <div className="flex flex-col gap-3">
                      <p className="text-sm text-muted-foreground">Loading compatible openings…</p>
                      <div aria-hidden="true" className="grid grid-cols-2 gap-2 sm:grid-cols-3">{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-14" />)}</div>
                    </div>
                  ) : displayedOpenings.length && openingsView === "calendar" ? (
                    <OpeningsCalendar dateKey={openingsDate} slots={openings} selected={slot} practitioners={catalog.practitioners} onSelect={setSlot} />
                  ) : displayedOpenings.length ? (
                    <div className="grid grid-cols-1 gap-2 min-[26rem]:grid-cols-2 sm:grid-cols-3">
                      {displayedOpenings.map((opening) => {
                        const room = opening.resourceId ? catalog.resourceName(opening.resourceId) : `No ${t.resource} required`;
                        const practitioner = catalog.practitionerName(opening.practitionerId);
                        return <OpeningButton key={opening.id} selected={slot?.startsAt === opening.startsAt && slot.practitionerId === opening.practitionerId && slot.resourceId === opening.resourceId} day={appointmentDay(opening.startsAt)} time={appointmentTime(opening.startsAt)} meta={<>{practitioner} · {room}</>} onClick={() => { setSlot(opening); setError(""); }} />;
                      })}
                    </div>
                  ) : (
                    <Empty className="p-4 md:p-6">
                      <EmptyHeader>
                        <EmptyMedia variant="icon"><CalendarOff aria-hidden="true" /></EmptyMedia>
                        <EmptyDescription>{walkIn ? `No one is free for this service in the next few hours. Try another ${t.practitioner} or service.` : "No openings on this date."}</EmptyDescription>
                      </EmptyHeader>
                    </Empty>
                  )}
                  {openingsView === "list" && openings.length > 28 && !showAllOpenings ? <Button variant="ghost" className="w-full" onClick={() => setShowAllOpenings(true)}>Show all {openings.length} openings</Button> : null}
                </div>
                </ScrollArea>
              ) : (
                <Empty className="p-4 md:p-6">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">{clinical ? <Stethoscope aria-hidden="true" /> : <CalendarClock aria-hidden="true" />}</EmptyMedia>
                    <EmptyDescription>Choose a service to see openings.</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </FramePanel>
            <FrameFooter className="flex flex-row flex-wrap justify-between gap-2 px-3 py-2">
              <Button variant="outline" onClick={() => setStage("patient")}>Back to {t.customer}</Button>
              <Button onClick={nextFromSlot} disabled={!slot}>{repeatingRule ? `Check ${t.appointments}` : `Review ${t.appointment}`}</Button>
            </FrameFooter>
          </Frame>
        </div>
        {summary}
      </div>
    ) : null}

    {stage === "review" && service && slot && repeatingRule ? (
      <div className="flex max-w-3xl flex-col gap-4">
        <Frame className="min-w-0">
          <FramePanel className="p-4">
            <dl className="grid gap-4 sm:grid-cols-2">
              <Fact label={t.Customer}>{patientName}</Fact>
              <Fact label="Service">{service.name} · {service.durationMinutes} min</Fact>
              <Fact label="First one"><span className="tabular-nums">{appointmentDateTime(slot.startsAt)}</span></Fact>
              <Fact label={t.Practitioner}>{catalog.practitionerName(slot.practitionerId)}</Fact>
            </dl>
          </FramePanel>
        </Frame>
        <RepeatReview
          summary={draftSummary(repeat, repeatStartsOn, clockIn(slot.startsAt), { visit: t.visit, visits: t.visits })}
          rule={repeatingRule}
          booking={{
            clinicSlug: catalog.clinic.slug, locationId, serviceId: service.id, practitionerId: slot.practitionerId, startsAt: slot.startsAt,
            source: source === "phone" ? "phone" : "desk",
            ...(reasonForVisit.trim() ? { reasonForVisit: reasonForVisit.trim() } : {}),
            ...(mode === "existing"
              ? { patientId: selectedPatient!.id }
              : { newPatient: { firstName: firstName.trim(), lastName: lastName.trim(), phone: phone.trim(), email: email.trim(), preferredChannel, isDependent: false, messagingConsent, ...(profile.features.dateOfBirth && dateOfBirth ? { dateOfBirth } : {}) } }),
          }}
          onBack={() => setStage("slot")}
          onSaved={(result) => { void staff?.refresh(); setSeriesResult(result); setError(""); setStage("result"); }}
        />
      </div>
    ) : null}

    {stage === "review" && service && slot && !repeatingRule ? (
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Frame className="min-w-0">
          <FrameHeader className="px-3 py-2"><h2 className="text-sm font-medium">{t.Appointment} details</h2></FrameHeader>
          <FramePanel className="p-4">
            <dl className="grid gap-4 sm:grid-cols-2">
              <Fact label={t.Customer}>{patientName}<span className="mt-0.5 block text-xs font-normal text-muted-foreground tabular-nums">{mode === "existing" ? selectedPatient?.phone : `New ${t.customer} · ${phone.trim()}`}</span></Fact>
              <Fact label="Service">{service.name} · {service.durationMinutes} min</Fact>
              <Fact label="Time"><span className="tabular-nums">{appointmentDateTime(slot.startsAt)}</span></Fact>
              <Fact label={`${t.Practitioner} and ${t.resource}`}>{catalog.practitionerName(slot.practitionerId)} · {roomName}</Fact>
              <Fact label="Booked through">{bookingSourceLabels[source === "desk" ? "staff" : source]}</Fact>
              <Fact label={`Reason for ${t.visit}`}>{reasonForVisit.trim() || <span className="font-normal text-muted-foreground">Not given</span>}</Fact>
            </dl>
          </FramePanel>
        </Frame>
        <aside>
          <Frame>
            <FrameHeader className="px-3 py-2"><h2 className="text-sm font-medium">{walkIn ? "Check in this walk-in" : "Confirm this booking"}</h2></FrameHeader>
            <FramePanel className="p-4"><p className="text-sm text-muted-foreground">{walkIn ? `The ${t.customer} joins today's queue as arrived. No message is sent.` : database ? `The ${t.appointment} is saved as confirmed. The ${t.customer} gets a confirmation with a link to change or cancel it.` : `Saves a confirmed ${t.appointment} in this browser preview. No message is sent.`}</p></FramePanel>
            <FrameFooter className="flex flex-col gap-2 px-3 py-3">
              <Button className="w-full" onClick={commit} loading={pending}>{walkIn ? "Check in now" : `Confirm ${t.appointment}`}</Button>
              <Button className="w-full" variant="outline" onClick={() => setStage("slot")}>Back to openings</Button>
            </FrameFooter>
          </Frame>
        </aside>
      </div>
    ) : null}

    {stage === "result" && seriesResult ? (
      <Frame role="status" className="max-w-3xl">
        <FramePanel className="flex items-start gap-3 p-4">
          <CircleCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-success-foreground" />
          <div>
            <h2 className="font-heading text-base font-semibold">{seriesResult.visitCount} {seriesResult.visitCount === 1 ? t.appointment : t.appointments} booked</h2>
            <p className="text-sm text-muted-foreground">{patientName} · {service?.name}.{seriesResult.skippedCount > 0 ? ` ${seriesResult.skippedCount} skipped.` : ""} One confirmation with every date is on its way to the {t.customer}.</p>
          </div>
        </FramePanel>
        <FrameFooter className="flex flex-row flex-wrap gap-2 px-3 py-2">
          <Button render={<Link href={`/appointments/series/${seriesResult.seriesId}?from=${from}`} />}>See every {t.visit}</Button>
          <Button variant="outline" render={<Link href={from === "schedule" ? `/schedule?date=${slot ? clinicDateKey(slot.startsAt) : selectedDate}&view=${initialView}&location=${locationId}` : "/dashboard"} />}>Return to {from === "schedule" ? "Schedule" : "Today"}</Button>
        </FrameFooter>
      </Frame>
    ) : null}

    {stage === "result" && !seriesResult ? (
      <Frame role="status" className="max-w-3xl">
        <FramePanel className="flex items-start gap-3 p-4">
          <CircleCheck aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-success-foreground" />
          <div>
            <h2 className="font-heading text-base font-semibold">{walkIn ? "Walk-in checked in" : database ? `${t.Appointment} created` : `Preview ${t.appointment} created`}</h2>
            <p className="text-sm text-muted-foreground">{patientName} · {service?.name} · {slot ? appointmentDateTime(slot.startsAt) : ""}.{walkIn ? " They are in today's queue as arrived." : database ? ` A confirmation is on its way to the ${t.customer}.` : ""}</p>
          </div>
        </FramePanel>
        {manageToken && !walkIn ? <ManageLinkPanel token={manageToken} /> : null}
        <FrameFooter className="flex flex-row flex-wrap gap-2 px-3 py-2">
          <Button render={<Link href={`/appointments/${createdAppointmentId}?from=${from}&date=${slot ? clinicDateKey(slot.startsAt) : selectedDate}&view=${initialView}&location=${locationId}`} />}>Open {t.appointment}</Button>
          <Button variant="outline" render={<Link href={from === "schedule" ? `/schedule?date=${slot ? clinicDateKey(slot.startsAt) : selectedDate}&view=${initialView}&location=${locationId}` : "/dashboard"} />}>Return to {from === "schedule" ? "Schedule" : "Today"}</Button>
        </FrameFooter>
      </Frame>
    ) : null}
  </div>;
}

/** The patient's own link to change or cancel. Read it out on the phone or send it in a message. */
function ManageLinkPanel({ token }: { token: string }) {
  const t = useTerms();
  const [copied, setCopied] = useState(false);
  const path = `/manage/${token}`;
  const href = typeof window === "undefined" ? path : `${window.location.origin}${path}`;
  return (
    <FramePanel className="flex flex-col gap-2 p-4">
      <h3 className="text-sm font-medium">Manage link for the {t.customer}</h3>
      <p className="text-xs text-muted-foreground">The {t.customer} can confirm, move or cancel with this link. It is shown once; copy it now if you need to send it yourself.</p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border bg-muted px-2 py-1.5 text-xs">{href}</code>
        <Button size="sm" variant="outline" onClick={() => {
          void navigator.clipboard.writeText(href).then(() => {
            setCopied(true);
            toastManager.add({ title: "Link copied", type: "success" });
            window.setTimeout(() => setCopied(false), 2000);
          }).catch(() => toastManager.add({ title: "Could not copy", description: "Select the link and copy it by hand.", type: "error" }));
        }}>{copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />} {copied ? "Copied" : "Copy link"}</Button>
      </div>
    </FramePanel>
  );
}
