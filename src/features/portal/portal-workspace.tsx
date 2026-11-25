"use client";

import { PushToggle } from "@/features/app-support/push-toggle";
import { releasePushForSignOut } from "@/features/app-support/use-push";
import { clearOfflineData } from "@/features/app-support/service-worker";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { CalendarDays, FileText, LogOut, ShieldCheck } from "lucide-react";

import { SelectField, TextField } from "@/components/form-fields";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Frame, FrameDescription, FrameHeader, FramePanel } from "@/components/ui/frame";
import { ResponsiveDrawer, ResponsiveDrawerPopup } from "@/components/responsive-drawer";
import { DrawerDescription, DrawerHeader, DrawerPanel, DrawerTitle } from "@/components/ui/drawer";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { isClinicalBusinessType } from "@/lib/business-types";
import type { AppointmentStatus } from "@/lib/domain";
import { resolveBusinessProfile, sharedBusinessProfile } from "@/lib/terminology";
import {
  demoClinic,
  demoLocations,
  demoPractitioners,
  demoServices,
} from "@/lib/demo-data";
import {
  previewAnanyaDateOfBirth,
  previewClinic,
  previewPortalContact,
  previewPortalIsKnown,
  previewPortalPeople,
  previewPortalRecords,
} from "@/lib/preview-records";
import { recordKindLabels, savedPeople, type PortalPerson, type PortalProvider, type PortalRecord, type PortalRecordDetail, type PortalSnapshot, type PortalVisit } from "@/lib/visit-records";

import { statusLabel } from "../clinic/clinic-format";
import { previewClockStart, usePreviewAppointments } from "../clinic/preview-appointments";
import { appointmentStatusTone } from "../clinic/task-ui";
import { RecordFileList } from "../records/record-file-list";
import { databasePortalClient, portalAuth, previewPortalClient, type PortalClient } from "../records/records-client";
import { useBusinessProfile, useFeatures, useTerms } from "../terms/business-profile-context";
import { DevicesPanel } from "./devices-panel";
import { PortalOffers } from "./portal-offers";
import { PortalShell } from "./portal-shell";
import { SavedPeopleList } from "./saved-people";

const previewTimezone = "Asia/Kolkata";

/** Past visits the preview schedule has no appointment for, so the portal has a history to show. */
const previewPastVisits: PortalVisit[] = [
  { id: "past_ananya", clinicSlug: previewClinic.slug, clinicName: previewClinic.name, patientId: "patient_ananya", serviceName: "Routine cleaning", practitionerName: "Mira Sen", practitionerId: "practitioner_mira", serviceId: "service_cleaning", locationName: "Indiranagar", startsAt: "2026-03-12T10:30:00+05:30", timezone: previewTimezone, status: "completed", href: null },
  { id: "past_kabir", clinicSlug: previewClinic.slug, clinicName: previewClinic.name, patientId: "patient_kabir", serviceName: "New patient consultation", practitionerName: "Dr. Rohan Shah", practitionerId: "practitioner_rohan", serviceId: "service_consultation", locationName: "Indiranagar", startsAt: "2026-05-04T09:45:00+05:30", timezone: previewTimezone, status: "completed", href: null },
];

function formatWhen(iso: string, timezone: string) {
  const date = new Date(iso);
  return {
    day: new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: timezone }).format(date),
    time: new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone: timezone }).format(date),
  };
}

function formatDay(iso: string) {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: previewTimezone }).format(new Date(iso));
}

