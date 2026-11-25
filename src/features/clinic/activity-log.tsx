"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Download, History, RefreshCw, ShieldX } from "lucide-react";

import { OptionSelect } from "@/components/form-fields";
import { PersonAvatar } from "@/components/person-avatar";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Frame, FrameDescription, FrameFooter, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { TogglePrimitive } from "@/components/ui/toggle";
import { ToggleGroupPrimitive } from "@/components/ui/toggle-group";
import { useFeatures, useTerms } from "@/features/terms/business-profile-context";
import { auditActionGroups } from "@/lib/enterprise-contracts";
import type { TermWords } from "@/lib/terminology";
import type { ActivityCategory, ActivityEntry, ActivityPage } from "@/server/staff-activity";

import { useCatalogLookups } from "./clinic-catalog";
import { StaffApiError } from "./queries/http";
import { staffQuery } from "./staff-snapshot-provider";
import { useStepUp } from "./step-up-dialog";
import { ScrollArea } from "@/components/ui/scroll-area";

function activityCategories(t: TermWords, records: boolean): { value: ActivityCategory; label: string }[] {
  return [
    { value: "all", label: "All" },
    { value: "team", label: "Team" },
    { value: "settings", label: "Settings" },
    { value: "visits", label: t.Visits },
    ...(records ? [{ value: "records" as const, label: "Records" }] : []),
    { value: "refused", label: "Refused" },
  ];
}

const dayFormat = new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const timeFormat = new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit" });

function dayLabel(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return dayFormat.format(date);
}

function groupByDay(entries: ActivityEntry[]): { day: string; entries: ActivityEntry[] }[] {
  const groups: { day: string; entries: ActivityEntry[] }[] = [];
  for (const entry of entries) {
    const day = dayLabel(entry.occurredAt);
    const last = groups.at(-1);
    if (last?.day === day) last.entries.push(entry);
    else groups.push({ day, entries: [entry] });
  }
  return groups;
}

/** The filters above the list, as the query string the activity routes read. Empty ones are left out. */
export interface ActivityFilter {
  actor: string;
  action: string;
  outcome: string;
  range: string;
  from: string;
  to: string;
}
const noFilter: ActivityFilter = { actor: "", action: "", outcome: "", range: "any", from: "", to: "" };

const rangeOptions = [
  { value: "any", label: "Any time" },
  { value: "today", label: "Today" },
  { value: "7", label: "Last 7 days" },
  { value: "30", label: "Last 30 days" },
  { value: "custom", label: "Pick dates" },
];

const kindOptions = [
  { value: "", label: "Everything" },
  ...Object.entries(auditActionGroups).map(([value, group]) => ({ value, label: group.label })),
];

const outcomeOptions = [
  { value: "", label: "Any result" },
  { value: "success", label: "Worked" },
  { value: "denied", label: "Refused" },
  { value: "failed", label: "Failed" },
];

const dayKey = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** `from` and `to` as calendar days for a preset range, or the typed dates. */
function rangeDays(filter: ActivityFilter, now: Date = new Date()): { from?: string; to?: string } {
  if (filter.range === "custom") return { ...(filter.from ? { from: filter.from } : {}), ...(filter.to ? { to: filter.to } : {}) };
  if (filter.range === "today") return { from: dayKey(now) };
  if (filter.range === "7" || filter.range === "30") return { from: dayKey(new Date(now.getTime() - Number(filter.range) * 86_400_000)) };
  return {};
}

export function activityQuery(category: ActivityCategory, filter: ActivityFilter, cursor?: string | null): URLSearchParams {
  const params = new URLSearchParams({ category });
  if (filter.actor) params.set("actor", filter.actor);
  if (filter.action) params.set("action", filter.action);
  if (filter.outcome) params.set("outcome", filter.outcome);
  for (const [key, value] of Object.entries(rangeDays(filter))) params.set(key, value);
  if (cursor) params.set("cursor", cursor);
  return params;
}

