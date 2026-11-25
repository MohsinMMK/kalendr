import type { Metadata } from "next";

import { ProfileWorkspace } from "@/features/clinic/profile-workspace";
import { findOwnStaffPhotoUrl } from "@/server/media";
import { requireStaffPageContext } from "@/server/staff-context";
import { findOwnJobTitle, findOwnPractitionerId } from "@/server/staff-team";
import { currentStaffNavLabels } from "@/server/sidebar-labels";

export async function generateMetadata(): Promise<Metadata> {
  const labels = await currentStaffNavLabels();
  return {
    title: labels.profile,
    description: "Your details, working hours and password.",
    robots: { index: false, follow: false },
  };
}

export default async function ProfilePage() {
  const staff = await requireStaffPageContext();
  const [practitionerId, jobTitle] = await Promise.all([findOwnPractitionerId(staff), findOwnJobTitle(staff)]);
  const ownPhotoUrl = practitionerId ? null : await findOwnStaffPhotoUrl(staff);
  return <ProfileWorkspace name={staff.userName} jobTitle={jobTitle} email={staff.userEmail} practitionerId={practitionerId} ownPhotoUrl={ownPhotoUrl} preview={staff.preview} />;
}
