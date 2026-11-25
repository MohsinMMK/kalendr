"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, CalendarOff, History, Pencil, SearchX, TriangleAlert, UserPlus, Users, Plus, Upload } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";

import { StatusBadge } from "@/components/status-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Card, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { TogglePrimitive } from "@/components/ui/toggle";
import { ToggleGroupPrimitive } from "@/components/ui/toggle-group";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { WorkspaceFrame, WorkspacePage } from "@/components/workspace-page";
import { useBusinessProfile, useTerms } from "@/features/terms/business-profile-context";
import { isClinicalBusinessType } from "@/lib/business-types";
import type { Patient } from "@/lib/domain";
import { appointmentDateTime, channelLabel, statusLabel } from "./clinic-format";
import { useNewVisit } from "./new-visit-sheet";
import { useCatalogLookups } from "./clinic-catalog";
import { useStaffAccess } from "./staff-access";
import { patientBookingContext, searchPatients } from "./patient-directory";
import { CustomerDetails } from "./customer-details";
import { CustomerNotes } from "./customer-notes";
import { CustomerOffersSection } from "./customer-offers";
import { CustomerProfilePage, CustomerSummaryStrip } from "./customer-profile";
import { CustomerTimeline } from "./customer-timeline";
import { PatientDetailsDialog } from "./patient-details-dialog";
import { DuplicatesPanel, SegmentsPanel } from "./segments-panel";
import { PATIENT_PAGE_SIZE, PatientsGrid, patientRows } from "./patients-grid";
import { usePreviewAppointments } from "./preview-appointments";
import { useOptionalStaffSnapshot } from "./staff-snapshot-provider";
import { appointmentStatusTone, Fact } from "./task-ui";

// The month calendar (drag, resize, recurrence) is heavy and shows only when someone picks the calendar view.
const PatientCalendar = dynamic(() => import("./patient-calendar").then((m) => m.PatientCalendar), { ssr: false, loading: () => <Skeleton className="size-full rounded-none" /> });

