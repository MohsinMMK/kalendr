"use client";

import { Building2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { OptionSelect } from "@/components/form-fields";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Frame, FramePanel } from "@/components/ui/frame";
import { ExpandingSearch } from "@/components/expanding-search";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MobilePager } from "@/features/clinic/grid-pager";
import type { AdminTenantRow } from "@/lib/admin-contracts";

import { useTenantList } from "./admin-api";
import { formatDate, planLabel, relativeTime, setupStageLabels } from "./admin-format";
import { EmptyPanel, ErrorPanel, LoadingRows, ScreenHeader } from "./screen-states";
import { SignupsPanel } from "./signups-chart";

const statusOptions = [
  { value: "all", label: "All businesses" },
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
];

export function StatusCell({ row }: { row: Pick<AdminTenantRow, "isActive" | "pausedAt"> }) {
  return row.pausedAt || !row.isActive
    ? <StatusBadge tone="attention">Paused</StatusBadge>
    : <StatusBadge tone="success">Active</StatusBadge>;
}

function PlanBadge({ row }: { row: AdminTenantRow }) {
  return row.planKey ? <Badge variant="outline" size="lg">{planLabel(row.planKey)}</Badge> : null;
}

function BusinessName({ row }: { row: AdminTenantRow }) {
  return (
    <Link href={`/admin/tenants/${encodeURIComponent(row.tenantId)}`} className="font-medium underline-offset-4 hover:underline focus-visible:underline">
      {row.name}
    </Link>
  );
}

function BusinessesTable({ items }: { items: AdminTenantRow[] }) {
  return (
    <>
      <Table className="max-md:hidden" aria-label="Businesses">
        <TableHeader>
          <TableRow>
            <TableHead>Business</TableHead>
            <TableHead>Plan</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Staff</TableHead>
            <TableHead>Set-up</TableHead>
            <TableHead>Signed up</TableHead>
            <TableHead>Last active</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((row) => (
            <TableRow key={row.tenantId}>
              <TableCell><BusinessName row={row} /><p className="text-xs text-muted-foreground">{row.slug}</p></TableCell>
              <TableCell><PlanBadge row={row} /></TableCell>
              <TableCell><StatusCell row={row} /></TableCell>
              <TableCell className="text-right tabular-nums">{row.staffCount}</TableCell>
              <TableCell>{setupStageLabels[row.setupStage]}</TableCell>
              <TableCell>{formatDate(row.createdAt)}</TableCell>
              <TableCell>{relativeTime(row.lastActiveAt)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ul className="flex flex-col divide-y md:hidden" aria-label="Businesses">
        {items.map((row) => (
          <li key={row.tenantId} className="flex flex-col gap-2 py-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0"><BusinessName row={row} /><p className="truncate text-xs text-muted-foreground">{row.slug}</p></div>
              <StatusCell row={row} />
            </div>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <PlanBadge row={row} />
              <span>{row.staffCount} staff</span>
              <span>{setupStageLabels[row.setupStage]}</span>
              <span>Signed up {formatDate(row.createdAt)}</span>
              <span>Active {relativeTime(row.lastActiveAt)}</span>
            </p>
          </li>
        ))}
      </ul>
    </>
  );
}

export function BusinessesScreen() {
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const query = useTenantList(search, status, page);

  // Wait for a pause in typing so each letter is not a request.
  useEffect(() => {
    const timer = setTimeout(() => { setSearch(typed.trim()); setPage(1); }, 300);
    return () => clearTimeout(timer);
  }, [typed]);

  const data = query.data;
  const pageCount = data ? Math.max(1, Math.ceil(data.total / Math.max(1, data.pageSize))) : 1;
  const filtered = search !== "" || status !== "all";

  return (
    <>
      <ScreenHeader title="Businesses" description="Every business on Kalendr. Open one to see how it is doing." />
      <SignupsPanel days={30} />
      <Frame>
        <FramePanel className="flex flex-col gap-4">
          <div className="flex items-center justify-end gap-2">
            <ExpandingSearch label="Search businesses" placeholder="Search by name or web address" value={typed} onValueChange={setTyped} />
            <OptionSelect aria-label="Show businesses" className="sm:w-48" value={status} options={statusOptions} onValueChange={(next) => { setStatus(next || "all"); setPage(1); }} />
          </div>
          {query.isPending ? <LoadingRows label="Loading businesses" rows={5} /> : null}
          {query.isError ? <ErrorPanel error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} /> : null}
          {data && data.items.length === 0 ? (
            <EmptyPanel icon={<Building2 aria-hidden="true" />} title={filtered ? "No business matches" : "No businesses yet"} description={filtered ? "Try a different name or clear the filter." : "Businesses appear here as soon as someone signs up."} />
          ) : null}
          {data && data.items.length > 0 ? <BusinessesTable items={data.items} /> : null}
          {data && data.total > 0 ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground tabular-nums">{data.total} {data.total === 1 ? "business" : "businesses"}</p>
              <MobilePager label="Businesses pages" page={page} pageCount={pageCount} onPage={setPage} />
            </div>
          ) : null}
        </FramePanel>
      </Frame>
    </>
  );
}
