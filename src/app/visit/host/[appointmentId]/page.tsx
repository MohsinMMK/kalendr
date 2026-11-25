import type { Metadata } from "next";

import { StaffVisit } from "@/features/video/staff-visit";
import { BusinessProfileProvider } from "@/features/terms/business-profile-context";
import { currentStaffBusinessProfile } from "@/server/business-profile";
import { requireStaffPageContext } from "@/server/staff-context";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Video visit",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/** Where staff open a video visit: see who is waiting, let them in, start the call. */
export default async function HostVisitPage({ params }: { params: Promise<{ appointmentId: string }> }) {
  await requireStaffPageContext();
  const [{ appointmentId }, profile] = await Promise.all([params, currentStaffBusinessProfile()]);
  return (
    <BusinessProfileProvider profile={profile}>
      <StaffVisit appointmentId={appointmentId} />
    </BusinessProfileProvider>
  );
}
