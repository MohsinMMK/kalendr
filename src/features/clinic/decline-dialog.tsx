"use client";

import { useState } from "react";
import { TriangleAlert } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useTerms } from "@/features/terms/business-profile-context";
import { declineReasonLabels, declineReasons, type DeclineReason } from "@/lib/approval";

export const DECLINE_MESSAGE_MAX = 500;
const reasonItems = declineReasons.map((value) => ({ value, label: declineReasonLabels[value] }));

/** Turning a request down: a reason (fixed list) and an optional message the customer will read. */
export function DeclineDialog({ open, onOpenChange, pending, error, onSubmit }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  error: string;
  onSubmit: (input: { reason: DeclineReason; message: string }) => void;
}) {
  const t = useTerms();
  const [reason, setReason] = useState<DeclineReason | null>(null);
  const [message, setMessage] = useState("");

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
      <DialogPopup showCloseButton={!pending}>
        <form onSubmit={(event) => { event.preventDefault(); if (reason && !pending) onSubmit({ reason, message: message.trim() }); }} className="contents">
          <DialogHeader>
            <DialogTitle>Decline this request</DialogTitle>
            <DialogDescription>The {t.customer} will be told it was declined and can book another time.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            {error ? <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertDescription>{error}</AlertDescription></Alert> : null}
            <Field>
              <FieldLabel>Reason</FieldLabel>
              <Select value={reason} onValueChange={(next) => { if (next) setReason(next as DeclineReason); }} items={reasonItems} disabled={pending}>
                <SelectTrigger aria-label="Reason" size="lg"><SelectValue placeholder="Choose a reason" /></SelectTrigger>
                <SelectPopup>{reasonItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectPopup>
              </Select>
            </Field>
            <Field>
              <FieldLabel>Message to the {t.customer} (they will see it)</FieldLabel>
              <Textarea
                aria-label={`Message to the ${t.customer} (they will see it)`}
                value={message}
                maxLength={DECLINE_MESSAGE_MAX}
                disabled={pending}
                onChange={(event) => setMessage(event.target.value)}
              />
              <p className="self-end text-xs text-muted-foreground tabular-nums" aria-live="polite">{message.length} / {DECLINE_MESSAGE_MAX}</p>
            </Field>
          </DialogPanel>
          <DialogFooter>
            <DialogClose disabled={pending} render={<Button type="button" variant="ghost" />}>Keep request</DialogClose>
            <Button type="submit" variant="destructive" disabled={!reason} loading={pending}>Decline</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
