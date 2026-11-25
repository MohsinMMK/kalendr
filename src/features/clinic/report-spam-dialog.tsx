"use client";

import { useState } from "react";
import { TriangleAlert } from "lucide-react";

import { OptionSelect } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { useTerms } from "@/features/terms/business-profile-context";
import { type SpamReasonCode, spamReasonCodes, spamReasonLabels } from "@/lib/spam-contact";

const options = spamReasonCodes.map((value) => ({ value, label: spamReasonLabels[value] }));

/** Flagging a booking as spam: a fixed reason. The customer is told nothing; an admin reviews the report. */
export function ReportSpamDialog({ open, onOpenChange, pending, error, repeats, onSubmit }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  error: string;
  /** True when this booking belongs to a repeating series, whose later visits are cancelled too. */
  repeats: boolean;
  onSubmit: (reasonCode: SpamReasonCode) => void;
}) {
  const t = useTerms();
  const [reason, setReason] = useState("");
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
      <DialogPopup showCloseButton={!pending}>
        <form onSubmit={(event) => { event.preventDefault(); const code = spamReasonCodes.find((value) => value === reason); if (code && !pending) onSubmit(code); }} className="contents">
          <DialogHeader>
            <DialogTitle>Report as spam</DialogTitle>
            <DialogDescription>
              This {t.appointment}{repeats ? " and every repeat after it" : ""} will be cancelled without telling the {t.customer}. An admin then decides whether to block the contact.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            {error ? <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertDescription>{error}</AlertDescription></Alert> : null}
            <Field>
              <FieldLabel>Why is it spam?</FieldLabel>
              <OptionSelect aria-label="Why is it spam?" value={reason} onValueChange={setReason} options={options} placeholder="Choose a reason" disabled={pending} />
            </Field>
          </DialogPanel>
          <DialogFooter>
            <DialogClose disabled={pending} render={<Button type="button" variant="ghost" />}>Keep {t.appointment}</DialogClose>
            <Button type="submit" variant="destructive" disabled={!reason} loading={pending}>Report and cancel</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
