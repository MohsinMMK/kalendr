"use client";

import { CalendarCheck, CalendarX, ClipboardCheck, Database, History, TriangleAlert } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { toastManager } from "@/components/ui/toast";
import { WorkspaceFrame, WorkspacePage } from "@/components/workspace-page";
import { useTerms } from "@/features/terms/business-profile-context";
import { BULK_MAX, type BookingTab, bookingQueryToParams, defaultSortFor, type WorkspaceTab, workspaceTabLabels, workspaceTabs } from "@/lib/bookings-list";

import { useNarrowerThan } from "./staff-viewport";
import { useBookingActions } from "./bookings-actions";
import { GridCustomizeProvider } from "@/components/reui/data-grid/data-grid-customize";
import { type BookingColumn, bookingColumns } from "@/lib/bookings-list";

import { bookingColumnSpecs, columnLabels } from "./bookings-columns";
import { GridColumnsMenu } from "./grid-columns-menu";
import { customizeFor, useGridColumns } from "./use-grid-columns";
import { cleanViewColumns, withViewColumns } from "./view-columns";
import { useBookingList, useRefreshBookings, useSavedViews } from "./bookings-data";
import { BookingFilterMenu } from "./bookings-filter";
import { RepeatingTab } from "./bookings-series";
import { BookingsSkeleton, BookingsTable } from "./bookings-table";
import { activeFilterCount, clearFilterPatch, filtersFromUrl, queryFromUrl, useBookingsUrl, viewPatch } from "./bookings-url";
import { BookingViewsMenu } from "./bookings-views";
import { useCatalogLookups } from "./clinic-catalog";
import { useRefreshSeriesList, useSeriesList } from "./series-list-data";
import { ScrollArea } from "@/components/ui/scroll-area";

const noneSelected: ReadonlySet<string> = new Set();

/** Calm words for an empty tab, with what to do next. */
function emptyCopy(tab: BookingTab, filtered: boolean, t: ReturnType<typeof useTerms>): { icon: ReactNode; title: string; description: string } {
  if (filtered) return { icon: <ClipboardCheck aria-hidden="true" />, title: `No ${t.appointments} match these filters`, description: "Try fewer filters, or clear them to see everything." };
  switch (tab) {
    case "needs_approval": return { icon: <CalendarCheck aria-hidden="true" />, title: "Nothing is waiting for you", description: `When a ${t.customer} asks for a ${t.appointment} that needs approval, it shows up here.` };
    case "past": return { icon: <History aria-hidden="true" />, title: `No past ${t.appointments} yet`, description: `${t.Appointments} that have happened are listed here.` };
    case "cancelled": return { icon: <CalendarX aria-hidden="true" />, title: `No cancelled ${t.appointments}`, description: "Cancellations will appear here, with who cancelled." };
    default: return { icon: <CalendarCheck aria-hidden="true" />, title: `No upcoming ${t.appointments}`, description: `New ${t.appointments} appear here as soon as they are booked.` };
  }
}

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

/**
 * Every booking in one list: four tabs with counts, one Filter menu, saved views, columns you choose, and
 * actions on one booking or up to 100 at once. The tab, filters and sort are in the address, so a link shows the same list.
 */
