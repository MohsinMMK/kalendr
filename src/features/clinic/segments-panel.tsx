"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Copy, Pencil, Plus, Trash2, Users, UsersRound } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import type { DuplicateSide } from "@/lib/customer-contracts";
import { amountInputValue } from "@/lib/money";
import { describeFilter, type SegmentSummary } from "@/lib/segment-filter";

import { useCatalogLookups } from "./clinic-catalog";
import { MergeDialog } from "./customer-dialogs";
import { errorText, ListSkeleton, LoadFailed } from "./customer-parts";
import { customerKeys, useCustomerTags, useDuplicates, useSegmentMembers, useSegments } from "./queries/customers";
import { staffMutation } from "./queries/http";
import { SegmentBuilder } from "./segment-builder";
import { useStaffAccess } from "./staff-access";

function MembersDialog({ segment, onClose, onOpenCustomer }: { segment: SegmentSummary | null; onClose: () => void; onOpenCustomer: (id: string) => void }) {
  const t = useTerms();
  const query = useSegmentMembers(segment?.id ?? null);
  const members = query.data?.pages.flatMap((page) => page.members) ?? [];
  return (
    <Dialog open={segment !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{segment?.name}</DialogTitle>
          <DialogDescription>{segment?.count ?? 0} {segment?.count === 1 ? t.customer : t.customers} match right now.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {query.isPending ? <ListSkeleton label="Loading members" rows={3} /> : null}
          {query.isError ? <LoadFailed message="The list could not be loaded." onRetry={() => void query.refetch()} /> : null}
          {query.isSuccess && members.length === 0 ? <p className="text-muted-foreground text-sm">No {t.customers} match yet.</p> : null}
          <ul aria-label="Members" className="flex flex-col">
            {members.map((member) => (
              <li key={member.id}>
                <button type="button" className="flex min-h-11 w-full flex-col items-start rounded-md px-2 py-2 text-start hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" onClick={() => { onClose(); onOpenCustomer(member.id); }}>
                  <span className="font-medium text-sm">{member.name}</span>
                  <span className="text-muted-foreground text-xs tabular-nums">{member.phone}{member.email ? ` · ${member.email}` : ""}</span>
                </button>
              </li>
            ))}
          </ul>
          {query.hasNextPage ? <Button variant="outline" className="mt-2" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? <Spinner /> : null}Show more</Button> : null}
        </DialogPanel>
        <DialogFooter><Button variant="outline" onClick={onClose}>Close</Button></DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** The saved segments: each with a live count and its conditions in plain words. */
export function SegmentsPanel({ onOpenCustomer }: { onOpenCustomer: (id: string) => void }) {
  const t = useTerms();
  const access = useStaffAccess();
  const client = useQueryClient();
  const catalog = useCatalogLookups();
  const tags = useCustomerTags();
  const query = useSegments();
  const [editing, setEditing] = useState<SegmentSummary | "new" | null>(null);
  const [viewing, setViewing] = useState<SegmentSummary | null>(null);
  const [removing, setRemoving] = useState<SegmentSummary | null>(null);
  const canEdit = access.can("customers.manage");
  const words = {
    serviceName: (id: string) => catalog.serviceName(id),
    tagName: (id: string) => tags.data?.find((tag) => tag.id === id)?.name ?? "",
    money: (minor: number) => `₹${amountInputValue(minor)}`,
  };

  async function remove(segment: SegmentSummary) {
    try {
      await staffMutation(`/api/staff/segments/${encodeURIComponent(segment.id)}`, "DELETE", {});
      await client.invalidateQueries({ queryKey: customerKeys.segments() });
      toastManager.add({ title: "Segment deleted", description: segment.name, type: "success" });
    } catch (cause: unknown) {
      toastManager.add({ title: "Could not delete the segment", description: errorText(cause, "Try again."), type: "error" });
    }
  }

  if (query.isPending) return <div className="p-4"><ListSkeleton label="Loading segments" /></div>;
  if (query.isError) return <div className="p-4"><LoadFailed message={query.error instanceof Error ? query.error.message : "Segments could not be loaded."} onRetry={() => void query.refetch()} /></div>;
  return (
    <div className="flex flex-col">
      {canEdit && query.data.length ? (
        <div className="flex justify-end border-b px-4 py-2">
          <Button size="sm" onClick={() => setEditing("new")}><Plus aria-hidden="true" />New segment</Button>
        </div>
      ) : null}
      {query.data.length === 0 ? (
        <Empty className="p-4 md:p-6">
          <EmptyHeader>
            <EmptyMedia variant="icon"><UsersRound aria-hidden="true" /></EmptyMedia>
            <EmptyTitle className="text-base">No segments yet</EmptyTitle>
            <EmptyDescription>For example: {t.customers} who have not visited in 90 days and have agreed to marketing.</EmptyDescription>
          </EmptyHeader>
          {canEdit ? <EmptyContent><Button size="sm" onClick={() => setEditing("new")}><Plus aria-hidden="true" />New segment</Button></EmptyContent> : null}
        </Empty>
      ) : (
            <ul aria-label="Segments" className="divide-y">
              {query.data.map((segment) => (
                <li key={segment.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <button type="button" className="min-w-0 flex-1 text-start focus-visible:outline-2 focus-visible:outline-ring" onClick={() => setViewing(segment)}>
                    <span className="block font-medium text-sm">{segment.name}</span>
                    <span className="block truncate text-muted-foreground text-xs">{describeFilter(segment.filter, words)}</span>
                  </button>
                  <span className="flex items-center gap-1 text-sm tabular-nums"><Users aria-hidden="true" className="size-4 text-muted-foreground" />{segment.count}</span>
                  {canEdit ? (
                    <span className="flex gap-1">
                      <Button size="icon" variant="ghost" className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8" aria-label={`Change ${segment.name}`} onClick={() => setEditing(segment)}><Pencil aria-hidden="true" /></Button>
                      <Button size="icon" variant="ghost" className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8" aria-label={`Delete ${segment.name}`} onClick={() => setRemoving(segment)}><Trash2 aria-hidden="true" /></Button>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
      )}
      {editing !== null ? <SegmentBuilder key={editing === "new" ? "new" : editing.id + editing.version} segment={editing === "new" ? null : editing} open onOpenChange={(open) => { if (!open) setEditing(null); }} /> : null}
      <MembersDialog segment={viewing} onClose={() => setViewing(null)} onOpenCustomer={onOpenCustomer} />
      <AlertDialog open={removing !== null} onOpenChange={(open) => { if (!open) setRemoving(null); }}>
        <AlertDialogPopup>
          <AlertDialogHeader><AlertDialogTitle>Delete {removing?.name}?</AlertDialogTitle><AlertDialogDescription>The {t.customers} in it are not affected. Campaigns already sent stay as they were.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Keep it</AlertDialogClose>
            <AlertDialogClose render={<Button variant="destructive" onClick={() => { if (removing) void remove(removing); }} />}>Delete segment</AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

/** Pairs that look like one person. Each opens a side-by-side review where one profile is kept. */
export function DuplicatesPanel() {
  const t = useTerms();
  const access = useStaffAccess();
  const query = useDuplicates();
  const [reviewing, setReviewing] = useState<{ a: DuplicateSide; b: DuplicateSide; reasons: string[] } | null>(null);
  const canMerge = access.can("customers.merge");
  if (query.isPending) return <div className="p-4"><ListSkeleton label="Looking for duplicates" /></div>;
  if (query.isError) return <div className="p-4"><LoadFailed message={query.error instanceof Error ? query.error.message : "Duplicates could not be checked."} onRetry={() => void query.refetch()} /></div>;
  if (query.data.length === 0) {
    return (
      <Empty className="p-4 md:p-6">
        <EmptyHeader>
          <EmptyMedia variant="icon"><Copy aria-hidden="true" /></EmptyMedia>
          <EmptyTitle className="text-base">No possible duplicates</EmptyTitle>
          <EmptyDescription>We look for {t.customers} with the same phone number or email, or a similar name and the same birth date.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="flex flex-col">
      <p className="border-b px-4 py-2 text-muted-foreground text-xs">{canMerge ? "Merging moves everything to the profile you keep and can be undone for 30 days." : "Ask an owner or admin to merge these. Merging needs extra permission."}</p>
          <ul aria-label="Possible duplicates" className="divide-y">
            {query.data.map((pair) => (
              <li key={`${pair.a.id}:${pair.b.id}`} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm"><span className="font-medium">{pair.a.name}</span> and <span className="font-medium">{pair.b.name}</span></p>
                  <p className="text-muted-foreground text-xs">{pair.reasons.join(" · ")}</p>
                </div>
                {canMerge ? <Button size="sm" variant="outline" aria-label={`Review ${pair.a.name} and ${pair.b.name}`} onClick={() => setReviewing(pair)}>Review</Button> : null}
              </li>
            ))}
          </ul>
      <MergeDialog pair={reviewing} open={reviewing !== null} onOpenChange={(open) => { if (!open) setReviewing(null); }} />
    </div>
  );
}