export function PortalWorkspace({ initialSnapshot, now }: { initialSnapshot?: PortalSnapshot; now?: string }) {
  const router = useRouter();
  const preview = !initialSnapshot;
  const schedule = usePreviewAppointments();
  const [previewContact, setPreviewContact] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState(initialSnapshot);

  const clock = now ?? schedule.operations.clockIso ?? previewClockStart;

  const buildPreviewSnapshot = useCallback((contact: string): PortalSnapshot => {
    const people = previewPortalPeople(contact);
    const upcoming: PortalVisit[] = !previewPortalIsKnown(contact) ? [] : schedule.appointments
      .filter((appointment) => appointment.patientId === "patient_ananya")
      .map((appointment) => ({
        id: appointment.id,
        clinicSlug: previewClinic.slug,
        clinicName: previewClinic.name,
        patientId: appointment.patientId,
        serviceName: demoServices.find((item) => item.id === appointment.serviceId)?.name ?? "Visit",
        practitionerName: demoPractitioners.find((item) => item.id === appointment.practitionerId)?.name ?? "Practitioner",
        practitionerId: appointment.practitionerId,
        serviceId: appointment.serviceId,
        locationName: demoLocations.find((item) => item.id === appointment.locationId)?.name ?? "",
        startsAt: appointment.startsAt,
        timezone: previewTimezone,
        status: appointment.status,
        href: appointment.manageToken ? `/manage/${encodeURIComponent(appointment.manageToken)}` : null,
      }));
    return {
      contact,
      people,
      visits: previewPortalIsKnown(contact) ? [...upcoming, ...previewPastVisits] : [],
      providers: demoPractitioners.map((person): PortalProvider => ({
        clinicSlug: previewClinic.slug,
        id: person.id,
        role: [person.title, person.specialty].filter(Boolean).join(" · "),
        photoUrl: person.photoUrl ?? null,
        isActive: person.isActive !== false,
      })),
      records: previewPortalRecords(contact),
      profiles: { [previewClinic.slug]: resolveBusinessProfile(demoClinic) },
    };
  }, [schedule.appointments]);

  const client: PortalClient | null = useMemo(() => {
    if (!preview) return databasePortalClient;
    return previewContact ? previewPortalClient(previewContact, clock, () => buildPreviewSnapshot(previewContact)) : null;
  }, [buildPreviewSnapshot, clock, preview, previewContact]);

  useEffect(() => {
    if (!preview) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      const contact = previewPortalContact();
      if (!contact) {
        router.replace("/portal/sign-in");
        return;
      }
      setPreviewContact(contact);
      setSnapshot(buildPreviewSnapshot(contact));
    });
    return () => { active = false; };
  }, [buildPreviewSnapshot, preview, router]);

  const signOut = async () => {
    if (preview) portalAuth.previewSignOut();
    else {
      await releasePushForSignOut("/api/portal/push/subscribe");
      await portalAuth.signOut().catch(() => undefined);
      await clearOfflineData();
    }
    router.replace("/portal/sign-in");
    router.refresh();
  };

  const signOutButton = (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {preview ? null : <PushToggle endpoint="/api/portal/push/subscribe" onLabel="Reminders on" offLabel="Get reminders here" compact />}
      <Button variant="outline" size="sm" onClick={() => void signOut()}>
        <LogOut aria-hidden="true" /> Sign out
      </Button>
    </div>
  );

  if (!snapshot || !client) {
    return (
      <PortalShell>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </PortalShell>
    );
  }

  return (
    <PortalShell contact={snapshot.contact} actions={signOutButton} profile={sharedBusinessProfile(Object.values(snapshot.profiles ?? {}))}>
      {snapshot.people.length ? (
        <PortalContent
          snapshot={snapshot}
          client={client}
          clock={clock}
          preview={preview}
          onRefresh={async () => setSnapshot(await client.snapshot())}
        />
      ) : (
        <NoVisitsFound action={signOutButton} />
      )}
    </PortalShell>
  );
}

function NoVisitsFound({ action }: { action: ReactNode }) {
  const t = useTerms();
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon"><CalendarDays aria-hidden="true" /></EmptyMedia>
        <EmptyTitle>No {t.visits} found for this contact</EmptyTitle>
        <EmptyDescription>Your {t.business} may have a different email or phone number for you. Try the other one, or ask them to update it.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>{action}</EmptyContent>
    </Empty>
  );
}

function personKey(person: Pick<PortalPerson, "clinicSlug" | "patientId">) {
  return `${person.clinicSlug}/${person.patientId}`;
}

