"use client";

import { ArrowDown, ArrowUp, Database, Ellipsis, ExternalLink, Repeat, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type MouseEvent, type ReactNode, useState } from "react";

import { ActionMenuButton, type ActionMenuEntry } from "@/components/action-bar";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useTerms } from "@/features/terms/business-profile-context";
import { seriesStatusLabels } from "@/lib/bookings-list";
import type { SeriesListRow } from "@/lib/series-list";
import { appointmentLink } from "@/lib/staff-alerts";
import { cn } from "@/lib/utils";

import { SeriesScopeDialog } from "./series-scope";
import { useStaffAccess } from "./staff-access";
import type { useSeriesList } from "./series-list-data";
import { ScrollArea } from "@/components/ui/scroll-area";

type SeriesList = ReturnType<typeof useSeriesList>;

const seriesLink = (id: string) => `/appointments/series/${id}?from=bookings`;
const interactive = "a,button,[role='menuitem']";
const nextVisitText = (row: SeriesListRow) => row.nextVisit
  ? new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: row.timezone }).format(new Date(row.nextVisit.startsAt))
  : null;
const rowName = (row: SeriesListRow) => `${row.customer.name}, ${row.summary}`;

function Notice({ icon, title, description, children }: { icon: ReactNode; title: string; description?: string; children?: ReactNode }) {
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">{icon}</EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description ? <EmptyDescription>{description}</EmptyDescription> : null}
      </EmptyHeader>
      {children}
    </Empty>
  );
}

/** The loading state: rows the shape of the real ones. */
function SeriesSkeleton({ phone }: { phone: boolean }) {
  return (
    <div role="status" aria-label="Loading repeating series" className="flex flex-col gap-px p-3">
      {Array.from({ length: phone ? 5 : 8 }, (_, index) => <Skeleton key={index} className={phone ? "h-20 w-full" : "h-11 w-full"} />)}
    </div>
  );
}

function SeriesStatus({ row }: { row: SeriesListRow }) {
  return <StatusBadge tone={row.status === "active" ? "success" : "neutral"}>{seriesStatusLabels[row.status]}</StatusBadge>;
}

const progress = (row: SeriesListRow) => `${row.visitsDone} of ${row.visitsTotal}`;
const none = <span className="text-muted-foreground" aria-label="None">-</span>;

/**
 * The Repeating tab (feature 17): one row per repeating series with what it repeats, the next visit and how far along it is.
 * Opening a row shows every visit; Move and Cancel ask which visits to change, the same way a single visit of a series does.
 */
