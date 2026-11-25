"use client";

import { FileSpreadsheet, FileText, Lock, Receipt, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { ActionBar, type ActionMenuEntry } from "@/components/action-bar";
import { OptionSelect } from "@/components/form-fields";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toastManager } from "@/components/ui/toast";
import { WorkspaceFrame, WorkspacePage } from "@/components/workspace-page";
import { useTerms } from "@/features/terms/business-profile-context";
import type { InvoiceSummary } from "@/lib/invoicing-contracts";
import { formatMoney } from "@/lib/money";

import { useCatalogLookups } from "./clinic-catalog";
import { DayEndDialog } from "./day-end-dialog";
import { InvoiceSheet } from "./invoice-sheet";
import { downloadFile, InvoiceStateBadge, currentMonth, invoiceDate, monthLabel, recentMonths } from "./invoice-parts";
import { useInvoiceList, type InvoiceStateFilter } from "./queries/invoicing";
import { useStaffAccess } from "./staff-access";
import { TaxSettingsPanel } from "./tax-settings-panel";

const stateOptions: { value: InvoiceStateFilter; label: string }[] = [
  { value: "all", label: "All invoices" },
  { value: "due", label: "Money due" },
  { value: "paid", label: "Paid" },
  { value: "credited", label: "Credited" },
];

function InvoiceRow({ invoice, onOpen }: { invoice: InvoiceSummary; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex min-h-14 w-full items-center justify-between gap-3 px-3 py-2 text-start outline-none hover:bg-accent/50 focus-visible:bg-accent">
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium text-sm tabular-nums">{invoice.number}</span>
          <span className="truncate text-muted-foreground text-xs">{invoice.buyerName} · {invoiceDate(invoice.issuedAt)}</span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <span className="font-medium text-sm tabular-nums">{formatMoney(invoice.totalMinor, invoice.currency)}</span>
          <InvoiceStateBadge state={invoice.state} />
        </span>
      </button>
    </li>
  );
}

type InvoiceFilters = { state: InvoiceStateFilter; month: string };

/** Show, Month and the export menu sit in the frame's toolbar, so the page owns them. */
function useInvoiceFilters() {
  const access = useStaffAccess();
  const [filters, setFilters] = useState<InvoiceFilters>({ state: "all", month: "" });
  const [exporting, setExporting] = useState(false);
  const [months] = useState(() => recentMonths(24));
  const [thisMonth] = useState(() => currentMonth());
  const exportMonth = filters.month || thisMonth;

  async function exportFile(kind: "documents" | "gst-summary") {
    if (exporting) return;
    setExporting(true);
    try {
      await downloadFile(`/api/staff/invoices/export?month=${exportMonth}&kind=${kind}`, `${kind}-${exportMonth}.csv`);
    } catch (cause: unknown) {
      toastManager.add({ title: cause instanceof Error ? cause.message : "The file could not be made. Try again.", type: "error" });
    } finally {
      setExporting(false);
    }
  }

  const menu: ActionMenuEntry[] = access.can("invoices.issue") ? [
    { kind: "label", id: "export-label", label: `For ${monthLabel(exportMonth)}` },
    { id: "export-documents", label: "Download invoices (CSV)", icon: <FileSpreadsheet aria-hidden="true" />, hint: "For your accountant", disabled: exporting, onSelect: () => void exportFile("documents") },
    { id: "export-gst", label: "Download GST summary (CSV)", icon: <FileText aria-hidden="true" />, hint: "Totals by tax rate", disabled: exporting, onSelect: () => void exportFile("gst-summary") },
  ] : [];

  const controls = (
    <>
      <OptionSelect aria-label="Show" className="w-36 min-w-0" value={filters.state} options={stateOptions} onValueChange={(next) => setFilters((current) => ({ ...current, state: (next || "all") as InvoiceStateFilter }))} />
      <OptionSelect aria-label="Month" className="w-40 min-w-0" value={filters.month} options={[{ value: "", label: "Every month" }, ...months.map((value) => ({ value, label: monthLabel(value) }))]} onValueChange={(month) => setFilters((current) => ({ ...current, month }))} />
      {menu.length ? <ActionBar className="flex-none" actions={[]} menu={menu} overflowLabel="Download and export" /> : null}
    </>
  );
  return { filters, clear: () => setFilters({ state: "all", month: "" }), controls };
}

