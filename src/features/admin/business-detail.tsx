"use client";

import { ArrowLeft, Building2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ReactNode } from "react";

import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Skeleton } from "@/components/ui/skeleton";
import type { AdminTenantHealth } from "@/lib/admin-contracts";

import { useTenantHealth } from "./admin-api";
import { formatDate, formatDateTime, planLabel, relativeTime } from "./admin-format";
import { BillingActionsSlot } from "./billing-actions-slot";
import { BusinessActions } from "./business-actions";
import { ErrorPanel, errorText, ScreenHeader } from "./screen-states";
import { StatusCell } from "./businesses-screen";

function Stat({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border p-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="flex flex-col gap-1">
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
        {note ? <span className="text-xs text-muted-foreground">{note}</span> : null}
      </dd>
    </div>
  );
}

const channelNames: Record<string, string> = { whatsapp: "WhatsApp", sms: "SMS", email: "Email", push: "App alert" };

/** `whatsapp:delivered` keys, grouped as one line per channel. */
export function messagesByChannel(messages7d: Record<string, number>): { channel: string; total: number; statuses: [string, number][] }[] {
  const grouped = new Map<string, [string, number][]>();
  for (const [key, count] of Object.entries(messages7d)) {
    const [channel = "other", status = "unknown"] = key.split(":");
    grouped.set(channel, [...(grouped.get(channel) ?? []), [status, count]]);
  }
  return [...grouped.entries()].map(([channel, statuses]) => ({ channel, total: statuses.reduce((sum, [, count]) => sum + count, 0), statuses }));
}

