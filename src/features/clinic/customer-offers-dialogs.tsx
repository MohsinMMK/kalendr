"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { useFieldArray, useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { SelectField, TextField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import { cleanGstin, gstStates, isValidGstin } from "@/lib/gst";
import { amountInputValue, formatMoney, parseAmountInput } from "@/lib/money";
import type { CustomerMembershipView, CustomerPackageView, MembershipPlanView, PackageView, SellPackageInput } from "@/lib/offers-contracts";

import { useCatalogLookups } from "./clinic-catalog";
import { applyFieldErrors, offerDay } from "./offers-parts";
import { staffMutation } from "./queries/http";
import { useTaxSettings } from "./queries/invoicing";
import { offerKeys } from "./queries/offers";

export const methodOptions = [
  { value: "cash", label: "Cash" },
  { value: "upi", label: "UPI" },
  { value: "card", label: "Card" },
  { value: "bank", label: "Bank transfer" },
];
type Method = "cash" | "upi" | "card" | "bank";
const asMethod = (value: string): Method => (value === "upi" || value === "card" || value === "bank" ? value : "cash");

function useDone(patientId: string) {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: offerKeys.customer(patientId) });
    void queryClient.invalidateQueries({ queryKey: offerKeys.all() });
  };
}

// --- Sell a package ------------------------------------------------------------------------------------------------

const sellSchema = z.object({
  packageId: z.string().min(1, "Choose a package."),
  locationId: z.string().min(1, "Choose a place."),
  payments: z.array(z.object({ method: z.enum(["cash", "upi", "card", "bank"]), amount: z.string() })).min(1).max(4),
  buyerGstin: z.string().trim().refine((value) => value === "" || isValidGstin(value), "That GSTIN does not look right. Check each character."),
  buyerStateCode: z.string(),
}).superRefine((value, context) => {
  value.payments.forEach((payment, index) => {
    if (parseAmountInput(payment.amount) === null) context.addIssue({ code: "custom", path: ["payments", index, "amount"], message: "Enter an amount, like 500." });
  });
});
type SellValues = z.infer<typeof sellSchema>;

