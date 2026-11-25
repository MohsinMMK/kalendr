"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { SelectField, TextareaField, TextField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ResponsiveDrawer, ResponsiveDrawerPopup } from "@/components/responsive-drawer";
import { DrawerDescription, DrawerFooter, DrawerHeader, DrawerPanel, DrawerTitle } from "@/components/ui/drawer";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import { amountInputValue, formatMoney, parseAmountInput } from "@/lib/money";
import type { CouponInput, CouponView, MembershipPlanInput, MembershipPlanView, PackageInput, PackageView } from "@/lib/offers-contracts";
import { describeCoupon, isValidCode, normaliseCode, priceBooking } from "@/lib/offers";

import { useCatalogLookups } from "./clinic-catalog";
import { applyFieldErrors, ServiceChecklist, wholeNumber } from "./offers-parts";
import { staffMutation } from "./queries/http";
import { offerKeys } from "./queries/offers";

const priceText = z.string().refine((value) => parseAmountInput(value) !== null, "Enter a price, like 4500.");
const rangeText = (min: number, max: number, message: string) => z.string().refine((value) => { const n = wholeNumber(value); return n !== null && n >= min && n <= max; }, message);
const optionalLimit = z.string().refine((value) => value.trim() === "" || (wholeNumber(value) ?? 0) >= 1, "Enter a whole number, or leave it empty.");
const nameText = z.string().trim().min(2, "Give it a name of at least 2 letters.").max(120, "Use 120 characters or fewer.");
const noteText = z.string().trim().max(400, "Use 400 characters or fewer.");

/** The form sits inside a right-hand sheet; the caller mounts it only while open so every opening starts fresh. */
function FormSheet({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: React.ReactNode }) {
  return (
    <ResponsiveDrawer open={open} onOpenChange={onOpenChange}>
      <ResponsiveDrawerPopup className="sm:max-w-lg">{open ? children : null}</ResponsiveDrawerPopup>
    </ResponsiveDrawer>
  );
}

function ActiveSwitch({ checked, onChange, hint }: { checked: boolean; onChange: (next: boolean) => void; hint: string }) {
  return (
    <Label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2 sm:min-h-10">
      <span className="flex min-w-0 flex-col"><span>Active</span><span className="font-normal text-muted-foreground text-xs">{hint}</span></span>
      <Switch aria-label="Active" checked={checked} onCheckedChange={onChange} />
    </Label>
  );
}

function SheetButtons({ submitting, label, onCancel }: { submitting: boolean; label: string; onCancel: () => void }) {
  return (
    <DrawerFooter>
      <Button type="button" variant="ghost" className="min-h-11 sm:min-h-8" onClick={onCancel}>Cancel</Button>
      <Button type="submit" className="min-h-11 sm:min-h-8" loading={submitting}>{label}</Button>
    </DrawerFooter>
  );
}

// --- Packages ----------------------------------------------------------------------------------------------------

const packageSchema = z.object({
  name: nameText,
  description: noteText,
  price: priceText,
  credits: rangeText(1, 200, "Enter 1 to 200 sessions."),
  validDays: rangeText(1, 3650, "Enter 1 to 3650 days."),
  serviceIds: z.array(z.string()).min(1, "Choose at least one service."),
  isActive: z.boolean(),
});
type PackageValues = z.infer<typeof packageSchema>;

