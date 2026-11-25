"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { FileText } from "lucide-react";
import Link from "next/link";
import { useEffect } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { TextField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Frame, FrameDescription, FrameHeader, FramePanel } from "@/components/ui/frame";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { StaffApiError } from "@/features/clinic/queries/http";
import { billingSettingsInputSchema, type BillingState } from "@/lib/billing-contracts";

import { money, planName, shortDate } from "./billing-format";

const gstinMessage = "That doesn't look like a GSTIN. It has 15 letters and numbers, such as 22AAAAA0000A1Z5.";
const formSchema = z.object({
  gstin: z.string().trim().toUpperCase().refine((value) => value === "" || billingSettingsInputSchema.shape.billingGstin.safeParse(value).success, gstinMessage),
});
type Values = z.infer<typeof formSchema>;

/** The business's GSTIN for invoices. Optional; saved on its own. */
export function GstinForm({ state, onSave }: { state: BillingState; onSave: (gstin: string | null) => Promise<unknown> }) {
  const form = useForm<Values>({ resolver: zodResolver(formSchema) as never, defaultValues: { gstin: state.billingGstin ?? "" } });
  const { reset } = form;
  useEffect(() => { reset({ gstin: state.billingGstin ?? "" }); }, [state.billingGstin, reset]);
  const submit = form.handleSubmit(async (values) => {
    try {
      await onSave(values.gstin === "" ? null : values.gstin);
    } catch (cause: unknown) {
      const message = cause instanceof StaffApiError ? (cause.fieldErrors.billingGstin?.[0] ?? cause.message) : "Your GSTIN could not be saved. Try again.";
      form.setError("gstin", { message });
    }
  });
  return (
    <Frame>
      <FrameHeader>
        <h3 className="font-semibold text-sm">Billing details</h3>
        <FrameDescription className="text-xs">Add your GSTIN and it appears on every invoice from now on.</FrameDescription>
      </FrameHeader>
      <FramePanel>
        <form onSubmit={submit} noValidate className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <TextField
            label="GSTIN"
            optional
            fieldClassName="sm:max-w-xs"
            autoComplete="off"
            spellCheck={false}
            maxLength={15}
            hint="Leave it empty if you do not have one."
            error={form.formState.errors.gstin?.message}
            {...form.register("gstin")}
          />
          <Button type="submit" size="lg" variant="outline" className="sm:mt-6" disabled={form.formState.isSubmitting || !form.formState.isDirty}>
            {form.formState.isSubmitting ? <Spinner aria-hidden="true" /> : null}
            Save GSTIN
          </Button>
        </form>
      </FramePanel>
    </Frame>
  );
}

export function InvoicesTable({ state, now }: { state: BillingState; now: Date }) {
  return (
    <Frame>
      <FrameHeader>
        <h3 className="font-semibold text-sm">Invoices</h3>
        <FrameDescription className="text-xs">Each invoice includes 18% GST. Open one to print it.</FrameDescription>
      </FrameHeader>
      <FramePanel className="p-0">
        {state.invoices.length === 0 ? (
          <Empty className="py-8">
            <EmptyHeader>
              <EmptyMedia variant="icon"><FileText aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>No invoices yet</EmptyTitle>
              <EmptyDescription>Your first invoice appears here after your first payment.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Number</TableHead><TableHead>Date</TableHead><TableHead>Plan</TableHead>
                <TableHead className="text-right">Amount</TableHead><TableHead className="text-right">GST</TableHead><TableHead className="text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {state.invoices.map((invoice) => (
                <TableRow key={invoice.id}>
                  <TableCell>
                    <Link href={`/billing/invoices/${invoice.id}`} className="inline-flex min-h-11 items-center font-medium text-primary underline-offset-2 hover:underline">{invoice.invoiceNumber}</Link>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{shortDate(invoice.issuedAt, now)}</TableCell>
                  <TableCell>{planName(state, invoice.planKey)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(invoice.amountMinor, invoice.currency)}</TableCell>
                  <TableCell className="text-right tabular-nums">{money(invoice.gstMinor, invoice.currency)}</TableCell>
                  <TableCell className="text-right font-medium tabular-nums">{money(invoice.totalMinor, invoice.currency)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </FramePanel>
    </Frame>
  );
}
