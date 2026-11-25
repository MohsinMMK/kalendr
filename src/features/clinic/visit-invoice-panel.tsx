"use client";

import { FileText, Link2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { Frame, FramePanel } from "@/components/ui/frame";
import { useTerms } from "@/features/terms/business-profile-context";
import type { InvoiceLinkResult, InvoiceList, InvoiceSummary, InvoiceView, TaxSettingsView } from "@/lib/invoicing-contracts";
import { formatMoney } from "@/lib/money";

import { useCatalogLookups } from "./clinic-catalog";
import { IssueInvoiceDialog } from "./invoice-dialogs";
import { InvoiceStateBadge } from "./invoice-parts";
import { CopyField } from "./payment-parts";
import { staffMutation, staffQuery } from "./queries/http";
import { useStaffAccess } from "./staff-access";

/** The invoice for one visit: its number and state with a link to copy, or a button to issue it. */
export function VisitInvoicePanel({ appointmentId }: { appointmentId: string }) {
  const t = useTerms();
  const access = useStaffAccess();
  const live = useCatalogLookups().database;
  const canIssue = access.can("invoices.issue");
  const enabled = live && access.can("payments.collect");
  const [invoice, setInvoice] = useState<InvoiceSummary | null | undefined>(undefined);
  const [registered, setRegistered] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [link, setLink] = useState<InvoiceLinkResult | null>(null);
  const [linkError, setLinkError] = useState("");
  const [linking, setLinking] = useState(false);
  const key = useRef(crypto.randomUUID());

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    staffQuery<InvoiceList>(`/api/staff/invoices?appointmentId=${encodeURIComponent(appointmentId)}&limit=5`, controller.signal)
      .then((list) => setInvoice(list.invoices[0] ?? null))
      .catch(() => { if (!controller.signal.aborted) { setInvoice(null); setLoadFailed(true); } });
    if (canIssue) {
      // Only a business registered for GST asks for the customer's GSTIN, so the dialog needs to know.
      staffQuery<TaxSettingsView>("/api/staff/tax-settings", controller.signal).then((settings) => setRegistered(settings.registered)).catch(() => undefined);
    }
    return () => controller.abort();
  }, [enabled, canIssue, appointmentId]);

  if (!enabled) return null;
  // Nothing until the answer is in: the visit page already has a lot of status messages, and this panel is an extra.
  if (invoice === undefined) return null;

  async function makeLink() {
    if (!invoice || linking) return;
    setLinking(true);
    setLinkError("");
    try {
      setLink(await staffMutation<InvoiceLinkResult>(`/api/staff/invoices/${invoice.id}/link`, "POST", {}, { idempotencyKey: key.current }));
      key.current = crypto.randomUUID();
    } catch (cause: unknown) {
      setLinkError(cause instanceof Error ? cause.message : "The link could not be made. Try again.");
    } finally {
      setLinking(false);
    }
  }

  function issued(next: InvoiceView) {
    setInvoice(next);
  }

  return (
    <section aria-label="Invoice">
      <Frame>
        <FramePanel className="flex flex-col gap-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-medium text-sm">Invoice</h2>
            {invoice ? <InvoiceStateBadge state={invoice.state} /> : null}
          </div>
          {invoice ? (
            <>
              <p className="text-sm"><span className="font-medium tabular-nums">{invoice.number}</span> · {formatMoney(invoice.totalMinor, invoice.currency)}{invoice.dueMinor > 0 ? ` · ${formatMoney(invoice.dueMinor, invoice.currency)} due` : ""}</p>
              {linkError ? <p role="alert" className="text-destructive-foreground text-sm">{linkError}</p> : null}
              {link ? <CopyField label="Invoice link" value={link.url} hint={`Send it to the ${t.customer} yourself.`} /> : null}
              <div className="flex items-center gap-2">
                <Button size="sm" className="min-h-11 sm:min-h-8" loading={linking} onClick={() => void makeLink()}><Link2 aria-hidden="true" />Copy invoice link</Button>
                <Link href="/billing" className={buttonVariants({ size: "sm", variant: "outline" }) + " min-h-11 sm:min-h-8"}><FileText aria-hidden="true" />Open in billing</Link>
              </div>
            </>
          ) : (
            <>
              <p className="text-muted-foreground text-sm">{loadFailed ? "Invoices could not be loaded just now. You can still issue one." : `No invoice for this ${t.visit} yet.`}</p>
              {canIssue ? <div><Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => setIssuing(true)}><FileText aria-hidden="true" />Issue invoice</Button></div> : null}
            </>
          )}
        </FramePanel>
      </Frame>
      {canIssue ? <IssueInvoiceDialog appointmentId={appointmentId} registered={registered} open={issuing} onOpenChange={setIssuing} onIssued={issued} /> : null}
    </section>
  );
}
