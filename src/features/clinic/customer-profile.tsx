"use client";

import { Ban, CalendarDays, Copy, History, Merge, Pencil, Pin, ShieldCheck, Undo2, UserRoundCheck, Wallet } from "lucide-react";
import { useMemo, useState } from "react";

import type { ActionMenuEntry, BarAction } from "@/components/action-bar";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PersonAvatar } from "@/components/person-avatar";
import { toastManager } from "@/components/ui/toast";
import { WorkspacePage } from "@/components/workspace-page";
import { useTerms } from "@/features/terms/business-profile-context";
import type { CustomerSummary } from "@/lib/customer-contracts";
import { formatMoney } from "@/lib/money";

import { BlockDialog, MergeWithDialog, useUnblock, useUndoMerge } from "./customer-dialogs";
import { dateTimeLabel, dayLabel, LoadFailed } from "./customer-parts";
import { CustomerTagsEditor } from "./customer-tags";
import { useCustomerSummary } from "./queries/customers";
import { useStaffAccess } from "./staff-access";
import { Fact } from "./task-ui";

/**
 * A dialog opened from the ⋯ menu waits for the menu to finish closing. On a phone the menu is a bottom sheet in the top
 * layer, and a dialog opened in the same tick would sit under it and never receive a tap.
 */
function afterMenuCloses(open: () => void): void {
  window.setTimeout(open, 250);
}

/**
 * The profile's actions: Edit details and Book stay in the row; copy, Block and Merge live in the ⋯ menu (a bottom
 * sheet on a phone). Returns the dialogs too, so the page only has to render them once.
 */
export function useCustomerActions({ patient, live, onEdit, onBook, recordsHref }: {
  patient: { id: string; firstName: string; lastName: string; phone: string; email: string };
  live: boolean;
  onEdit?: () => void;
  onBook: () => void;
  recordsHref?: string;
}): { bar: BarAction[]; menu: ActionMenuEntry[]; dialogs: React.ReactNode } {
  const access = useStaffAccess();
  const summary = useCustomerSummary(patient.id, live);
  const [blocking, setBlocking] = useState(false);
  const [merging, setMerging] = useState(false);
  const unblock = useUnblock(patient.id, `${patient.firstName} ${patient.lastName}`.trim());
  const name = `${patient.firstName} ${patient.lastName}`.trim();
  const blocked = Boolean(summary.data?.blocked);

  const copy = (label: string, value: string) => () => {
    if (!navigator.clipboard) { toastManager.add({ title: `${label} could not be copied`, type: "error" }); return; }
    void navigator.clipboard.writeText(value).then(
      () => toastManager.add({ title: `${label} copied`, description: value, type: "success" }),
      () => toastManager.add({ title: `${label} could not be copied`, type: "error" }),
    );
  };

  const bar = useMemo<BarAction[]>(() => [
    { id: "book", label: "Book", icon: <CalendarDays aria-hidden="true" />, variant: "default", onSelect: onBook, pinned: true, priority: 3 },
    ...(onEdit ? [{ id: "edit", label: "Edit details", icon: <Pencil aria-hidden="true" />, onSelect: onEdit, priority: 2 }] : []),
  ], [onBook, onEdit]);

  const menu: ActionMenuEntry[] = [
    { id: "copy-phone", label: "Copy phone", icon: <Copy aria-hidden="true" />, onSelect: copy("Phone", patient.phone), disabled: !patient.phone },
    { id: "copy-email", label: "Copy email", icon: <Copy aria-hidden="true" />, onSelect: copy("Email", patient.email), disabled: !patient.email },
    ...(recordsHref ? [{ id: "records", label: "Records", icon: <ShieldCheck aria-hidden="true" />, href: recordsHref }] : []),
    ...(live && access.can("customers.manage") ? [
      { kind: "separator" as const, id: "sep-block" },
      blocked
        ? { id: "unblock", label: "Allow to book online again", icon: <UserRoundCheck aria-hidden="true" />, onSelect: () => void unblock() }
        : { id: "block", label: "Block from booking online…", icon: <Ban aria-hidden="true" />, destructive: true, onSelect: () => afterMenuCloses(() => setBlocking(true)) },
    ] : []),
    ...(live && access.can("customers.merge") ? [{ id: "merge", label: "Merge with another profile…", icon: <Merge aria-hidden="true" />, onSelect: () => afterMenuCloses(() => setMerging(true)) }] : []),
  ];

  const dialogs = live ? (
    <>
      <BlockDialog patientId={patient.id} name={name} open={blocking} onOpenChange={setBlocking} />
      <MergeWithDialog current={{ id: patient.id, name, phone: patient.phone, email: patient.email, dateOfBirth: null, visits: summary.data?.visits ?? 0, lastVisitAt: summary.data?.lastVisit?.startsAt ?? null }} open={merging} onOpenChange={setMerging} />
    </>
  ) : null;
  return { bar, menu, dialogs };
}

