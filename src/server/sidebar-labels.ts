import "server-only";

import { cache } from "react";

import { sidebarLabels, type SidebarEntryId } from "@/lib/sidebar";
import { defaultBusinessProfile, profileWords } from "@/lib/terminology";

import { currentStaffBusinessProfile } from "./business-profile";
import { currentStaffContext } from "./staff-context";
import { loadWorkspaceLayout } from "./workspace-layout";

/**
 * The sidebar's names for the signed-in person's business, for page titles on the server. Read once per request. When
 * nobody is signed in (or the layout cannot be read) it falls back to the standard names, so it never throws from
 * `generateMetadata`.
 */
export const currentStaffNavLabels = cache(async (): Promise<Record<SidebarEntryId, string>> => {
  try {
    const [profile, context] = await Promise.all([currentStaffBusinessProfile(), currentStaffContext()]);
    const layout = await loadWorkspaceLayout(context);
    return sidebarLabels(profileWords(profile), layout.pages.sidebar);
  } catch {
    return sidebarLabels(profileWords(defaultBusinessProfile), undefined);
  }
});
