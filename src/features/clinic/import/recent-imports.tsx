"use client";

import { History, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Skeleton } from "@/components/ui/skeleton";
import { useTerms } from "@/features/terms/business-profile-context";

import { useDiscardImport, useImportList } from "./api";
import type { ImportJob } from "./types";
import { canRedo, formatDay, formatMoment, kindWords, plural, statusText, statusTone, undoOpen } from "./words";

function summary(job: ImportJob): string {
  const c = job.counts;
  if (job.status === "done" || job.status === "undone" || job.status === "undoing" || job.status === "failed") {
    return `${c.created.toLocaleString("en-GB")} added, ${c.updated.toLocaleString("en-GB")} updated, ${c.skipped.toLocaleString("en-GB")} skipped, ${c.failed.toLocaleString("en-GB")} failed`;
  }
  return plural(job.rowCount, "row", "rows");
}

export function RecentImports({ onOpen, activeId }: { onOpen: (job: ImportJob) => void; activeId: string | null }) {
  const t = useTerms();
  const list = useImportList(true);
  const discard = useDiscardImport();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <Frame>
      <FrameHeader>
        <FrameTitle>Recent imports</FrameTitle>
        <FrameDescription>Pick up an import you left unfinished, or undo a finished one within 7 days.</FrameDescription>
      </FrameHeader>
      <FramePanel className="p-0">
        {list.isPending ? (
          <div className="flex flex-col gap-3 p-4" role="status" aria-label="Loading recent imports">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : list.isError ? (
          <div className="flex flex-col items-start gap-3 p-4">
            <Alert variant="error" role="alert"><TriangleAlert aria-hidden="true" /><AlertDescription>Your recent imports could not be loaded.</AlertDescription></Alert>
            <Button variant="outline" onClick={() => void list.refetch()}>Try again</Button>
          </div>
        ) : list.data.length === 0 ? (
          <Empty className="p-6 md:p-8">
            <EmptyHeader>
              <EmptyMedia variant="icon"><History aria-hidden="true" /></EmptyMedia>
              <EmptyTitle className="text-base">No imports yet</EmptyTitle>
              <EmptyDescription>Imports you start here will be listed so you can come back to them.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="divide-y" aria-label="Recent imports">
            {discard.isError ? <li className="p-3"><Alert variant="error" role="alert"><TriangleAlert aria-hidden="true" /><AlertDescription>{discard.error.message}</AlertDescription></Alert></li> : null}
            {list.data.map((job) => {
              const words = kindWords(job.kind, t);
              const undo = undoOpen(job, now);
              const open = job.status === "done" ? (undo ? "View or undo" : "View") : canRedo(job.status) || job.status === "checking" ? "Continue" : "View";
              return (
                <li key={job.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 p-3 md:px-4">
                  <div className="min-w-0 flex-1 basis-56">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium">{words.title}</p>
                      <StatusBadge tone={statusTone(job.status)}>{statusText[job.status]}</StatusBadge>
                    </div>
                    <p className="text-xs text-muted-foreground tabular-nums">{formatMoment(job.createdAt)} · {summary(job)}</p>
                    {undo && job.undoUntil ? <p className="text-xs text-muted-foreground">Can be undone until {formatDay(job.undoUntil)}</p> : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {canRedo(job.status) || job.status === "failed" ? (
                      <Button size="sm" variant="ghost" className="min-h-11 sm:min-h-0" disabled={discard.isPending} onClick={() => discard.mutate(job.id)} aria-label={`Discard the ${words.noun} import from ${formatMoment(job.createdAt)}`}>Discard</Button>
                    ) : null}
                    <Button size="sm" variant="outline" className="min-h-11 sm:min-h-0" disabled={job.id === activeId} onClick={() => onOpen(job)} aria-label={`${open} the ${words.noun} import from ${formatMoment(job.createdAt)}`}>{open}</Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </FramePanel>
    </Frame>
  );
}