function MessageHealth({ health }: { health: AdminTenantHealth }) {
  const channels = messagesByChannel(health.messages7d);
  return (
    <Frame>
      <FrameHeader>
        <FrameTitle>Messages in the last 7 days</FrameTitle>
        <FrameDescription>Counts only. To see why one message did not arrive, use Messages.</FrameDescription>
      </FrameHeader>
      <FramePanel>
        {channels.length === 0 ? <p className="text-sm text-muted-foreground">No messages were scheduled this week.</p> : (
          <ul className="flex flex-col divide-y">
            {channels.map((entry) => (
              <li key={entry.channel} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="font-medium">{channelNames[entry.channel] ?? entry.channel} <span className="font-normal text-muted-foreground tabular-nums">({entry.total})</span></span>
                <span className="flex flex-wrap gap-1.5">
                  {entry.statuses.map(([status, count]) => (
                    <Badge key={status} variant={status === "failed" || status === "dead_letter" ? "error" : status === "delivered" || status === "read" ? "success" : "secondary"} size="lg">{count} {status.replace(/_/g, " ")}</Badge>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </FramePanel>
    </Frame>
  );
}

function ErrorsPanel({ health }: { health: AdminTenantHealth }) {
  return (
    <Frame>
      <FrameHeader><FrameTitle>Recent errors</FrameTitle><FrameDescription>Error codes seen lately, with how often.</FrameDescription></FrameHeader>
      <FramePanel>
        {health.recentErrors.length === 0 ? <p className="text-sm text-muted-foreground">No recent errors.</p> : (
          <ul className="flex flex-col divide-y">
            {health.recentErrors.map((entry) => (
              <li key={entry.code} className="flex items-center justify-between gap-3 py-2 text-sm">
                <code className="min-w-0 truncate rounded bg-muted px-1.5 py-0.5 text-xs">{entry.code}</code>
                <span className="tabular-nums text-muted-foreground">{entry.count} {entry.count === 1 ? "time" : "times"}</span>
              </li>
            ))}
          </ul>
        )}
      </FramePanel>
    </Frame>
  );
}

function featureOn(value: unknown): boolean {
  return value === true || (typeof value === "object" && value !== null && "enabled" in value && value.enabled === true);
}

function FeaturesPanel({ health }: { health: AdminTenantHealth }) {
  const entries = Object.entries(health.features);
  return (
    <Frame>
      <FrameHeader><FrameTitle>Feature switches</FrameTitle><FrameDescription>The business&apos;s own switches. Read only here.</FrameDescription></FrameHeader>
      <FramePanel className="flex flex-col gap-3">
        {entries.length === 0 ? <p className="text-sm text-muted-foreground">No switches set. Defaults apply.</p> : (
          <ul className="flex flex-col divide-y">
            {entries.map(([key, value]) => (
              <li key={key} className="flex items-center justify-between gap-3 py-2 text-sm">
                <span>{key.replace(/[._-]+/g, " ")}</span>
                {featureOn(value) ? <StatusBadge tone="success">On</StatusBadge> : <StatusBadge tone="neutral">Off</StatusBadge>}
              </li>
            ))}
          </ul>
        )}
        <Button variant="outline" size="sm" className="self-start" render={<Link href="/admin/features" />}>Open the rollout layer</Button>
      </FramePanel>
    </Frame>
  );
}

function BillingBlock({ billing }: { billing: NonNullable<AdminTenantHealth["billing"]> }) {
  return (
    <Frame>
      <FrameHeader><FrameTitle>Billing</FrameTitle><FrameDescription>Plan and usage this period.</FrameDescription></FrameHeader>
      <FramePanel className="flex flex-col gap-3">
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-muted-foreground">Plan</dt><dd className="font-medium">{planLabel(billing.planKey) || "None"}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Status</dt><dd className="font-medium">{billing.status ? planLabel(billing.status) : "Unknown"}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Trial ends</dt><dd>{billing.trialEndsAt ? formatDate(billing.trialEndsAt) : "Not on a trial"}</dd></div>
          <div><dt className="text-xs text-muted-foreground">Period ends</dt><dd>{billing.currentPeriodEnd ? formatDate(billing.currentPeriodEnd) : "Not set"}</dd></div>
        </dl>
        {Object.keys(billing.usage).length ? (
          <ul className="flex flex-wrap gap-1.5">
            {Object.entries(billing.usage).map(([key, value]) => <li key={key}><Badge variant="outline" size="lg">{key.replace(/[._-]+/g, " ")}: {value}</Badge></li>)}
          </ul>
        ) : null}
      </FramePanel>
    </Frame>
  );
}

function DetailSkeleton() {
  return (
    <div role="status" aria-label="Loading business" className="flex flex-col gap-4">
      <Skeleton className="h-10 w-2/3" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((index) => <Skeleton key={index} className="h-24" />)}</div>
      <Skeleton className="h-40 w-full" />
    </div>
  );
}

export function BusinessDetail({ tenantId, onViewStarted }: { tenantId: string; onViewStarted?: () => void }) {
  const router = useRouter();
  // The session cookie is already set, so the business home renders as that business.
  const openBusinessHome = () => { router.push("/dashboard"); router.refresh(); };
  const query = useTenantHealth(tenantId);
  const health = query.data;
  return (
    <>
      <Link href="/admin" className="inline-flex min-h-11 items-center gap-1 self-start text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"><ArrowLeft aria-hidden="true" className="size-4" />All businesses</Link>
      {query.isPending ? <DetailSkeleton /> : null}
      {query.isError && !health ? <ErrorPanel error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} /> : null}
      {health ? (
        <>
          <ScreenHeader
            title={health.name}
            description={`${health.slug} · ${health.businessType} · signed up ${formatDate(health.createdAt)} · id ${health.tenantId}`}
            actions={<div className="flex min-w-0 flex-[1_1_16rem] items-center justify-end gap-3"><StatusCell row={health} /><BusinessActions health={health} onViewStarted={onViewStarted ?? openBusinessHome} /></div>}
          />
          {query.isError ? <p role="status" className="flex items-center gap-2 text-sm text-warning-foreground"><TriangleAlert aria-hidden="true" className="size-4" />Showing the last numbers we had. {errorText(query.error)}</p> : null}
          {health.pausedAt ? <p className="flex items-center gap-2 text-sm text-warning-foreground"><Building2 aria-hidden="true" className="size-4" />Paused since {formatDateTime(health.pausedAt)}. Public pages show a neutral notice.</p> : null}
          <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Health">
            <Stat label="Staff" value={health.staffCount} note={`Last active ${relativeTime(health.lastStaffActivityAt)}`} />
            <Stat label="Appointments, 30 days" value={health.appointments30d} />
            <Stat label="Messages, 7 days" value={Object.values(health.messages7d).reduce((sum, count) => sum + count, 0)} />
            <Stat label="Dead letters" value={health.deadLetters} note={health.deadLetters > 0 ? "Messages that gave up. See Worker." : "Nothing stuck."} />
          </dl>
          <div className="grid gap-4 lg:grid-cols-2">
            <MessageHealth health={health} />
            <ErrorsPanel health={health} />
            <FeaturesPanel health={health} />
            {health.billing ? <BillingBlock billing={health.billing} /> : null}
          </div>
          <BillingActionsSlot tenantId={health.tenantId} billing={health.billing} />
        </>
      ) : null}
    </>
  );
}
