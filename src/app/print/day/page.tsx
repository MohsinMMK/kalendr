import type { Metadata } from "next";

import { PrintDay } from "@/features/clinic/print-day";
import { isClinicDateKey } from "@/features/clinic/schedule-availability";
import { requireStaffPageContext } from "@/server/staff-context";

export const metadata: Metadata = {
  title: "Day sheet",
  // A sheet of customers' names and numbers is for the front desk's printer, not for a search engine.
  robots: { index: false, follow: false },
};

export default async function PrintDayPage({ searchParams }: { searchParams: Promise<{ date?: string; location?: string }> }) {
  const [staff, { date, location }] = await Promise.all([requireStaffPageContext(), searchParams]);
  return <PrintDay
    clinicSlug={staff.clinicSlug}
    clinicName={staff.clinicName}
    role={staff.role}
    userId={staff.userId}
    preview={staff.preview}
    permissions={staff.permissions}
    initialDate={date && isClinicDateKey(date) ? date : ""}
    initialLocation={location ?? ""}
  />;
}