export function BookingsWorkspace() {
  const t = useTerms();
  const catalog = useCatalogLookups();
  const phone = useNarrowerThan("sm");
  const [url, setUrl] = useBookingsUrl();
  const database = catalog.database;
  const [filterOpen, setFilterOpen] = useState(false);

  const query = queryFromUrl(url);
  const tab = query.tab;
  const repeating = tab === "repeating";
  // The booking tabs share one query; the Repeating tab lists series with its own (feature 17).
  const bookingTab: BookingTab = repeating ? "upcoming" : tab;
  const filter = filtersFromUrl(url);
  const filterCount = activeFilterCount(filter, tab);
  const sort = url.sort ?? defaultSortFor(tab);
  const list = useBookingList({ ...query, tab: bookingTab }, database && !repeating);
  const series = useSeriesList(filter, sort, database && repeating);
  const refreshSeries = useRefreshSeriesList();
  const refresh = useRefreshBookings();
  const views = useSavedViews(database);
  // The columns are the business's own arrangement (names, order, which show), the same for everyone on the team.
  const defaultLabels = useMemo(() => columnLabels(t), [t]);
  const specs = useMemo(() => bookingColumnSpecs(defaultLabels), [defaultLabels]);
  const businessGrid = useGridColumns("bookings", specs);
  // A saved view brings back the columns it was saved with (held in the address); without one, the business's own.
  const viewColumns = useMemo(() => cleanViewColumns(url.columns, bookingColumns), [url.columns]);
  const grid = useMemo(() => withViewColumns(businessGrid, viewColumns, (next) => void setUrl({ columns: next }, { history: "replace" })), [businessGrid, viewColumns, setUrl]);
  const columns = useMemo(() => grid.visible.map((column) => column.id as BookingColumn), [grid.visible]);
  const labels = useMemo(() => Object.fromEntries(grid.all.map((column) => [column.id, column.title])) as Record<BookingColumn, string>, [grid.all]);
  const customize = customizeFor(grid, {
    isSystem: (id) => Boolean(specs.find((spec) => spec.id === id)?.system),
    canFilter: (id) => id !== "price" && bookingColumns.includes(id as BookingColumn),
    filter: () => setFilterOpen(true),
  });

  // A selection belongs to the list it was made on, so it clears when the tab or filters change.
  const listKey = bookingQueryToParams({ ...query, tab: bookingTab }).toString() + (repeating ? "#repeating" : "");
  const [selection, setSelection] = useState<{ key: string; ids: ReadonlySet<string> }>({ key: listKey, ids: noneSelected });
  const selected = selection.key === listKey ? selection.ids : noneSelected;
  const setSelected = (ids: ReadonlySet<string>) => setSelection({ key: listKey, ids });

  const people = useMemo(() => catalog.practitioners.filter((item) => item.isActive !== false).map((item) => ({ value: item.id, label: item.name })), [catalog.practitioners]);
  const services = useMemo(() => catalog.services.map((item) => ({ value: item.id, label: item.name })), [catalog.services]);
  const branches = useMemo(() => catalog.locations.map((item) => ({ value: item.id, label: item.name })), [catalog.locations]);

  const actions = useBookingActions({ rows: list.rows, tab: bookingTab, selected, setSelected, people, refresh });
  const selectable = actions.canChange && !repeating;

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else if (next.size >= BULK_MAX) { toastManager.add({ title: `You can choose up to ${BULK_MAX} at a time`, description: "Do these first, then choose more.", type: "warning" }); return; }
    else next.add(id);
    setSelected(next);
  }
  function toggleAll(ids: string[], on: boolean) {
    if (!on) { setSelected(new Set([...selected].filter((id) => !ids.includes(id)))); return; }
    const next = new Set([...selected, ...ids].slice(0, BULK_MAX));
    if (ids.length + selected.size > BULK_MAX && next.size === BULK_MAX) toastManager.add({ title: `Chose the first ${BULK_MAX}`, description: `${BULK_MAX} is the most you can change at once.`, type: "warning" });
    setSelected(next);
  }

  const previewMessage = !database || list.previewOnly;
  const counts = repeating ? series.counts : list.counts;
  const repeatingCount = repeating ? series.repeatingCount : list.repeatingCount;
  let body: ReactNode;
  if (repeating) {
    body = <RepeatingTab series={series} filtered={filterCount > 0} phone={phone} sort={sort} database={database} onSort={() => { void setUrl({ sort: sort === "asc" ? "desc" : null }); }} onClear={() => void setUrl(clearFilterPatch)} onChanged={refreshSeries} />;
  } else if (previewMessage) {
    body = <Notice icon={<Database aria-hidden="true" />} title="Bookings need the database" description="This screen is not available in the preview. Everything on it comes from your saved bookings." />;
  } else if (list.loading) {
    body = <BookingsSkeleton phone={phone} />;
  } else if (list.error) {
    body = <Notice icon={<TriangleAlert aria-hidden="true" />} title="Bookings could not be loaded" description={list.error}><Button onClick={() => void list.refetch()}>Try again</Button></Notice>;
  } else if (list.rows.length === 0) {
    const copy = emptyCopy(bookingTab, filterCount > 0, t);
    body = <Notice icon={copy.icon} title={copy.title} description={copy.description}>{filterCount > 0 ? <Button variant="outline" onClick={() => void setUrl(clearFilterPatch)}>Clear filters</Button> : null}</Notice>;
  } else {
    const table = <BookingsTable rows={list.rows} columns={columns} labels={labels} selected={selected} selectable={selectable} sort={sort} busy={list.stale || list.refreshing} phone={phone}
      onSort={() => { const next = sort === "asc" ? "desc" : "asc"; void setUrl({ sort: next === defaultSortFor(bookingTab) ? null : next }); }} onToggle={toggle} onToggleAll={toggleAll} menuFor={actions.menuFor} />;
    body = (
      <>
        {phone ? <ScrollArea className="min-h-0 flex-1">{table}</ScrollArea> : table}
        {actions.bar}
        {list.hasMore ? (
          <div className="flex items-center justify-center border-t px-3 py-2">
            <Button size="sm" variant="outline" loading={list.loadingMore} onClick={list.loadMore}>Load more</Button>
          </div>
        ) : null}
      </>
    );
  }

  return (
    <GridCustomizeProvider value={customize}>
    <WorkspacePage nav="bookings" fit="screen">
      <Tabs value={tab} onValueChange={(next) => void setUrl({ tab: next === "upcoming" ? null : (next as WorkspaceTab), sort: null })} className="min-h-0 flex-1 gap-0">
        <WorkspaceFrame
          flush
          panelClassName="overflow-hidden"
          start={
            <TabsList variant="underline" aria-label="Booking lists">
              {workspaceTabs.map((item) => (
                <TabsTab key={item} value={item} className="pointer-coarse:min-h-11">{workspaceTabLabels[item]}{counts ? <Badge variant="outline" className="tabular-nums">{item === "repeating" ? (repeatingCount ?? 0) : counts[item]}</Badge> : null}</TabsTab>
              ))}
            </TabsList>
          }
          end={
            <>
              <BookingFilterMenu filter={filter} tab={tab} people={people} services={services} branches={branches} timeZone={catalog.clinic.timezone} terms={t}
                open={filterOpen} onOpenChange={setFilterOpen}
                onChange={(patch) => void setUrl(patch, { history: "replace" })} onClear={() => void setUrl(clearFilterPatch)} />
              <BookingViewsMenu views={views.views} loading={views.loading} failed={views.failed} canSave={database && !previewMessage}
                current={{ tab, filters: filter, sort, columns }} onApply={(view) => { void setUrl(viewPatch(view)); }} onChanged={() => void views.refresh()} />
              {phone || repeating ? null : <GridColumnsMenu columns={grid} />}
            </>
          }
        >
          <TabsPanel value={tab} className="flex min-h-0 flex-1 flex-col overflow-hidden">{body}</TabsPanel>
        </WorkspaceFrame>
      </Tabs>
      {actions.dialogs}
    </WorkspacePage>
    </GridCustomizeProvider>
  );
}
