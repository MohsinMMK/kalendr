"use client";

import { Banknote, CalendarDays, ClipboardList, ListFilter, MessageSquare, NotebookPen, PenLine } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroupPrimitive } from "@/components/ui/toggle-group";
import { TogglePrimitive } from "@/components/ui/toggle";
import { useTerms } from "@/features/terms/business-profile-context";
import { timelineKindLabels, timelineKinds, type TimelineEntry, type TimelineKind } from "@/lib/customer-contracts";
import { formatMoney } from "@/lib/money";

import { dateTimeLabel, ListSkeleton, LoadFailed } from "./customer-parts";
import { useTimeline } from "./queries/customers";
import { useStaffAccess } from "./staff-access";

const icons: Record<TimelineKind, typeof CalendarDays> = {
  visit: CalendarDays, message: MessageSquare, payment: Banknote, form: ClipboardList, note: NotebookPen, change: PenLine,
};

const statusWords: Record<string, string> = {
  completed: "Done", booked: "Booked", requested: "Requested", cancelled: "Cancelled", no_show: "No-show", checked_in: "Checked in",
  delivered: "Delivered", sending: "Sending", failed: "Failed", cancelled_message: "Not sent", paid: "Paid", refunded: "Refunded", pinned: "Pinned",
  submitted: "Received", sent: "Sent", read: "Read",
};

function Entry({ entry }: { entry: TimelineEntry }) {
  const Icon = icons[entry.kind];
  const body = (
    <>
      <span aria-hidden="true" className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"><Icon className="size-4" /></span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline justify-between gap-x-3">
          <span className="font-medium text-sm">{entry.title}{entry.amountMinor !== null ? <span className="ms-2 font-normal tabular-nums">{entry.kind === "payment" && entry.title === "Refund" ? "−" : ""}{formatMoney(entry.amountMinor, entry.currency ?? "INR")}</span> : null}</span>
          <time dateTime={entry.at} className="text-muted-foreground text-xs tabular-nums">{dateTimeLabel(entry.at)}</time>
        </span>
        {entry.detail ? <span className="block whitespace-pre-wrap break-words text-muted-foreground text-sm">{entry.detail}</span> : null}
        <span className="mt-0.5 flex flex-wrap gap-x-2 text-muted-foreground text-xs">
          {entry.status ? <span>{statusWords[entry.status] ?? entry.status.replaceAll("_", " ")}</span> : null}
          {entry.by ? <span>by {entry.by}</span> : null}
        </span>
      </span>
    </>
  );
  return entry.kind === "visit" && entry.refId
    ? <Link href={`/appointments/${entry.refId}?from=patients`} className="flex gap-3 rounded-md px-2 py-2 text-foreground no-underline outline-2 outline-transparent hover:bg-accent focus-visible:outline-ring">{body}</Link>
    : <div className="flex gap-3 px-2 py-2">{body}</div>;
}

/** Everything that happened to one customer, newest first. Filter by kind; older entries load a page at a time. */
export function CustomerTimeline({ patientId }: { patientId: string }) {
  const t = useTerms();
  const access = useStaffAccess();
  const [kinds, setKinds] = useState<TimelineKind[]>([]);
  const query = useTimeline(patientId, kinds);
  const entries = query.data?.pages.flatMap((page) => page.entries) ?? [];
  const available = timelineKinds.filter((kind) => kind !== "payment" || access.can("payments.collect") || access.can("invoices.issue"));

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <ListFilter aria-hidden="true" className="size-4 text-muted-foreground" />
        <ToggleGroupPrimitive aria-label="Show only" multiple value={kinds} onValueChange={(next: string[]) => setKinds(available.filter((kind) => next.includes(kind)))} className="flex flex-wrap gap-1">
          {available.map((kind) => (
            <TogglePrimitive key={kind} value={kind} className="inline-flex min-h-11 items-center rounded-full border px-3 text-sm outline-2 outline-transparent focus-visible:outline-ring data-[pressed]:border-primary data-[pressed]:bg-primary/8 sm:min-h-8">{timelineKindLabels[kind]}</TogglePrimitive>
          ))}
        </ToggleGroupPrimitive>
        {kinds.length > 0 ? <Button size="sm" variant="ghost" onClick={() => setKinds([])}>Show everything</Button> : null}
      </div>
      {query.isPending ? <ListSkeleton label="Loading history" /> : null}
      {query.isError ? <LoadFailed message={query.error instanceof Error ? query.error.message : "The history could not be loaded."} onRetry={() => void query.refetch()} /> : null}
      {query.isSuccess && entries.length === 0 ? (
        <Empty className="p-4 md:p-6">
          <EmptyHeader>
            <EmptyMedia variant="icon"><CalendarDays aria-hidden="true" /></EmptyMedia>
            <EmptyTitle className="text-base">{kinds.length ? "Nothing of that kind yet" : "No history yet"}</EmptyTitle>
            <EmptyDescription>{kinds.length ? "Choose another kind, or show everything." : `${t.Appointments}, messages, payments and notes appear here as they happen.`}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {entries.length > 0 ? (
        <ol aria-label="History, newest first" className="flex flex-col divide-y">
          {entries.map((entry) => <li key={entry.key}><Entry entry={entry} /></li>)}
        </ol>
      ) : null}
      {query.isFetchNextPageError ? <LoadFailed message="More history could not be loaded." onRetry={() => void query.fetchNextPage()} /> : null}
      {query.hasNextPage ? (
        <Button variant="outline" className="self-center" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
          {query.isFetchingNextPage ? <Spinner /> : null}Load older history
        </Button>
      ) : entries.length > 50 ? <p className="text-center text-muted-foreground text-xs">That is everything.</p> : null}
    </div>
  );
}
