import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { SetupWorkspace } from "@/features/clinic/setup-workspace";
import { StaffQueryProvider } from "@/features/clinic/queries/client";
import { StaffBusinessProfile } from "@/features/clinic/staff-business-profile";
import { StaffSnapshotProvider } from "@/features/clinic/staff-snapshot-provider";
import { can, requireStaffPageContext } from "@/server/staff-context";

export const metadata: Metadata = {
  title: "Setup",
  description: "Add what people can book, who takes the bookings, and your hours.",
};

export default async function SetupPage() {
  const staff = await requireStaffPageContext();
  if (!can(staff, "settings.manage")) redirect("/dashboard");
  if (staff.preview) return <StaffBusinessProfile><SetupWorkspace preview /></StaffBusinessProfile>;
  return (
    <StaffQueryProvider scope={`${staff.clinicSlug}:${staff.userId ?? "preview"}`}>
      <StaffSnapshotProvider role={staff.role}>
        <StaffBusinessProfile>
          <SetupWorkspace />
        </StaffBusinessProfile>
      </StaffSnapshotProvider>
    </StaffQueryProvider>
  );
}
