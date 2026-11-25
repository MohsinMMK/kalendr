"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Ban, FileMinus2, Link2, TriangleAlert } from "lucide-react";
import { useRef, useState } from "react";

import { ActionBar, type ActionMenuEntry } from "@/components/action-bar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ResponsiveDrawer, ResponsiveDrawerPopup } from "@/components/responsive-drawer";
import { DrawerDescription, DrawerFooter, DrawerHeader, DrawerPanel, DrawerTitle } from "@/components/ui/drawer";
import { Skeleton } from "@/components/ui/skeleton";
import { useTerms } from "@/features/terms/business-profile-context";
import { documentTitles, gstStateName, stateTaxLabel } from "@/lib/gst";
import type { InvoiceLinkResult, InvoicePaymentView, InvoiceView } from "@/lib/invoicing-contracts";
import { formatMoney } from "@/lib/money";

import { CreditNoteDialog } from "./invoice-dialogs";
import { InvoiceStateBadge, invoiceDate } from "./invoice-parts";
import { CopyField } from "./payment-parts";
import { invoiceKeys, useInvoice } from "./queries/invoicing";
import { staffMutation } from "./queries/http";
import { useStaffAccess } from "./staff-access";

const untilFormat = (iso: string) => new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" }).format(new Date(iso));

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 text-sm ${strong ? "font-medium" : ""}`}>
      <dt className={strong ? "" : "text-muted-foreground"}>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

function Party({ title, name, gstin, detail }: { title: string; name: string; gstin: string | null; detail: string | null }) {
  return (
    <section aria-label={title} className="flex min-w-0 flex-col gap-0.5 text-sm">
      <h4 className="text-muted-foreground text-xs">{title}</h4>
      <p className="break-words font-medium">{name}</p>
      {detail ? <p className="break-words text-muted-foreground">{detail}</p> : null}
      {gstin ? <p className="tabular-nums">GSTIN {gstin}</p> : null}
    </section>
  );
}

function InvoiceBody({ invoice }: { invoice: InvoiceView }) {
  const money = (minor: number) => formatMoney(minor, invoice.currency);
  const stateLabel = stateTaxLabel(invoice.sellerStateCode);
  const taxed = invoice.cgstMinor + invoice.sgstMinor + invoice.igstMinor > 0;
  return (
    <div className="flex flex-col gap-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Party title="From" name={invoice.sellerLegalName} gstin={invoice.sellerGstin} detail={invoice.sellerAddress} />
        <Party title="To" name={invoice.buyerName} gstin={invoice.buyerGstin} detail={gstStateName(invoice.buyerStateCode)} />
      </div>
      <dl className="grid gap-1">
        <Row label="Document" value={documentTitles[invoice.kind]} />
        <Row label="Financial year" value={invoice.financialYear} />
        {invoice.placeOfSupplyState ? <Row label="Place of supply" value={`${gstStateName(invoice.placeOfSupplyState) ?? invoice.placeOfSupplyState} (${invoice.supply === "inter" ? "other state" : "same state"})`} /> : null}
      </dl>
      <section aria-label="Lines">
        <h4 className="mb-1 text-muted-foreground text-xs">Lines</h4>
        <ul className="flex flex-col divide-y rounded-lg border">
          {invoice.lines.map((line) => (
            <li key={line.id} className="flex flex-col gap-1 px-3 py-2">
              <div className="flex items-baseline justify-between gap-3">
                <p className="min-w-0 break-words font-medium text-sm">{line.description}</p>
                <p className="shrink-0 font-medium text-sm tabular-nums">{money(line.totalMinor)}</p>
              </div>
              <p className="text-muted-foreground text-xs tabular-nums">
                {line.sacCode ? `HSN/SAC ${line.sacCode} · ` : ""}{line.quantity} × {money(line.unitPriceMinor)}{line.discountMinor ? ` − ${money(line.discountMinor)} off` : ""}
              </p>
              <p className="text-muted-foreground text-xs tabular-nums">
                {line.treatment === "taxable" && line.rateBps > 0
                  ? `Before tax ${money(line.taxableMinor)} · ${line.igstMinor ? `IGST ${money(line.igstMinor)}` : `CGST ${money(line.cgstMinor)} + ${stateLabel} ${money(line.sgstMinor)}`} (${line.rateBps / 100}%)`
                  : line.treatment === "exempt" ? "Exempt from GST" : "No GST charged"}
              </p>
              {line.creditedBy ? <p className="text-info-foreground text-xs">Taken back by a credit note</p> : null}
            </li>
          ))}
        </ul>
      </section>
      <dl className="grid gap-1 rounded-lg border bg-muted/50 p-3">
        <Row label="Before tax" value={money(invoice.taxableMinor)} />
        {invoice.igstMinor > 0 ? <Row label="IGST" value={money(invoice.igstMinor)} /> : null}
        {invoice.cgstMinor > 0 ? <Row label="CGST" value={money(invoice.cgstMinor)} /> : null}
        {invoice.sgstMinor > 0 ? <Row label={stateLabel} value={money(invoice.sgstMinor)} /> : null}
        {!taxed ? <Row label="Tax" value="None" /> : null}
        <Row label="Total" value={money(invoice.totalMinor)} strong />
        {invoice.creditedMinor > 0 ? <Row label="Taken back" value={`− ${money(invoice.creditedMinor)}`} /> : null}
        <Row label="Paid" value={money(invoice.paidMinor)} />
        <Row label={invoice.refundDueMinor > 0 ? "To give back" : "Still due"} value={money(invoice.refundDueMinor > 0 ? invoice.refundDueMinor : invoice.dueMinor)} strong />
      </dl>
      {invoice.exemptionNote ? <p className="text-muted-foreground text-xs">{invoice.exemptionNote}</p> : null}
      {invoice.creditNotes.length ? (
        <section aria-label="Credit notes">
          <h4 className="mb-1 text-muted-foreground text-xs">Credit notes</h4>
          <ul className="flex flex-col divide-y rounded-lg border">
            {invoice.creditNotes.map((note) => (
              <li key={note.id} className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm">
                <span className="min-w-0"><span className="font-medium tabular-nums">{note.number}</span><span className="block truncate text-muted-foreground text-xs">{invoiceDate(note.issuedAt)} · {note.reason}</span></span>
                <span className="shrink-0 tabular-nums">− {money(note.totalMinor)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <p className="rounded-lg border bg-muted/50 p-3 text-muted-foreground text-sm">An issued invoice cannot be edited. To correct a mistake, issue a credit note, then issue a new invoice.</p>
    </div>
  );
}

/** When money has to go back (a credit note on a paid invoice), each payment it came from with a one-tap refund. */
function GiveBackPanel({ invoice, canRefund, onDone }: { invoice: InvoiceView; canRefund: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const keys = useRef(new Map<string, string>());
  const methodWord = { cash: "Cash", upi: "UPI", card: "Card", bank: "Bank transfer", other: "Other" } as const;
  // Give back from the oldest payment first, never more than what is owed or what each payment still holds.
  const rows = invoice.payments.reduce<{ payment: InvoicePaymentView; amount: number }[]>((chosen, payment) => {
    const owedStill = invoice.refundDueMinor - chosen.reduce((total, row) => total + row.amount, 0);
    const amount = Math.min(payment.refundableMinor, owedStill);
    return amount > 0 ? [...chosen, { payment, amount }] : chosen;
  }, []);
  if (invoice.refundDueMinor <= 0 || rows.length === 0) return null;

  async function give(paymentId: string, amountMinor: number) {
    setBusy(paymentId);
    setError("");
    const id = `${paymentId}:${amountMinor}`;
    if (!keys.current.has(id)) keys.current.set(id, crypto.randomUUID());
    try {
      await staffMutation(`/api/staff/payments/${paymentId}/refunds`, "POST", { amountMinor, reason: `Credit note on ${invoice.number}` }, { idempotencyKey: keys.current.get(id)! });
      keys.current.delete(id);
      onDone();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "The refund could not be recorded. Try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-label="Give the money back" className="flex flex-col gap-2 rounded-lg border bg-muted/50 p-3">
      <div>
        <h4 className="font-medium text-sm">Give the money back</h4>
        <p className="text-muted-foreground text-xs">A credit note corrects the invoice, but the money has not moved yet. Record what you gave back here.</p>
      </div>
      {error ? <p role="alert" className="text-destructive-foreground text-sm">{error}</p> : null}
      <ul className="flex flex-col divide-y rounded-lg border bg-background">
        {rows.map(({ payment, amount }) => (
          <li key={payment.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
            <span className="min-w-0">{methodWord[payment.method]} · {invoiceDate(payment.at)}<span className="block text-muted-foreground text-xs">Paid {formatMoney(payment.amountMinor, invoice.currency)}</span></span>
            <Button size="sm" variant="outline" className="min-h-11 shrink-0 sm:min-h-8" disabled={!canRefund || busy !== null} loading={busy === payment.id} onClick={() => void give(payment.id, amount)}>Give back {formatMoney(amount, invoice.currency)}</Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** One invoice in full, with its actions in a single row: copy the customer's link, and a ⋯ menu for a credit note or a void. */
export function InvoiceSheet({ invoiceId, onClose }: { invoiceId: string | null; onClose: () => void }) {
  const t = useTerms();
  const access = useStaffAccess();
  const queryClient = useQueryClient();
  const query = useInvoice(invoiceId);
  const [creditOpen, setCreditOpen] = useState(false);
  const [link, setLink] = useState<InvoiceLinkResult | null>(null);
  const [linking, setLinking] = useState(false);
  const [notice, setNotice] = useState("");
  const key = useRef(crypto.randomUUID());
  const invoice = query.data;

  async function makeLink() {
    if (!invoice || linking) return;
    setLinking(true);
    setNotice("");
    try {
      setLink(await staffMutation<InvoiceLinkResult>(`/api/staff/invoices/${invoice.id}/link`, "POST", {}, { idempotencyKey: key.current }));
      key.current = crypto.randomUUID();
    } catch (cause: unknown) {
      setNotice(cause instanceof Error ? cause.message : "The link could not be made. Try again.");
    } finally {
      setLinking(false);
    }
  }

  async function tryVoid() {
    if (!invoice) return;
    setNotice("");
    try {
      await staffMutation(`/api/staff/invoices/${invoice.id}/void`, "POST", {});
    } catch (cause: unknown) {
      // The server always refuses an issued invoice and says why; show that, not our own guess.
      setNotice(cause instanceof Error ? cause.message : "An issued invoice cannot be voided. Issue a credit note instead.");
    }
  }

  const canCredit = access.can("payments.refund") && access.can("invoices.issue");
  const menu: ActionMenuEntry[] = [];
  if (invoice && canCredit) menu.push({ id: "credit-note", label: "Issue credit note…", icon: <FileMinus2 aria-hidden="true" />, hint: "Take lines back", disabled: invoice.lines.every((line) => line.creditedBy), onSelect: () => setCreditOpen(true) });
  if (invoice && access.can("invoices.issue")) menu.push({ id: "void", label: "Void", icon: <Ban aria-hidden="true" />, destructive: true, hint: "Not allowed once issued", onSelect: () => void tryVoid() });

  function close(next: boolean) {
    if (next) return;
    setLink(null);
    setNotice("");
    setCreditOpen(false);
    onClose();
  }

  return (
    <ResponsiveDrawer open={Boolean(invoiceId)} onOpenChange={close}>
      <ResponsiveDrawerPopup className="sm:max-w-lg">
        <DrawerHeader>
          <DrawerTitle className="flex flex-wrap items-center gap-2"><span className="tabular-nums">{invoice?.number ?? "Invoice"}</span>{invoice ? <InvoiceStateBadge state={invoice.state} /> : null}</DrawerTitle>
          <DrawerDescription>{invoice ? `${invoiceDate(invoice.issuedAt)} · ${invoice.buyerName}` : `Loading the ${t.customer}'s invoice…`}</DrawerDescription>
        </DrawerHeader>
        <DrawerPanel>
          {query.isPending && invoiceId ? <div role="status" aria-label="Loading invoice" className="flex flex-col gap-3"><Skeleton className="h-16 w-full" /><Skeleton className="h-40 w-full" /><Skeleton className="h-24 w-full" /></div> : null}
          {query.isError ? (
            <Alert variant="error">
              <TriangleAlert aria-hidden="true" />
              <AlertTitle>This invoice could not be loaded</AlertTitle>
              <AlertDescription>
                <p>{query.error instanceof Error ? query.error.message : "Something went wrong."}</p>
                <Button size="sm" variant="outline" className="mt-2 min-h-11 sm:min-h-8" onClick={() => void query.refetch()}>Try again</Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {invoice ? (
            <div className="flex flex-col gap-4">
              <InvoiceBody invoice={invoice} />
              <GiveBackPanel invoice={invoice} canRefund={access.can("payments.refund")} onDone={() => { void queryClient.invalidateQueries({ queryKey: invoiceKeys.all() }); void query.refetch(); }} />
              {notice ? <p role="alert" className="rounded-lg border border-destructive/32 bg-destructive/4 p-3 text-destructive-foreground text-sm">{notice}</p> : null}
              {link ? <CopyField label="Invoice link" value={link.url} hint={`Send it to the ${t.customer} yourself. Works until ${untilFormat(link.expiresAt)}.${invoice.pdfReady ? "" : " The PDF is still being made, so it opens once that is done."}`} /> : null}
            </div>
          ) : null}
        </DrawerPanel>
        {invoice ? (
          <DrawerFooter>
            <ActionBar
              overflowLabel="More actions"
              actions={[{ id: "link", label: "Copy invoice link", icon: <Link2 aria-hidden="true" />, variant: "default", pinned: true, disabled: linking, onSelect: () => void makeLink() }]}
              menu={menu}
            />
          </DrawerFooter>
        ) : null}
        {invoice ? <CreditNoteDialog key={invoice.creditNotes.length} invoice={invoice} open={creditOpen} onOpenChange={setCreditOpen} onIssued={(next) => queryClient.setQueryData(invoiceKeys.one(next.id), next)} /> : null}
      </ResponsiveDrawerPopup>
    </ResponsiveDrawer>
  );
}
