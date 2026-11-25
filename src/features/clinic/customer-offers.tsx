"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Ticket, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { ActionBar, type ActionMenuEntry } from "@/components/action-bar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { toastManager } from "@/components/ui/toast";
import type { CreditEntryView, CustomerMembershipView, CustomerPackageView } from "@/lib/offers-contracts";

import { useCatalogLookups } from "./clinic-catalog";
import { AdjustCreditsDialog, RenewMembershipDialog, SellPackageDialog, StartMembershipDialog } from "./customer-offers-dialogs";
import { creditsLeftText, ledgerLine, MembershipStatusBadge, offerDay, offerDayYear, PackageStatusBadge } from "./offers-parts";
import { staffMutation } from "./queries/http";
import { offerKeys, useCustomerOffers, useOffers } from "./queries/offers";
import { useStaffAccess } from "./staff-access";

/** Every change to a package, newest first, each with its reason and what was left afterwards. */
function Ledger({ entries }: { entries: CreditEntryView[] }) {
  const oldestFirst = [...entries].sort((a, b) => a.at.localeCompare(b.at));
  const lines = oldestFirst.map((entry, index) => ({ entry, left: oldestFirst.slice(0, index + 1).reduce((sum, item) => sum + item.change, 0) })).reverse();
  return (
    <ul aria-label="History" className="mt-2 flex flex-col divide-y rounded-lg border">
      {lines.map(({ entry, left }) => {
        const line = ledgerLine(entry);
        return (
          <li key={entry.id} className="flex items-baseline justify-between gap-3 px-3 py-2 text-sm">
            <span className="flex min-w-0 flex-col">
              <span className="font-medium">{line.title}</span>
              <span className="break-words text-muted-foreground text-xs">{entry.reason} · {offerDayYear(entry.at)}</span>
            </span>
            <span className="flex shrink-0 flex-col items-end tabular-nums">
              <span className="font-medium">{line.change}</span>
              <span className="text-muted-foreground text-xs">{left} left</span>
            </span>
          </li>
        );
      })}
      {!lines.length ? <li className="px-3 py-2 text-muted-foreground text-sm">Nothing has happened yet.</li> : null}
    </ul>
  );
}

function PackageCard({ pack, serviceName }: { pack: CustomerPackageView; serviceName: (id: string) => string }) {
  const [open, setOpen] = useState(false);
  const covers = pack.serviceIds.length <= 2 ? pack.serviceIds.map(serviceName).join(", ") : `${pack.serviceIds.length} services`;
  return (
    <li className="flex flex-col gap-1 rounded-lg border p-3">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex items-start justify-between gap-3">
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="break-words font-medium text-sm">{pack.name}</span>
            <span className="font-medium text-sm tabular-nums">{creditsLeftText(pack.remaining, pack.creditsTotal)}</span>
            <span className="text-muted-foreground text-xs">{pack.status === "expired" ? "Ran out on" : "Valid until"} {offerDay(pack.expiresAt)}{covers ? ` · ${covers}` : ""}</span>
          </span>
          <PackageStatusBadge status={pack.status} />
        </div>
        <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="-ms-2 mt-1 min-h-11 sm:min-h-8" />}>
          <ChevronDown aria-hidden="true" className={open ? "rotate-180 transition-transform" : "transition-transform"} />
          History ({pack.ledger.length})
        </CollapsibleTrigger>
        <CollapsiblePanel><Ledger entries={pack.ledger} /></CollapsiblePanel>
      </Collapsible>
    </li>
  );
}

function MembershipCard({ membership, patientId, canCollect, onRenew }: { membership: CustomerMembershipView; patientId: string; canCollect: boolean; onRenew: () => void }) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState("");

  async function change(action: "pause" | "resume" | "cancel") {
    setNotice("");
    try {
      await staffMutation(`/api/staff/memberships/${membership.id}`, "POST", { action });
      void queryClient.invalidateQueries({ queryKey: offerKeys.customer(patientId) });
      void queryClient.invalidateQueries({ queryKey: offerKeys.all() });
      toastManager.add({ title: action === "pause" ? "Membership paused" : action === "resume" ? "Membership resumed" : "Membership cancelled", description: membership.planName, type: "success" });
    } catch (cause: unknown) {
      // A membership billed by the payment provider is refused with the reason; show it as it comes.
      setNotice(cause instanceof Error ? cause.message : "The membership could not be changed. Try again.");
    }
  }

  const live = membership.status !== "cancelled";
  const menu: ActionMenuEntry[] = [];
  if (membership.status === "active" || membership.status === "past_due") menu.push({ id: "pause", label: "Pause", onSelect: () => void change("pause") });
  if (membership.status === "paused") menu.push({ id: "resume", label: "Resume", onSelect: () => void change("resume") });
  if (live) menu.push({ id: "cancel", label: "Cancel membership", destructive: true, onSelect: () => void change("cancel") });

  return (
    <li className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-start justify-between gap-3">
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="break-words font-medium text-sm">{membership.planName}</span>
          <span className="text-muted-foreground text-xs">{membership.status === "cancelled" ? "Ended" : "Paid up to"} {offerDay(membership.currentPeriodEnd)}</span>
        </span>
        <MembershipStatusBadge membership={membership} />
      </div>
      {notice ? <p role="alert" className="rounded-lg border border-destructive/32 bg-destructive/4 p-2 text-destructive-foreground text-sm">{notice}</p> : null}
      {live && canCollect ? (
        <ActionBar
          className="justify-start"
          overflowLabel={`More for ${membership.planName}`}
          actions={[{ id: "renew", label: "Record this month's payment", pinned: true, onSelect: onRenew }]}
          menu={menu}
        />
      ) : null}
    </li>
  );
}

