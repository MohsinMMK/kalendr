"use client";

import { Download, TriangleAlert } from "lucide-react";
import { parseAsString, useQueryStates } from "nuqs";
import { useMemo } from "react";

import { WorkspaceFrame, WorkspacePage } from "@/components/workspace-page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import { reportKeys, reportLabels, type ReportKey, type ReportParams } from "@/lib/reports";

import { useCatalogLookups } from "./clinic-catalog";
import { StaffApiError } from "./queries/http";
import { useExportReport, useReport, useReportExports } from "./queries/reports";
import { ChartCard, MetricCard, TableCard } from "./reports-parts";
import { presetRange, rangePresets, todayIn, type RangePreset } from "./reports-range";
import { useStaffAccess } from "./staff-access";

const parsers = {
  report: parseAsString.withDefault("overview"),
  range: parseAsString.withDefault("last30"),
  from: parseAsString,
  to: parseAsString,
  location: parseAsString,
  person: parseAsString,
};

function Filter({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: { value: string; label: string }[] }) {
  return (
    <Select items={options} value={value} onValueChange={(next) => onChange(String(next))}>
      <SelectTrigger size="sm" aria-label={label} className="min-h-11 min-w-36 sm:min-h-8"><SelectValue /></SelectTrigger>
      <SelectPopup>{options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectPopup>
    </Select>
  );
}

function Loading() {
  return <div role="status" aria-label="Loading the report" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Skeleton className="h-32" /><Skeleton className="h-32" /><Skeleton className="h-32" /><Skeleton className="h-32" /></div>;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** Reports (feature 26): one report at a time, for a range, a place and a person, each figure explained and checkable. */
export function ReportsWorkspace() {
  const t = useTerms();
  const access = useStaffAccess();
  const catalog = useCatalogLookups();
  const [url, setUrl] = useQueryStates(parsers, { history: "replace", clearOnDefault: true });
  const timeZone = catalog.clinic.timezone;
  const reports = reportKeys.filter((key) => key !== "revenue" || access.can("reports.revenue"));
  const report: ReportKey = reports.includes(url.report as ReportKey) ? (url.report as ReportKey) : "overview";
  const preset = (rangePresets.some((item) => item.id === url.range) ? url.range : "last30") as RangePreset;
  const today = useMemo(() => todayIn(timeZone), [timeZone]);
  const range = preset === "custom" && url.from && url.to ? { from: url.from, to: url.to } : presetRange(preset === "custom" ? "last30" : preset, today);
  const ownNumbersOnly = access.role === "practitioner";
  const params: ReportParams = { ...range, ...(url.location ? { locationId: url.location } : {}), ...(!ownNumbersOnly && url.person ? { practitionerId: url.person } : {}) };

  const query = useReport(report, params);
  const exports = useReportExports(access.can("reports.export"));
  const exporter = useExportReport();
  const invalidRange = range.from > range.to;

  const runExport = () => exporter.mutate({ report, params }, {
    onSuccess: (outcome) => {
      if (outcome.kind === "file") downloadBlob(outcome.blob, outcome.filename);
      else toastManager.add({ title: "Your export is being prepared", description: "Large ranges are built in the background. It appears under Ready exports in a moment.", type: "info" });
    },
    onError: (error) => toastManager.add({ title: "The export did not work", description: error instanceof Error ? error.message : "Try again.", type: "error" }),
  });

  const ready = (exports.data ?? []).filter((item) => item.status === "ready");
  const planBlocked = query.error instanceof StaffApiError && query.error.code === "plan_limit";
  const previewBlocked = query.error instanceof StaffApiError && query.error.code === "preview_only";

  return (
    <Tabs value={report} onValueChange={(next) => void setUrl({ report: String(next) })} className="gap-0">
    <WorkspacePage
      nav="reports"
      bar={access.can("reports.export") ? [{ id: "export", label: exporter.isPending ? "Preparing…" : "Export CSV", icon: <Download aria-hidden="true" />, variant: "outline", pinned: true, onSelect: runExport }] : []}
    >
      <WorkspaceFrame
        start={
          <TabsList variant="underline" aria-label="Reports">
            {reports.map((key) => <TabsTrigger key={key} value={key} className="min-h-11 shrink-0 sm:min-h-8">{reportLabels[key]}</TabsTrigger>)}
          </TabsList>
        }
        end={
          <div className="flex flex-wrap items-center justify-end gap-2" role="group" aria-label="Report filters">
        <Filter label="Dates" value={preset} onChange={(next) => void setUrl({ range: next, from: next === "custom" ? range.from : null, to: next === "custom" ? range.to : null })} options={rangePresets.map((item) => ({ value: item.id, label: item.label }))} />
        {preset === "custom" ? (
          <>
            <Input type="date" aria-label="From" className="min-h-11 w-40 sm:min-h-8" value={range.from} max={range.to} onChange={(event) => void setUrl({ from: event.target.value || null })} />
            <Input type="date" aria-label="To" className="min-h-11 w-40 sm:min-h-8" value={range.to} min={range.from} onChange={(event) => void setUrl({ to: event.target.value || null })} />
          </>
        ) : null}
        {catalog.locations.length > 1 ? <Filter label="Place" value={url.location ?? "all"} onChange={(next) => void setUrl({ location: next === "all" ? null : next })} options={[{ value: "all", label: "All places" }, ...catalog.locations.map((place) => ({ value: place.id, label: place.name }))]} /> : null}
        {!ownNumbersOnly ? <Filter label={t.Practitioner} value={url.person ?? "all"} onChange={(next) => void setUrl({ person: next === "all" ? null : next })} options={[{ value: "all", label: `All ${t.practitioners}` }, ...catalog.practitioners.map((person) => ({ value: person.id, label: person.name }))]} /> : null}
          </div>
        }
        panelClassName="gap-4"
      >
      {ready.length > 0 ? (
        <Alert variant="success"><AlertTitle>Ready exports</AlertTitle><AlertDescription className="flex flex-wrap gap-2">{ready.map((item) => <a key={item.id} className="min-h-11 content-center font-medium underline underline-offset-4 sm:min-h-6" href={`/api/staff/reports/export/${item.id}`} download>{item.filename ?? `${reportLabels[item.report]} CSV`}</a>)}</AlertDescription></Alert>
      ) : null}

      {invalidRange ? <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertTitle>Check the dates</AlertTitle><AlertDescription>The start is after the end.</AlertDescription></Alert> : query.isPending ? <Loading /> : query.isError ? (
        planBlocked || previewBlocked ? (
          <Empty><EmptyHeader><EmptyTitle>{planBlocked ? "Reports are on a higher plan" : "Reports need real bookings"}</EmptyTitle><EmptyDescription>{query.error.message}</EmptyDescription></EmptyHeader></Empty>
        ) : (
          <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertTitle>The report could not be loaded</AlertTitle><AlertDescription><p>{query.error.message}</p><Button size="sm" variant="outline" className="mt-2 min-h-11 sm:min-h-8" onClick={() => void query.refetch()}>Try again</Button></AlertDescription></Alert>
        )
      ) : (
        <div className="flex min-w-0 flex-col gap-4" aria-busy={query.isFetching}>
          {query.data.scopedToPerson && !ownNumbersOnly ? <p className="text-muted-foreground text-sm">Showing one {t.practitioner}&apos;s numbers.</p> : null}
          {query.data.metrics.length > 0 ? <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{query.data.metrics.map((metric) => <MetricCard key={metric.key} metric={metric} currency={query.data.currency} />)}</div> : null}
          {query.data.charts.length > 0 ? <div className="grid gap-4 xl:grid-cols-2">{query.data.charts.map((chart) => <ChartCard key={chart.key} chart={chart} currency={query.data.currency} />)}</div> : null}
          {query.data.tables.length > 0 ? <div className="grid gap-4 xl:grid-cols-2">{query.data.tables.map((table) => <TableCard key={table.key} table={table} currency={query.data.currency} />)}</div> : null}
          {query.data.metrics.length > 0 && query.data.metrics.every((metric) => !metric.value) && query.data.charts.length === 0 && query.data.tables.length === 0 ? <Empty><EmptyHeader><EmptyTitle>Nothing in this period</EmptyTitle><EmptyDescription>Try a longer range, or a different place or person.</EmptyDescription></EmptyHeader></Empty> : null}
        </div>
      )}
      <p className="text-muted-foreground text-xs">Days follow the business&apos;s own clock: {timeZone}.</p>
      </WorkspaceFrame>
    </WorkspacePage>
    </Tabs>
  );
}
