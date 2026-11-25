"use client";

import { debounce } from "nuqs";
import { ListFilter, MoreHorizontal, Plus, Printer, SlidersHorizontal } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { type CalEvent, byResourceId, useIsClient } from "@/components/kloq";
import { dateFromKey } from "@/components/date-picker";
import { OptionSelect } from "@/components/form-fields";
import { WorkspaceFrame, WorkspacePage } from "@/components/workspace-page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Menu, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Label } from "@/components/ui/label";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { Drawer, DrawerHeader, DrawerPanel, DrawerPopup, DrawerTitle } from "@/components/ui/drawer";
import { toastManager } from "@/components/ui/toast";
import { useBusinessProfile, useFeatures, useTerms } from "@/features/terms/business-profile-context";
import { isClinicalBusinessType } from "@/lib/business-types";
import { demoAppointments } from "@/lib/demo-data";
import type { Appointment } from "@/lib/domain";

import { useNarrowerThan } from "./staff-viewport";
import { useCatalogLookups } from "./clinic-catalog";
import { useNewVisit } from "./new-visit-sheet";
import { appointmentEvent, blockEvent, ClinicCalendar, type ClinicEvent, closedTimeConstraint, practitionerLanes } from "./clinic-calendar";
import { usePreviewAppointments } from "./preview-appointments";
import { clinicDateKey, clinicTimeMinutes, isClinicDateKey } from "./schedule-availability";
import { BulkBar, BulkDialogs } from "./schedule-bulk";
import { type ListGrouping, type ListVisit, ScheduleList } from "./schedule-list";
import { dayLabel, filterAppointments, type FilterStatus, type StatusFilter, stepDateKey, visibleDays, visitsOnDays } from "./schedule-model";
import { describeChange, useScheduleMoves } from "./schedule-moves";
import { SchedulePlanningPanel } from "./schedule-planning";
import { AppointmentPopover, type VisitAnchor } from "./appointment-card";
import { OpeningSheet, type SelectedOpening } from "./schedule-sheets";
import { ScheduleToolbar } from "./schedule-toolbar";
import { useScheduleUrl } from "./schedule-url";
import { usePageShortcuts } from "./shortcuts";
import { useStaffAccess } from "./staff-access";
import { WhyNoSlotMenuItem, WhyNoSlotSheet } from "./why-no-slot-sheet";
import { useOptionalStaffSnapshot } from "./staff-snapshot-provider";
import { useScheduleAvailability } from "./use-visits-needing-person";
import { patientName } from "./patient-directory";
import { ClassSessionsStrip } from "./class-sessions-strip";

const statusOptions: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All statuses" },
  { value: "requested", label: "Requested" },
  { value: "booked", label: "Booked" },
  { value: "checked_in", label: "Checked in" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "no_show", label: "No-show" },
];

const roomLaneAdapter = byResourceId("roomId");
const noRoomLane = "no-room";

