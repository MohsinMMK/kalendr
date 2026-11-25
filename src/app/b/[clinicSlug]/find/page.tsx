import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { BookingShell } from "@/features/booking/booking-shell";
import { FindGuide } from "@/features/business/find-guide";
import { dateKeyIn } from "@/lib/business-page";
import { profileWords } from "@/lib/terminology";
import { loadFreeTimes } from "@/server/business-page";

import { getBusinessCatalog } from "../catalog";
import { unavailablePage } from "@/features/booking/unavailable-page";

interface FindRouteProps {
  params: Promise<{ clinicSlug: string }>;
}

export async function generateMetadata({ params }: FindRouteProps): Promise<Metadata> {
  const { clinicSlug } = await params;
  const catalog = await getBusinessCatalog(clinicSlug);
  if (!catalog?.guide) return { title: "Page unavailable", robots: { index: false, follow: false } };
  const t = profileWords(catalog.profile);
  return {
    title: `${catalog.guide.title} · ${catalog.clinic.name}`,
    description: catalog.guide.intro || `Answer a few questions and see the ${t.providers} and ${t.services} at ${catalog.clinic.name} that fit.`,
    alternates: { canonical: `/b/${catalog.clinic.slug}/find` },
    // Every set of answers is its own address; only the business page itself belongs in search results.
    robots: { index: false, follow: true },
  };
}

/** "Help me choose": the business's own questions, then the people and services that fit the answers. */
export default async function FindRoute({ params }: FindRouteProps) {
  const { clinicSlug } = await params;
  const catalog = await getBusinessCatalog(clinicSlug);
  if (!catalog) return unavailablePage(clinicSlug);
  if (!catalog.guide) redirect(`/b/${catalog.clinic.slug}`);

  const now = new Date();
  const freeTimes = await loadFreeTimes(catalog, now).catch(() => ({}));
  const timeZone = catalog.locations[0]?.timezone ?? catalog.clinic.timezone;

  return (
    <BookingShell clinicName={catalog.clinic.name} clinicPhone={catalog.clinic.phone} logoUrl={catalog.clinic.logoUrl} brand={catalog.clinic.brand} profile={catalog.profile}>
      <Suspense fallback={null}>
        <FindGuide
          clinic={catalog.clinic}
          guide={catalog.guide}
          services={catalog.services}
          practitioners={catalog.practitioners}
          ratings={catalog.ratings}
          freeTimes={freeTimes}
          todayKey={dateKeyIn(now, timeZone)}
        />
      </Suspense>
    </BookingShell>
  );
}
