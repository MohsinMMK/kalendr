"use client";

import { CircleCheck, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toastManager } from "@/components/ui/toast";
import type { AdminWorkerHealth } from "@/lib/admin-contracts";

import { adminActions, useAdminAction, useWorkerHealth, workerRefreshMs } from "./admin-api";
import { formatAge, formatClock, formatDateTime, shortId } from "./admin-format";
import { useAdminCan } from "./admin-role";
import { ReasonDialog } from "./reason-dialog";
import { EmptyPanel, ErrorPanel, LoadingRows, ScreenHeader } from "./screen-states";

/** A worker that has not checked in for this long is flagged. */
export const staleAfterSeconds = 90;

type DeadLetter = AdminWorkerHealth["deadLetterItems"][number];

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
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

function Heartbeats({ data, now }: { data: AdminWorkerHealth; now: number }) {
  return (
    <Frame>
      <FrameHeader><FrameTitle>Workers</FrameTitle><FrameDescription>Each worker checks in often. One that goes quiet for over {staleAfterSeconds} seconds is flagged.</FrameDescription></FrameHeader>
      <FramePanel>
        {data.heartbeats.length === 0 ? <EmptyPanel icon={<RefreshCw aria-hidden="true" />} title="No worker has checked in" description="If messages are waiting, start the worker. Nothing is sent without one." /> : (
          <Table aria-label="Worker heartbeats">
            <TableHeader><TableRow><TableHead>Worker</TableHead><TableHead>Mode</TableHead><TableHead>Version</TableHead><TableHead>Last seen</TableHead><TableHead>State</TableHead></TableRow></TableHeader>
            <TableBody>
              {data.heartbeats.map((beat) => {
                const seconds = Math.max(0, Math.round((now - new Date(beat.lastSeenAt).getTime()) / 1000));
                const stopped = beat.stoppedAt !== null;
                const stale = !stopped && seconds > staleAfterSeconds;
                return (
                  <TableRow key={beat.workerId}>
                    <TableCell className="font-mono text-xs">{shortId(beat.workerId)}</TableCell>
                    <TableCell>{beat.mode}</TableCell>
                    <TableCell>{beat.version}</TableCell>
                    <TableCell className="tabular-nums">{formatAge(seconds)} ago</TableCell>
                    <TableCell>
                      {stopped ? <StatusBadge tone="neutral">Stopped</StatusBadge> : stale ? <StatusBadge tone="danger">Stale: no check-in for {formatAge(seconds)}</StatusBadge> : <StatusBadge tone="success">Healthy</StatusBadge>}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </FramePanel>
    </Frame>
  );
}

function DeadLetters({ items, canRetry, onRetry }: { items: DeadLetter[]; canRetry: boolean; onRetry: (item: DeadLetter) => void }) {
  return (
    <Frame>
      <FrameHeader><FrameTitle>Dead letters</FrameTitle><FrameDescription>Jobs that gave up after too many tries. Retrying puts one back in the queue.</FrameDescription></FrameHeader>
      <FramePanel>
        {items.length === 0 ? <EmptyPanel icon={<CircleCheck aria-hidden="true" />} title="No dead letters" description="Every job is either done or still being tried." /> : (
          <ul className="flex flex-col divide-y" aria-label="Dead letters">
            {items.map((item) => (
              <li key={item.eventId} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 text-sm">
                <div className="min-w-0 flex-1 basis-56">
                  <p className="font-medium">{item.eventType.replace(/[._-]+/g, " ")}</p>
                  <p className="text-xs text-muted-foreground"><Link className="underline-offset-4 hover:underline" href={`/admin/tenants/${encodeURIComponent(item.tenantId)}`}>Business {shortId(item.tenantId)}</Link> · event <span className="font-mono">{shortId(item.eventId)}</span> · {item.attempts} tries · {formatDateTime(item.createdAt)}</p>
                </div>
                {item.lastErrorCode ? <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{item.lastErrorCode}</code> : null}
                {canRetry ? <Button variant="outline" size="sm" onClick={() => onRetry(item)} aria-label={`Retry event ${shortId(item.eventId)}`}>Retry</Button> : null}
              </li>
            ))}
          </ul>
        )}
      </FramePanel>
    </Frame>
  );
}

export function WorkerScreen() {
  const can = useAdminCan();
  const query = useWorkerHealth();
  const [retrying, setRetrying] = useState<DeadLetter | null>(null);
  const retry = useAdminAction((input: { eventId: string; reason: string }) => adminActions.retry(input));
  const data = query.data;
  const updated = query.dataUpdatedAt;

  return (
    <>
      <ScreenHeader
        title="Worker"
        description="The background worker sends reminders and other messages."
        actions={
          <div className="flex items-center gap-2">
            <p role="status" className="text-xs text-muted-foreground tabular-nums">{updated ? `Updated ${formatClock(new Date(updated))}. Refreshes every ${workerRefreshMs / 1000} seconds.` : "Loading"}</p>
            <Button variant="outline" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}><RefreshCw aria-hidden="true" />Refresh</Button>
          </div>
        }
      />
      {query.isPending ? <LoadingRows label="Loading worker health" rows={4} /> : null}
      {query.isError ? <ErrorPanel error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} /> : null}
      {data ? (
        <>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3" aria-label="Queue">
            <Stat label="Waiting in the queue" value={String(data.pending)} />
            <Stat label="Oldest waiting" value={data.pending === 0 ? "None" : formatAge(data.oldestPendingSeconds)} note={data.oldestPendingSeconds > 300 && data.pending > 0 ? "Older than 5 minutes. Check the workers below." : undefined} />
            <Stat label="Dead letters" value={String(data.deadLetters)} />
          </dl>
          <Heartbeats data={data} now={updated} />
          <DeadLetters items={data.deadLetterItems} canRetry={can.retry} onRetry={setRetrying} />
        </>
      ) : null}
      <ReasonDialog
        open={retrying !== null}
        onOpenChange={(next) => { if (!next) setRetrying(null); }}
        title="Retry this job?"
        description={retrying ? `It goes back in the queue and the worker tries it again. Event ${shortId(retrying.eventId)}.` : ""}
        confirmLabel="Retry job"
        onConfirm={async (reason) => {
          if (!retrying) return;
          await retry.mutateAsync({ eventId: retrying.eventId, reason });
          toastManager.add({ title: "Job put back in the queue", type: "success" });
        }}
      />
    </>
  );
}
