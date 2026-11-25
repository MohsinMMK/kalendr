"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { SelectField, TextareaField, TextField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import { cleanGstin, gstStates, isValidGstin } from "@/lib/gst";
import type { InvoiceView } from "@/lib/invoicing-contracts";
import { formatMoney } from "@/lib/money";

import { invoiceKeys } from "./queries/invoicing";
import { StaffApiError, staffMutation } from "./queries/http";

const stateOptions = [{ value: "", label: "Same state as the business" }, ...gstStates.map((state) => ({ value: state.code, label: state.name }))];

const creditSchema = z.object({
  reason: z.string().trim().min(2, "Say why, so the books make sense later.").max(200, "Use 200 characters or fewer."),
  lineIds: z.array(z.string()).min(1, "Choose at least one line."),
});
type CreditValues = z.infer<typeof creditSchema>;

/** Takes whole lines of an issued invoice back with a numbered credit note. The money is given back separately. */
export function CreditNoteDialog({ invoice, open, onOpenChange, onIssued }: {
  invoice: InvoiceView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIssued: (next: InvoiceView) => void;
}) {
  const t = useTerms();
  const queryClient = useQueryClient();
  const open_ = invoice.lines.filter((line) => !line.creditedBy);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [message, setMessage] = useState("");
  const form = useForm<CreditValues>({ resolver: zodResolver(creditSchema), defaultValues: { reason: "", lineIds: open_.map((line) => line.id) } });
  const { register, handleSubmit, setValue, setError, control, formState: { errors, isSubmitting } } = form;
  const chosen = useWatch({ control, name: "lineIds" }) ?? [];
  const total = invoice.lines.filter((line) => chosen.includes(line.id)).reduce((sum, line) => sum + line.totalMinor, 0);

  const submit = handleSubmit(async (values) => {
    setMessage("");
    try {
      const next = await staffMutation<InvoiceView>(`/api/staff/invoices/${invoice.id}/credit-notes`, "POST", {
        // Always name the lines: it is exact, even when some were taken back by an earlier credit note.
        lineIds: values.lineIds,
        reason: values.reason.trim(),
      }, { idempotencyKey: key });
      setKey(crypto.randomUUID());
      void queryClient.invalidateQueries({ queryKey: invoiceKeys.all() });
      toastManager.add({ title: "Credit note issued", description: `${next.creditNotes.at(-1)?.number ?? ""} for ${formatMoney(total, invoice.currency)}`.trim(), type: "success" });
      onIssued(next);
      onOpenChange(false);
    } catch (cause: unknown) {
      setKey(crypto.randomUUID());
      if (cause instanceof StaffApiError && cause.fieldErrors.reason?.[0]) { setError("reason", { type: "server", message: cause.fieldErrors.reason[0] }); return; }
      if (cause instanceof StaffApiError && cause.fieldErrors.lineIds?.[0]) { setError("lineIds", { type: "server", message: cause.fieldErrors.lineIds[0] }); return; }
      setMessage(cause instanceof Error ? cause.message : "The credit note could not be issued. Try again.");
    }
  });

  function toggle(id: string, on: boolean) {
    setValue("lineIds", on ? [...chosen, id] : chosen.filter((item) => item !== id), { shouldValidate: true, shouldDirty: true });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <form noValidate aria-label="Issue credit note" className="contents" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>Issue credit note</DialogTitle>
            <DialogDescription>Takes lines of invoice {invoice.number} back. The invoice itself never changes.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            {message ? <Alert variant="error"><AlertDescription>{message}</AlertDescription></Alert> : null}
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 font-medium text-sm">Lines to take back</legend>
              {invoice.lines.map((line) => (
                <Label key={line.id} className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border px-3 py-2 sm:min-h-10">
                  <Checkbox className="mt-0.5" disabled={Boolean(line.creditedBy)} checked={!line.creditedBy && chosen.includes(line.id)} onCheckedChange={(checked) => toggle(line.id, checked === true)} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">{line.description}</span>
                    {line.creditedBy ? <span className="text-muted-foreground text-xs">Already taken back</span> : null}
                  </span>
                  <span className="tabular-nums">{formatMoney(line.totalMinor, invoice.currency)}</span>
                </Label>
              ))}
              {errors.lineIds?.message ? <p role="alert" className="text-destructive-foreground text-xs">{errors.lineIds.message}</p> : null}
            </fieldset>
            <TextareaField label="Why" rows={2} maxLength={200} placeholder="Service not given" error={errors.reason?.message} {...register("reason")} />
            <p className="rounded-lg border bg-muted/50 p-3 text-muted-foreground text-sm">
              A credit note does not give any money back. If the {t.customer} paid, use Give back in the payment screen for the {t.visit}.
            </p>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" className="min-h-11 sm:min-h-8" />}>Cancel</DialogClose>
            <Button type="submit" className="min-h-11 sm:min-h-8" loading={isSubmitting}>Issue credit note for {formatMoney(total, invoice.currency)}</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

const issueSchema = z.object({
  buyerName: z.string().trim().max(200, "Use 200 characters or fewer."),
  buyerGstin: z.string().trim().refine((value) => value === "" || isValidGstin(value), "That GSTIN does not look right. Check each character."),
  buyerStateCode: z.string(),
});
type IssueValues = z.infer<typeof issueSchema>;

/** Issues the numbered invoice or receipt for a visit. Buyer GSTIN and state matter only to a business registered for GST. */
export function IssueInvoiceDialog({ appointmentId, registered, open, onOpenChange, onIssued }: {
  appointmentId: string;
  registered: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onIssued: (invoice: InvoiceView) => void;
}) {
  const t = useTerms();
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [message, setMessage] = useState("");
  const form = useForm<IssueValues>({ resolver: zodResolver(issueSchema), defaultValues: { buyerName: "", buyerGstin: "", buyerStateCode: "" } });
  const { register, handleSubmit, setValue, setError, control, formState: { errors, isSubmitting } } = form;
  const stateCode = useWatch({ control, name: "buyerStateCode" }) ?? "";

  const submit = handleSubmit(async (values) => {
    setMessage("");
    // The server refuses empty optional values, so only what was filled in goes.
    const body: Record<string, string> = { appointmentId };
    if (values.buyerName) body.buyerName = values.buyerName;
    if (registered && values.buyerGstin) body.buyerGstin = cleanGstin(values.buyerGstin);
    if (registered && values.buyerStateCode) body.buyerStateCode = values.buyerStateCode;
    try {
      const invoice = await staffMutation<InvoiceView>("/api/staff/invoices", "POST", body, { idempotencyKey: key });
      setKey(crypto.randomUUID());
      toastManager.add({ title: `${invoice.number} issued`, type: "success" });
      onIssued(invoice);
      onOpenChange(false);
    } catch (cause: unknown) {
      setKey(crypto.randomUUID());
      if (cause instanceof StaffApiError) {
        for (const field of ["buyerName", "buyerGstin", "buyerStateCode"] as const) {
          const text = cause.fieldErrors[field]?.[0];
          if (text) { setError(field, { type: "server", message: text }); return; }
        }
      }
      setMessage(cause instanceof Error ? cause.message : "The invoice could not be issued. Try again.");
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <form noValidate aria-label="Issue invoice" className="contents" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>Issue invoice</DialogTitle>
            <DialogDescription>Once issued it gets a number and cannot be edited. Mistakes are fixed with a credit note.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            {message ? <Alert variant="error"><AlertDescription>{message}</AlertDescription></Alert> : null}
            <TextField label={`Name to print`} optional autoComplete="off" hint={`Leave it empty to use the ${t.customer}'s own name.`} error={errors.buyerName?.message} {...register("buyerName")} />
            {registered ? (
              <>
                <TextField label="Customer GSTIN" optional autoComplete="off" autoCapitalize="characters" hint="Only for a customer who is registered for GST." error={errors.buyerGstin?.message} {...register("buyerGstin")} />
                <SelectField label="Customer's state" optional value={stateCode} options={stateOptions} hint="Decides whether tax is split as CGST and SGST, or charged as IGST." onValueChange={(next) => setValue("buyerStateCode", next, { shouldDirty: true })} />
              </>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" className="min-h-11 sm:min-h-8" />}>Cancel</DialogClose>
            <Button type="submit" className="min-h-11 sm:min-h-8" loading={isSubmitting}>Issue invoice</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
