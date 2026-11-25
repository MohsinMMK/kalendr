import type { Metadata } from "next";
import { cache } from "react";

import { ClassTimetable } from "@/features/booking/class-timetable";
import { BookingShell } from "@/features/booking/booking-shell";
import { unavailablePage } from "@/features/booking/unavailable-page";
import { todayKey, addDaysToKey, dayStartUtc } from "@/features/booking/zone-time";
import type { TimetableSession } from "@/lib/classes-contracts";
import { listTimetable } from "@/server/classes";
import { getPublicClinicCatalog } from "@/server/public-catalog";

const getCatalog = cache((slug: string) => getPublicClinicCatalog(slug));

interface ClassesPageProps {
  params: Promise<{ clinicSlug: string }>;
}

export async function generateMetadata({ params }: ClassesPageProps): Promise<Metadata> {
  const { clinicSlug } = await params;
  const catalog = await getCatalog(clinicSlug);
  if (!catalog) return { title: "Booking page unavailable", robots: { index: false, follow: false } };
  return { title: `Classes at ${catalog.clinic.name}`, description: `See the class timetable at ${catalog.clinic.name} and book a seat.`, robots: { index: false, follow: false } };
}

export default async function ClassesPage({ params }: ClassesPageProps) {
  const { clinicSlug } = await params;
  const catalog = await getCatalog(clinicSlug);
  if (!catalog) return unavailablePage(clinicSlug);

  // The next seven days. A failure here still opens the page, which loads the week again and offers Retry.
  let initial: TimetableSession[] | null = null;
  try {
    const to = dayStartUtc(addDaysToKey(todayKey(catalog.clinic.timezone), 7), catalog.clinic.timezone);
    initial = await listTimetable({ clinicSlug, from: new Date().toISOString(), to: to.toISOString() });
  } catch {
    initial = null;
  }

  return (
    <BookingShell clinicName={catalog.clinic.name} clinicPhone={catalog.clinic.phone} logoUrl={catalog.clinic.logoUrl} brand={catalog.clinic.brand} profile={catalog.profile}>
      <ClassTimetable
        clinicSlug={clinicSlug}
        businessName={catalog.clinic.name}
        businessZone={catalog.clinic.timezone}
        locale={catalog.clinic.locale}
        places={catalog.locations.map((place) => ({ id: place.id, name: place.name, timezone: place.timezone || catalog.clinic.timezone }))}
        initialSessions={initial}
      />
    </BookingShell>
  );
}