function PackageForm({ pack, onClose }: { pack: PackageView | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const catalog = useCatalogLookups();
  const services = catalog.services.filter((service) => service.isActive !== false);
  const [message, setMessage] = useState("");
  const form = useForm<PackageValues>({
    resolver: zodResolver(packageSchema),
    defaultValues: { name: pack?.name ?? "", description: pack?.description ?? "", price: pack ? amountInputValue(pack.priceMinor) : "", credits: pack ? String(pack.credits) : "10", validDays: pack ? String(pack.validDays) : "365", serviceIds: pack?.serviceIds ?? [], isActive: pack?.isActive ?? true },
  });
  const { register, handleSubmit, setError, control, setValue, formState: { errors, isSubmitting } } = form;
  const chosen = useWatch({ control, name: "serviceIds" }) ?? [];
  const active = useWatch({ control, name: "isActive" });

  const submit = handleSubmit(async (values) => {
    setMessage("");
    const body: PackageInput = {
      name: values.name.trim(), priceMinor: parseAmountInput(values.price)!, credits: wholeNumber(values.credits)!, validDays: wholeNumber(values.validDays)!,
      serviceIds: values.serviceIds, isActive: values.isActive, ...(values.description.trim() ? { description: values.description.trim() } : {}),
      ...(pack ? { version: pack.version } : {}),
    };
    try {
      await staffMutation(pack ? `/api/staff/packages/${pack.id}` : "/api/staff/packages", pack ? "PUT" : "POST", body);
      void queryClient.invalidateQueries({ queryKey: offerKeys.all() });
      toastManager.add({ title: pack ? "Package saved" : "Package created", description: body.name, type: "success" });
      onClose();
    } catch (cause: unknown) {
      if (applyFieldErrors(cause, setError, { name: "name", description: "description", priceMinor: "price", credits: "credits", validDays: "validDays", serviceIds: "serviceIds" })) return;
      setMessage(cause instanceof Error ? cause.message : "The package could not be saved. Try again.");
    }
  });

  return (
    <form noValidate aria-label={pack ? "Edit package" : "New package"} className="contents" onSubmit={(event) => void submit(event)}>
      <DrawerHeader>
        <DrawerTitle>{pack ? "Edit package" : "New package"}</DrawerTitle>
        <DrawerDescription>A bundle of sessions bought once and used over time.</DrawerDescription>
      </DrawerHeader>
      <DrawerPanel className="flex flex-col gap-4">
        {message ? <Alert variant="error"><AlertDescription>{message}</AlertDescription></Alert> : null}
        <TextField label="Name" autoComplete="off" maxLength={120} placeholder="10 massages" error={errors.name?.message} {...register("name")} />
        <TextareaField label="Description" optional rows={2} maxLength={400} error={errors.description?.message} {...register("description")} />
        <div className="grid gap-4 sm:grid-cols-3">
          <TextField label="Price (₹)" inputMode="decimal" autoComplete="off" error={errors.price?.message} {...register("price")} />
          <TextField label="Sessions" inputMode="numeric" autoComplete="off" error={errors.credits?.message} {...register("credits")} />
          <TextField label="Valid for (days)" inputMode="numeric" autoComplete="off" error={errors.validDays?.message} {...register("validDays")} />
        </div>
        <ServiceChecklist legend="Services it covers" services={services} value={chosen} onChange={(next) => setValue("serviceIds", next, { shouldValidate: true, shouldDirty: true })} error={errors.serviceIds?.message} />
        <ActiveSwitch checked={active} onChange={(next) => setValue("isActive", next, { shouldDirty: true })} hint="Switched off, it can't be sold. People who already have it keep it." />
      </DrawerPanel>
      <SheetButtons submitting={isSubmitting} label={pack ? "Save package" : "Create package"} onCancel={onClose} />
    </form>
  );
}

export function PackageSheet({ open, pack, onOpenChange }: { open: boolean; pack: PackageView | null; onOpenChange: (open: boolean) => void }) {
  return <FormSheet open={open} onOpenChange={onOpenChange}><PackageForm key={pack?.id ?? "new"} pack={pack} onClose={() => onOpenChange(false)} /></FormSheet>;
}

// --- Membership plans --------------------------------------------------------------------------------------------

const planSchema = z.object({
  name: nameText,
  description: noteText,
  price: priceText,
  credits: rangeText(0, 100, "Enter 0 to 100 sessions."),
  discount: rangeText(0, 100, "Enter 0 to 100 percent."),
  serviceIds: z.array(z.string()).min(1, "Choose at least one service."),
  isActive: z.boolean(),
}).refine((value) => (wholeNumber(value.credits) ?? 0) > 0 || (wholeNumber(value.discount) ?? 0) > 0, { path: ["credits"], message: "Give members sessions each month, a discount, or both." });
type PlanValues = z.infer<typeof planSchema>;

function PlanForm({ plan, onClose }: { plan: MembershipPlanView | null; onClose: () => void }) {
  const queryClient = useQueryClient();
  const catalog = useCatalogLookups();
  const services = catalog.services.filter((service) => service.isActive !== false);
  const [message, setMessage] = useState("");
  const form = useForm<PlanValues>({
    resolver: zodResolver(planSchema),
    defaultValues: { name: plan?.name ?? "", description: plan?.description ?? "", price: plan ? amountInputValue(plan.priceMinor) : "", credits: plan ? String(plan.creditsPerPeriod) : "0", discount: plan ? String(plan.memberDiscountPercent) : "0", serviceIds: plan?.serviceIds ?? [], isActive: plan?.isActive ?? true },
  });
  const { register, handleSubmit, setError, control, setValue, formState: { errors, isSubmitting } } = form;
  const chosen = useWatch({ control, name: "serviceIds" }) ?? [];
  const active = useWatch({ control, name: "isActive" });

  const submit = handleSubmit(async (values) => {
    setMessage("");
    const body: MembershipPlanInput = {
      name: values.name.trim(), priceMinor: parseAmountInput(values.price)!, creditsPerPeriod: wholeNumber(values.credits)!, memberDiscountPercent: wholeNumber(values.discount)!,
      serviceIds: values.serviceIds, isActive: values.isActive, ...(values.description.trim() ? { description: values.description.trim() } : {}),
      ...(plan ? { version: plan.version } : {}),
    };
    try {
      await staffMutation(plan ? `/api/staff/memberships/plans/${plan.id}` : "/api/staff/memberships/plans", plan ? "PUT" : "POST", body);
      void queryClient.invalidateQueries({ queryKey: offerKeys.all() });
      toastManager.add({ title: plan ? "Plan saved" : "Plan created", description: body.name, type: "success" });
      onClose();
    } catch (cause: unknown) {
      if (applyFieldErrors(cause, setError, { name: "name", description: "description", priceMinor: "price", creditsPerPeriod: "credits", memberDiscountPercent: "discount", serviceIds: "serviceIds" })) return;
      setMessage(cause instanceof Error ? cause.message : "The plan could not be saved. Try again.");
    }
  });

  return (
    <form noValidate aria-label={plan ? "Edit membership plan" : "New membership plan"} className="contents" onSubmit={(event) => void submit(event)}>
      <DrawerHeader>
        <DrawerTitle>{plan ? "Edit membership plan" : "New membership plan"}</DrawerTitle>
        <DrawerDescription>Members pay every month and get sessions, a lower price, or both.</DrawerDescription>
      </DrawerHeader>
      <DrawerPanel className="flex flex-col gap-4">
        {message ? <Alert variant="error"><AlertDescription>{message}</AlertDescription></Alert> : null}
        <TextField label="Name" autoComplete="off" maxLength={120} placeholder="Gold membership" error={errors.name?.message} {...register("name")} />
        <TextareaField label="Description" optional rows={2} maxLength={400} error={errors.description?.message} {...register("description")} />
        <div className="grid gap-4 sm:grid-cols-3">
          <TextField label="Price per month (₹)" inputMode="decimal" autoComplete="off" error={errors.price?.message} {...register("price")} />
          <TextField label="Sessions each month" inputMode="numeric" autoComplete="off" error={errors.credits?.message} {...register("credits")} />
          <TextField label="Member discount (%)" inputMode="numeric" autoComplete="off" error={errors.discount?.message} {...register("discount")} />
        </div>
        <ServiceChecklist legend="Services it covers" services={services} value={chosen} onChange={(next) => setValue("serviceIds", next, { shouldValidate: true, shouldDirty: true })} error={errors.serviceIds?.message} />
        <ActiveSwitch checked={active} onChange={(next) => setValue("isActive", next, { shouldDirty: true })} hint="Switched off, nobody new can join. Current members keep it." />
      </DrawerPanel>
      <SheetButtons submitting={isSubmitting} label={plan ? "Save plan" : "Create plan"} onCancel={onClose} />
    </form>
  );
}

export function PlanSheet({ open, plan, onOpenChange }: { open: boolean; plan: MembershipPlanView | null; onOpenChange: (open: boolean) => void }) {
  return <FormSheet open={open} onOpenChange={onOpenChange}><PlanForm key={plan?.id ?? "new"} plan={plan} onClose={() => onOpenChange(false)} /></FormSheet>;
}

// --- Codes -------------------------------------------------------------------------------------------------------

const sampleListMinor = 100_000;

const couponSchema = z.object({
  code: z.string().refine((value) => isValidCode(normaliseCode(value)), "A code is 3 to 32 letters, numbers, dashes or underscores."),
  kind: z.enum(["percent", "fixed"]),
  value: z.string(),
  maxUses: optionalLimit,
  perCustomerLimit: optionalLimit,
  validFrom: z.string(),
  validTo: z.string(),
  serviceIds: z.array(z.string()),
  firstVisitOnly: z.boolean(),
  stackable: z.boolean(),
  isActive: z.boolean(),
}).superRefine((value, context) => {
  if (value.kind === "percent") {
    const n = wholeNumber(value.value);
    if (n === null || n < 1 || n > 100) context.addIssue({ code: "custom", path: ["value"], message: "Enter a percentage from 1 to 100." });
  } else if (parseAmountInput(value.value) === null) {
    context.addIssue({ code: "custom", path: ["value"], message: "Enter an amount, like 200." });
  }
  if (value.validFrom && value.validTo && value.validFrom > value.validTo) context.addIssue({ code: "custom", path: ["validTo"], message: "The last day can't be before the first day." });
});
type CouponValues = z.infer<typeof couponSchema>;

const istDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit" });
/** A date field's "2026-12-31" from a stored time. `endOfDay` times are stored as the start of the next day. */
function dayInputValue(iso: string | null, endOfDay: boolean): string {
  if (!iso) return "";
  return istDay.format(new Date(Date.parse(iso) - (endOfDay ? 1 : 0)));
}
const startOfDay = (day: string) => new Date(`${day}T00:00:00+05:30`).toISOString();
const dayAfter = (day: string) => new Date(Date.parse(`${day}T00:00:00+05:30`) + 86_400_000).toISOString();

/** What a code does to a ₹1,000 booking, worked out with the same rules the server uses. */
export function CouponPreview({ kind, valueText, stackable }: { kind: "percent" | "fixed"; valueText: string; stackable: boolean }) {
  const value = kind === "percent" ? wholeNumber(valueText) : parseAmountInput(valueText);
  if (!value || (kind === "percent" && value > 100)) return <p className="rounded-lg border bg-muted/50 p-3 text-muted-foreground text-sm">Enter the discount to see what it does to a {formatMoney(sampleListMinor)} booking.</p>;
  const money = (minor: number) => formatMoney(minor);
  const price = priceBooking({ listMinor: sampleListMinor, coupon: { kind, value, stackable } });
  return (
    <div role="status" aria-label="What this code does" className="flex flex-col gap-1 rounded-lg border bg-muted/50 p-3 text-sm">
      <p className="font-medium">{describeCoupon(kind, value, money)}</p>
      <p className="text-muted-foreground">On a {money(sampleListMinor)} booking, the customer pays {money(price.netMinor)} (saves {money(price.listMinor - price.netMinor)}).</p>
      <p className="text-muted-foreground text-xs">{stackable ? "It can be used on top of a member price." : "It can't be used together with a member price."}</p>
    </div>
  );
}

function CouponForm({ coupon, onClose }: { coupon: CouponView | null; onClose: () => void }) {
  const t = useTerms();
  const queryClient = useQueryClient();
  const catalog = useCatalogLookups();
  const services = catalog.services.filter((service) => service.isActive !== false);
  const [message, setMessage] = useState("");
  const form = useForm<CouponValues>({
    resolver: zodResolver(couponSchema),
    defaultValues: {
      code: coupon?.code ?? "", kind: coupon?.kind ?? "percent", value: coupon ? (coupon.kind === "percent" ? String(coupon.value) : amountInputValue(coupon.value)) : "",
      maxUses: coupon?.maxUses ? String(coupon.maxUses) : "", perCustomerLimit: coupon?.perCustomerLimit ? String(coupon.perCustomerLimit) : "",
      validFrom: dayInputValue(coupon?.validFrom ?? null, false), validTo: dayInputValue(coupon?.validTo ?? null, true),
      serviceIds: coupon?.serviceIds ?? [], firstVisitOnly: coupon?.firstVisitOnly ?? false, stackable: coupon?.stackable ?? false, isActive: coupon?.isActive ?? true,
    },
  });
  const { register, handleSubmit, setError, control, setValue, formState: { errors, isSubmitting } } = form;
  const [kind, valueText, stackable, firstVisitOnly, active, chosen] = useWatch({ control, name: ["kind", "value", "stackable", "firstVisitOnly", "isActive", "serviceIds"] });

  const submit = handleSubmit(async (values) => {
    setMessage("");
    const body: CouponInput = {
      code: normaliseCode(values.code), kind: values.kind, value: values.kind === "percent" ? wholeNumber(values.value)! : parseAmountInput(values.value)!,
      maxUses: values.maxUses.trim() ? wholeNumber(values.maxUses) : null, perCustomerLimit: values.perCustomerLimit.trim() ? wholeNumber(values.perCustomerLimit) : null,
      validFrom: values.validFrom ? startOfDay(values.validFrom) : null, validTo: values.validTo ? dayAfter(values.validTo) : null,
      serviceIds: values.serviceIds, firstVisitOnly: values.firstVisitOnly, stackable: values.stackable, isActive: values.isActive,
      ...(coupon ? { version: coupon.version } : {}),
    };
    try {
      await staffMutation(coupon ? `/api/staff/coupons/${coupon.id}` : "/api/staff/coupons", coupon ? "PUT" : "POST", body);
      void queryClient.invalidateQueries({ queryKey: offerKeys.all() });
      toastManager.add({ title: coupon ? "Code saved" : "Code created", description: body.code, type: "success" });
      onClose();
    } catch (cause: unknown) {
      if (applyFieldErrors(cause, setError, { code: "code", value: "value", maxUses: "maxUses", perCustomerLimit: "perCustomerLimit", validFrom: "validFrom", validTo: "validTo", serviceIds: "serviceIds" })) return;
      setMessage(cause instanceof Error ? cause.message : "The code could not be saved. Try again.");
    }
  });

  return (
    <form noValidate aria-label={coupon ? "Edit code" : "New code"} className="contents" onSubmit={(event) => void submit(event)}>
      <DrawerHeader>
        <DrawerTitle>{coupon ? "Edit code" : "New code"}</DrawerTitle>
        <DrawerDescription>A code the {t.customer} types when booking. It is saved in capital letters.</DrawerDescription>
      </DrawerHeader>
      <DrawerPanel className="flex flex-col gap-4">
        {message ? <Alert variant="error"><AlertDescription>{message}</AlertDescription></Alert> : null}
        <TextField label="Code" autoComplete="off" autoCapitalize="characters" maxLength={40} placeholder="WELCOME10" hint="Customers can type it in any case." error={errors.code?.message} {...register("code")} />
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField label="Takes off" value={kind} onValueChange={(next) => setValue("kind", next === "fixed" ? "fixed" : "percent", { shouldDirty: true })} options={[{ value: "percent", label: "A percentage" }, { value: "fixed", label: "A fixed amount" }]} />
          <TextField label={kind === "percent" ? "Percentage (%)" : "Amount (₹)"} inputMode="decimal" autoComplete="off" error={errors.value?.message} {...register("value")} />
        </div>
        <CouponPreview kind={kind} valueText={valueText} stackable={stackable} />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Can be used in total" optional inputMode="numeric" autoComplete="off" hint="Leave empty for no limit." error={errors.maxUses?.message} {...register("maxUses")} />
          <TextField label={`Times per ${t.customer}`} optional inputMode="numeric" autoComplete="off" hint="Leave empty for no limit." error={errors.perCustomerLimit?.message} {...register("perCustomerLimit")} />
          <TextField label="First day" optional type="date" error={errors.validFrom?.message} {...register("validFrom")} />
          <TextField label="Last day" optional type="date" error={errors.validTo?.message} {...register("validTo")} />
        </div>
        <ServiceChecklist legend="Services it works for" hint="Leave all unticked for every service." services={services} value={chosen} onChange={(next) => setValue("serviceIds", next, { shouldDirty: true })} error={errors.serviceIds?.message} />
        <Label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2 sm:min-h-10">
          <span>First visit only</span>
          <Switch aria-label="First visit only" checked={firstVisitOnly} onCheckedChange={(next) => setValue("firstVisitOnly", next, { shouldDirty: true })} />
        </Label>
        <Label className="flex min-h-11 cursor-pointer items-center justify-between gap-3 rounded-lg border px-3 py-2 sm:min-h-10">
          <span className="flex min-w-0 flex-col"><span>Can be used with a member price</span><span className="font-normal text-muted-foreground text-xs">Off means members get one discount, not two.</span></span>
          <Switch aria-label="Can be used with a member price" checked={stackable} onCheckedChange={(next) => setValue("stackable", next, { shouldDirty: true })} />
        </Label>
        <ActiveSwitch checked={active} onChange={(next) => setValue("isActive", next, { shouldDirty: true })} hint="Switched off, the code stops working straight away." />
      </DrawerPanel>
      <SheetButtons submitting={isSubmitting} label={coupon ? "Save code" : "Create code"} onCancel={onClose} />
    </form>
  );
}

export function CouponSheet({ open, coupon, onOpenChange }: { open: boolean; coupon: CouponView | null; onOpenChange: (open: boolean) => void }) {
  return <FormSheet open={open} onOpenChange={onOpenChange}><CouponForm key={coupon?.id ?? "new"} coupon={coupon} onClose={() => onOpenChange(false)} /></FormSheet>;
}

