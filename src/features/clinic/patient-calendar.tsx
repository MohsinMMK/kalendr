"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { dateFromKey } from "@/components/date-picker";
import { KloqToolbar } from "@/components/kloq";
import type { Appointment } from "@/lib/domain";

import { ClinicCalendar, ignoreChanges, MonthNav } from "./clinic-calendar";
import { appointmentEvent } from "./clinic-calendar-events";
import { clinicDateKey } from "./schedule-availability";

/** One patient's visits by month, opening on the most recent or next one. Visits open their appointment page. */
export function PatientCalendar({ visits, serviceName, practitionerName }: { visits: Appointment[]; serviceName: (id: string) => string; practitionerName: (id: string) => string }) {
  const router = useRouter();
  const [date, setDate] = useState(() => dateFromKey(clinicDateKey(visits[0].startsAt)));
  const events = useMemo(() => visits.map((visit) => appointmentEvent(visit, { patientName: serviceName(visit.serviceId), serviceName: serviceName(visit.serviceId), practitionerName: practitionerName(visit.practitionerId) })), [practitionerName, serviceName, visits]);
  return <ClinicCalendar view="month" date={date} onDateChange={setDate} events={events} onEventsChange={ignoreChanges} onOpenVisit={(id) => router.push(`/appointments/${id}?from=patients`)}>
    <KloqToolbar className="px-3 py-2"><MonthNav /></KloqToolbar>
  </ClinicCalendar>;
}
