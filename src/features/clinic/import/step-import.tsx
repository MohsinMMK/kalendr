"use client";

import { ArrowLeft, CircleCheck, Download, Play, TriangleAlert, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Frame, FrameDescription, FrameFooter, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Progress, ProgressLabel } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { useTerms } from "@/features/terms/business-profile-context";
import { importFailureFallback, importReasons } from "@/lib/import-messages";

import { errorsUrl, isVersionConflict, useCommitImport, useUndoImport } from "./api";
import type { ImportJob } from "./types";
import { formatDay, kindWords, plural, undoOpen } from "./words";

/** True when the file has a consent column that the owner has not yet confirmed. */
export function consentUnconfirmed(job: ImportJob): boolean {
  if (job.kind !== "customers" || !job.mapping) return false;
  const mapped = Object.entries(job.mapping).some(([key, column]) => /consent/i.test(key) && column !== null);
  return mapped && job.options?.consentConfirmed !== true;
}

function Tile({ value, label, hint }: { value: number; label: string; hint: string }) {
  return (
    <li className="flex flex-col gap-0.5 rounded-lg border p-3">
      <span className="font-heading text-2xl font-semibold tabular-nums">{value.toLocaleString("en-GB")}</span>
      <span className="text-sm font-medium">{label}</span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </li>
  );
}

export interface ImportStepProps {
  job: ImportJob;
  onBackToCheck: () => void;
  onNewImport: () => void;
  onConflict: () => void;
}

