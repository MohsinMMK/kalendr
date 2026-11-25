"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { CloudOff, Info, TriangleAlert } from "lucide-react";

import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Frame, FrameHeader, FramePanel } from "@/components/ui/frame";
import { Skeleton } from "@/components/ui/skeleton";
import { useBusinessProfile, useTerms } from "@/features/terms/business-profile-context";
import { isClinicalBusinessType } from "@/lib/business-types";
import { nextSetupLabel } from "@/lib/clinic-setup";

import { ScheduleSkeleton } from "./schedule-skeleton";
import { useStaffAccess } from "./staff-access";
import { useStaffSnapshot } from "./staff-snapshot-provider";

const bannerClass = "rounded-none border-x-0 border-t-0";

export function WorkspaceStatus({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { snapshot, loading, error, refresh } = useStaffSnapshot();
  const access = useStaffAccess();
  const t = useTerms();
  const clinical = isClinicalBusinessType(useBusinessProfile().businessType);
  if (loading && !snapshot && pathname === "/schedule") return <ScheduleSkeleton label={`Loading the schedule for this ${t.business}.`} />;
  if (loading && !snapshot) {
    return (
      <div role="status" className="flex flex-col gap-4 p-4 md:p-6">
        <span className="sr-only">Loading {t.business} data. Fetching the current schedule for this {t.business}.</span>
        <div aria-hidden="true" className="flex flex-col gap-2">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <div aria-hidden="true" className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <Frame>
            <FrameHeader className="px-3 py-2"><Skeleton className="h-5 w-32" /></FrameHeader>
            <FramePanel className="flex flex-col gap-3 p-4">
              {Array.from({ length: 5 }, (_, index) => (
                <div key={index} className="flex items-center gap-3">
                  <Skeleton className="size-8 shrink-0 rounded-full" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <Skeleton className="h-4 w-40 max-w-full" />
                    <Skeleton className="h-3 w-56 max-w-full" />
                  </div>
                </div>
              ))}
            </FramePanel>
          </Frame>
          <Frame className="max-lg:hidden">
            <FrameHeader className="px-3 py-2"><Skeleton className="h-5 w-24" /></FrameHeader>
            <FramePanel className="flex flex-col gap-3 p-4">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-5/6" />
            </FramePanel>
          </Frame>
        </div>
      </div>
    );
  }
  if (!snapshot) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><CloudOff aria-hidden="true" /></EmptyMedia>
          <EmptyTitle role="heading" aria-level={1}>{t.Business} data unavailable</EmptyTitle>
          <EmptyDescription role="alert">{error || `The ${t.business} workspace could not be loaded.`}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button loading={loading} onClick={() => void refresh()}>Try again</Button>
        </EmptyContent>
      </Empty>
    );
  }
  const truncated = snapshot.limits.appointmentsTruncated || snapshot.limits.patientsTruncated
    || snapshot.limits.waitlistTruncated || snapshot.limits.recallsTruncated;
  const showSetup = access.can("settings.manage") && !snapshot.setup.complete && pathname !== "/setup";
  return (
    <>
      {showSetup ? (
        <Alert role="note" variant="info" className={bannerClass}>
          <Info aria-hidden="true" />
          <AlertDescription>{nextSetupLabel(snapshot.setup.missing, t, clinical)}.</AlertDescription>
          <AlertAction>
            <Button size="sm" variant="outline" render={<Link href="/setup" />}>{clinical ? `Finish ${t.business} setup` : "Finish setup"}</Button>
          </AlertAction>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="warning" className={bannerClass}>
          <TriangleAlert aria-hidden="true" />
          <AlertDescription>{error} Showing the last loaded {t.business} data.</AlertDescription>
          <AlertAction>
            <Button size="sm" variant="outline" loading={loading} onClick={() => void refresh()}>Try again</Button>
          </AlertAction>
        </Alert>
      ) : null}
      {truncated ? (
        <Alert role="note" className={bannerClass}>
          <Info aria-hidden="true" />
          <AlertDescription>
            Showing {t.appointments} from {snapshot.limits.appointmentWindow}. Search {t.customers} to find records outside this window.
          </AlertDescription>
        </Alert>
      ) : null}
      {children}
    </>
  );
}