/**
 * The customer's packages and memberships on their profile: each package with its balance, expiry and a history that
 * explains every change, and the actions to sell, adjust or start. Silent in the preview and without database access.
 */
export function CustomerOffersSection({ patientId, className }: { patientId: string; className?: string }) {
  const live = useCatalogLookups().database;
  const allowed = useStaffAccess().can("schedule.read");
  // The queries live one level down, so the preview (and a screen with no query cache) never starts them.
  return live && allowed ? <CustomerOffers patientId={patientId} className={className} /> : null;
}

function CustomerOffers({ patientId, className }: { patientId: string; className?: string }) {
  const access = useStaffAccess();
  const catalog = useCatalogLookups();
  const offers = useCustomerOffers(patientId);
  const summary = useOffers(offers.isSuccess);
  const [dialog, setDialog] = useState<"sell" | "adjust" | "membership" | null>(null);
  const [renewing, setRenewing] = useState<CustomerMembershipView | null>(null);
  const canSell = access.can("payments.collect") && access.can("invoices.issue");
  const canAdjust = access.can("payments.refund");
  const adjustable = (offers.data?.packages ?? []).filter((pack) => pack.status !== "expired");
  const menu: ActionMenuEntry[] = [];
  if (canAdjust) menu.push({ id: "adjust", label: "Adjust credits…", hint: "Add or take away", disabled: !adjustable.length, onSelect: () => setDialog("adjust") });
  if (canSell) menu.push({ id: "membership", label: "Start a membership…", hint: "Billed by hand", disabled: !summary.data, onSelect: () => setDialog("membership") });
  const hasBar = canSell || menu.length > 0;

  return (
    <section aria-label="Packages and memberships" className={`flex flex-col gap-3 ${className ?? ""}`}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-medium text-sm">Packages and memberships</h3>
        {hasBar ? (
          <ActionBar className="flex-none" overflowLabel="More package actions" actions={canSell ? [{ id: "sell", label: "Sell a package", icon: <Ticket aria-hidden="true" />, pinned: true, variant: "outline", disabled: !summary.data, onSelect: () => setDialog("sell") }] : []} menu={menu} />
        ) : null}
      </div>

      {offers.isPending ? (
        <div role="status" aria-label="Loading packages" className="flex flex-col gap-2"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>
      ) : offers.isError || !offers.data ? (
        <Alert variant="error">
          <TriangleAlert aria-hidden="true" />
          <AlertDescription>
            <p>{offers.error instanceof Error ? offers.error.message : "Packages could not be loaded."}</p>
            <Button type="button" size="sm" variant="outline" className="mt-2 min-h-11 sm:min-h-8" onClick={() => void offers.refetch()}>Try again</Button>
          </AlertDescription>
        </Alert>
      ) : !offers.data.packages.length && !offers.data.memberships.length ? (
        <p className="text-muted-foreground text-sm">No packages or memberships yet.</p>
      ) : (
        <>
          {offers.data.packages.length ? <ul aria-label="Packages" className="flex flex-col gap-2">{offers.data.packages.map((pack) => <PackageCard key={pack.id} pack={pack} serviceName={catalog.serviceName} />)}</ul> : null}
          {offers.data.memberships.length ? (
            <ul aria-label="Memberships" className="flex flex-col gap-2">
              {offers.data.memberships.map((membership) => <MembershipCard key={membership.id} membership={membership} patientId={patientId} canCollect={canSell} onRenew={() => setRenewing(membership)} />)}
            </ul>
          ) : null}
        </>
      )}

      {/* The dialogs sit inside the profile form in the React tree, so their submit must not reach it. */}
      <div className="contents" onSubmit={(event) => event.stopPropagation()}>
        {dialog === "sell" && summary.data ? <SellPackageDialog patientId={patientId} packages={summary.data.packages} open onOpenChange={(open) => { if (!open) setDialog(null); }} /> : null}
        {dialog === "adjust" ? <AdjustCreditsDialog patientId={patientId} packages={adjustable} open onOpenChange={(open) => { if (!open) setDialog(null); }} /> : null}
        {dialog === "membership" && summary.data ? <StartMembershipDialog patientId={patientId} plans={summary.data.plans} open onOpenChange={(open) => { if (!open) setDialog(null); }} /> : null}
        {renewing ? <RenewMembershipDialog patientId={patientId} membership={renewing} open onOpenChange={(open) => { if (!open) setRenewing(null); }} /> : null}
      </div>
    </section>
  );
}