/** The Activity page. Who changed what in the clinic, newest first, including refused attempts. */
export function ActivityLog() {
  const catalog = useCatalogLookups();
  const { runWithStepUp } = useStepUp();
  const [category, setCategory] = useState<ActivityCategory>("all");
  const [filter, setFilter] = useState<ActivityFilter>(noFilter);
  const [people, setPeople] = useState<{ userId: string; name: string }[]>([]);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "more" | "error">("loading");
  const [error, setError] = useState("");
  const t = useTerms();
  const features = useFeatures();
  const categories = activityCategories(t, features.records);

  const load = useCallback(async (next: ActivityCategory, after: string | null, nextFilter: ActivityFilter, signal?: AbortSignal) => {
    setState(after ? "more" : "loading");
    setError("");
    try {
      const params = activityQuery(next, nextFilter, after);
      const page = await staffQuery<ActivityPage>(`/api/staff/activity?${params.toString()}`, signal);
      setEntries((current) => after ? [...current, ...page.entries] : page.entries);
      setCursor(page.nextCursor);
      setState("ready");
    } catch (cause: unknown) {
      if (signal?.aborted) return;
      setError(cause instanceof Error ? cause.message : "The activity log could not be loaded.");
      setState("error");
    }
  }, []);

  useEffect(() => {
    if (!catalog.database) return;
    const controller = new AbortController();
    queueMicrotask(() => void load(category, null, filter, controller.signal));
    return () => controller.abort();
  }, [catalog.database, category, filter, load]);

  useEffect(() => {
    if (!catalog.database) return;
    const controller = new AbortController();
    staffQuery<{ userId: string; name: string }[]>("/api/staff/activity/people", controller.signal)
      .then((list) => { if (Array.isArray(list)) setPeople(list); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [catalog.database]);

  /** The same filters as the screen, as a spreadsheet. It needs a recent second-factor check, so it goes through the step-up prompt. */
  async function download() {
    setExporting(true);
    setExportError("");
    try {
      const blob = await runWithStepUp(async () => {
        const response = await fetch(`/api/staff/activity/export?${activityQuery(category, filter).toString()}`, { cache: "no-store" });
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: { code?: string; message?: string } } | null;
          throw new StaffApiError(body?.error?.message ?? "The file could not be made.", response.status, body?.error?.code ?? "unknown");
        }
        return response.blob();
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "activity-log.csv";
      link.click();
      URL.revokeObjectURL(url);
    } catch (cause: unknown) {
      setExportError(cause instanceof Error ? cause.message : "The file could not be made.");
    } finally {
      setExporting(false);
    }
  }

  const filtered = JSON.stringify(filter) !== JSON.stringify(noFilter);

  if (!catalog.database) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><History aria-hidden="true" /></EmptyMedia>
          <EmptyTitle>The activity log needs the {t.business} database</EmptyTitle>
          <EmptyDescription>Changes made in the browser preview are not recorded.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <Frame>
      <FrameHeader className="flex-row flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-64">
          <FrameTitle>Activity</FrameTitle>
          <FrameDescription>Every change to the team, settings, {features.records ? `${t.visits} and records` : t.visits}, and every time someone was refused.</FrameDescription>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => void download()} disabled={exporting || state === "loading"}>
            {exporting ? <Spinner aria-hidden="true" /> : <Download aria-hidden="true" />}
            Download CSV
          </Button>
          <Button variant="outline" size="sm" onClick={() => void load(category, null, filter)} disabled={state === "loading"}>
            <RefreshCw aria-hidden="true" />
            Refresh
          </Button>
        </div>
      </FrameHeader>
      <FramePanel className="flex flex-col gap-4">
        <ScrollArea className="h-auto!" clampContentMinWidth={false}>
        <SegmentedControl
          className="w-full"
          size="sm"
          render={<ToggleGroupPrimitive aria-label="Show activity for" value={[category]} onValueChange={(next: string[]) => { if (next[0]) setCategory(next[0] as ActivityCategory); }} />}
        >
          {categories.map((item) => (
            <SegmentedControlItem key={item.value} className="flex-1" render={<TogglePrimitive value={item.value} />}>{item.label}</SegmentedControlItem>
          ))}
        </SegmentedControl>
        </ScrollArea>
        <div role="group" aria-label="Filter the activity" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <OptionSelect size="default" aria-label="Who" value={filter.actor} onValueChange={(value) => setFilter((current) => ({ ...current, actor: value }))} options={[{ value: "", label: "Everyone" }, ...people.map((person) => ({ value: person.userId, label: person.name }))]} />
          <OptionSelect size="default" aria-label="What happened" value={filter.action} onValueChange={(value) => setFilter((current) => ({ ...current, action: value }))} options={kindOptions} />
          <OptionSelect size="default" aria-label="Result" value={filter.outcome} onValueChange={(value) => setFilter((current) => ({ ...current, outcome: value }))} options={outcomeOptions} />
          <OptionSelect size="default" aria-label="When" value={filter.range} onValueChange={(value) => setFilter((current) => ({ ...current, range: value || "any" }))} options={rangeOptions} />
          {filter.range === "custom" ? (
            <>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">From<input type="date" value={filter.from} max={filter.to || undefined} onChange={(event) => setFilter((current) => ({ ...current, from: event.target.value }))} className="h-9 rounded-lg border bg-background px-3 text-sm text-foreground" /></label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">To<input type="date" value={filter.to} min={filter.from || undefined} onChange={(event) => setFilter((current) => ({ ...current, to: event.target.value }))} className="h-9 rounded-lg border bg-background px-3 text-sm text-foreground" /></label>
            </>
          ) : null}
          {filtered ? <Button type="button" variant="ghost" size="sm" className="self-end justify-self-start" onClick={() => setFilter(noFilter)}>Clear filters</Button> : null}
        </div>
        {exportError ? <Alert variant="error"><AlertDescription>{exportError}</AlertDescription></Alert> : null}
        {state === "error" ? (
          <Alert variant="error"><AlertDescription>{error}</AlertDescription></Alert>
        ) : null}
        {state === "loading" ? (
          <div role="status" aria-label="Loading activity" className="flex flex-col gap-3">
            {[0, 1, 2, 3].map((row) => <Skeleton key={row} className="h-12 w-full" />)}
          </div>
        ) : null}
        {state !== "loading" && state !== "error" && entries.length === 0 ? (
          <Empty className="py-8">
            <EmptyHeader>
              <EmptyMedia variant="icon">{category === "refused" ? <ShieldX aria-hidden="true" /> : <History aria-hidden="true" />}</EmptyMedia>
              <EmptyTitle>{filtered ? "Nothing matches those filters" : category === "refused" ? "Nobody has been refused" : "Nothing here yet"}</EmptyTitle>
              <EmptyDescription>{filtered ? "Try a wider range or clear the filters." : category === "refused" ? "When someone tries something their access doesn't allow, it shows here." : "Changes appear here as soon as they are saved."}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
        {state !== "loading" ? groupByDay(entries).map((group) => (
          <section key={group.day} aria-label={group.day} className="flex flex-col gap-1">
            <h4 className="text-xs font-medium text-muted-foreground">{group.day}</h4>
            <ol className="flex flex-col divide-y">
              {group.entries.map((entry) => <ActivityRow key={entry.id} entry={entry} />)}
            </ol>
          </section>
        )) : null}
      </FramePanel>
      {cursor ? (
        <FrameFooter className="flex justify-center">
          <Button variant="outline" size="sm" onClick={() => void load(category, cursor, filter)} disabled={state === "more"}>
            {state === "more" ? <Spinner aria-hidden="true" /> : null}
            Show older activity
          </Button>
        </FrameFooter>
      ) : null}
    </Frame>
  );
}

function ActivityRow({ entry }: { entry: ActivityEntry }) {
  const t = useTerms();
  return (
    <li className="flex gap-3 py-3">
      <PersonAvatar name={entry.actor} />
      <div className="min-w-0 flex-1">
        {entry.support ? (
          // The summary already names Kalendr support, so it is not repeated as the actor.
          <p className="text-sm font-medium">{entry.summary}</p>
        ) : (
          <p className="text-sm">
            <span className="font-medium">{entry.actor}</span>{" "}
            <span className="text-muted-foreground">{entry.summary.charAt(0).toLowerCase() + entry.summary.slice(1)}</span>
          </p>
        )}
        {entry.changes.length ? (
          <ul className="mt-1 flex flex-col gap-0.5 text-xs text-muted-foreground">
            {entry.changes.map((change) => <li key={change}>{change}</li>)}
          </ul>
        ) : null}
        {entry.appointmentId ? (
          <Link href={`/appointments/${entry.appointmentId}`} className="mt-1 inline-block text-xs font-medium text-primary underline-offset-4 hover:underline">Open the {t.visit}</Link>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <time dateTime={entry.occurredAt} className="text-xs text-muted-foreground tabular-nums">{timeFormat.format(new Date(entry.occurredAt))}</time>
        {entry.support ? <StatusBadge tone="info">Kalendr support</StatusBadge> : null}
        {entry.outcome === "denied" ? <StatusBadge tone="danger">Refused</StatusBadge> : null}
        {entry.outcome === "failed" ? <StatusBadge tone="attention">Failed</StatusBadge> : null}
      </div>
    </li>
  );
}
