"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Ticket } from "lucide-react";
import { useState, type ReactNode } from "react";

import type { ActionMenuEntry } from "@/components/action-bar";
import { SelectField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import type { Appointment } from "@/lib/domain";
import type { CustomerPackageView } from "@/lib/offers-contracts";

import { creditsLeftText, offerDay } from "./offers-parts";
import { staffMutation } from "./queries/http";
import { offerKeys, useCustomerOffers } from "./queries/offers";

const payable = ["booked", "checked_in", "completed"];

function UseCreditDialog({ appointment, serviceId, serviceName, onDone, onClose }: { appointment: Appointment; serviceId: string; serviceName: string; onDone: () => Promise<void>; onClose: () => void }) {
  const t = useTerms();
  const queryClient = useQueryClient();
  const offers = useCustomerOffers(appointment.patientId);
  const usable = (offers.data?.packages ?? []).filter((pack) => pack.status === "active" && pack.remaining > 0 && pack.serviceIds.includes(serviceId));
  const [packageId, setPackageId] = useState("");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const chosen = usable.find((pack) => pack.id === packageId) ?? usable[0];

  async function submit() {
    if (!chosen || pending) return;
    setPending(true);
    setMessage("");
    try {
      await staffMutation<CustomerPackageView>(`/api/staff/appointments/${appointment.id}/use-credit`, "POST", { customerPackageId: chosen.id }, { idempotencyKey: key });
      setKey(crypto.randomUUID());
      void queryClient.invalidateQueries({ queryKey: offerKeys.all() });
      await onDone();
      toastManager.add({ title: "Paid with a package credit", description: `${chosen.name}: ${chosen.remaining - 1} of ${chosen.creditsTotal} left`, type: "success" });
      onClose();
    } catch (cause: unknown) {
      setKey(crypto.randomUUID());
      setMessage(cause instanceof Error ? cause.message : "The credit could not be used. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPopup>
        <form noValidate aria-label="Use a package credit" className="contents" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <DialogHeader>
            <DialogTitle>Use a package credit</DialogTitle>
            <DialogDescription>Pays for this {t.visit} with one session from the {t.customer}’s package.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            {message ? <Alert variant="error"><AlertDescription>{message}</AlertDescription></Alert> : null}
            {offers.isPending ? <div role="status" aria-label="Loading packages" className="flex flex-col gap-2"><Skeleton className="h-9 w-full" /></div> : null}
            {offers.isError ? (
              <Alert variant="error"><AlertDescription><p>{offers.error instanceof Error ? offers.error.message : "Packages could not be loaded."}</p><Button type="button" size="sm" variant="outline" className="mt-2 min-h-11 sm:min-h-8" onClick={() => void offers.refetch()}>Try again</Button></AlertDescription></Alert>
            ) : null}
            {offers.isSuccess && !usable.length ? <p className="text-muted-foreground text-sm">This {t.customer} has no package with sessions left for {serviceName}.</p> : null}
            {usable.length ? <SelectField label="Package" value={chosen?.id ?? ""} onValueChange={setPackageId} options={usable.map((pack) => ({ value: pack.id, label: `${pack.name} · ${creditsLeftText(pack.remaining, pack.creditsTotal)} · to ${offerDay(pack.expiresAt)}` }))} /> : null}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" className="min-h-11 sm:min-h-8" />}>Cancel</DialogClose>
            <Button type="submit" className="min-h-11 sm:min-h-8" loading={pending} disabled={!chosen}>Use 1 credit</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * "Use a package credit…" for the visit's ⋯ menu: shown for a priced visit with nothing paid yet. Returns the menu entries and
 * the dialog they open. The dialog (and its queries) exist only while open, so a screen without a query cache is untouched.
 */
export function useUseCreditAction({ appointment, serviceName, enabled, refresh }: { appointment: Appointment | undefined; serviceName: string; enabled: boolean; refresh: () => Promise<void> }): { menu: ActionMenuEntry[]; dialogs: ReactNode } {
  const [open, setOpen] = useState(false);
  const eligible = enabled && Boolean(appointment) && payable.includes(appointment!.status) && (appointment!.priceMinor ?? 0) > 0 && !(appointment!.paidMinor ?? 0);
  const menu: ActionMenuEntry[] = eligible ? [{ id: "use-credit", label: "Use a package credit…", icon: <Ticket aria-hidden="true" />, hint: "Pay with one session", onSelect: () => setOpen(true) }] : [];
  const dialogs = eligible && open && appointment ? <UseCreditDialog appointment={appointment} serviceId={appointment.serviceId} serviceName={serviceName} onDone={refresh} onClose={() => setOpen(false)} /> : null;
  return { menu, dialogs };
}