export function ScheduleWorkspace() {
  const { appointments, patients, operations, auditEvents, recordAudits, addScheduleBlock, updateScheduleBlock, removeScheduleBlock, addRecurringSeries, database } = usePreviewAppointments();
  const staff = useOptionalStaffSnapshot();
  const { openNewVisit } = useNewVisit();
  const scheduleHours = useScheduleAvailability();
  const catalog = useCatalogLookups();
  const t = useTerms();
  const profile = useBusinessProfile();
  const features = useFeatures();
  const access = useStaffAccess();
  const [whyOpen, setWhyOpen] = useState(false);
  const resourceLabel = isClinicalBusinessType(profile.businessType) ? "Room or chair" : t.Resource;
  const router = useRouter();
  const phone = useNarrowerThan("sm");
  // KLOQ draws in the browser's clock, and its docs allow server rendering only with a fixed display zone,
  // which this calendar does not set. So the calendar waits for the browser; the list renders on the server.
  const browser = useIsClient();
  const [url, setUrl] = useScheduleUrl();
  const clockDay = clinicDateKey(operations.clockIso);
  const defaultDay = database ? clockDay : clinicDateKey(demoAppointments[0].startsAt);

  const dateKey = url.date && isClinicDateKey(url.date) ? url.date : defaultDay;
  const view = url.view ?? "staff";
  const range = url.range ?? "day";
  const locationId = catalog.locations.some((item) => item.id === url.location) ? url.location! : catalog.locations[0]?.id ?? "";
  const statusFilter: StatusFilter = url.status ?? "all";
  const search = url.q ?? "";
  const openId = url.open ?? "";

  const [visitAnchor, setVisitAnchor] = useState<VisitAnchor | null>(null);
  const [opening, setOpening] = useState<SelectedOpening | null>(null);
  const [planning, setPlanning] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [bulkDialog, setBulkDialog] = useState<"message" | "move" | "cancel" | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const canChange = access.can("appointments.book");
  const versions = useMemo(() => new Map((staff?.snapshot?.appointments ?? []).map((item) => [item.id, item.version])), [staff?.snapshot?.appointments]);
  const patientsById = useMemo(() => new Map(patients.map((item) => [item.id, item])), [patients]);

  // A practitioner only ever gets their own visits, so their schedule is their own column, not empty ones for colleagues.
  const ownOnly = access.role === "practitioner" ? access.ownPractitionerId : null;
  const locationPractitioners = useMemo(() => catalog.practitioners.filter((item) => item.locationIds.includes(locationId) && (!ownOnly || item.id === ownOnly)), [catalog.practitioners, locationId, ownOnly]);
  const practitionerId = locationPractitioners.some((item) => item.id === url.staff) ? url.staff! : "";
  const shownPractitioners = useMemo(() => locationPractitioners.filter((item) => !practitionerId || item.id === practitionerId), [locationPractitioners, practitionerId]);
  const shownIds = useMemo(() => shownPractitioners.map((item) => item.id), [shownPractitioners]);
  const rooms = useMemo(() => catalog.resources.filter((item) => item.locationId === locationId), [catalog.resources, locationId]);
  const resourceId = rooms.some((item) => item.id === url.room) ? url.room! : "";
  const needle = search.trim().toLocaleLowerCase("en-IN");
  const activeFilters = [practitionerId, resourceId, statusFilter !== "all"].filter(Boolean).length;

  const moves = useScheduleMoves({ notifyByDefault: features.notifyOnMove });

  // Write the view, date and place into the address on first load, so the link you copy is the screen you see.
  const normalised = useRef(false);
  useEffect(() => {
    if (normalised.current) return;
    normalised.current = true;
    if (!url.view || !url.date || !url.location) void setUrl({ view, date: dateKey, location: locationId }, { history: "replace" });
  }, [dateKey, locationId, setUrl, url.date, url.location, url.view, view]);

  const filters = useMemo(() => ({ locationId, practitionerId, resourceId, status: statusFilter, needle }), [locationId, needle, practitionerId, resourceId, statusFilter]);
  const matching = useMemo(() => filterAppointments(appointments, patientsById, filters, new Set(shownIds)), [appointments, filters, patientsById, shownIds]);
  const days = useMemo(() => visibleDays(dateKey, phone && view === "week" ? "list" : view, phone && view === "week" ? "week" : range), [dateKey, phone, range, view]);
  const listMode = phone || view === "list";
  const stepsByWeek = days.length > 1;

  function nameOf(appointment: Appointment): string {
    const patient = patientsById.get(appointment.patientId);
    return patient ? patientName(patient) : t.Customer;
  }

  const events = useMemo<ClinicEvent[]>(() => {
    const visits = matching.map((appointment) => {
      const event = appointmentEvent(appointment, {
        patientName: nameOf(appointment),
        serviceName: catalog.serviceName(appointment.serviceId),
        practitionerName: catalog.practitionerName(appointment.practitionerId),
        roomName: appointment.resourceIds.map((id) => catalog.resourceName(id)).filter(Boolean).join(", "),
        movable: canChange && (appointment.status === "booked" || appointment.status === "requested"),
      });
      return { ...event, roomId: appointment.resourceIds[0] ?? noRoomLane };
    });
    const blocks = needle ? [] : operations.schedule.blocks.filter((block) => block.targetType === "practitioner" ? shownIds.includes(block.targetId) : rooms.some((room) => room.id === block.targetId)).map(blockEvent);
    const override = moves.override;
    const shown = override ? visits.map((event) => event.id === override.id ? { ...event, start: override.startsAt, end: override.endsAt, practitionerId: override.practitionerId } : event) : visits;
    return [...shown, ...blocks];
    // nameOf only reads patientsById and terms, which are already dependencies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canChange, catalog, matching, moves.override, needle, operations.schedule.blocks, patientsById, rooms, shownIds, t.Customer]);

  const lanes = useMemo(() => {
    if (view === "rooms") {
      const lanesForRooms = rooms.map((room) => ({ id: room.id, label: room.name }));
      return matching.some((item) => item.resourceIds.length === 0 && clinicDateKey(item.startsAt) === dateKey) ? [...lanesForRooms, { id: noRoomLane, label: `No ${t.resource}` }] : lanesForRooms;
    }
    return practitionerLanes(shownPractitioners, dateKey, scheduleHours, operations.clockIso);
  }, [dateKey, matching, operations.clockIso, rooms, scheduleHours, shownPractitioners, t.resource, view]);
  const constraints = useMemo(() => ({
    isSlotDisabled: closedTimeConstraint(scheduleHours, shownIds),
    // The preview reviews a move on the appointment page, where a service sets the length, so a drag can move a visit but not stretch it.
    // With a database the bottom edge can be dragged: the server checks the new length like any other change.
    ...(database ? {} : { canDrop: (event: CalEvent, target: { start: Date; end: Date }) => Date.parse(event.end) - Date.parse(event.start) === target.end.getTime() - target.start.getTime() }),
  }), [database, scheduleHours, shownIds]);
  const anchorDate = useMemo(() => dateFromKey(dateKey), [dateKey]);

  const listVisits = useMemo<ListVisit[]>(() => visitsOnDays(matching, days).map((appointment) => ({
    appointment,
    patientName: nameOf(appointment),
    phone: patientsById.get(appointment.patientId)?.phone ?? "",
    serviceName: catalog.serviceName(appointment.serviceId),
    practitionerName: catalog.practitionerName(appointment.practitionerId),
    roomName: appointment.resourceIds.map((id) => catalog.resourceName(id)).filter(Boolean).join(", "),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  })), [catalog, days, matching, patientsById, t.Customer]);
  const grouping: ListGrouping = days.length > 1 ? "day" : phone && view === "staff" ? "staff" : phone && view === "rooms" ? "room" : "none";
  const selectedVisits = useMemo(() => listVisits.filter((visit) => selectedIds.has(visit.appointment.id)), [listVisits, selectedIds]);

  const dayVisitCount = appointments.filter((item) => item.locationId === locationId && days.includes(clinicDateKey(item.startsAt)) && !["cancelled", "no_show", "entered_in_error"].includes(item.status)).length;
  const locationName = catalog.locations.find((item) => item.id === locationId)?.name ?? catalog.clinic.name;
  const rangeTitle = days.length > 1 ? `${dayLabel(days[0])} – ${dayLabel(days[days.length - 1])}` : dayLabel(dateKey);

  const context = new URLSearchParams({ from: "schedule", date: dateKey, view, location: locationId });
  const selected = appointments.find((item) => item.id === openId) ?? null;

  // A link that names a visit on another day (Bookings links carry no date) turns to that day first, once per visit,
  // so its block is on screen; after that the arrows move freely.
  const turnedTo = useRef<string | null>(null);
  const selectedDay = selected ? clinicDateKey(selected.startsAt) : null;
  useEffect(() => {
    if (!openId || !selectedDay || turnedTo.current === openId) return;
    // Arriving from another page, Next can still be landing the link and wipe a change made now, so this keeps
    // asking until the address bar itself agrees with what is shown, then lets go.
    const settled = () => days.includes(selectedDay) && new URLSearchParams(window.location.search).get("date") === (url.date ?? null);
    if (settled()) { turnedTo.current = openId; return; }
    const turn = () => void setUrl({ date: selectedDay }, { history: "replace" });
    turn();
    const retry = window.setInterval(turn, 250);
    return () => window.clearInterval(retry);
  }, [days, openId, selectedDay, setUrl, url.date]);

  // The open visit may be named in a link: point its card at the block on screen once the calendar has drawn it.
  // If the block never appears (a filter hides it), the card opens in the middle of the page instead of nowhere.
  useEffect(() => {
    if (!openId || visitAnchor instanceof Element) return;
    let frame = 0;
    let tries = 0;
    const look = () => {
      const element = document.querySelector(`[data-cal-event="${CSS.escape(openId)}"], [data-visit-id="${CSS.escape(openId)}"]`);
      if (element) { element.scrollIntoView({ block: "nearest", inline: "center" }); setVisitAnchor(element); }
      else if (++tries < 60) frame = requestAnimationFrame(look);
      // Centred until the block turns up; once it does, the card moves beside it.
      else if (!visitAnchor) setVisitAnchor({ getBoundingClientRect: () => new DOMRect(window.innerWidth / 2 - 184, window.innerHeight / 2, 0, 0) });
    };
    frame = requestAnimationFrame(look);
    return () => cancelAnimationFrame(frame);
  }, [openId, visitAnchor, events]);

  function goTo(next: string) { void setUrl({ date: next }); }
  const todayKey = database ? clinicDateKey(new Date().toISOString()) : defaultDay;
  const stepDate = (direction: -1 | 1) => goTo(stepDateKey(dateKey, listMode ? "list" : view, stepsByWeek ? "week" : "day", direction));

  usePageShortcuts({
    new: () => router.push(`/appointments/new?${context.toString()}`),
    today: () => goTo(todayKey),
    previous: () => stepDate(-1),
    next: () => stepDate(1),
    search: () => searchRef.current?.focus(),
  });

  function openVisit(id: string, anchor?: VisitAnchor) {
    setVisitAnchor(anchor ?? null);
    void setUrl({ open: id });
  }

  function handleEventsChange(next: CalEvent[]) {
    // The calendar only proposes changes; nothing is saved until the server agrees.
    const current = new Map(events.map((event) => [event.id, event]));
    for (const raw of next) {
      const event = raw as ClinicEvent;
      const before = current.get(event.id);
      if (!before) {
        setOpening({ dateKey: clinicDateKey(new Date(event.start).toISOString()), minute: clinicTimeMinutes(new Date(event.start).toISOString()), practitionerId: event.practitionerId || undefined });
        return;
      }
      const startsAt = new Date(event.start).toISOString();
      const endsAt = new Date(event.end).toISOString();
      const appointment = appointments.find((item) => item.id === event.id);
      if (!appointment || before.kind !== "appointment") continue;
      const change = describeChange({ startsAt: before.start, endsAt: before.end, practitionerId: before.practitionerId }, { startsAt, endsAt, practitionerId: event.practitionerId });
      if (!change) {
        if (view === "rooms" && event.roomId !== before.roomId) toastManager.add({ type: "info", title: `${resourceLabel}s are picked when a ${t.appointment} is booked`, description: `Drag it to another time, or open the ${t.appointment} to change who it is with.` });
        continue;
      }
      if (!database) {
        const params = new URLSearchParams(context);
        params.set("action", appointment.status === "requested" ? "suggest" : "reschedule");
        params.set("start", startsAt);
        params.set("practitioner", event.practitionerId);
        router.push(`/appointments/${appointment.id}?${params.toString()}`);
        return;
      }
      const version = versions.get(appointment.id);
      if (version === undefined) { toastManager.add({ type: "error", title: "Reload the schedule and try again" }); return; }
      moves.request({ appointment: { ...appointment, version }, patientName: nameOf(appointment), practitionerName: catalog.practitionerName(event.practitionerId), startsAt: change === "resize" ? appointment.startsAt : startsAt, endsAt, practitionerId: change === "resize" ? appointment.practitionerId : event.practitionerId }, change);
      return;
    }
  }

  const clearFilters = () => void setUrl({ staff: null, room: null, status: null });
  const filterControls = <Popover>
    <PopoverTrigger render={<Button variant="outline" />}>
      <ListFilter aria-hidden="true" /> Filters{activeFilters ? <Badge variant="secondary" className="tabular-nums">{activeFilters}</Badge> : null}
    </PopoverTrigger>
    <PopoverPopup align="end" className="w-72">
      <div className="flex flex-col gap-3">
        {catalog.locations.length > 1 ? <FilterField label="Location"><OptionSelect aria-label="Location" size="default" value={locationId} onValueChange={(next) => void setUrl({ location: next, room: null, staff: null })} options={catalog.locations.map((item) => ({ value: item.id, label: item.name }))} /></FilterField> : null}
        <FilterField label={t.Practitioner}><OptionSelect aria-label={t.Practitioner} size="default" value={practitionerId} onValueChange={(next) => void setUrl({ staff: next || null })} options={[{ value: "", label: `All ${t.practitioners}` }, ...locationPractitioners.map((item) => ({ value: item.id, label: item.name }))]} /></FilterField>
        <FilterField label={resourceLabel}><OptionSelect aria-label={resourceLabel} size="default" value={resourceId} onValueChange={(next) => void setUrl({ room: next || null })} options={[{ value: "", label: `All ${t.resources}` }, ...rooms.map((item) => ({ value: item.id, label: item.name }))]} /></FilterField>
        <FilterField label="Status"><OptionSelect aria-label={`${t.Appointment} status`} size="default" value={statusFilter} onValueChange={(next) => void setUrl({ status: next === "all" ? null : (next as FilterStatus) })} options={statusOptions} /></FilterField>
        {activeFilters ? <Button variant="ghost" size="sm" onClick={clearFilters}>Clear filters</Button> : null}
      </div>
    </PopoverPopup>
  </Popover>;

  const printHref = `/print/day?${new URLSearchParams({ date: dateKey, location: locationId }).toString()}`;

  return <>
    <WorkspacePage
      fit="screen"
      nav="schedule"
        actions={<>
          <Button variant="outline" size="sm" className="max-sm:hidden" render={<a href={printHref} target="_blank" rel="noreferrer" />}><Printer aria-hidden="true" /> Print day sheet</Button>
          {database ? null : <Button variant="outline" size="sm" onClick={() => setPlanning(true)}><SlidersHorizontal aria-hidden="true" /> Availability</Button>}
          <Button size="sm" className="max-sm:size-11 max-sm:px-0" onClick={() => openNewVisit({ date: dateKey, locationId })}><Plus aria-hidden="true" /><span className="max-sm:sr-only">New {t.appointment}</span></Button>
          {access.can("schedule.read") ? <Menu><MenuTrigger render={<Button variant="outline" size="icon" aria-label="More schedule actions" />}><MoreHorizontal aria-hidden="true" /></MenuTrigger><MenuPopup align="end"><WhyNoSlotMenuItem onOpen={() => setWhyOpen(true)} /></MenuPopup></Menu> : null}
        </>}
    >
      <ClassSessionsStrip dateKey={dateKey} />
      <WorkspaceFrame
        flush
        panelClassName="overflow-hidden"
        start={<ScheduleToolbar part="start" summary={`${dayVisitCount} ${dayVisitCount === 1 ? t.visit : t.visits}${catalog.locations.length > 1 ? ` · ${locationName}` : ""}`} view={view} onViewChange={(next) => void setUrl({ view: next })} range={range} onRangeChange={(next) => void setUrl({ range: next })} phone={phone} dateKey={dateKey} title={rangeTitle} stepLabel={stepsByWeek ? "week" : "day"} onStep={stepDate} onToday={() => goTo(todayKey)} onPickDate={goTo} search={search} onSearch={(value) => void setUrl({ q: value || null }, { history: "replace", limitUrlUpdates: debounce(300) })} searchRef={searchRef} filters={filterControls} />}
        end={<ScheduleToolbar part="end" view={view} onViewChange={(next) => void setUrl({ view: next })} range={range} onRangeChange={(next) => void setUrl({ range: next })} phone={phone} dateKey={dateKey} title={rangeTitle} stepLabel={stepsByWeek ? "week" : "day"} onStep={stepDate} onToday={() => goTo(todayKey)} onPickDate={goTo} search={search} onSearch={(value) => void setUrl({ q: value || null }, { history: "replace", limitUrlUpdates: debounce(300) })} searchRef={searchRef} filters={filterControls} />}
      >
        <div className="min-h-0 flex-1">
            {listMode ? <ScheduleList
              visits={listVisits}
              grouping={grouping}
              selectedIds={selectedIds}
              openId={openId}
              selectable={!phone}
              touch={phone}
              label={`${t.Appointments} for ${rangeTitle}`}
              emptyTitle={`No ${t.visits} ${days.length > 1 ? "this week" : "this day"}`}
              emptyDescription={activeFilters || needle ? "Nothing matches the search or filters." : `Booked ${t.visits} will show here.`}
              onClearFilters={activeFilters || needle ? () => { clearFilters(); void setUrl({ q: null }); } : undefined}
              onToggle={(id) => setSelectedIds((current) => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; })}
              onToggleAll={(ids, on) => setSelectedIds(on ? new Set(ids) : new Set())}
              onOpen={openVisit}
              bulkBar={<BulkBar count={selectedVisits.length} canChange={canChange} onClear={() => setSelectedIds(new Set())} onMessage={() => setBulkDialog("message")} onMove={() => setBulkDialog("move")} onCancel={() => setBulkDialog("cancel")} />}
            /> : !browser ? null : <ClinicCalendar
              view={view === "week" ? "week" : "timeline"}
              date={anchorDate}
              onDateChange={(next) => { const key = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-${String(next.getDate()).padStart(2, "0")}`; goTo(key); }}
              events={events}
              onEventsChange={handleEventsChange}
              lanes={lanes}
              {...(view === "rooms" ? { laneAdapter: roomLaneAdapter } : {})}
              constraints={constraints}
              onOpenVisit={(id, anchor) => openVisit(id, anchor)}
              onOpenTime={setOpening}
            />}
        </div>
      </WorkspaceFrame>
    </WorkspacePage>

    <AppointmentPopover appointment={visitAnchor ? selected : null} anchor={visitAnchor} patients={patients} clockIso={operations.clockIso} started={Boolean(selected && operations.visitTimings[selected.id]?.startedAt)} context={context.toString()} onClose={() => { setVisitAnchor(null); void setUrl({ open: null }, { history: "replace" }); }} />
    {whyOpen ? <WhyNoSlotSheet open onOpenChange={setWhyOpen} locationId={locationId} {...(practitionerId ? { practitionerId } : {})} /> : null}
    <OpeningSheet opening={opening} locationId={locationId} onClose={() => setOpening(null)} />
    {moves.dialog}
    <BulkDialogs
      dialog={bulkDialog}
      onClose={() => setBulkDialog(null)}
      selected={selectedVisits}
      practitioners={locationPractitioners}
      onFinished={(remaining) => setSelectedIds(new Set(remaining))}
    />
    {database ? null : <Drawer position="right" open={planning} onOpenChange={setPlanning}>
      <DrawerPopup showCloseButton variant="inset">
        <DrawerHeader><DrawerTitle>Availability</DrawerTitle></DrawerHeader>
        <DrawerPanel>
          <SchedulePlanningPanel key={locationId} appointments={appointments} patients={patients} locationId={locationId} selectedDay={dateKey} availability={operations.schedule} previewClock={operations.clockIso} addScheduleBlock={addScheduleBlock} updateScheduleBlock={updateScheduleBlock} removeScheduleBlock={removeScheduleBlock} addRecurringSeries={addRecurringSeries} recordAudits={recordAudits} auditCount={auditEvents.length} />
        </DrawerPanel>
      </DrawerPopup>
    </Drawer>}
  </>;
}

function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex flex-col gap-1.5"><Label className="text-xs text-muted-foreground">{label}</Label>{children}</div>;
}
