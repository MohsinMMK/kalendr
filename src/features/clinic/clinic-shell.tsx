import type { DehydratedState } from "@tanstack/react-query";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { findOwnStaffPhotoUrl } from "@/server/media";
import { listOwnBusinesses } from "@/server/staff-businesses";
import { listMyInvites } from "@/server/staff-login-invites";
import { requireStaffPageContext, type StaffContext } from "@/server/staff-context";
import { getStaffSnapshot } from "@/server/staff-repository";
import { findOwnJobTitle, findOwnPractitionerId } from "@/server/staff-team";
import { loadWorkspaceLayout } from "@/server/workspace-layout";

import { ClinicFrame } from "./clinic-frame";
import { staffKeys } from "./queries/keys";
import { asApiJson, prefetchStaffData } from "./queries/prefetch";
import type { ViewportGuess } from "./staff-viewport";
import { parseTheme, themeCookie } from "./theme-choice";

/** Phone or desktop, from the browser's own hint when it sends one, otherwise its user agent (the usual "Mobi" test). */
function viewportGuess(requestHeaders: Headers): ViewportGuess {
  const hint = requestHeaders.get("sec-ch-ua-mobile");
  if (hint) return hint === "?1" ? "phone" : "desktop";
  return /Mobi/i.test(requestHeaders.get("user-agent") ?? "") ? "phone" : "desktop";
}

/** The staff snapshot, which every staff screen reads, loaded with the page. Preview mode has no database snapshot. */
async function prefetchSnapshot(staff: StaffContext): Promise<DehydratedState | undefined> {
  if (staff.preview) return undefined;
  return prefetchStaffData((client) => client.prefetchQuery({ queryKey: staffKeys.snapshot(), queryFn: async () => asApiJson(await getStaffSnapshot(staff)) }));
}

/** The staff frame with the signed-in person's business, permissions and saved layout. Rendered once by the staff layout. */
export async function ClinicShell({ children }: { children: ReactNode }) {
  const staff = await requireStaffPageContext();
  const [cookieStore, requestHeaders, layout, prefetched, ownPractitionerId, jobTitle] = await Promise.all([
    cookies(), headers(), loadWorkspaceLayout(staff), prefetchSnapshot(staff), findOwnPractitionerId(staff), findOwnJobTitle(staff),
  ]);
  // A practitioner login sees only its own profile's visits, so without a linked profile there is nothing to show.
  if (staff.role === "practitioner" && !staff.preview && !ownPractitionerId) redirect("/access-denied?reason=no_profile");
  // A booking profile's photo is the person's photo; only people without one use their own staff photo.
  const ownPhotoUrl = ownPractitionerId ? null : await findOwnStaffPhotoUrl(staff);
  // Every business this login works in, for the switcher; one login, one list. Only when the person has two or more is anything shown.
  // Invites from other businesses waiting for this login's answer; a support session is the operator's, who never has any.
  const ownLogin = !staff.preview && staff.userId && !staff.impersonation ? staff.userId : null;
  const [businesses, invites] = ownLogin ? await Promise.all([listOwnBusinesses(ownLogin, null, staff.clinicSlug), listMyInvites(ownLogin)]) : [[], []];
  return (
    <ClinicFrame
      clinicName={staff.clinicName}
      clinicSlug={staff.clinicSlug}
      userName={staff.userName}
      userEmail={staff.userEmail}
      role={staff.role}
      permissions={staff.permissions}
      userId={staff.userId}
      jobTitle={jobTitle}
      ownPractitionerId={ownPractitionerId}
      ownPhotoUrl={ownPhotoUrl}
      businesses={businesses}
      invites={invites}
      preview={staff.preview}
      sidebarOpen={cookieStore.get("sidebar_state")?.value !== "false"}
      layout={layout}
      initialTheme={parseTheme(cookieStore.get(themeCookie)?.value)}
      impersonation={staff.impersonation}
      prefetched={prefetched}
      viewport={viewportGuess(requestHeaders)}
    >
      {children}
    </ClinicFrame>
  );
}
