"use client";

import { ShieldCheck } from "lucide-react";
import Link from "next/link";

import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import type { AdminAbuse } from "@/lib/admin-contracts";

import { useAbuse } from "./admin-api";
import { EmptyPanel, ErrorPanel, LoadingRows, ScreenHeader } from "./screen-states";

function Ranked({ title, description, empty, rows, unit }: { title: string; description: string; empty: string; rows: { tenantId: string; name: string; value: number }[]; unit: string }) {
  return (
    <Frame>
      <FrameHeader><FrameTitle>{title}</FrameTitle><FrameDescription>{description}</FrameDescription></FrameHeader>
      <FramePanel>
        {rows.length === 0 ? <EmptyPanel icon={<ShieldCheck aria-hidden="true" />} title="Nothing unusual" description={empty} /> : (
          <ul className="flex flex-col divide-y" aria-label={title}>
            {rows.map((row) => (
              <li key={row.tenantId} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <Link className="min-w-0 truncate font-medium underline-offset-4 hover:underline" href={`/admin/tenants/${encodeURIComponent(row.tenantId)}`}>{row.name}</Link>
                <span className="shrink-0 tabular-nums text-muted-foreground">{row.value} {unit}</span>
              </li>
            ))}
          </ul>
        )}
      </FramePanel>
    </Frame>
  );
}

export function AbuseView({ data }: { data: AdminAbuse }) {
  return (
    <>
      <div className="rounded-xl border p-4">
        <p className="text-xs text-muted-foreground">New businesses in the last 24 hours</p>
        <p className="text-2xl font-semibold tabular-nums">{data.newBusinesses24h}</p>
        {data.newBusinesses24h === 0 ? <p className="text-xs text-muted-foreground">No sign-ups today.</p> : null}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Ranked title="High message volume" description="Businesses that sent the most messages in the last 24 hours." empty="No business is sending an unusual amount." unit="messages" rows={data.highVolume.map((row) => ({ tenantId: row.tenantId, name: row.name, value: row.messages24h }))} />
        <Ranked title="Suppressed contacts" description="Businesses with the most customers who cannot be messaged." empty="No business has suppressed contacts." unit="suppressed" rows={data.suppressions.map((row) => ({ tenantId: row.tenantId, name: row.name, value: row.count }))} />
      </div>
    </>
  );
}

export function AbuseScreen() {
  const query = useAbuse();
  return (
    <>
      <ScreenHeader title="Abuse" description="Spot businesses with unusual volume and new sign-ups that need a look." />
      {query.isPending ? <LoadingRows label="Loading abuse overview" rows={3} /> : null}
      {query.isError ? <ErrorPanel error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} /> : null}
      {query.data ? <AbuseView data={query.data} /> : null}
    </>
  );
}