/** Sells a package at the desk. Part payment is fine: what is not taken stays owing on the invoice. */
export function SellPackageDialog({ patientId, packages, open, onOpenChange }: { patientId: string; packages: PackageView[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTerms();
  const catalog = useCatalogLookups();
  const done = useDone(patientId);
  const settings = useTaxSettings(open);
  const registered = Boolean(settings.data?.registered);
  const sellable = packages.filter((pack) => pack.isActive);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [message, setMessage] = useState("");
  const first = sellable[0];
  const form = useForm<SellValues>({
    resolver: zodResolver(sellSchema),
    defaultValues: { packageId: first?.id ?? "", locationId: catalog.locations[0]?.id ?? "", payments: [{ method: "cash", amount: first ? amountInputValue(first.priceMinor) : "" }], buyerGstin: "", buyerStateCode: "" },
  });
  const { register, handleSubmit, setValue, setError, control, formState: { errors, isSubmitting } } = form;
  const { fields, append, remove } = useFieldArray({ control, name: "payments" });
  const [packageId, locationId, payments, stateCode] = useWatch({ control, name: ["packageId", "locationId", "payments", "buyerStateCode"] });
  const pack = sellable.find((item) => item.id === packageId);
  const takenMinor = (payments ?? []).reduce((sum, payment) => sum + (parseAmountInput(payment.amount) ?? 0), 0);
  const currency = pack?.currency ?? "INR";

  function choosePackage(next: string) {
    setValue("packageId", next, { shouldValidate: true, shouldDirty: true });
    const chosen = sellable.find((item) => item.id === next);
    // One payment line starts as the full price; several lines are left for the desk to split.
    if (chosen && (payments ?? []).length === 1) setValue("payments.0.amount", amountInputValue(chosen.priceMinor));
  }

  const submit = handleSubmit(async (values) => {
    setMessage("");
    if (!pack) return;
    if (takenMinor > pack.priceMinor) { setError("payments.0.amount", { type: "manual", message: `That is more than the price, ${formatMoney(pack.priceMinor, currency)}.` }); return; }
    const body: SellPackageInput = {
      patientId, packageId: values.packageId, locationId: values.locationId,
      payments: values.payments.map((payment) => ({ method: payment.method, amountMinor: parseAmountInput(payment.amount)! })),
      ...(registered && values.buyerGstin ? { buyerGstin: cleanGstin(values.buyerGstin) } : {}),
      ...(registered && values.buyerStateCode ? { buyerStateCode: values.buyerStateCode } : {}),
    };
    try {
      await staffMutation<CustomerPackageView>("/api/staff/packages/sell", "POST", body, { idempotencyKey: key });
      setKey(crypto.randomUUID());
      done();
      toastManager.add({ title: "Package sold", description: pack.name, type: "success" });
      onOpenChange(false);
    } catch (cause: unknown) {
      setKey(crypto.randomUUID());
      if (applyFieldErrors(cause, setError, { packageId: "packageId", locationId: "locationId", "payments.0.amountMinor": "payments.0.amount", "payments.0.method": "payments.0.method", buyerGstin: "buyerGstin", buyerStateCode: "buyerStateCode" })) return;
      setMessage(cause instanceof Error ? cause.message : "The package could not be sold. Try again.");
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <form noValidate aria-label="Sell a package" className="contents" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>Sell a package</DialogTitle>
            <DialogDescription>An invoice is made for it. If you take less than the price, the rest stays owing.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            {message ? <Alert variant="error"><AlertDescription>{message}</AlertDescription></Alert> : null}
            {!sellable.length ? <Alert variant="warning"><AlertDescription>There are no packages to sell yet. Make one in Offers first.</AlertDescription></Alert> : null}
            <SelectField label="Package" value={packageId} onValueChange={choosePackage} error={errors.packageId?.message} placeholder="Choose a package" options={sellable.map((item) => ({ value: item.id, label: `${item.name} · ${formatMoney(item.priceMinor, item.currency)}` }))} />
            {catalog.locations.length > 1 ? <SelectField label={t.Location} value={locationId} onValueChange={(next) => setValue("locationId", next, { shouldDirty: true })} error={errors.locationId?.message} options={catalog.locations.map((item) => ({ value: item.id, label: item.name }))} /> : null}
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 font-medium text-sm">How it was paid</legend>
              {fields.map((field, index) => (
                <div key={field.id} className="flex items-start gap-2">
                  <SelectField label={`Method ${index + 1}`} fieldClassName="min-w-0 flex-1" value={payments?.[index]?.method ?? "cash"} onValueChange={(next) => setValue(`payments.${index}.method`, asMethod(next), { shouldDirty: true })} options={methodOptions} />
                  <TextField label={`Amount ${index + 1} (₹)`} fieldClassName="min-w-0 flex-1" inputMode="decimal" autoComplete="off" error={errors.payments?.[index]?.amount?.message} {...register(`payments.${index}.amount`)} />
                  {fields.length > 1 ? <Button type="button" variant="ghost" size="icon" className="mt-6 min-h-11 min-w-11 sm:min-h-8 sm:min-w-8" aria-label={`Remove payment ${index + 1}`} onClick={() => remove(index)}><X aria-hidden="true" /></Button> : null}
                </div>
              ))}
              {fields.length < 4 ? <Button type="button" variant="ghost" size="sm" className="min-h-11 self-start sm:min-h-8" onClick={() => append({ method: "cash", amount: "" })}><Plus aria-hidden="true" />Split across another method</Button> : null}
              {pack ? <p role="status" className="text-muted-foreground text-sm tabular-nums">Taking {formatMoney(takenMinor, currency)} of {formatMoney(pack.priceMinor, currency)}{takenMinor < pack.priceMinor ? `. ${formatMoney(pack.priceMinor - takenMinor, currency)} stays owing.` : "."}</p> : null}
            </fieldset>
            {registered ? (
              <>
                <TextField label={`${t.Customer} GSTIN`} optional autoComplete="off" autoCapitalize="characters" hint={`Only for a ${t.customer} who is registered for GST.`} error={errors.buyerGstin?.message} {...register("buyerGstin")} />
                <SelectField label={`${t.Customer}'s state`} optional value={stateCode} onValueChange={(next) => setValue("buyerStateCode", next, { shouldDirty: true })} options={[{ value: "", label: "Same state as the business" }, ...gstStates.map((state) => ({ value: state.code, label: state.name }))]} />
              </>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" className="min-h-11 sm:min-h-8" />}>Cancel</DialogClose>
            <Button type="submit" className="min-h-11 sm:min-h-8" loading={isSubmitting} disabled={!sellable.length}>Sell package</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

// --- Adjust credits ------------------------------------------------------------------------------------------------

const adjustSchema = z.object({
  customerPackageId: z.string().min(1, "Choose a package."),
  change: z.string().refine((value) => /^[+-]?\d{1,3}$/.test(value.trim()) && Number(value) !== 0 && Math.abs(Number(value)) <= 200, "Enter how many to add or take away, like 2 or -1."),
  reason: z.string().trim().min(2, "Say why, so the history makes sense later.").max(200, "Use 200 characters or fewer."),
});
type AdjustValues = z.infer<typeof adjustSchema>;

/** Adds or takes away sessions by hand. The reason stays in the package's history. */
export function AdjustCreditsDialog({ patientId, packages, open, onOpenChange }: { patientId: string; packages: CustomerPackageView[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const done = useDone(patientId);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [message, setMessage] = useState("");
  const form = useForm<AdjustValues>({ resolver: zodResolver(adjustSchema), defaultValues: { customerPackageId: packages[0]?.id ?? "", change: "", reason: "" } });
  const { register, handleSubmit, setValue, setError, control, formState: { errors, isSubmitting } } = form;
  const chosen = useWatch({ control, name: "customerPackageId" });

  const submit = handleSubmit(async (values) => {
    setMessage("");
    try {
      await staffMutation(`/api/staff/packages/credits/${values.customerPackageId}`, "POST", { change: Number(values.change), reason: values.reason.trim() }, { idempotencyKey: key });
      setKey(crypto.randomUUID());
      done();
      toastManager.add({ title: "Sessions changed", type: "success" });
      onOpenChange(false);
    } catch (cause: unknown) {
      setKey(crypto.randomUUID());
      if (applyFieldErrors(cause, setError, { change: "change", reason: "reason" })) return;
      setMessage(cause instanceof Error ? cause.message : "The sessions could not be changed. Try again.");
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <form noValidate aria-label="Adjust credits" className="contents" onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>Adjust credits</DialogTitle>
            <DialogDescription>Add or take away sessions by hand, for a gift or a mistake.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            {message ? <Alert variant="error"><AlertDescription>{message}</AlertDescription></Alert> : null}
            <SelectField label="Package" value={chosen} onValueChange={(next) => setValue("customerPackageId", next, { shouldValidate: true })} error={errors.customerPackageId?.message} options={packages.map((item) => ({ value: item.id, label: `${item.name} · ${item.remaining} of ${item.creditsTotal} left` }))} />
            <TextField label="Change" inputMode="numeric" autoComplete="off" placeholder="2" hint="Use a minus to take sessions away, like -1." error={errors.change?.message} {...register("change")} />
            <TextField label="Why" autoComplete="off" maxLength={200} placeholder="Gift for a referral" error={errors.reason?.message} {...register("reason")} />
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" className="min-h-11 sm:min-h-8" />}>Cancel</DialogClose>
            <Button type="submit" className="min-h-11 sm:min-h-8" loading={isSubmitting}>Save change</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

// --- Start a membership / record a month's payment -----------------------------------------------------------------

/** Starts a membership billed by hand: pick the plan and how the first month was paid. */
export function StartMembershipDialog({ patientId, plans, open, onOpenChange }: { patientId: string; plans: MembershipPlanView[]; open: boolean; onOpenChange: (open: boolean) => void }) {
  const done = useDone(patientId);
  const active = plans.filter((plan) => plan.isActive);
  const [planId, setPlanId] = useState(active[0]?.id ?? "");
  const [method, setMethod] = useState<Method>("cash");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const plan = active.find((item) => item.id === planId);

  async function submit() {
    if (!plan || pending) return;
    setPending(true);
    setMessage("");
    try {
      await staffMutation<CustomerMembershipView>("/api/staff/memberships", "POST", { patientId, planId: plan.id, method }, { idempotencyKey: key });
      setKey(crypto.randomUUID());
      done();
      toastManager.add({ title: "Membership started", description: plan.name, type: "success" });
      onOpenChange(false);
    } catch (cause: unknown) {
      setKey(crypto.randomUUID());
      setMessage(cause instanceof Error ? cause.message : "The membership could not be started. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <form noValidate aria-label="Start a membership" className="contents" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <DialogHeader>
            <DialogTitle>Start a membership</DialogTitle>
            <DialogDescription>It is billed by hand. Record each month’s payment from this screen.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            {message ? <Alert variant="error"><AlertDescription>{message}</AlertDescription></Alert> : null}
            {!active.length ? <Alert variant="warning"><AlertDescription>There are no membership plans yet. Make one in Offers first.</AlertDescription></Alert> : null}
            <SelectField label="Plan" value={planId} onValueChange={setPlanId} placeholder="Choose a plan" options={active.map((item) => ({ value: item.id, label: `${item.name} · ${formatMoney(item.priceMinor, item.currency)} a month` }))} />
            <SelectField label="How the first month was paid" value={method} onValueChange={(next) => setMethod(asMethod(next))} options={methodOptions} />
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" className="min-h-11 sm:min-h-8" />}>Cancel</DialogClose>
            <Button type="submit" className="min-h-11 sm:min-h-8" loading={pending} disabled={!plan}>Start membership</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** Records one month's payment for a membership billed by hand. Renews it for another month. */
export function RenewMembershipDialog({ patientId, membership, open, onOpenChange }: { patientId: string; membership: CustomerMembershipView; open: boolean; onOpenChange: (open: boolean) => void }) {
  const done = useDone(patientId);
  const [method, setMethod] = useState<Method>("cash");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  async function submit() {
    if (pending) return;
    setPending(true);
    setMessage("");
    try {
      await staffMutation<CustomerMembershipView>(`/api/staff/memberships/${membership.id}`, "POST", { action: "renew", method }, { idempotencyKey: key });
      setKey(crypto.randomUUID());
      done();
      toastManager.add({ title: "Payment recorded", description: membership.planName, type: "success" });
      onOpenChange(false);
    } catch (cause: unknown) {
      setKey(crypto.randomUUID());
      setMessage(cause instanceof Error ? cause.message : "The payment could not be recorded. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <form noValidate aria-label="Record this month's payment" className="contents" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <DialogHeader>
            <DialogTitle>Record this month’s payment</DialogTitle>
            <DialogDescription>{membership.planName} runs to {offerDay(membership.currentPeriodEnd)}. Recording a payment adds another month and this month’s sessions.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            {message ? <Alert variant="error"><AlertDescription>{message}</AlertDescription></Alert> : null}
            <SelectField label="How it was paid" value={method} onValueChange={(next) => setMethod(asMethod(next))} options={methodOptions} />
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="ghost" className="min-h-11 sm:min-h-8" />}>Cancel</DialogClose>
            <Button type="submit" className="min-h-11 sm:min-h-8" loading={pending}>Record payment</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

