import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

import { BookingShell } from "@/features/booking/booking-shell";
import { RoutingForm } from "@/features/routing/routing-form";
import { ApiError } from "@/server/api-error";
import { loadPublicBrandBySlug } from "@/server/brand";
import { loadBusinessProfileBySlug } from "@/server/business-profile";
import { getPublicRoutingForm } from "@/server/routing-forms/public";

export const dynamic = "force-dynamic";

interface RoutingFormPageProps {
  params: Promise<{ clinicSlug: string; formSlug: string }>;
}

/** Shared within one render; the form itself is always read live. An unknown business, unknown form and draft all end as the same 404. */
const loadForm = cache(async (clinicSlug: string, formSlug: string) => {
  try {
    return await getPublicRoutingForm(clinicSlug, formSlug);
  } catch (error: unknown) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
});

export async function generateMetadata({ params }: RoutingFormPageProps): Promise<Metadata> {
  const { clinicSlug, formSlug } = await params;
  const form = await loadForm(clinicSlug, formSlug);
  return { title: form ? form.name : "Form unavailable", robots: { index: false, follow: false } };
}

export default async function RoutingFormPage({ params }: RoutingFormPageProps) {
  const { clinicSlug, formSlug } = await params;
  const form = await loadForm(clinicSlug, formSlug);
  if (!form) notFound();

  // The business's own words and colours, as on its booking page.
  const [profile, brand] = await Promise.all([loadBusinessProfileBySlug(clinicSlug), loadPublicBrandBySlug(clinicSlug)]);
  return (
    <BookingShell clinicName={form.businessName} profile={profile} {...(brand ? { brand } : {})}>
      <RoutingForm clinicSlug={clinicSlug} formSlug={formSlug} form={form} />
    </BookingShell>
  );
}
