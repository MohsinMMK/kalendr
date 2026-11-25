import { HydrationBoundary } from "@tanstack/react-query";
import type { Metadata } from "next";

import { BookingsWorkspace } from "@/features/clinic/bookings-workspace";
import { staffKeys } from "@/features/clinic/queries/keys";
import { asApiJson, prefetchStaffData } from "@/features/clinic/queries/prefetch";
import { bookingQueryFromParams, bookingQuerySchema, bookingQueryToParams } from "@/lib/bookings-list";
import { listBookings } from "@/server/bookings-list";
import { requirePageAccess } from "@/server/staff-page-guard";
import { currentStaffNavLabels } from "@/server/sidebar-labels";

export async function generateMetadata(): Promise<Metadata> {
  const labels = await currentStaffNavLabels();
  return {
    title: labels.bookings,
    description: "Every booking in one list: filter, save views and act on many at once.",
  };
}

export default async function BookingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await requirePageAccess("bookings");
  // The tab, filters and sort are read from the address by the screen itself. The plain address (upcoming,
  // no filters) is loaded with the page under the same key and query text the screen uses, so it opens filled.
  const plain = Object.keys(await searchParams).length === 0;
  const params = bookingQueryToParams({ tab: "upcoming" });
  const state = plain && !staff.preview
    ? await prefetchStaffData((client) => client.prefetchInfiniteQuery({
      queryKey: staffKeys.bookingList(params.toString()),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
      queryFn: async () => asApiJson(await listBookings(staff, bookingQuerySchema.parse(bookingQueryFromParams(params)))),
    }))
    : undefined;
  return <HydrationBoundary state={state}><BookingsWorkspace /></HydrationBoundary>;
}