function PanelEmpty({ icon, title, description, action }: { icon: React.ReactNode; title: string; description?: string; action?: React.ReactNode }) {
  return (
    <Empty className="p-4 md:p-6">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle className="text-base">{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  );
}

export function PatientsWorkspace() {
  const t = useTerms();
  const { openNewVisit } = useNewVisit();
  const profile = useBusinessProfile();
  const access = useStaffAccess();
  const { appointments, patients, operations, database } = usePreviewAppointments();
  const catalog = useCatalogLookups();
  const [remotePatients, setRemotePatients] = useState<Patient[] | null>(null);
  const [searchError, setSearchError] = useState("");
  const [query, setQuery] = useState("");
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: PATIENT_PAGE_SIZE });
  const [selectedPatientId, setSelectedPatientId] = useState<string | null>(null);
  const [section, setSection] = useState<"overview" | "timeline" | "notes" | "details" | "packages" | "appointments" | "contact">("overview");
  const [listTab, setListTab] = useState<"everyone" | "segments" | "duplicates">("everyone");
  const [historyView, setHistoryView] = useState<"calendar" | "list">("calendar");
  const [dialog, setDialog] = useState<"add" | "edit" | null>(null);
  const staff = useOptionalStaffSnapshot();
  const canEdit = database && access.can("appointments.book");

  useEffect(() => {
    const sync = () => {
      const id = new URLSearchParams(window.location.search).get("patient");
      setSelectedPatientId(id);
    };
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  // Stable, so the table's columns are not rebuilt (and their cells remounted) on every render.
  const selectPatient = useCallback((id: string | null) => {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("patient", id);
    else url.searchParams.delete("patient");
    window.history.pushState({}, "", url);
    setSelectedPatientId(id);
    setSection("overview");
  }, []);

  const searchRemote = Boolean(database && catalog.snapshot?.limits.patientsTruncated && query.trim());
  useEffect(() => {
    if (!searchRemote) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/staff/patients?q=${encodeURIComponent(query.trim())}`, {
            cache: "no-store",
            signal: controller.signal,
          });
          const result: unknown = await response.json();
          if (!response.ok || typeof result !== "object" || result === null || !("data" in result)) {
            throw new Error(`${t.Customer} search could not be completed.`);
          }
          const data = result.data as { patients?: Patient[] };
          setRemotePatients(Array.isArray(data.patients) ? data.patients : []);
          setSearchError("");
        } catch (error: unknown) {
          if (controller.signal.aborted) return;
          setSearchError(error instanceof Error ? error.message : `${t.Customer} search could not be completed.`);
        }
      })();
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [query, searchRemote, t.Customer]);

  const directory = searchRemote && remotePatients ? remotePatients : patients;
  const filtered = searchPatients(directory, searchRemote ? "" : query);
  const patient = [...patients, ...directory].find((item) => item.id === selectedPatientId);
  const history = appointments.filter((appointment) => appointment.patientId === patient?.id).sort((a, b) => b.startsAt.localeCompare(a.startsAt));
  const nextContext = patient ? patientBookingContext(patient.id, appointments, operations.clockIso) : null;
  const next = nextContext?.kind === "next" ? nextContext.appointment : null;

  async function patientSaved(saved: Patient) {
    await staff?.refresh();
    setRemotePatients((current) => current?.map((item) => (item.id === saved.id ? saved : item)) ?? current);
    const added = dialog === "add";
    setDialog(null);
    if (added) selectPatient(saved.id);
  }
  const detailsDialog = canEdit ? (
    <PatientDetailsDialog
      open={dialog !== null}
      onOpenChange={(open) => { if (!open) setDialog(null); }}
      patient={dialog === "edit" ? patient : undefined}
      patients={patients}
      visits={dialog === "edit" ? history.map((visit) => ({ id: visit.id, startsAt: visit.startsAt, status: visit.status, title: catalog.serviceName(visit.serviceId), detail: catalog.practitionerName(visit.practitionerId) })) : undefined}
      onSaved={patientSaved}
    />
  ) : null;
  const rows = useMemo(() => patientRows(filtered, appointments, operations.clockIso), [appointments, filtered, operations.clockIso]);
  const onBook = useCallback((id: string) => openNewVisit({ patientId: id }), [openNewVisit]);
  const recordsHref = useCallback((id: string) => `/records?patient=${encodeURIComponent(id)}`, []);

  const showPackages = database && access.can("schedule.read");
  const showListTabs = database && (access.can("customers.manage") || access.can("campaigns.manage"));

  if (patient) {
    const historyToggle = history.length ? (
      <SegmentedControl render={<ToggleGroupPrimitive aria-label={`Show ${t.appointments} as`} value={[historyView]} onValueChange={(next: string[]) => { if (next[0]) setHistoryView(next[0] as "calendar" | "list"); }} />}>
        <SegmentedControlItem render={<TogglePrimitive value="calendar" />}>Calendar</SegmentedControlItem>
        <SegmentedControlItem render={<TogglePrimitive value="list" />}>List</SegmentedControlItem>
      </SegmentedControl>
    ) : null;
    const sectionEnd = section === "appointments" ? (
      <>{historyToggle}<Button size="sm" onClick={() => openNewVisit({ patientId: patient.id })}><Plus aria-hidden="true" /> Book</Button></>
    ) : section === "contact" && canEdit ? (
      <Button size="sm" variant="outline" onClick={() => setDialog("edit")}><Pencil aria-hidden="true" /> Edit</Button>
    ) : null;
    const flush = section === "appointments";
    return (
      <CustomerProfilePage
        patient={patient}
        live={database}
        back={{ label: `Back to ${t.customers}`, onClick: () => selectPatient(null) }}
        badge={profile.features.dependents && patient.isDependent ? <Badge variant="outline">Dependent</Badge> : null}
        onEdit={canEdit ? () => setDialog("edit") : undefined}
        onBook={() => openNewVisit({ patientId: patient.id })}
        recordsHref={profile.features.records && access.can("records.view") ? `/records?patient=${encodeURIComponent(patient.id)}` : undefined}
      >
        <CustomerSummaryStrip patientId={patient.id} live={database} />

        <Tabs value={section} onValueChange={(tab) => setSection(tab as typeof section)} className="gap-0">
          <WorkspaceFrame
            flush={flush}
            start={
              <TabsList variant="underline" aria-label={`${t.Customer} details`}>
                <TabsTab value="overview" className="max-sm:px-1.5">Overview</TabsTab>
                {database ? <TabsTab value="timeline" className="max-sm:px-1.5">History</TabsTab> : null}
                {database ? <TabsTab value="notes" className="max-sm:px-1.5">Notes</TabsTab> : null}
                {database ? <TabsTab value="details" className="max-sm:px-1.5">Details</TabsTab> : null}
                {showPackages ? <TabsTab value="packages" className="max-sm:px-1.5">Packages</TabsTab> : null}
                <TabsTab value="appointments" className="max-sm:px-1.5">{t.Appointments} <Badge variant="outline" className="tabular-nums max-sm:hidden">{history.length}</Badge></TabsTab>
                <TabsTab value="contact" className="max-sm:px-1.5">Contact details</TabsTab>
              </TabsList>
            }
            end={sectionEnd}
            footer={<p className="text-xs text-muted-foreground">{isClinicalBusinessType(profile.businessType) ? "Scheduling information only. Clinical records are not stored here." : "Scheduling information only."}</p>}
          >
            <TabsPanel value="overview" className="grid items-start gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader><CardTitle render={<h2 />} className="text-sm">Next {t.appointment}</CardTitle></CardHeader>
                {next ? (
                  <CardPanel className="flex flex-col gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-heading text-base font-semibold">{catalog.serviceName(next.serviceId)}</p>
                      <StatusBadge tone={appointmentStatusTone(next.status)}>{statusLabel(next.status)}</StatusBadge>
                    </div>
                    <dl className="grid gap-3 sm:grid-cols-2">
                      <Fact label="Time"><span className="tabular-nums">{appointmentDateTime(next.startsAt)}</span></Fact>
                      <Fact label={t.Practitioner}>{catalog.practitionerName(next.practitionerId)}</Fact>
                    </dl>
                    <Button size="sm" variant="outline" className="self-start" render={<Link href={`/appointments/${next.id}?from=patients`} />}>View {t.appointment} <ArrowRight aria-hidden="true" /></Button>
                  </CardPanel>
                ) : (
                  <PanelEmpty icon={<CalendarOff aria-hidden="true" />} title={database ? `No upcoming ${t.appointment} for this ${t.customer}.` : `No active ${t.appointment} in this preview.`} />
                )}
              </Card>
              <Card>
                <CardHeader><CardTitle render={<h2 />} className="text-sm">Contact and preferences</CardTitle></CardHeader>
                <CardPanel>
                  <dl className="grid gap-4 sm:grid-cols-2">
                    <Fact label="Phone"><span className="tabular-nums">{patient.phone}</span></Fact>
                    <Fact label="Email">{patient.email || "Not recorded"}</Fact>
                    <Fact label="Preferred contact">{channelLabel(patient.preferredChannel)}</Fact>
                    {profile.features.dateOfBirth ? <Fact label="Date of birth"><span className="tabular-nums">{patient.dateOfBirth ? formatBirthDate(patient.dateOfBirth) : "Not recorded"}</span></Fact> : null}
                    <Fact label="Reminders">{patient.messagingConsentAt ? "Text or WhatsApp allowed" : "Email only"}</Fact>
                    <Fact label="Accommodation">{patient.accessibilityNeed ?? "None recorded"}</Fact>
                  </dl>
                </CardPanel>
              </Card>
            </TabsPanel>

            {database ? <TabsPanel value="timeline"><CustomerTimeline patientId={patient.id} /></TabsPanel> : null}
            {database ? <TabsPanel value="notes"><CustomerNotes patientId={patient.id} /></TabsPanel> : null}
            {database ? <TabsPanel value="details"><CustomerDetails patientId={patient.id} /></TabsPanel> : null}
            {showPackages ? <TabsPanel value="packages"><CustomerOffersSection patientId={patient.id} /></TabsPanel> : null}

            <TabsPanel value="appointments">
              <h2 className="sr-only">{t.Appointments}</h2>
              {history.length && historyView === "calendar" ? (
                <div className="h-[34rem]">
                  <PatientCalendar visits={history} serviceName={catalog.serviceName} practitionerName={catalog.practitionerName} />
                </div>
              ) : history.length ? (
                <ol className="flex flex-col p-2">
                  {history.map((appointment, index) => (
                    <li key={appointment.id} className="flex gap-2">
                      <span aria-hidden="true" className="relative flex w-5 shrink-0 justify-center">
                        {index < history.length - 1 ? <span className="absolute inset-y-0 top-5 w-px bg-border" /> : null}
                        <span className="relative mt-4 size-2 rounded-full bg-muted-foreground/64" />
                      </span>
                      <Link
                        href={`/appointments/${appointment.id}?from=patients`}
                        className="flex min-w-0 flex-1 flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-md px-2 py-2 text-foreground no-underline outline-2 outline-transparent hover:bg-accent focus-visible:outline-ring"
                      >
                        <span className="min-w-0">
                          <span className="block text-sm font-medium">{catalog.serviceName(appointment.serviceId)}</span>
                          <span className="block text-xs text-muted-foreground tabular-nums">{appointmentDateTime(appointment.startsAt)} · {catalog.practitionerName(appointment.practitionerId)}</span>
                        </span>
                        <StatusBadge tone={appointmentStatusTone(appointment.status)}>{statusLabel(appointment.status)}</StatusBadge>
                      </Link>
                    </li>
                  ))}
                </ol>
              ) : (
                <PanelEmpty icon={<History aria-hidden="true" />} title={database ? `No scheduling history in the current ${t.business} window.` : "No scheduling history in this preview."} />
              )}
            </TabsPanel>

            <TabsPanel value="contact">
              <h2 className="sr-only">Contact details</h2>
              <dl className="grid max-w-2xl gap-4 sm:grid-cols-2">
                  <Fact label="First name">{patient.firstName}</Fact>
                  <Fact label="Last name">{patient.lastName}</Fact>
                  <Fact label="Phone"><span className="tabular-nums">{patient.phone}</span></Fact>
                  <Fact label="Email">{patient.email || "Not recorded"}</Fact>
                  {profile.features.dateOfBirth ? <Fact label="Date of birth"><span className="tabular-nums">{patient.dateOfBirth ? formatBirthDate(patient.dateOfBirth) : "Not recorded"}</span></Fact> : null}
                  <Fact label="Preferred channel">{channelLabel(patient.preferredChannel)}</Fact>
                  <Fact label="Text and WhatsApp reminders">{patient.messagingConsentAt ? <>Allowed <span className="block text-xs font-normal text-muted-foreground tabular-nums">Since {formatConsentDate(patient.messagingConsentAt)}</span></> : "Not allowed — email only"}</Fact>
                  <Fact label="Privacy notice">{patient.privacyAcceptedAt ? <>Accepted online <span className="block text-xs font-normal text-muted-foreground tabular-nums">{formatConsentDate(patient.privacyAcceptedAt)}</span></> : "Not accepted online"}</Fact>
                  <Fact label="Accessibility or communication needs">{patient.accessibilityNeed ?? "None recorded"}</Fact>
              </dl>
            </TabsPanel>
          </WorkspaceFrame>
        </Tabs>
        {detailsDialog}
      </CustomerProfilePage>
    );
  }

  const listTabs = showListTabs ? (
    <TabsList variant="underline" aria-label={`${t.Customers} views`}>
      <TabsTab value="everyone" className="max-sm:px-1.5">Everyone</TabsTab>
      <TabsTab value="segments" className="max-sm:px-1.5">Segments</TabsTab>
      {access.can("customers.manage") ? <TabsTab value="duplicates" className="max-sm:px-1.5">Possible duplicates</TabsTab> : null}
    </TabsList>
  ) : undefined;
  const otherTab = !showListTabs || listTab === "everyone" ? undefined
    : listTab === "segments" ? <SegmentsPanel onOpenCustomer={selectPatient} /> : <DuplicatesPanel />;

  return (
    <Tabs value={listTab} onValueChange={(tab) => setListTab(tab as typeof listTab)} className="gap-0">
    <WorkspacePage
      nav="patients"
      bar={canEdit ? [{ id: "add", label: `Add ${t.customer}`, icon: <UserPlus aria-hidden="true" />, variant: "default", onSelect: () => setDialog("add"), pinned: true }] : []}
      menu={database && access.can("settings.manage") ? [{ id: "import", label: `Import ${t.customers}`, icon: <Upload aria-hidden="true" />, href: "/settings/import" }] : undefined}
    >
      {searchError && !otherTab ? <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertDescription>{searchError}</AlertDescription></Alert> : null}
      <PatientsGrid
        tabs={listTabs}
        replace={otherTab}
        live={database}
        rows={rows}
        terms={t}
        query={query}
        onQueryChange={(next) => { setQuery(next); setPagination((current) => ({ ...current, pageIndex: 0 })); }}
        pagination={pagination}
        onPaginationChange={setPagination}
        onOpen={selectPatient}
        onBook={onBook}
        recordsHref={profile.features.records && access.can("records.view") ? recordsHref : undefined}
        empty={patients.length === 0 && !query
          ? <PanelEmpty icon={<Users aria-hidden="true" />} title={`No ${t.customers} yet`} description={canEdit ? `${t.Customers} appear here after their first booking, or add one yourself.` : `${t.Customers} appear here after their first booking.`} action={canEdit ? <Button size="sm" onClick={() => openNewVisit()}><Plus aria-hidden="true" />Book the first {t.appointment}</Button> : undefined} />
          : <PanelEmpty icon={<SearchX aria-hidden="true" />} title={`No ${t.customers} match that search.`} description="Try a name, phone number or email, or clear a filter." />}
      />
      {detailsDialog}
    </WorkspacePage>
    </Tabs>
  );
}

function formatBirthDate(value: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
}

function formatConsentDate(value: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value));
}
