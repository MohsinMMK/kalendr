"use client";

import { useQueryClient } from "@tanstack/react-query";
import { CircleCheck, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { TextField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Skeleton } from "@/components/ui/skeleton";
import { toastManager } from "@/components/ui/toast";
import { formatMoney, } from "@/lib/money";
import type { MismatchView } from "@/lib/payments";

import { paymentKeys, usePaymentMismatches } from "./queries/payments";
import { staffMutation } from "./queries/http";

const kindText: Record<MismatchView["kind"], string> = {
  missing_here: "Paid at the provider, but not in your records",
  missing_at_provider: "In your records, but not found at the provider",
  amount_differs: "The amounts do not match",
};

function dayText(day: string): string {
  const date = new Date(`${day}T00:00:00+05:30`);
  return Number.isNaN(date.getTime()) ? day : new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(date);
}

function amounts(item: MismatchView): string {
  const provider = item.providerAmountMinor === null ? "none" : formatMoney(item.providerAmountMinor);
  const ledger = item.ledgerAmountMinor === null ? "none" : formatMoney(item.ledgerAmountMinor);
  return `Provider ${provider} · Your records ${ledger}`;
}

/**
 * Payments the provider and the books disagree about. Hidden when there are none and no account is connected;
 * with an account it says so when all is well.
 */
export function PaymentMismatchesCard({ hasAccount }: { hasAccount: boolean }) {
  const query = usePaymentMismatches();
  const queryClient = useQueryClient();
  const [resolving, setResolving] = useState<MismatchView | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const items = query.data ?? [];
  const open = items.filter((item) => !item.resolved);
  if (!hasAccount && !query.isError && (query.isPending || items.length === 0)) return null;

  async function resolve() {
    if (!resolving) return;
    setSaving(true);
    setError("");
    try {
      await staffMutation<unknown>(`/api/staff/payments/mismatches/${encodeURIComponent(resolving.id)}/resolve`, "POST", note.trim() ? { note: note.trim() } : {});
      await queryClient.invalidateQueries({ queryKey: paymentKeys.mismatches() });
      toastManager.add({ title: "Marked as sorted out.", type: "success" });
      setResolving(null);
      setNote("");
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "That could not be saved. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Frame>
      <FrameHeader>
        <FrameTitle>Needs a look</FrameTitle>
        <FrameDescription>Checked every day against your payment account. Sort these out in the provider dashboard or your records, then mark them done.</FrameDescription>
      </FrameHeader>
      <FramePanel className="flex flex-col gap-3">
        {query.isPending ? <div role="status" aria-label="Loading payments to check" className="flex flex-col gap-2"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div> : null}
        {query.isError ? (
          <Alert variant="error">
            <TriangleAlert aria-hidden="true" />
            <AlertDescription>
              <p>{query.error instanceof Error ? query.error.message : "The list could not be loaded."}</p>
              <Button size="sm" variant="outline" className="mt-2 min-h-11 sm:min-h-8" onClick={() => void query.refetch()}>Try again</Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {query.isSuccess && items.length === 0 ? (
          <p className="flex items-center gap-2 text-muted-foreground text-sm"><CircleCheck aria-hidden="true" className="size-4 text-success" />Everything matches. Nothing needs a look.</p>
        ) : null}
        {items.length ? (
          <ul className="flex flex-col divide-y rounded-lg border" aria-label="Payments that need a look">
            {items.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                <div className="min-w-0 flex-1 basis-56">
                  <p className="text-sm font-medium">{kindText[item.kind]}</p>
                  <p className="text-muted-foreground text-xs">{dayText(item.day)} · {amounts(item)}</p>
                  <p className="truncate text-muted-foreground text-xs">Provider reference {item.providerPaymentId}</p>
                </div>
                {item.resolved ? <Badge variant="outline">Sorted out</Badge> : (
                  <Button type="button" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => { setResolving(item); setNote(""); setError(""); }}>Resolve<span className="sr-only"> {kindText[item.kind]}, {dayText(item.day)}</span></Button>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {open.length === 0 && items.length > 0 ? <p className="text-muted-foreground text-sm">All of these are sorted out.</p> : null}
      </FramePanel>
      <Dialog open={resolving !== null} onOpenChange={(next) => { if (!next) setResolving(null); }}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Mark as sorted out</DialogTitle>
            <DialogDescription>This does not change any money. It only tells the team you looked at it.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-3">
            <TextField label="Note" optional maxLength={200} placeholder="Refunded by hand in the dashboard" value={note} onChange={(event) => setNote(event.target.value)} />
            {error ? <p role="alert" className="text-destructive-foreground text-sm">{error}</p> : null}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="ghost" />}>Cancel</DialogClose>
            <Button loading={saving} onClick={() => void resolve()}>Mark as sorted out</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </Frame>
  );
}