function PortalContent({ snapshot, client, clock, preview, onRefresh }: {
  snapshot: PortalSnapshot;
  client: PortalClient;
  clock: string;
  preview: boolean;
  onRefresh: () => Promise<void>;
}) {
  const t = useTerms();
  const features = useFeatures();
  const clinical = isClinicalBusinessType(useBusinessProfile().businessType);
  const [personFilter, setPersonFilter] = useState("all");
  const [tab, setTab] = useState("visits");
  const multiplePeople = snapshot.people.length > 1;
  const people = personFilter === "all" ? snapshot.people : snapshot.people.filter((person) => personKey(person) === personFilter);
  const inFilter = (item: { clinicSlug: string; patientId: string }) => personFilter === "all" || personKey(item) === personFilter;
  const nameOf = (item: { clinicSlug: string; patientId: string }) => snapshot.people.find((person) => personKey(person) === personKey(item))?.name ?? "";

  const visits = snapshot.visits.filter(inFilter);
  const clockMs = Date.parse(clock);
  const upcoming = visits
    .filter((visit) => Date.parse(visit.startsAt) >= clockMs && (visit.status === "booked" || visit.status === "requested" || visit.status === "checked_in"))
    .sort((left, right) => left.startsAt.localeCompare(right.startsAt));
  const past = visits.filter((visit) => !upcoming.includes(visit)).sort((left, right) => right.startsAt.localeCompare(left.startsAt));
  const seen = savedPeople(visits, clockMs);
  const businesses = [...new Map(snapshot.people.map((person) => [person.clinicSlug, { slug: person.clinicSlug, name: person.clinicName }])).values()];
  const visitLists = (
    <>
      <VisitList title="Upcoming" empty="Nothing booked." visits={upcoming} nameOf={multiplePeople ? nameOf : undefined} />
      <VisitList title="Past" empty={`No earlier ${t.visits}.`} visits={past} nameOf={multiplePeople ? nameOf : undefined} />
    </>
  );

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="font-heading text-xl font-semibold">{clinical ? "Your care" : `Your ${t.appointments}`}</h1>
        <Button variant="outline" size="sm" render={<Link href="/portal/privacy" />}><ShieldCheck aria-hidden="true" /> Your privacy</Button>
        {multiplePeople ? (
          <SelectField
            id="portal-person"
            label="Showing"
            fieldClassName="w-full sm:w-56"
            value={personFilter}
            onValueChange={setPersonFilter}
            options={[{ value: "all", label: "Everyone" }, ...snapshot.people.map((person) => ({ value: personKey(person), label: person.name }))]}
          />
        ) : null}
      </div>
      <Tabs value={tab} onValueChange={(next) => setTab(String(next))}>
        <TabsList aria-label="Portal sections">
          <TabsTab value="visits">{t.Visits}</TabsTab>
          <TabsTab value="people">{t.Providers}</TabsTab>
          {features.records ? <TabsTab value="documents">Documents</TabsTab> : null}
          <TabsTab value="devices">Devices</TabsTab>
        </TabsList>
        <TabsPanel value="visits" className="flex flex-col gap-4 pt-3">
          {visitLists}
          <PortalOffers preview={preview} />
        </TabsPanel>
        <TabsPanel value="people" className="flex flex-col gap-4 pt-3">
          <SavedPeopleList people={seen} providers={snapshot.providers ?? []} businesses={businesses} showBusiness={businesses.length > 1} />
        </TabsPanel>
        {features.records ? (
          <TabsPanel value="documents" className="flex flex-col gap-4 pt-3">
            {people.map((person) => (
              <PersonDocuments
                key={personKey(person)}
                person={person}
                records={snapshot.records.filter((record) => personKey(record) === personKey(person))}
                client={client}
                preview={preview}
                onRefresh={onRefresh}
              />
            ))}
          </TabsPanel>
        ) : null}
        <TabsPanel value="devices" className="flex flex-col gap-4 pt-3">
          <DevicesPanel preview={preview} />
        </TabsPanel>
      </Tabs>
    </>
  );
}

