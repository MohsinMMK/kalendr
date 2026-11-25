import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { BookingShell } from "@/features/booking/booking-shell";
import { RatingPage } from "@/features/booking/rating-page";
import { resolveBusinessProfile } from "@/lib/terminology";
import { ApiError } from "@/server/api-error";
import { getRatingState } from "@/server/ratings";

export const dynamic = "force-dynamic";

// The link carries no business type, so the page uses plain words and no clinic-only footer.
const neutralProfile = resolveBusinessProfile({ businessType: "other" });

// The link is the proof, so it must not be indexed or leak through a referrer.
export const metadata: Metadata = {
  title: "Rate your visit",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default async function RatePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) notFound();
  const state = await getRatingState(token).catch((error: unknown) => {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  });
  if (!state) notFound();
  return (
    <BookingShell clinicName={state.business} profile={neutralProfile}>
      <div className="mx-auto w-full max-w-lg py-2">
        <RatingPage token={token} initial={state} />
      </div>
    </BookingShell>
  );
}
