import type { Metadata } from "next";

import { SeriesWorkspace } from "@/features/clinic/series-view";
import { currentStaffWords } from "@/server/business-profile";
import { requirePageAccess } from "@/server/staff-page-guard";

export async function generateMetadata(): Promise<Metadata> {
  const t = await currentStaffWords();
  return {
    title: `Repeating ${t.appointments}`,
    description: `Every date in a repeating series of ${t.appointments}, and where each one stands.`,
  };
}

export default async function SeriesPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  await requirePageAccess("appointment-series");
  const [{ id }, { from }] = await Promise.all([params, searchParams]);
  const returnTo = from === "dashboard" ? "dashboard" : from === "bookings" ? "bookings" : "schedule";
  return <SeriesWorkspace seriesId={id} returnTo={returnTo} />;
}