function VisitList({ title, empty, visits, nameOf }: {
  title: string;
  empty: string;
  visits: PortalVisit[];
  nameOf?: (visit: PortalVisit) => string;
}) {
  const t = useTerms();
  return (
    <Frame>
      <FrameHeader className="px-4 py-3"><h2 className="text-sm font-medium">{title}</h2></FrameHeader>
      <FramePanel className="p-0">
        {visits.length ? (
          <ul className="divide-y">
            {visits.map((visit) => {
              const when = formatWhen(visit.startsAt, visit.timezone);
              const status = visit.status as AppointmentStatus;
              return (
                <li key={visit.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                  <div className="w-32 shrink-0">
                    <p className="text-sm font-medium">{when.day}</p>
                    <p className="text-xs text-muted-foreground">{when.time}</p>
                  </div>
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="text-sm font-medium">{visit.serviceName}{nameOf ? <span className="font-normal text-muted-foreground"> · {nameOf(visit)}</span> : null}</p>
                    <p className="text-xs text-muted-foreground">{visit.practitionerName} · {visit.clinicName}{visit.locationName ? `, ${visit.locationName}` : ""}</p>
                  </div>
                  <StatusBadge tone={appointmentStatusTone(status)}>{status === "requested" ? `Waiting for ${t.business}` : statusLabel(status)}</StatusBadge>
                  {visit.href ? <Button variant="outline" size="sm" render={<Link href={visit.href} />}>Manage</Button> : null}
                </li>
              );
            })}
          </ul>
        ) : <p className="px-4 py-6 text-sm text-muted-foreground">{empty}</p>}
      </FramePanel>
    </Frame>
  );
}

function PersonDocuments({ person, records, client, preview, onRefresh }: {
  person: PortalPerson;
  records: PortalRecord[];
  client: PortalClient;
  preview: boolean;
  onRefresh: () => Promise<void>;
}) {
  const t = useTerms();
  const [openRecord, setOpenRecord] = useState<PortalRecordDetail | null>(null);
  const [error, setError] = useState("");

  async function open(record: PortalRecord) {
    setError("");
    try {
      setOpenRecord(await client.record(record.clinicSlug, record.id));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "This document could not be opened.");
    }
  }

  return (
    <Frame>
      <FrameHeader className="px-4 py-3">
        <h2 className="text-sm font-medium">{person.name}</h2>
        <FrameDescription className="text-xs">{person.clinicName}</FrameDescription>
      </FrameHeader>
      <FramePanel className={person.access === "open" ? "p-0" : undefined}>
        {person.access === "open" ? (
          <>
            {error ? <Alert variant="error" role="alert" className="m-3 w-auto"><AlertDescription>{error}</AlertDescription></Alert> : null}
            {records.length ? (
              <ul className="divide-y">
                {records.map((record) => (
                  <li key={record.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                    <div className="min-w-0 flex-1 basis-48">
                      <p className="text-sm font-medium">{record.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {[record.practitionerName, formatDay(record.sharedAt), record.fileCount ? `${record.fileCount} file${record.fileCount === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ")}
                      </p>
                    </div>
                    <Badge variant="outline">{recordKindLabels[record.kind]}</Badge>
                    <Button variant="outline" size="sm" onClick={() => void open(record)}>Open</Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-6 text-sm text-muted-foreground">Nothing shared yet. Your {t.business}&apos;s notes and reports appear here once {t.aPractitioner} shares them.</p>
            )}
          </>
        ) : <IdentityStep person={person} client={client} preview={preview} onRefresh={onRefresh} />}
      </FramePanel>
      <ResponsiveDrawer open={openRecord !== null} onOpenChange={(next) => { if (!next) setOpenRecord(null); }}>
        <ResponsiveDrawerPopup variant="inset">
          {openRecord ? (
            <>
              <DrawerHeader>
                <DrawerTitle>{openRecord.title}</DrawerTitle>
                <DrawerDescription>
                  {[recordKindLabels[openRecord.kind], openRecord.practitionerName, formatDay(openRecord.sharedAt)].filter(Boolean).join(" · ")}
                </DrawerDescription>
              </DrawerHeader>
              <DrawerPanel className="flex flex-col gap-4">
                {openRecord.body ? <p className="text-sm whitespace-pre-wrap">{openRecord.body}</p> : null}
                {openRecord.files.length ? (
                  <RecordFileList files={openRecord.files} hrefFor={(file) => client.fileHref(openRecord.clinicSlug, openRecord.id, file)} />
                ) : null}
              </DrawerPanel>
            </>
          ) : null}
        </ResponsiveDrawerPopup>
      </ResponsiveDrawer>
    </Frame>
  );
}

/** Sharing a phone shows a family's visits, not each other's documents. This is the extra step that opens them. */
function IdentityStep({ person, client, preview, onRefresh }: {
  person: PortalPerson;
  client: PortalClient;
  preview: boolean;
  onRefresh: () => Promise<void>;
}) {
  const t = useTerms();
  const [dateOfBirth, setDateOfBirth] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function confirm(value?: string) {
    setPending(true);
    setError("");
    try {
      await client.confirm(person.clinicSlug, person.patientId, value);
      await onRefresh();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "That could not be confirmed.");
      await onRefresh().catch(() => undefined);
    } finally {
      setPending(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (dateOfBirth) void confirm(dateOfBirth);
  }

  if (person.access === "requested") {
    return (
      <Alert variant="info" role="status">
        <ShieldCheck aria-hidden="true" />
        <AlertDescription>The {t.business} has your request. They may ask to see ID at your next {t.visit}, and {person.name}&apos;s documents open once they confirm.</AlertDescription>
      </Alert>
    );
  }

  if (person.access === "ask_clinic") {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-muted-foreground">To keep {person.name}&apos;s documents private, the {t.business} needs to confirm this is you. They may ask to see ID.</p>
        {error ? <Alert variant="error" role="alert"><AlertDescription>{error}</AlertDescription></Alert> : null}
        <Button variant="outline" disabled={pending} onClick={() => void confirm()}>
          {pending ? <Spinner aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />}
          Ask the {t.business}
        </Button>
      </div>
    );
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <p className="text-sm text-muted-foreground">Confirm {person.name}&apos;s date of birth to open their documents. Families often share a phone or email, so this keeps each person&apos;s records private.</p>
      {preview ? <Alert variant="info"><AlertDescription>Preview date of birth: <span className="font-medium text-foreground">{formatDay(previewAnanyaDateOfBirth)}</span></AlertDescription></Alert> : null}
      {error ? <Alert variant="error" role="alert"><AlertDescription>{error}</AlertDescription></Alert> : null}
      <div className="flex flex-wrap items-end gap-2">
        <TextField id={`dob-${person.patientId}`} label="Date of birth" type="date" fieldClassName="w-full sm:w-56" value={dateOfBirth} onChange={(event) => setDateOfBirth(event.target.value)} required />
        <Button type="submit" disabled={pending || !dateOfBirth}>
          {pending ? <Spinner aria-hidden="true" /> : <FileText aria-hidden="true" />}
          Open documents
        </Button>
      </div>
    </form>
  );
}