function SummaryFacts({ summary }: { summary: CustomerSummary }) {
  const t = useTerms();
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-5">
      <Fact label={`Next ${t.appointment}`}>
        {summary.nextVisit ? <><span className="block tabular-nums">{dateTimeLabel(summary.nextVisit.startsAt)}</span><span className="block text-muted-foreground text-xs">{summary.nextVisit.serviceName}</span></> : "None booked"}
      </Fact>
      <Fact label={`Last ${t.appointment}`}>
        {summary.lastVisit ? <><span className="block tabular-nums">{dayLabel(summary.lastVisit.startsAt)}</span><span className="block text-muted-foreground text-xs">{summary.lastVisit.serviceName}</span></> : `No finished ${t.appointments}`}
      </Fact>
      <Fact label={t.Appointments}>
        <span className="tabular-nums">{summary.visits}</span> done
        <span className="block text-xs text-muted-foreground tabular-nums">{summary.noShows} {summary.noShows === 1 ? "no-show" : "no-shows"}</span>
      </Fact>
      {summary.balanceOwedMinor !== null ? (
        <Fact label="Balance owed">
          {summary.balanceOwedMinor > 0 ? <Badge variant="warning" size="lg"><Wallet aria-hidden="true" /><span className="tabular-nums">{formatMoney(summary.balanceOwedMinor, summary.currency)}</span></Badge> : "Nothing owed"}
        </Fact>
      ) : null}
      <Fact label="Package credits">{summary.packageCredits > 0 ? <span className="tabular-nums">{summary.packageCredits} left</span> : "None"}</Fact>
    </dl>
  );
}

/** What staff need in the first three seconds, above the tabs. Silent in preview, where there is no database. */
export function CustomerSummaryStrip({ patientId, live }: { patientId: string; live: boolean }) {
  const t = useTerms();
  const access = useStaffAccess();
  const query = useCustomerSummary(patientId, live);
  const unblock = useUnblock(patientId, "This " + t.customer);
  const undo = useUndoMerge();
  if (!live) return null;
  if (query.isPending) return <div role="status" aria-label="Loading profile summary" className="flex flex-col gap-3"><Skeleton className="h-16 w-full" /><Skeleton className="h-8 w-2/3" /></div>;
  if (query.isError) return <LoadFailed message={query.error instanceof Error ? query.error.message : "The summary could not be loaded."} onRetry={() => void query.refetch()} />;
  const summary = query.data;
  return (
    <div className="flex flex-col gap-3" data-testid="customer-summary">
      {summary.blocked ? (
        <Alert variant="warning" role="alert">
          <Ban aria-hidden="true" />
          <AlertTitle>Blocked from booking online</AlertTitle>
          <AlertDescription>{summary.blocked.reason ? `${summary.blocked.reason}. ` : ""}Blocked {dayLabel(summary.blocked.at)}{summary.blocked.byName ? ` by ${summary.blocked.byName}` : ""}. You can still book them at the desk.</AlertDescription>
          {access.can("customers.manage") ? <AlertAction><Button size="sm" variant="outline" onClick={() => void unblock()}>Unblock</Button></AlertAction> : null}
        </Alert>
      ) : null}
      {summary.recentMerge ? (
        <Alert variant="info">
          <History aria-hidden="true" />
          <AlertTitle>Another profile was merged into this one</AlertTitle>
          <AlertDescription>You can undo it until {dayLabel(summary.recentMerge.undoUntil)}.</AlertDescription>
          {access.can("customers.merge") ? <AlertAction><Button size="sm" variant="outline" onClick={() => void undo(summary.recentMerge?.id ?? "")}><Undo2 aria-hidden="true" />Undo merge</Button></AlertAction> : null}
        </Alert>
      ) : null}
      <SummaryFacts summary={summary} />
      <CustomerTagsEditor patientId={patientId} current={summary.tags} canEdit={access.can("customers.manage")} />
      {summary.pinnedNote ? (
        <div className="flex gap-2 rounded-lg border bg-muted/40 p-3 text-sm" role="note" aria-label="Pinned at the top of the profile">
          <Pin aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="whitespace-pre-wrap break-words">{summary.pinnedNote.body}</p>
            <p className="mt-1 text-muted-foreground text-xs">{summary.pinnedNote.authorName}, {dayLabel(summary.pinnedNote.updatedAt)}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}



/** A customer's page: avatar and name as the title, one row of actions, the ⋯ menu, and the dialogs those open. */
export function CustomerProfilePage({ patient, live, badge, back, onEdit, onBook, recordsHref, children }: {
  patient: { id: string; firstName: string; lastName: string; phone: string; email: string };
  live: boolean;
  badge?: React.ReactNode;
  back: { label: string; onClick: () => void };
  onEdit?: () => void;
  onBook: () => void;
  recordsHref?: string;
  children: React.ReactNode;
}) {
  const { bar, menu, dialogs } = useCustomerActions({ patient, live, onEdit, onBook, recordsHref });
  const name = `${patient.firstName} ${patient.lastName}`.trim();
  return (
    <WorkspacePage
      back={back}
      title={<span className="flex min-w-0 items-center gap-2"><PersonAvatar name={name} className="size-7" /><span className="truncate">{name}</span>{badge}</span>}
      bar={bar}
      menu={menu}
    >
      {children}
      {dialogs}
    </WorkspacePage>
  );
}
