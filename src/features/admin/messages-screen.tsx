"use client";

import { MessagesSquare, Search } from "lucide-react";
import { useState, type FormEvent } from "react";

import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Frame, FramePanel } from "@/components/ui/frame";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import type { AdminMessageRow } from "@/lib/admin-contracts";

import { useMessageSearch } from "./admin-api";
import { useAdminCan } from "./admin-role";
import { formatDateTime, messageTone } from "./admin-format";
import { EmptyPanel, ErrorPanel, LoadingRows, ScreenHeader } from "./screen-states";

const channelNames: Record<string, string> = { whatsapp: "WhatsApp", sms: "SMS", email: "Email", push: "App alert" };

function statusText(status: string): string {
  const text = status.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The steps a message went through, oldest first, skipping the ones that never happened. */
function timeline(row: AdminMessageRow): { label: string; at: string }[] {
  return [
    { label: "Scheduled", at: row.scheduledAt },
    ...(row.sentAt ? [{ label: "Sent", at: row.sentAt }] : []),
    ...(row.deliveredAt ? [{ label: "Delivered", at: row.deliveredAt }] : []),
    ...(row.failedAt ? [{ label: "Failed", at: row.failedAt }] : []),
  ];
}

export function MessageResult({ row }: { row: AdminMessageRow }) {
  const tone = messageTone(row.status);
  return (
    <Frame>
      <FramePanel className="flex flex-col gap-4">
        <div>
          <p className="text-xs font-medium text-muted-foreground">Why</p>
          <p className="mt-1 text-lg font-semibold leading-snug">{row.explanation}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge tone={tone}>{statusText(row.status)}</StatusBadge>
          <span className="text-sm">{channelNames[row.channel] ?? row.channel} · {row.templateKey.replace(/[._-]+/g, " ")}</span>
          <span className="text-sm text-muted-foreground tabular-nums">{row.attemptCount} {row.attemptCount === 1 ? "attempt" : "attempts"}</span>
          {row.failureCode ? <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{row.failureCode}</code> : null}
        </div>
        <ol aria-label="Message timeline" className="flex flex-col gap-1 border-s ps-4 text-sm">
          {timeline(row).map((step) => (
            <li key={step.label} className="flex flex-wrap gap-x-2"><span className="font-medium">{step.label}</span><time dateTime={step.at} className="text-muted-foreground tabular-nums">{formatDateTime(step.at)}</time></li>
          ))}
        </ol>
        <dl className="grid grid-cols-1 gap-2 text-xs text-muted-foreground sm:grid-cols-3">
          <div><dt>Message id</dt><dd className="break-all font-mono text-foreground">{row.notificationId}</dd></div>
          <div><dt>Appointment id</dt><dd className="break-all font-mono text-foreground">{row.appointmentId ?? "None"}</dd></div>
          <div><dt>Provider reference</dt><dd className="text-foreground">{row.hasProviderId ? "Received from the provider" : "None yet"}</dd></div>
        </dl>
        <section aria-label="Delivery attempts">
          <h3 className="text-sm font-medium">Delivery attempts</h3>
          {row.outbox.length === 0 ? <p className="mt-1 text-sm text-muted-foreground">No delivery jobs were found for this message.</p> : (
            <ul className="mt-2 flex flex-col divide-y rounded-lg border text-sm">
              {row.outbox.map((job) => (
                <li key={job.eventId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                  <StatusBadge tone={messageTone(job.status)}>{statusText(job.status)}</StatusBadge>
                  <span>{job.eventType.replace(/[._-]+/g, " ")}</span>
                  <span className="text-muted-foreground tabular-nums">{job.attemptCount} {job.attemptCount === 1 ? "try" : "tries"}</span>
                  {job.lastErrorCode ? <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{job.lastErrorCode}</code> : null}
                  <time dateTime={job.availableAt} className="ms-auto text-xs text-muted-foreground tabular-nums">{formatDateTime(job.availableAt)}</time>
                </li>
              ))}
            </ul>
          )}
        </section>
      </FramePanel>
    </Frame>
  );
}

export function MessagesScreen() {
  const can = useAdminCan();
  const [typed, setTyped] = useState("");
  const [q, setQ] = useState("");
  const [tooShort, setTooShort] = useState(false);
  const query = useMessageSearch(can.findMessages ? q : "");

  function submit(event: FormEvent) {
    event.preventDefault();
    const next = typed.trim();
    if (next.length < 8) { setTooShort(true); return; }
    setTooShort(false);
    setQ(next);
  }

  if (!can.findMessages) {
    return (
      <>
        <ScreenHeader title="Messages" description="Find out why a message did or did not reach a customer." />
        <EmptyPanel icon={<MessagesSquare aria-hidden="true" />} title="Support and super admins only" description="Your role can see the overview screens. Ask a support operator to look up a message." />
      </>
    );
  }

  return (
    <>
      <ScreenHeader title="Messages" description="Find out why a message did or did not reach a customer. Search by message id or appointment id." />
      <form onSubmit={submit} role="search" className="flex gap-2">
        <InputGroup className="max-w-xl">
          <InputGroupAddon><Search aria-hidden="true" /></InputGroupAddon>
          <InputGroupInput aria-label="Message id or appointment id" placeholder="Paste a message id or appointment id" value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" spellCheck={false} />
        </InputGroup>
        <Button type="submit" size="lg" className="min-h-11" disabled={typed.trim() === "" || query.isFetching}>Find</Button>
      </form>
      {tooShort ? <p role="alert" className="text-sm text-destructive-foreground">Ids are at least 8 characters. Paste the whole id.</p> : null}
      {q === "" ? <EmptyPanel icon={<MessagesSquare aria-hidden="true" />} title="Search for a message" description="Paste an id from a support request. The result starts with the reason in plain words." /> : null}
      {q !== "" && query.isFetching && !query.data ? <LoadingRows label="Searching messages" rows={3} /> : null}
      {q !== "" && query.isError ? <ErrorPanel error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} /> : null}
      {q !== "" && query.data && query.data.length === 0 ? <EmptyPanel icon={<MessagesSquare aria-hidden="true" />} title="No message found" description="Check the id and try again. Ids from other systems will not match." /> : null}
      {q !== "" && query.data ? <div className="flex flex-col gap-4">{query.data.map((row) => <MessageResult key={row.notificationId} row={row} />)}</div> : null}
    </>
  );
}