export function ImportStep({ job, onBackToCheck, onNewImport, onConflict }: ImportStepProps) {
  const t = useTerms();
  const words = kindWords(job.kind, t);
  const commit = useCommitImport(job.id);
  const undo = useUndoImport(job.id);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const c = job.counts;

  async function start() {
    try { await commit.mutateAsync({ expectedVersion: job.version }); } catch (error: unknown) { if (isVersionConflict(error)) onConflict(); }
  }

  async function doUndo() {
    try {
      await undo.mutateAsync();
      setConfirmUndo(false);
    } catch (error: unknown) {
      setConfirmUndo(false);
      if (isVersionConflict(error)) onConflict();
    }
  }

  if (job.status === "checked") {
    const blocked = consentUnconfirmed(job);
    return (
      <Frame>
        <FrameHeader>
          <FrameTitle>Ready to import {words.noun}</FrameTitle>
          <FrameDescription>Here is what will happen when you start.</FrameDescription>
        </FrameHeader>
        <FramePanel className="flex flex-col gap-4">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-muted-foreground">Will be added</dt><dd className="font-medium tabular-nums">{plural(c.ready, "row", "rows")}</dd></div>
            <div><dt className="text-muted-foreground">Will be filled in</dt><dd className="font-medium tabular-nums">{plural(c.update, "existing record", "existing records")}</dd></div>
            <div><dt className="text-muted-foreground">Will be skipped</dt><dd className="font-medium tabular-nums">{plural(c.skip, "row", "rows")}</dd></div>
            <div><dt className="text-muted-foreground">Will not be imported</dt><dd className="font-medium tabular-nums">{plural(c.error, "row with an error", "rows with errors")}</dd></div>
            {job.kind === "appointments" ? <div><dt className="text-muted-foreground">Confirmations</dt><dd className="font-medium">{job.options?.sendConfirmations ? `Each ${t.customer} is messaged` : `Nothing is sent to ${t.customers}`}</dd></div> : null}
          </dl>
          {blocked ? (
            <Alert variant="warning" role="alert">
              <TriangleAlert aria-hidden="true" />
              <AlertDescription>Your file has a consent column. Go back to the column step and confirm that these {t.customers} agreed to receive messages before importing.</AlertDescription>
            </Alert>
          ) : null}
          <p className="text-sm text-muted-foreground">You can undo this import for 7 days after it finishes.</p>
          {commit.isError && !isVersionConflict(commit.error) ? <Alert variant="error" role="alert"><TriangleAlert aria-hidden="true" /><AlertDescription>{commit.error.message}</AlertDescription></Alert> : null}
        </FramePanel>
        <FrameFooter className="flex flex-wrap justify-between gap-3">
          <Button variant="ghost" onClick={onBackToCheck}><ArrowLeft aria-hidden="true" /> Back to the check</Button>
          <Button onClick={start} disabled={blocked || commit.isPending || c.ready + c.update === 0}>
            {commit.isPending ? <Spinner aria-hidden="true" /> : <Play aria-hidden="true" />}
            Start the import
          </Button>
        </FrameFooter>
      </Frame>
    );
  }

  if (job.status === "queued" || job.status === "running" || job.status === "undoing") {
    const undoing = job.status === "undoing";
    const done = c.created + c.updated + c.skipped + c.failed;
    // The last rows land together with "done", so the bar never claims to be finished before the server says so.
    const percent = undoing || job.status === "queued" ? null : Math.min(99, Math.round((done / Math.max(1, job.rowCount)) * 100));
    const label = undoing ? "Undoing the import…" : job.status === "queued" ? "Waiting to start…" : `Imported ${done.toLocaleString("en-GB")} of ${job.rowCount.toLocaleString("en-GB")} rows`;
    return (
      <Frame>
        <FramePanel className="flex flex-col gap-4" role="status">
          <Progress value={percent} aria-label={undoing ? "Undo progress" : "Import progress"}>
            <ProgressLabel>{label}</ProgressLabel>
          </Progress>
          {!undoing ? (
            <ul className="grid grid-cols-2 gap-2 lg:grid-cols-4" aria-label="So far">
              <Tile value={c.created} label="Added" hint="New records" />
              <Tile value={c.updated} label="Filled in" hint="Existing records" />
              <Tile value={c.skipped} label="Skipped" hint="Left as they were" />
              <Tile value={c.failed} label="Failed" hint="Not saved" />
            </ul>
          ) : null}
          <p className="text-sm text-muted-foreground">You can leave this page. The import carries on and the result will be waiting under Recent imports.</p>
        </FramePanel>
      </Frame>
    );
  }

  const canUndo = undoOpen(job, now);
  const failedReason = job.failureCode ? importReasons(t)[job.failureCode] ?? importFailureFallback : importFailureFallback;
  const undone = job.status === "undone";

  return (
    <Frame>
      <FrameHeader>
        <FrameTitle>{undone ? "Import undone" : job.status === "failed" ? "The import stopped" : "Import finished"}</FrameTitle>
        <FrameDescription>
          {undone
            ? job.undo
              ? `${job.undo.removed.toLocaleString("en-GB")} ${words.noun} this import added were removed.${job.undo.kept ? ` ${job.undo.kept.toLocaleString("en-GB")} stayed because they were used or changed after the import.` : ""} Everything that was there before is untouched.`
              : `The ${words.noun} this import added were removed. Everything that was there before is untouched.`
            : job.status === "failed"
              ? "Some rows may have been saved before it stopped."
              : `Imported ${words.noun}${job.finishedAt ? ` on ${formatDay(job.finishedAt)}` : ""}.`}
        </FrameDescription>
      </FrameHeader>
      <FramePanel className="flex flex-col gap-4" role="status">
        {job.status === "failed" ? (
          <Alert variant="error" role="alert"><TriangleAlert aria-hidden="true" /><AlertTitle>It could not finish</AlertTitle><AlertDescription>{failedReason}</AlertDescription></Alert>
        ) : undone ? (
          <Alert variant="success"><CircleCheck aria-hidden="true" /><AlertDescription>Undo is complete.</AlertDescription></Alert>
        ) : null}
        <ul className="grid grid-cols-2 gap-2 lg:grid-cols-4" aria-label="Result">
          <Tile value={c.created} label="Created" hint={undone ? "Removed again" : "New records"} />
          <Tile value={c.updated} label="Updated" hint="Blanks filled in" />
          <Tile value={c.skipped} label="Skipped" hint="Left as they were" />
          <Tile value={c.failed} label="Failed" hint="Not saved" />
        </ul>
        {job.status === "done" ? (
          <p className="text-sm text-muted-foreground">
            {canUndo && job.undoUntil ? `You can undo this import until ${formatDay(job.undoUntil)}.` : "The 7 days to undo this import have passed."}
          </p>
        ) : null}
        {undo.isError && !isVersionConflict(undo.error) ? <Alert variant="error" role="alert"><TriangleAlert aria-hidden="true" /><AlertDescription>{undo.error.message}</AlertDescription></Alert> : null}
      </FramePanel>
      <FrameFooter className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {c.failed + c.error > 0 ? <Button variant="outline" render={<a href={errorsUrl(job.id)} download />}><Download aria-hidden="true" /> Download errors</Button> : null}
          {canUndo ? <Button variant="destructive-outline" onClick={() => setConfirmUndo(true)}><Undo2 aria-hidden="true" /> Undo this import</Button> : null}
        </div>
        <Button onClick={onNewImport}>Import something else</Button>
      </FrameFooter>

      <AlertDialog open={confirmUndo} onOpenChange={(open) => { if (!undo.isPending) setConfirmUndo(open); }}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Undo this import?</AlertDialogTitle>
            <AlertDialogDescription render={<div />}>
              <p className="font-medium text-foreground">What this removes</p>
              <p>The {c.created.toLocaleString("en-GB")} {words.noun} this import added, as long as nobody has used them since. Any that were booked, edited or messaged after the import stay.</p>
              <p className="mt-3 font-medium text-foreground">What this keeps</p>
              <p>Everything that was in your list before the import, the {plural(c.updated, "existing record", "existing records")} it filled in (they keep the details added), and anything added by hand. Nothing is sent to anyone.</p>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" disabled={undo.isPending} />}>Keep the import</AlertDialogClose>
            <Button variant="destructive" onClick={doUndo} disabled={undo.isPending}>
              {undo.isPending ? <Spinner aria-hidden="true" /> : null}Undo the import
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </Frame>
  );
}
