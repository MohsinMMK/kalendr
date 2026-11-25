import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { Button } from "@/components/ui/button";
import { BookingShell } from "@/features/booking/booking-shell";
import { ManageBooking } from "@/features/booking/manage-booking";
import { defaultBusinessProfile, profileWords } from "@/lib/terminology";
import { ApiError } from "@/server/api-error";
import { loadPublicBrandBySlug } from "@/server/brand";
import { loadBusinessProfileBySlug } from "@/server/business-profile";
import { getPatientAccount } from "@/server/patient-auth";
import { resolvePortalVisit } from "@/server/patient-portal";
import { isPreviewMode } from "@/server/preview-repository";

type PortalVisitParams = { params: Promise<{ clinicSlug: string; id: string }> };

export async function generateMetadata({ params }: PortalVisitParams): Promise<Metadata> {
  const { clinicSlug } = await params;
  const t = profileWords(await loadBusinessProfileBySlug(clinicSlug).catch(() => defaultBusinessProfile));
  return {
    title: `Your ${t.visit}`,
    description: `Review or change ${t.aBusiness} ${t.appointment}.`,
    robots: { index: false, follow: false },
  };
}

export default async function PortalVisitPage({ params }: PortalVisitParams) {
  if (isPreviewMode()) redirect("/portal");
  const account = await getPatientAccount(await headers());
  if (!account) redirect("/portal/sign-in");
  const { clinicSlug, id } = await params;
  try {
    await resolvePortalVisit(account, clinicSlug, id);
  } catch (error: unknown) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }
  const profile = await loadBusinessProfileBySlug(clinicSlug);
  const t = profileWords(profile);
  const look = await loadPublicBrandBySlug(clinicSlug);
  return (
    <BookingShell profile={profile} brand={look}>
      <Button variant="ghost" size="sm" className="mb-2 self-start" render={<Link href="/portal" />}>
        <ArrowLeft aria-hidden="true" /> All {t.visits}
      </Button>
      <ManageBooking
        token={id}
        apiPath={`/api/portal/visits/${encodeURIComponent(clinicSlug)}/${encodeURIComponent(id)}`}
        fallbackSlots={[]}
      />
    </BookingShell>
  );
}
