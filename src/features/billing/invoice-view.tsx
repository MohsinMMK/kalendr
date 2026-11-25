"use client";

import { ArrowLeft, Printer, TriangleAlert } from "lucide-react";
import Link from "next/link";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StaffQueryProvider } from "@/features/clinic/queries/client";
import type { BillingInvoice } from "@/lib/billing-contracts";

import { useBillingState } from "./billing-api";
import { money, planName } from "./billing-format";

const kalendrName = "Kalendr";

function longDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "long", year: "numeric" }).format(date);
}

/** The paper invoice: seller, buyer, one line for the plan, and the 18% GST split. Built from the billing state, nothing extra. */
export function InvoiceDocument({ invoice, businessName, plan }: { invoice: BillingInvoice; businessName: string; plan: string }) {
  return (
    <article aria-label={`Invoice ${invoice.invoiceNumber}`} className="mx-auto w-full max-w-2xl rounded-xl border bg-background p-6 sm:p-8 print:max-w-none print:rounded-none print:border-0 print:p-0">
      <header className="flex flex-wrap items-start justify-between gap-4 border-b pb-4">
        <div>
          <h1 className="font-heading text-2xl font-semibold">Tax invoice</h1>
          <p className="mt-1 text-sm text-muted-foreground">{invoice.invoiceNumber}</p>
        </div>
        <p className="text-sm tabular-nums">Date: {longDate(invoice.issuedAt)}</p>
      </header>
      <dl className="grid gap-4 py-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs font-medium text-muted-foreground">From</dt>
          <dd className="font-medium">{kalendrName}</dd>
          <dd className="text-muted-foreground">GSTIN: {invoice.kalendrGstin ?? "Not given"}</dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-muted-foreground">Bill to</dt>
          <dd className="font-medium">{businessName}</dd>
          <dd className="text-muted-foreground">GSTIN: {invoice.buyerGstin ?? "Not given"}</dd>
        </div>
      </dl>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-y text-left text-xs text-muted-foreground"><th scope="col" className="py-2 font-medium">Item</th><th scope="col" className="py-2 text-right font-medium">Amount</th></tr>
        </thead>
        <tbody className="tabular-nums">
          <tr><td className="py-2">{plan} plan, monthly subscription</td><td className="py-2 text-right">{money(invoice.amountMinor, invoice.currency)}</td></tr>
          <tr><td className="py-2 text-muted-foreground">GST at 18%</td><td className="py-2 text-right">{money(invoice.gstMinor, invoice.currency)}</td></tr>
          <tr className="border-t font-semibold"><td className="py-2">Total</td><td className="py-2 text-right">{money(invoice.totalMinor, invoice.currency)}</td></tr>
        </tbody>
      </table>
      <p className="mt-6 text-xs text-muted-foreground">This invoice is computer generated. Amounts are in {invoice.currency}.</p>
    </article>
  );
}

function InvoiceBody({ invoiceId, clinicName }: { invoiceId: string; clinicName: string }) {
  const query = useBillingState(true);
  const invoice = query.data?.invoices.find((item) => item.id === invoiceId);
  return (
    <main className="min-h-svh bg-muted/40 p-4 sm:p-8 print:bg-background print:p-0">
      <div className="mx-auto mb-4 flex w-full max-w-2xl items-center justify-between gap-3 print:hidden">
        <Button variant="ghost" render={<Link href="/settings" />}><ArrowLeft aria-hidden="true" /> Back to settings</Button>
        {invoice ? <Button onClick={() => window.print()}><Printer aria-hidden="true" /> Print</Button> : null}
      </div>
      {query.isPending ? (
        <div role="status" aria-label="Loading the invoice" className="mx-auto flex max-w-2xl flex-col gap-3"><Skeleton className="h-8 w-48" /><Skeleton className="h-64 w-full" /></div>
      ) : query.isError ? (
        <Alert variant="error" className="mx-auto max-w-2xl">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>{query.error instanceof Error ? query.error.message : "The invoice could not be loaded."}</span>
            <Button size="sm" variant="outline" onClick={() => void query.refetch()}>Try again</Button>
          </AlertDescription>
        </Alert>
      ) : invoice && query.data ? (
        <InvoiceDocument invoice={invoice} businessName={clinicName} plan={planName(query.data, invoice.planKey)} />
      ) : (
        <Alert variant="warning" className="mx-auto max-w-2xl"><AlertDescription>We could not find this invoice. Go back to Plan and billing and pick one from the list.</AlertDescription></Alert>
      )}
    </main>
  );
}

export function InvoicePage({ invoiceId, clinicSlug, clinicName, userId, preview }: { invoiceId: string; clinicSlug: string; clinicName: string; userId: string | null; preview: boolean }) {
  return (
    <StaffQueryProvider scope={`${clinicSlug}:${userId ?? "preview"}`}>
      {preview
        ? <main className="p-8"><Alert variant="info" className="mx-auto max-w-2xl"><AlertDescription>Invoices are not part of the preview.</AlertDescription></Alert></main>
        : <InvoiceBody invoiceId={invoiceId} clinicName={clinicName} />}
    </StaffQueryProvider>
  );
}
