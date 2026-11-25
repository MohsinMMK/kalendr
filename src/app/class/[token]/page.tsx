import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";

import { BookingShell } from "@/features/booking/booking-shell";
import { ClassSeatPage } from "@/features/booking/class-seat-page";
import { ApiError } from "@/server/api-error";
import { getSeat, type MySeatView } from "@/server/classes";

interface SeatRouteProps {
  params: Promise<{ token: string }>;
}

/** The seat behind a link, read once per render. A dead link is a 404; a temporary failure still opens the page, which offers Try again. */
const loadSeat = cache(async (token: string): Promise<{ seat: MySeatView | null }> => {
  try {
    return { seat: await getSeat(token) };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    return { seat: null };
  }
});

export const metadata: Metadata = {
  title: "Your place in the class",
  description: "See, take or cancel your place in a class.",
  robots: { index: false, follow: false },
};

export default async function SeatRoute({ params }: SeatRouteProps) {
  const { token } = await params;
  const { seat } = await loadSeat(token);
  return (
    <BookingShell clinicName={seat?.businessName}>
      <ClassSeatPage token={token} initial={seat} />
    </BookingShell>
  );
}
