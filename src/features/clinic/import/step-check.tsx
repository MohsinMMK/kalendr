"use client";

import { ArrowLeft, ArrowRight, Download, ListChecks, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Frame, FrameDescription, FrameFooter, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Progress, ProgressLabel } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useTerms } from "@/features/terms/business-profile-context";
import { importReason } from "@/lib/import-messages";
import { cn } from "@/lib/utils";

import { errorsUrl, isVersionConflict, useImportRows, useStartCheck } from "./api";
import type { ImportJob, ImportRowView, RowStatus } from "./types";
import { plural } from "./words";
import { ScrollArea } from "@/components/ui/scroll-area";

const tiles: { status: RowStatus; label: string; hint: string }[] = [
  { status: "ready", label: "Ready", hint: "Will be added" },
  { status: "will_update", label: "Will update", hint: "Existing records get blanks filled in" },
  { status: "will_skip", label: "Will skip", hint: "Already in your list" },
  { status: "error", label: "Has errors", hint: "Will not be imported" },
];

const countFor = (job: ImportJob, status: RowStatus) => ({ ready: job.counts.ready, will_update: job.counts.update, will_skip: job.counts.skip, error: job.counts.error })[status];

const rowText: Partial<Record<ImportRowView["status"], string>> = {
  ready: "Will be added",
  will_update: "Will be filled in",
  will_skip: "Will be skipped",
  error: "Has an error",
};

function fieldName(key: string | null, labels: Record<string, string>): string {
  if (!key) return "";
  return labels[key] ?? key.replace(/([A-Z])/g, " $1").replace(/[_-]+/g, " ").toLowerCase();
}

