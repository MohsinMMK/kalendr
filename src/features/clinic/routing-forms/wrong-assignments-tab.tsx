"use client";

import { CircleCheck, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import type { WrongAssignmentView } from "@/lib/routing-forms";

import { StaffApiError } from "../queries/http";
import { useReviewWrongAssignment, useWrongAssignments } from "./queries";

const when = (iso: string) => new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

function Item({ item, busy, onReview }: { item: WrongAssignmentView; busy: boolean; onReview: (status: "fixed" | "dismissed") => void }) {
  const t = useTerms();
  const open = item.status === "open";
  return (
    <li className="flex flex-col gap-2 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-sm">{item.serviceName}</span>
        <span className="text-muted-foreground text-xs">{when(item.startsAt)}</span>
        {open ? <StatusBadge tone="attention">Open</StatusBadge> : <StatusBadge tone={item.status === "fixed" ? "success" : "neutral"}>{item.status === "fixed" ? "Fixed" : "Dismissed"}</StatusBadge>}
      </div>
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
        <div><dt className="text-muted-foreground text-xs">Booked with</dt><dd>{item.assignedName}</dd></div>
        <div><dt className="text-muted-foreground text-xs">Should have been</dt><dd>{item.correctName ?? `Not said`}</dd></div>
        <div><dt className="text-muted-foreground text-xs">Route</dt><dd>{item.routeName ?? "Not routed by a form"}</dd></div>
        <div><dt className="text-muted-foreground text-xs">Reported by</dt><dd>{item.reportedBy}</dd></div>
        {item.note ? <div className="sm:col-span-2"><dt className="text-muted-foreground text-xs">Note</dt><dd className="whitespace-pre-wrap break-words">{item.note}</dd></div> : null}
      </dl>
      {open ? (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" className="min-h-11 sm:min-h-8" disabled={busy} onClick={() => onReview("fixed")} aria-label={`Mark fixed: ${item.serviceName} booked with ${item.assignedName}`}>Mark fixed</Button>
          <Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" disabled={busy} onClick={() => onReview("dismissed")} aria-label={`Dismiss: ${item.serviceName} booked with ${item.assignedName}`}>Dismiss</Button>
        </div>
      ) : <p className="text-muted-foreground text-xs">This {t.appointment} was reviewed.</p>}
    </li>
  );
}

/** Bookings staff said went to the wrong person. Fix the form's routes, then mark the report fixed. */
export function WrongAssignmentsTab() {
  const [all, setAll] = useState(false);
  const query = useWrongAssignments(all ? "all" : "open");
  const review = useReviewWrongAssignment();
  const t = useTerms();

  function act(item: WrongAssignmentView, status: "fixed" | "dismissed") {
    review.mutate({ id: item.id, status, expectedVersion: item.version }, {
      onSuccess: () => toastManager.add({ title: status === "fixed" ? "Marked as fixed" : "Dismissed", type: "success" }),
      onError: (cause) => toastManager.add({ title: cause instanceof StaffApiError && cause.code === "version_conflict" ? "Someone already reviewed this. The list is refreshed." : "That could not be saved. Try again.", type: "error" }),
    });
  }

  return (
    <section aria-label="Bookings sent to the wrong person" className="flex flex-col gap-3">
      <div className="flex min-h-11 items-center justify-between gap-4">
        <div className="min-w-0"><Label htmlFor="routing-wrong-all" className="font-medium">Show reviewed ones too</Label><p className="text-muted-foreground text-xs">Staff flag a booking that should have gone to someone else. Use them to fix your routes.</p></div>
        <Switch id="routing-wrong-all" checked={all} onCheckedChange={setAll} />
      </div>
      {query.isPending ? <div role="status" aria-label="Loading reports" className="flex flex-col gap-2"><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /></div>
        : query.isError ? (
          <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertTitle>The list could not be loaded</AlertTitle>
            <AlertDescription><p>{query.error instanceof Error ? query.error.message : "Something went wrong."}</p><Button size="sm" variant="outline" className="mt-2 min-h-11 sm:min-h-8" onClick={() => void query.refetch()}>Try again</Button></AlertDescription></Alert>
        ) : query.data.length === 0 ? (
          <Empty className="p-6"><EmptyHeader><EmptyMedia variant="icon"><CircleCheck aria-hidden="true" /></EmptyMedia><EmptyTitle className="text-base">Nothing to fix</EmptyTitle><EmptyDescription>When staff say a {t.appointment} went to the wrong {t.provider}, it shows up here.</EmptyDescription></EmptyHeader></Empty>
        ) : (
          <ul aria-label="Reports" className="flex flex-col divide-y rounded-lg border">
            {query.data.map((item) => <Item key={item.id} item={item} busy={review.isPending} onReview={(status) => act(item, status)} />)}
          </ul>
        )}
    </section>
  );
}
