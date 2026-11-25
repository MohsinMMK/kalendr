import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";

import { BookingShell } from "@/features/booking/booking-shell";
import { ManageBooking } from "@/features/booking/manage-booking";
import { ManageLinkExpired } from "@/features/booking/manage-link-expired";
import { ManageLinkMoved } from "@/features/booking/manage-link-moved";
import type { ManageBookingSnapshot } from "@/features/booking/booking-types";
import {
  demoAppointments,
  demoClinic,
  demoLocations,
  demoPractitioners,
  demoServices,
  demoSlots,
} from "@/lib/demo-data";
import type { Clinic } from "@/lib/domain";
import { inPreviewWords } from "@/lib/preview-sample";
import { defaultBusinessProfile, profileWords, resolveBusinessProfile } from "@/lib/terminology";
import { ApiError } from "@/server/api-error";
import { getManageSnapshot } from "@/server/appointment-repository";
import { previewBusinessClinic } from "@/server/business-profile";
import { loadPublicBrand } from "@/server/brand";
import { loadMovedBooking } from "@/server/old-manage-link";
import { manageLinkExpired } from "@/server/patient-step-up";
import { isPreviewMode } from "@/server/preview-repository";

interface ManagePageProps {
  params: Promise<{ token: string }>;
}

/** The booking behind a link, read once per render for both the title and the page. */
const loadManagePage = cache(async (token: string) => {
  // A dead link answers 404 before anything renders. Any other failure may be
  // temporary, so the page still opens and the client offers Try again.
  // An old link must not render the booking at all, nor the business's brand.
  const expired = await manageLinkExpired(token).catch(() => false);
  if (expired) return { expired: true as const, missing: false, moved: null, preview: false, profile: undefined, brand: undefined, previewClinic: undefined, look: undefined };
  let loaded: ManageBookingSnapshot | null = null;
  let missing = false;
  try {
    loaded = await getManageSnapshot(token);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) missing = true;
  }
  // A link a move replaced is still dead. It only gets a landing that says so, and only once nothing live matched it.
  const moved = missing ? await loadMovedBooking(token).catch(() => null) : null;
  if (moved) return { expired: false as const, missing, moved, preview: false, profile: moved.profile, brand: { name: moved.businessName, phone: undefined, logoUrl: undefined }, look: await loadPublicBrand(moved.tenantId), previewClinic: undefined };
  const preview = isPreviewMode();
  const profileClinic = preview ? await previewBusinessClinic() : loaded?.clinic;
  const profile = profileClinic ? resolveBusinessProfile(profileClinic) : undefined;
  // The header shows the business's name, phone and logo; nothing private about the booking itself.
  const brand = loaded ? { name: loaded.clinic.name, phone: loaded.clinic.phone, logoUrl: loaded.clinic.logoUrl } : undefined;
  // The business's colours and corner style (feature 13), only once the link is known to be good.
  const look = loaded && !preview ? await loadPublicBrand(loaded.clinic.id) : undefined;
  return { expired: false as const, missing, moved: null, preview, profile, brand, look, previewClinic: preview ? profileClinic : undefined };
});

export async function generateMetadata({ params }: ManagePageProps): Promise<Metadata> {
  const { token } = await params;
  const { profile, expired, moved } = await loadManagePage(token);
  if (moved) return { title: `This ${profileWords(profile ?? defaultBusinessProfile).appointment} was moved`, robots: { index: false, follow: false } };
  if (expired) return { title: "Sign in to see this booking", robots: { index: false, follow: false } };
  const t = profileWords(profile ?? defaultBusinessProfile);
  return {
    title: `Manage ${t.appointment}`,
    description: `Review or change ${t.aBusiness} ${t.appointment}.`,
    robots: { index: false, follow: false },
  };
}

function getDemoSnapshot(token: string, clinic: Clinic): ManageBookingSnapshot | undefined {
  const appointment = demoAppointments.find((item) => item.manageToken === token);
  if (!appointment) {
    return undefined;
  }

  const location = demoLocations.find((item) => item.id === appointment.locationId);
  const practitioner = demoPractitioners.find(
    (item) => item.id === appointment.practitionerId,
  );
  const service = demoServices.find((item) => item.id === appointment.serviceId);
  if (!location || !practitioner || !service) {
    return undefined;
  }

  return inPreviewWords({
    appointment: { ...appointment, version: 1 },
    clinic: demoClinic,
    location,
    practitioner,
    service,
    canCancel:
      appointment.status === "booked" || appointment.status === "requested",
    canReschedule:
      appointment.status === "booked" || appointment.status === "requested",
  }, clinic);
}

export default async function ManagePage({ params }: ManagePageProps) {
  const { token } = await params;
  const { expired, missing, moved, preview, profile, brand, look, previewClinic } = await loadManagePage(token);
  if (expired) {
    return (
      <BookingShell>
        <ManageLinkExpired />
      </BookingShell>
    );
  }
  if (moved) {
    return (
      <BookingShell clinicName={moved.businessName} brand={look} profile={profile}>
        <ManageLinkMoved businessName={moved.businessName} serviceName={moved.serviceName} newTime={moved.newTime} bookAgainPath={moved.bookAgainPath} />
      </BookingShell>
    );
  }
  if (missing) notFound();

  const initialSnapshot = previewClinic ? getDemoSnapshot(token, previewClinic) : undefined;
  const t = profileWords(profile ?? defaultBusinessProfile);
  const records = profile?.features.records ?? true;

  return (
    <BookingShell
      clinicName={initialSnapshot?.clinic.name ?? brand?.name}
      clinicPhone={initialSnapshot?.clinic.phone ?? brand?.phone}
      logoUrl={initialSnapshot ? initialSnapshot.clinic.logoUrl : brand?.logoUrl}
      brand={look}
      profile={profile}
    >
      <ManageBooking
        token={token}
        initialSnapshot={initialSnapshot}
        fallbackSlots={preview ? demoSlots : []}
        allowDemoFallback={preview && Boolean(initialSnapshot)}
      />
      <p className="mt-6 text-sm text-muted-foreground">
        All your {t.visits}{records ? " and documents" : ""} are in{" "}
        <Link className="font-medium text-foreground underline underline-offset-2" href="/portal">your {t.customer} account</Link>.
      </p>
    </BookingShell>
  );
}
