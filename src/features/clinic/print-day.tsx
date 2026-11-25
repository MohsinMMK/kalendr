"use client";

import { Printer, TriangleAlert } from "lucide-react";
import { useMemo } from "react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useBusinessProfile, useTerms } from "@/features/terms/business-profile-context";
import type { Permission, StaffRole } from "@/lib/permissions";
import { demoAppointments } from "@/lib/demo-data";
import type { Appointment, Patient } from "@/lib/domain";

import { useCatalogLookups } from "./clinic-catalog";
import { appointmentDuration, appointmentTime, statusLabel } from "./clinic-format";
import { inactiveStatuses } from "./clinic-calendar-events";
import { usePreviewAppointments } from "./preview-appointments";
import { StaffQueryProvider } from "./queries/client";
import { clinicDateKey } from "./schedule-availability";
import { dayLabel, visitsOnDays } from "./schedule-model";
import { StaffAccessProvider } from "./staff-access";
import { StaffBusinessProfile } from "./staff-business-profile";
import { StaffSnapshotProvider, useOptionalStaffSnapshot } from "./staff-snapshot-provider";

interface PrintDayProps {
  clinicSlug: string;
  clinicName: string;
  role: StaffRole;
  userId: string | null;
  preview: boolean;
  permissions: Permission[];
  initialDate: string;
  initialLocation: string;
}

/** The day sheet has no menus or sidebar, only what goes on paper, so it brings just the data it reads. */
export function PrintDay({ clinicSlug, clinicName, role, userId, preview, permissions, initialDate, initialLocation }: PrintDayProps) {
  const body = <StaffBusinessProfile><DaySheet clinicName={clinicName} initialDate={initialDate} initialLocation={initialLocation} /></StaffBusinessProfile>;
  return (
    <StaffQueryProvider scope={`${clinicSlug}:${userId ?? "preview"}`}>
      <StaffAccessProvider role={role} permissions={permissions} userId={userId}>
        {preview ? body : <StaffSnapshotProvider role={role}>{body}</StaffSnapshotProvider>}
      </StaffAccessProvider>
    </StaffQueryProvider>
  );
}

function patientLine(patient: Patient | undefined, fallback: string): { name: string; phone: string } {
  return patient ? { name: `${patient.firstName} ${patient.lastName}`.trim(), phone: patient.phone } : { name: fallback, phone: "" };
}

