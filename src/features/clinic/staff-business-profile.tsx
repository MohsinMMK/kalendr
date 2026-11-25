"use client";

import { useMemo, useSyncExternalStore, type ReactNode } from "react";

import { getPreviewBusinessClinic, getServerPreviewBusinessClinic, subscribePreviewBusiness } from "@/lib/preview-business-profile";
import { resolveBusinessProfile } from "@/lib/terminology";

import { BusinessProfileProvider } from "../terms/business-profile-context";
import { useOptionalStaffSnapshot } from "./staff-snapshot-provider";

/** The staff screens' words: from the loaded snapshot, or from the preview choice when there is no database. */
export function StaffBusinessProfile({ children }: { children: ReactNode }) {
  const staff = useOptionalStaffSnapshot();
  const previewClinic = useSyncExternalStore(subscribePreviewBusiness, getPreviewBusinessClinic, getServerPreviewBusinessClinic);
  const snapshotProfile = staff?.snapshot?.catalog.profile;
  const profile = useMemo(
    () => snapshotProfile ?? (staff ? null : resolveBusinessProfile(previewClinic)),
    [previewClinic, snapshotProfile, staff],
  );
  return <BusinessProfileProvider profile={profile}>{children}</BusinessProfileProvider>;
}