function RowsList({ job, status, labels }: { job: ImportJob; status: RowStatus; labels: Record<string, string> }) {
  const t = useTerms();
  const rows = useImportRows(job.id, status, true);
  if (rows.isPending) return <div className="flex flex-col gap-2 p-4" role="status" aria-label="Loading rows"><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-full" /></div>;
  if (rows.isError) {
    return (
      <div className="flex flex-col items-start gap-3 p-4">
        <Alert variant="error" role="alert"><TriangleAlert aria-hidden="true" /><AlertDescription>The rows could not be loaded.</AlertDescription></Alert>
        <Button variant="outline" onClick={() => void rows.refetch()}>Try again</Button>
      </div>
    );
  }
  const list: ImportRowView[] = rows.data.pages.flatMap((page) => page.rows);
  if (list.length === 0) {
    return (
      <Empty className="p-6 md:p-8">
        <EmptyHeader>
          <EmptyMedia variant="icon"><ListChecks aria-hidden="true" /></EmptyMedia>
          <EmptyTitle className="text-base">No rows in this group</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div>
      <ScrollArea clampContentMinWidth={false}><Table render={<div className="relative w-full overflow-visible!" />} aria-label={`${tiles.find((tile) => tile.status === status)?.label ?? ""} rows`}>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">Row</TableHead>
            <TableHead>What happens</TableHead>
            <TableHead>Why</TableHead>
            <TableHead>Field</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.map((row) => (
            <TableRow key={row.rowNumber}>
              <TableCell className="tabular-nums">{row.rowNumber}</TableCell>
              <TableCell className="whitespace-nowrap">{rowText[row.status] ?? "Done"}</TableCell>
              <TableCell className="min-w-56 whitespace-normal">
                {row.status === "error" || (row.status === "will_skip" && row.errorCode)
                  ? importReason(row.errorCode, t)
                  : row.status === "will_skip" ? "This row is already in your list, so it is left as it is."
                  : row.status === "will_update" ? "Matches an existing record. Only blank details are filled in."
                  : "Nothing to fix."}
              </TableCell>
              <TableCell className="capitalize">{fieldName(row.errorField, labels) || <span className="text-muted-foreground normal-case">None</span>}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table></ScrollArea>
      {rows.hasNextPage ? (
        <div className="flex justify-center p-3">
          <Button variant="outline" onClick={() => void rows.fetchNextPage()} disabled={rows.isFetchingNextPage}>
            {rows.isFetchingNextPage ? <Spinner aria-hidden="true" /> : null}Show more rows
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export interface CheckStepProps {
  job: ImportJob;
  fieldLabels: Record<string, string>;
  /** False when the column names are gone (a reload with nothing kept): the mapping can't be edited. */
  canChangeMapping: boolean;
  onBack: () => void;
  onContinue: () => void;
  onConflict: () => void;
}

export function CheckStep({ job, fieldLabels, canChangeMapping, onBack, onContinue, onConflict }: CheckStepProps) {
  const start = useStartCheck(job.id);
  const [chosen, setChosen] = useState<RowStatus | null>(null);
  const filter = chosen ?? (job.counts.error > 0 ? "error" : "ready");

  async function run() {
    try { await start.mutateAsync(); } catch (error: unknown) { if (isVersionConflict(error)) onConflict(); }
  }

  if (job.status === "mapped") {
    return (
      <Frame>
        <FramePanel className="flex flex-col items-start gap-3">
          <p className="text-sm">Your columns are matched. Check every row before anything is saved.</p>
          {start.isError ? <Alert variant="error" role="alert"><TriangleAlert aria-hidden="true" /><AlertDescription>{start.error.message}</AlertDescription></Alert> : null}
        </FramePanel>
        <FrameFooter className="flex flex-wrap justify-between gap-3">
          {canChangeMapping ? <Button variant="ghost" onClick={onBack}><ArrowLeft aria-hidden="true" /> Change the columns</Button> : <span />}
          <Button onClick={run} disabled={start.isPending}>{start.isPending ? <Spinner aria-hidden="true" /> : null}Check the file</Button>
        </FrameFooter>
      </Frame>
    );
  }

  if (job.status === "checking") {
    return (
      <Frame>
        <FramePanel className="flex flex-col gap-3" role="status">
          <Progress value={null} aria-label="Checking the file">
            <ProgressLabel>Checking {plural(job.rowCount, "row", "rows")}…</ProgressLabel>
          </Progress>
          <p className="text-sm text-muted-foreground">Looking for phone numbers, dates and duplicates that need attention. Nothing is saved yet. You can leave this page; the check carries on.</p>
        </FramePanel>
      </Frame>
    );
  }

  const importable = job.counts.ready + job.counts.update;
  return (
    <Frame>
      <FrameHeader>
        <FrameTitle>Check the results</FrameTitle>
        <FrameDescription>We checked {plural(job.rowCount, "row", "rows")}. Choose a group to see its rows.</FrameDescription>
      </FrameHeader>
      <FramePanel className="flex flex-col gap-4">
        <ul className="grid grid-cols-2 gap-2 lg:grid-cols-4" aria-label="Totals">
          {tiles.map((tile) => {
            const count = countFor(job, tile.status);
            const selected = filter === tile.status;
            return (
              <li key={tile.status} className="flex">
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setChosen(tile.status)}
                  className={cn(
                    "flex min-h-11 w-full cursor-pointer flex-col items-start gap-0.5 rounded-lg border p-3 text-start outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    selected ? "border-primary/48 bg-accent/50" : "hover:bg-accent/32",
                  )}
                >
                  <span className={cn("font-heading text-2xl font-semibold tabular-nums", tile.status === "error" && count > 0 ? "text-destructive-foreground" : null)}>{count.toLocaleString("en-GB")}</span>
                  <span className="text-sm font-medium">{tile.label}</span>
                  <span className="text-xs text-muted-foreground">{tile.hint}</span>
                </button>
              </li>
            );
          })}
        </ul>
        {job.counts.error > 0 ? (
          <Alert variant="warning" role="status">
            <TriangleAlert aria-hidden="true" />
            <AlertDescription>
              {plural(job.counts.error, "row has", "rows have")} an error and will not be imported. The rest can still go ahead. Download the rows with errors, fix them in your file, and import them as a new file later.
            </AlertDescription>
          </Alert>
        ) : null}
      </FramePanel>
      <FramePanel className="p-0">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <h3 className="font-heading text-sm font-semibold">{tiles.find((tile) => tile.status === filter)?.label} rows</h3>
          <Badge variant="outline" className="tabular-nums">{countFor(job, filter).toLocaleString("en-GB")}</Badge>
        </div>
        <RowsList key={filter} job={job} status={filter} labels={fieldLabels} />
      </FramePanel>
      <FrameFooter className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {canChangeMapping ? <Button variant="ghost" onClick={onBack}><ArrowLeft aria-hidden="true" /> Change the columns</Button> : null}
          {job.counts.error > 0 ? <Button variant="outline" render={<a href={errorsUrl(job.id)} download />}><Download aria-hidden="true" /> Download the rows with errors</Button> : null}
        </div>
        <Button onClick={onContinue} disabled={importable === 0}>
          Continue to import <ArrowRight aria-hidden="true" />
        </Button>
      </FrameFooter>
      {importable === 0 ? <p className="px-2 pt-2 text-xs text-muted-foreground" role="status">No row can be imported. Change the columns or fix your file and upload it again.</p> : null}
    </Frame>
  );
}