function DaySheet({ clinicName, initialDate, initialLocation }: { clinicName: string; initialDate: string; initialLocation: string }) {
  const { appointments, patients, operations, database } = usePreviewAppointments();
  const staff = useOptionalStaffSnapshot();
  const catalog = useCatalogLookups();
  const t = useTerms();
  const profile = useBusinessProfile();
  const defaultDay = database ? clinicDateKey(operations.clockIso) : clinicDateKey(demoAppointments[0].startsAt);
  const dateKey = initialDate || defaultDay;
  const locationId = catalog.locations.some((item) => item.id === initialLocation) ? initialLocation : catalog.locations[0]?.id ?? "";
  const locationName = catalog.locations.find((item) => item.id === locationId)?.name ?? "";
  const patientsById = useMemo(() => new Map(patients.map((item) => [item.id, item])), [patients]);

  const sections = useMemo(() => {
    const day = visitsOnDays(appointments, [dateKey]).filter((item) => item.locationId === locationId && !inactiveStatuses.includes(item.status));
    const byPractitioner = new Map<string, Appointment[]>();
    for (const appointment of day) byPractitioner.set(appointment.practitionerId, [...(byPractitioner.get(appointment.practitionerId) ?? []), appointment]);
    return catalog.practitioners
      .filter((person) => person.locationIds.includes(locationId))
      .map((person) => ({ person, visits: byPractitioner.get(person.id) ?? [] }));
  }, [appointments, catalog.practitioners, dateKey, locationId]);

  if (staff && !staff.snapshot) {
    return <div role="status" className="mx-auto flex max-w-3xl flex-col gap-3 p-6">
      <span className="sr-only">Loading the day sheet</span>
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-4 w-96 max-w-full" />
      {Array.from({ length: 8 }, (_, index) => <Skeleton key={index} className="h-10 w-full" />)}
      {staff.error ? <p role="alert" className="flex items-center gap-2 text-sm text-destructive-foreground"><TriangleAlert aria-hidden="true" className="size-4" />{staff.error}</p> : null}
    </div>;
  }

  const printedAt = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" }).format(new Date(database ? operations.clockIso : `${dateKey}T09:00:00+05:30`));
  // `w-full`: a flex child with auto margins would otherwise shrink to its content, and the columns with it.
  return <div className="mx-auto w-full max-w-4xl bg-background p-6 text-foreground print:max-w-none print:p-0">
    {/* One sheet per staff member: the page break falls between them, never inside a table. */}
    <style>{"@page { size: A4; margin: 12mm; } @media print { html, body { background: #fff !important; color: #000 !important; } }"}</style>
    <div className="mb-6 flex items-center justify-between gap-4 print:hidden">
      <p className="text-muted-foreground text-sm">One page for each {t.practitioner}. Use your browser&rsquo;s print dialog to print or save as a PDF.</p>
      <Button onClick={() => window.print()}><Printer aria-hidden="true" /> Print</Button>
    </div>
    {sections.length === 0 ? <p className="py-12 text-center text-muted-foreground">There are no {t.practitioners} at this location.</p> : null}
    {sections.map(({ person, visits }, index) => (
      <section key={person.id} aria-label={`${person.name}, ${dayLabel(dateKey)}`} className={index < sections.length - 1 ? "mb-10 break-after-page print:mb-0" : ""}>
        <header className="mb-3 flex flex-wrap items-end justify-between gap-2 border-b-2 border-foreground pb-2">
          <div>
            <h1 className="font-heading text-xl font-semibold">{person.name}</h1>
            <p className="text-sm">{dayLabel(dateKey, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</p>
          </div>
          <p className="text-right text-sm">{clinicName}{locationName ? ` · ${locationName}` : ""}<br />{visits.length} {visits.length === 1 ? t.visit : t.visits}</p>
        </header>
        {visits.length === 0 ? <p className="py-6 text-sm">No {t.visits} booked.</p> : <table className="w-full table-fixed border-collapse text-left text-sm">
          <colgroup><col className="w-[14%]" /><col className="w-[26%]" /><col className="w-[20%]" /><col className="w-[12%]" /><col /></colgroup>
          <thead>
            <tr className="border-b border-foreground/60 text-xs uppercase tracking-wide">
              <th scope="col" className="py-1.5 pe-2 font-semibold">Time</th>
              <th scope="col" className="py-1.5 pe-2 font-semibold">{t.Customer}</th>
              <th scope="col" className="py-1.5 pe-2 font-semibold">Service</th>
              <th scope="col" className="py-1.5 pe-2 font-semibold">{profile.terms.resource.singular.replace(/^./, (letter) => letter.toUpperCase())}</th>
              <th scope="col" className="py-1.5 font-semibold">Notes</th>
            </tr>
          </thead>
          <tbody>
            {visits.map((appointment) => {
              const who = patientLine(patientsById.get(appointment.patientId), t.Customer);
              const notes = [appointment.reasonForVisit, appointment.notes, appointment.status === "booked" ? "" : statusLabel(appointment.status)].filter(Boolean).join(" · ");
              return <tr key={appointment.id} className="break-inside-avoid border-b border-foreground/20 align-top">
                <td className="py-2 pe-2 tabular-nums"><span className="font-medium">{appointmentTime(appointment.startsAt)}</span><br /><span className="text-xs">{appointmentDuration(appointment)} min</span></td>
                <td className="py-2 pe-2"><span className="font-medium">{who.name}</span>{who.phone ? <><br /><span className="text-xs tabular-nums">{who.phone}</span></> : null}</td>
                <td className="py-2 pe-2">{catalog.serviceName(appointment.serviceId)}</td>
                <td className="py-2 pe-2">{appointment.resourceIds.map((id) => catalog.resourceName(id)).filter(Boolean).join(", ") || "–"}</td>
                <td className="py-2">{notes || <span className="text-transparent print:text-black/0">.</span>}</td>
              </tr>;
            })}
          </tbody>
        </table>}
        <footer className="mt-4 text-xs">Printed {printedAt}</footer>
      </section>
    ))}
  </div>;
}
