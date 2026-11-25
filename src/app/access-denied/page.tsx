import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { ShieldAlert } from "lucide-react";

import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Button } from "@/components/ui/button";
import { Frame, FramePanel } from "@/components/ui/frame";
import { BusinessPicker } from "@/features/clinic/business-switcher";
import { PendingInvites } from "@/features/clinic/pending-invites";
import { StaffSignOut } from "@/features/clinic/staff-auth-controls";
import { currentStaffWords } from "@/server/business-profile";
import { otherBusinessesFor, requireSessionUserId } from "@/server/staff-businesses";
import { listMyInvites, type MyInvite } from "@/server/staff-login-invites";

export async function generateMetadata(): Promise<Metadata> {
  const t = await currentStaffWords();
  return { title: `${t.Business} access unavailable`, robots: { index: false, follow: false } };
}

/** Invites from other businesses waiting for the signed-in login's answer; none when nobody is signed in. */
async function myInvites(requestHeaders: Headers): Promise<MyInvite[]> {
  try {
    return await listMyInvites(await requireSessionUserId(requestHeaders));
  } catch {
    return [];
  }
}

export default async function AccessDeniedPage({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const requestHeaders = await headers();
  const [t, { reason }, otherBusinesses, invites] = await Promise.all([currentStaffWords(), searchParams, otherBusinessesFor(requestHeaders), myInvites(requestHeaders)]);
  // A practitioner login whose booking profile is not linked: signed in and a member, but with no own visits to show.
  const noProfile = reason === "no_profile";
  // A signed-in member who opened a screen their role doesn't include: they have access to the business, just not to this page.
  const noPermission = reason === "permission";
  return (
    <main className="grid flex-1 place-items-center bg-background p-4">
      <Frame className="w-full max-w-lg">
        <FramePanel className="p-0">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ShieldAlert aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>
                <h1>{noProfile ? `Your ${t.practitioner} profile isn't linked yet` : noPermission ? "You don't have access to this page" : `${t.Business} access unavailable`}</h1>
              </EmptyTitle>
              <EmptyDescription>
                {noPermission
                  ? `Your role doesn't include this page. Ask the owner or an admin if you need it.`
                  : noProfile
                  ? `This login can only show your own ${t.visits} and ${t.customers}, and no ${t.practitioner} profile is linked to it. Ask the owner or an admin to link your login to your profile, or sign out and use another account.`
                  : `This account has no active ${t.business} membership. Ask ${t.aBusiness} administrator to grant access, or sign out and use another account.`}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <PendingInvites invites={invites} className="flex w-full flex-col gap-2 text-start" />
              {otherBusinesses.length > 0 ? <BusinessPicker businesses={otherBusinesses} /> : null}
              {noPermission ? <Button render={<Link href="/dashboard" />}>Back to the dashboard</Button> : null}
              <StaffSignOut />
            </EmptyContent>
          </Empty>
        </FramePanel>
      </Frame>
    </main>
  );
}