function InvoicesTab({ filters: { state, month }, onClear }: { filters: InvoiceFilters; onClear: () => void }) {
  const t = useTerms();
  const [openId, setOpenId] = useState<string | null>(null);
  const query = useInvoiceList({ state, month });
  const invoices = query.data?.pages.flatMap((page) => page.invoices) ?? [];

  return (
    <div className="flex flex-1 flex-col">


      {query.isPending ? (
        <div role="status" aria-label="Loading invoices" className="flex flex-col gap-2 p-4"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div>
      ) : query.isError && !invoices.length ? (
        <Alert variant="error" className="m-4 w-auto">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Invoices could not be loaded</AlertTitle>
          <AlertDescription>
            <p>{query.error instanceof Error ? query.error.message : "Something went wrong."}</p>
            <Button size="sm" variant="outline" className="mt-2 min-h-11 sm:min-h-8" onClick={() => void query.refetch()}>Try again</Button>
          </AlertDescription>
        </Alert>
      ) : !invoices.length ? (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon"><Receipt aria-hidden="true" /></EmptyMedia>
            <EmptyTitle>{state === "all" && !month ? "No invoices yet" : "No invoices match"}</EmptyTitle>
            <EmptyDescription>{state === "all" && !month ? `Open ${/^[aeiou]/i.test(t.visit) ? "an" : "a"} ${t.visit} and choose Issue invoice. It shows up here.` : "Try another month or another filter."}</EmptyDescription>
          </EmptyHeader>
          {state !== "all" || month ? <EmptyContent><Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={onClear}>Clear filters</Button></EmptyContent> : null}
        </Empty>
      ) : (
        <>
          <ul aria-label="Invoices" className="flex flex-col divide-y">
            {invoices.map((invoice) => <InvoiceRow key={invoice.id} invoice={invoice} onOpen={() => setOpenId(invoice.id)} />)}
          </ul>
          {query.isError ? <p role="alert" className="px-4 py-2 text-destructive-foreground text-sm">More invoices could not be loaded. {query.error instanceof Error ? query.error.message : ""}</p> : null}
          {query.hasNextPage ? (
            <div className="flex justify-center border-t p-3">
              <Button variant="outline" className="min-h-11 sm:min-h-8" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>Show more</Button>
            </div>
          ) : null}
        </>
      )}
      <InvoiceSheet invoiceId={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}

/** The day-end dialog already counts the till; this tab only opens it, so there is one copy of that screen. */
function DayEndTab() {
  const t = useTerms();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col items-start gap-3">
      <h2 className="sr-only">Day end</h2>
      <p className="max-w-prose text-sm">Count what came in by cash, UPI, card and bank, compare it with the till, and close the day. A closed day cannot change. Money from every {t.visit} is added up for you.</p>
      <Button className="min-h-11 sm:min-h-8" onClick={() => setOpen(true)}><Lock aria-hidden="true" />Open day end</Button>
      <DayEndDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}

/** Billing: invoices, the day-end count and GST settings. Needs the database; the preview keeps no invoices. */
export function BillingWorkspace() {
  const t = useTerms();
  const access = useStaffAccess();
  const live = useCatalogLookups().database;
  const [tab, setTab] = useState("invoices");
  const canSeeTax = access.can("invoices.issue");
  const canCloseDay = access.can("payments.close_day");
  const invoices = useInvoiceFilters();

  if (!live) {
    return (
      <WorkspacePage nav="billing">
      <WorkspaceFrame>
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon"><Receipt aria-hidden="true" /></EmptyMedia>
          <EmptyTitle>Billing is not available in the preview</EmptyTitle>
          <EmptyDescription>Invoices, day end and GST settings need the {t.business} database. Nothing here is stored in the preview.</EmptyDescription>
        </EmptyHeader>
      </Empty>
      </WorkspaceFrame>
      </WorkspacePage>
    );
  }

  return (
    <WorkspacePage nav="billing">
      <Tabs value={tab} onValueChange={(next) => setTab(String(next))} className="gap-0">
        <WorkspaceFrame
          flush={tab === "invoices"}
          panelClassName={tab === "tax" ? "gap-4" : undefined}
          start={
            <TabsList variant="underline" aria-label="Billing">
              <TabsTrigger value="invoices" className="pointer-coarse:min-h-11">Invoices</TabsTrigger>
              {canCloseDay ? <TabsTrigger value="day-end" className="pointer-coarse:min-h-11">Day end</TabsTrigger> : null}
              {canSeeTax ? <TabsTrigger value="tax" className="pointer-coarse:min-h-11">Tax settings</TabsTrigger> : null}
            </TabsList>
          }
          end={tab === "invoices" ? invoices.controls : null}
        >
          <TabsContent value="invoices" className="flex flex-1 flex-col"><InvoicesTab filters={invoices.filters} onClear={invoices.clear} /></TabsContent>
          {canCloseDay ? <TabsContent value="day-end"><DayEndTab /></TabsContent> : null}
          {canSeeTax ? <TabsContent value="tax" className="flex flex-col gap-4"><TaxSettingsPanel /></TabsContent> : null}
        </WorkspaceFrame>
      </Tabs>
    </WorkspacePage>
  );
}