export function RepeatingTab({ series, filtered, phone, sort, database, onSort, onClear, onChanged }: {
  series: SeriesList;
  filtered: boolean;
  phone: boolean;
  sort: "asc" | "desc";
  database: boolean;
  onSort: () => void;
  onClear: () => void;
  onChanged: () => Promise<unknown> | void;
}) {
  const t = useTerms();
  const router = useRouter();
  const access = useStaffAccess();
  const canOpen = access.can("appointments.book");
  const canChange = access.can("series.manage");
  const [dialog, setDialog] = useState<{ row: SeriesListRow; action: "reschedule" | "cancel" } | null>(null);

  if (!database || series.previewOnly) {
    return <Notice icon={<Database aria-hidden="true" />} title="Repeating bookings need the database" description="This screen is not available in the preview. Everything on it comes from your saved bookings." />;
  }
  if (series.loading) return <SeriesSkeleton phone={phone} />;
  if (series.error) {
    return <Notice icon={<TriangleAlert aria-hidden="true" />} title="Repeating bookings could not be loaded" description={series.error}><Button onClick={() => void series.refetch()}>Try again</Button></Notice>;
  }
  if (series.rows.length === 0) {
    return filtered
      ? <Notice icon={<Repeat aria-hidden="true" />} title="No repeating series match these filters" description="Try fewer filters, or clear them to see every running series."><Button variant="outline" onClick={onClear}>Clear filters</Button></Notice>
      : <Notice icon={<Repeat aria-hidden="true" />} title={`No repeating ${t.appointments} yet`} description={`Book a ${t.appointment} and choose "Repeats" to set up weekly or monthly ${t.appointments} in one step. They are listed here.`} />;
  }

  const menuFor = (row: SeriesListRow): ActionMenuEntry[] => {
    const entries: ActionMenuEntry[] = [];
    if (canOpen) entries.push({ id: "open", label: `See every ${t.visit}`, icon: <ExternalLink aria-hidden="true" />, href: seriesLink(row.id) });
    if (canChange && row.status === "active" && row.nextVisit) {
      entries.push({ id: "move", label: "Move…", onSelect: () => setDialog({ row, action: "reschedule" }) }, { kind: "separator", id: "cancel-sep" }, { id: "cancel", label: "Cancel…", destructive: true, onSelect: () => setDialog({ row, action: "cancel" }) });
    }
    return entries;
  };
  const menu = (row: SeriesListRow) => {
    const entries = menuFor(row);
    // Whatever happens inside the menu (its sheet on a phone included) stays there: it must never open the row behind it.
    return entries.length === 0 ? null : <span onClick={(event) => event.stopPropagation()}><ActionMenuButton label={`Actions for ${rowName(row)}`} iconOnly variant="ghost" icon={<Ellipsis aria-hidden="true" />} items={entries} className="pointer-coarse:size-11" /></span>;
  };
  const open = (row: SeriesListRow) => (event: MouseEvent) => {
    // A menu or dialog opened from the row lives in a portal, but its clicks still reach the row through React: only clicks inside the row count.
    if (!(event.currentTarget as HTMLElement).contains(event.target as Node)) return;
    if (canOpen && !(event.target as HTMLElement).closest(interactive)) router.push(seriesLink(row.id));
  };
  const name = (row: SeriesListRow) => canOpen
    ? <Link href={seriesLink(row.id)} className="truncate font-medium outline-none hover:underline focus-visible:underline focus-visible:decoration-2">{row.customer.name}</Link>
    : <span className="truncate font-medium">{row.customer.name}</span>;
  const busy = series.stale || series.refreshing;
  const SortIcon = sort === "asc" ? ArrowUp : ArrowDown;

  const list = phone ? (
    <ScrollArea className="min-h-0 flex-1">
      <ul aria-label="Repeating series" aria-busy={busy} className={cn("flex flex-col", busy && "opacity-60")}>
        {series.rows.map((row) => (
          <li key={row.id} onClick={open(row)} className="flex items-start gap-1 border-b px-3 py-2">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-1">
              <span className="flex min-w-0">{name(row)}</span>
              <span className="text-sm">{row.summary}</span>
              <span className="truncate text-xs text-muted-foreground">{row.service.name} · {row.practitioner.name}</span>
              <span className="text-xs text-muted-foreground tabular-nums">{row.nextVisit ? `Next ${nextVisitText(row)}` : "Nothing ahead"} · {progress(row)} done</span>
              <span className="pt-1"><SeriesStatus row={row} /></span>
            </div>
            {menu(row)}
          </li>
        ))}
      </ul>
    </ScrollArea>
  ) : (
    <ScrollArea className="min-h-0 flex-1 [&_[data-slot=table-container]]:overflow-visible" clampContentMinWidth={false}>
      <Table aria-label="Repeating series" aria-busy={busy} className={cn(busy && "opacity-60")}>
        <TableHeader>
          <TableRow>
            <TableHead scope="col" className="sticky top-0 z-10 bg-background">{t.Customer}</TableHead>
            <TableHead scope="col" className="sticky top-0 z-10 bg-background">Repeats</TableHead>
            <TableHead scope="col" className="sticky top-0 z-10 bg-background">Service</TableHead>
            <TableHead scope="col" className="sticky top-0 z-10 bg-background">{t.Practitioner}</TableHead>
            <TableHead scope="col" className="sticky top-0 z-10 bg-background">
              <Button size="sm" variant="ghost" className="-ms-2" aria-label={`Next ${t.visit}, sorted ${sort === "asc" ? "soonest first" : "latest first"}. Change the order`} onClick={onSort}>Next {t.visit}<SortIcon aria-hidden="true" className="opacity-70" /></Button>
            </TableHead>
            <TableHead scope="col" className="sticky top-0 z-10 bg-background">Done</TableHead>
            <TableHead scope="col" className="sticky top-0 z-10 bg-background">Status</TableHead>
            <TableHead scope="col" className="sticky top-0 z-10 bg-background"><span className="sr-only">Actions</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {series.rows.map((row) => (
            <TableRow key={row.id} className={cn(canOpen && "cursor-pointer")} onClick={open(row)}>
              <TableCell><span className="flex max-w-56 min-w-0">{name(row)}</span></TableCell>
              <TableCell><span className="block max-w-72">{row.summary}</span></TableCell>
              <TableCell><span className="block max-w-48 truncate">{row.service.name}</span></TableCell>
              <TableCell><span className="block max-w-48 truncate">{row.practitioner.name}</span></TableCell>
              <TableCell className="whitespace-nowrap tabular-nums">{nextVisitText(row) ?? none}</TableCell>
              <TableCell className="whitespace-nowrap tabular-nums">{progress(row)}</TableCell>
              <TableCell><SeriesStatus row={row} /></TableCell>
              <TableCell className="w-12 text-end">{menu(row)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </ScrollArea>
  );

  return (
    <>
      {list}
      {series.hasMore ? (
        <div className="flex items-center justify-center border-t px-3 py-2">
          <Button size="sm" variant="outline" loading={series.loadingMore} onClick={series.loadMore}>Load more</Button>
        </div>
      ) : null}
      {dialog && dialog.row.nextVisit ? (
        <SeriesScopeDialog
          key={`${dialog.row.id}-${dialog.action}`}
          action={dialog.action}
          open
          appointment={{ id: dialog.row.nextVisit.appointmentId, startsAt: dialog.row.nextVisit.startsAt, seriesId: dialog.row.id, seriesIndex: dialog.row.nextVisit.index, practitionerId: dialog.row.practitioner.id, locationId: dialog.row.location.id, serviceId: dialog.row.service.id }}
          onOpenChange={(next) => { if (!next) setDialog(null); }}
          onThisOne={() => router.push(appointmentLink(dialog.row.nextVisit!.appointmentId))}
          onDone={async () => { await onChanged(); setDialog(null); }}
        />
      ) : null}
    </>
  );
}
