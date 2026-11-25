"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { SelectField, TextareaField, TextField } from "@/components/form-fields";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardDescription, CardFooter, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import { cleanGstin, gstStates, HEALTH_EXEMPTION_NOTE, isValidGstin, stateTaxLabel, taxLine, taxTreatments, type TaxTreatment } from "@/lib/gst";
import type { TaxSettingsView } from "@/lib/invoicing-contracts";
import { formatMoney } from "@/lib/money";

import { invoiceKeys, useTaxSettings } from "./queries/invoicing";
import { StaffApiError, staffMutation } from "./queries/http";
import { useStaffAccess } from "./staff-access";
import { TaxServiceRules } from "./tax-service-rules";

const sacPattern = /^\d{4,8}$/;
const rateOf = (value: string): number | null => (/^\d{1,2}(\.\d{1,2})?$/.test(value.trim()) ? Math.round(Number(value) * 100) : null);

const formSchema = z.object({
  registered: z.boolean(),
  gstin: z.string(),
  legalName: z.string().trim().max(200, "Use 200 characters or fewer."),
  address: z.string().trim().max(400, "Use 400 characters or fewer."),
  stateCode: z.string(),
  pricesIncludeTax: z.boolean(),
  defaultTreatment: z.enum(taxTreatments),
  defaultRate: z.string(),
  defaultSacCode: z.string().trim(),
  confirm: z.boolean(),
}).superRefine((value, context) => {
  const bps = rateOf(value.defaultRate);
  if (bps === null || bps > 4000) context.addIssue({ code: "custom", path: ["defaultRate"], message: "Enter a rate from 0 to 40, like 18." });
  else if (value.defaultTreatment === "taxable" && bps === 0) context.addIssue({ code: "custom", path: ["defaultRate"], message: "A taxable service needs a rate above 0%." });
  if (value.defaultSacCode && !sacPattern.test(value.defaultSacCode)) context.addIssue({ code: "custom", path: ["defaultSacCode"], message: "A HSN or SAC code is 4 to 8 digits." });
  if (!value.registered) return;
  const gstin = cleanGstin(value.gstin);
  if (!gstin) context.addIssue({ code: "custom", path: ["gstin"], message: "Enter the business's GSTIN." });
  else if (!isValidGstin(gstin)) context.addIssue({ code: "custom", path: ["gstin"], message: "That GSTIN does not look right. Check each character." });
  if (!value.legalName) context.addIssue({ code: "custom", path: ["legalName"], message: "Enter the name to print on invoices." });
  if (!value.stateCode) context.addIssue({ code: "custom", path: ["stateCode"], message: "Choose the state the business supplies from." });
  else if (gstin && isValidGstin(gstin) && gstin.slice(0, 2) !== value.stateCode) context.addIssue({ code: "custom", path: ["stateCode"], message: "The state does not match the first two digits of the GSTIN." });
});
type FormValues = z.infer<typeof formSchema>;

const treatmentOptions: { value: TaxTreatment; label: string }[] = [
  { value: "exempt", label: "Exempt from GST" },
  { value: "taxable", label: "Taxable" },
  { value: "nil", label: "Nil rated (no GST)" },
];
const stateOptions = [{ value: "", label: "Choose a state" }, ...gstStates.map((state) => ({ value: state.code, label: state.name }))];

function valuesFrom(settings: TaxSettingsView): FormValues {
  return {
    registered: settings.registered, gstin: settings.gstin ?? "", legalName: settings.legalName ?? "", address: settings.address ?? "", stateCode: settings.stateCode ?? "",
    pricesIncludeTax: settings.pricesIncludeTax, defaultTreatment: settings.defaultTreatment, defaultRate: String(settings.defaultRateBps / 100),
    defaultSacCode: settings.defaultSacCode ?? "", confirm: false,
  };
}

/** A sample ₹1,000 service taxed with what is on the form, so the owner sees what customers will be charged. */
function SamplePreview({ values, currency = "INR" }: { values: FormValues; currency?: string }) {
  const bps = rateOf(values.defaultRate);
  const stateLabel = stateTaxLabel(values.stateCode);
  if (bps === null || bps > 4000) return <p className="text-muted-foreground text-sm">Fix the rate to see how a sample line is taxed.</p>;
  const line = (supply: "intra" | "inter") => taxLine(
    { description: "Sample", sacCode: null, quantity: 1, unitPriceMinor: 100_000, discountMinor: 0, treatment: values.defaultTreatment, rateBps: bps },
    { registered: values.registered, pricesIncludeTax: values.pricesIncludeTax, supply },
  );
  const same = line("intra");
  const other = line("inter");
  const money = (minor: number) => formatMoney(minor, currency);
  const split = (taxed: typeof same, supply: "intra" | "inter") => (!taxed.cgstMinor && !taxed.sgstMinor && !taxed.igstMinor ? "no tax" : supply === "intra" ? `CGST ${money(taxed.cgstMinor)} + ${stateLabel} ${money(taxed.sgstMinor)}` : `IGST ${money(taxed.igstMinor)}`);
  return (
    <ul className="flex flex-col gap-1 text-sm" aria-label="Sample line">
      <li>Customer in the same state: {money(same.totalMinor)} in total, {split(same, "intra")}.</li>
      <li>Customer in another state: {money(other.totalMinor)} in total, {split(other, "inter")}.</li>
    </ul>
  );
}

function TaxSettingsForm({ settings, canEdit, isOwner }: { settings: TaxSettingsView; canEdit: boolean; isOwner: boolean }) {
  const t = useTerms();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const [conflict, setConflict] = useState(false);
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), mode: "onChange", defaultValues: valuesFrom(settings) });
  const { register, handleSubmit, setValue, setError, control, reset, formState: { errors, isDirty, isSubmitting } } = form;
  const values = useWatch({ control }) as FormValues;
  const gstinOk = values.registered && cleanGstin(values.gstin ?? "") !== "" && isValidGstin(values.gstin ?? "");
  const treatment = values.defaultTreatment;

  const submit = handleSubmit(async (next) => {
    setMessage("");
    const orNull = (value: string) => (value.trim() ? value.trim() : null);
    try {
      const saved = await staffMutation<TaxSettingsView>("/api/staff/tax-settings", "PUT", {
        registered: next.registered,
        gstin: next.registered ? cleanGstin(next.gstin) : null,
        legalName: orNull(next.legalName),
        address: orNull(next.address),
        stateCode: orNull(next.stateCode),
        pricesIncludeTax: next.pricesIncludeTax,
        defaultTreatment: next.defaultTreatment,
        defaultRateBps: next.defaultTreatment === "taxable" ? rateOf(next.defaultRate) ?? 0 : 0,
        defaultSacCode: orNull(next.defaultSacCode),
        confirm: next.confirm,
        version: settings.version,
      });
      queryClient.setQueryData(invoiceKeys.taxSettings(), saved);
      reset(valuesFrom(saved));
      toastManager.add({ title: "Tax settings saved. New invoices use them.", type: "success" });
    } catch (cause: unknown) {
      if (cause instanceof StaffApiError && cause.code === "version_conflict") { setConflict(true); return; }
      if (cause instanceof StaffApiError) {
        for (const field of ["gstin", "legalName", "address", "stateCode", "defaultRateBps", "defaultSacCode"] as const) {
          const text = cause.fieldErrors[field]?.[0];
          if (text) { setError(field === "defaultRateBps" ? "defaultRate" : field, { type: "server", message: text }); return; }
        }
      }
      setMessage(cause instanceof Error ? cause.message : "The tax settings could not be saved. Try again.");
    }
  });

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <form noValidate aria-label="GST settings" onSubmit={(event) => void submit(event)}>
          <CardHeader>
            <CardTitle render={<h2 />} className="text-base">GST</CardTitle>
            <CardDescription>How invoices for this {t.business} are taxed.{canEdit ? "" : " You can read these settings. Only someone who sets up payments can change them."}</CardDescription>
          </CardHeader>
          <CardPanel className="flex flex-col gap-4">
            <Alert variant="warning">
              <TriangleAlert aria-hidden="true" />
              <AlertTitle>Confirm this with your accountant</AlertTitle>
              <AlertDescription>
                <p>{settings.hint} We offer a starting point for your type of {t.business}. We do not decide your tax. You and your accountant do.</p>
                {settings.isDefault ? <p className="mt-1">You have not saved these yet, so these are the starting values.</p> : null}
              </AlertDescription>
            </Alert>
            {conflict ? (
              <Alert variant="warning">
                <AlertTitle>Someone else changed these settings</AlertTitle>
                <AlertDescription>
                  <p>Load their version to keep working. Your unsaved changes here will be replaced.</p>
                  <Button type="button" size="sm" variant="outline" className="mt-2 min-h-11 sm:min-h-8" onClick={() => void queryClient.invalidateQueries({ queryKey: invoiceKeys.taxSettings() })}>Load their version</Button>
                </AlertDescription>
              </Alert>
            ) : null}
            {message ? <Alert variant="error"><AlertDescription>{message}</AlertDescription></Alert> : null}

            <Label className="flex min-h-11 items-center justify-between gap-3">
              <span className="flex flex-col"><span className="font-medium text-sm">Registered for GST</span><span className="text-muted-foreground text-xs">Off means invoices are receipts with no tax on them.</span></span>
              <Switch checked={values.registered} disabled={!canEdit} onCheckedChange={(next) => setValue("registered", next, { shouldDirty: true, shouldValidate: true })} />
            </Label>

            {values.registered ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField label="GSTIN" autoComplete="off" autoCapitalize="characters" disabled={!canEdit} error={errors.gstin?.message} hint={gstinOk ? "This GSTIN looks right." : "15 letters and numbers, like 36AABCU9603R1ZM."} {...register("gstin")} />
                <TextField label="Name on invoices" autoComplete="organization" disabled={!canEdit} error={errors.legalName?.message} {...register("legalName")} />
                <SelectField label="State you supply from" value={values.stateCode} options={stateOptions} disabled={!canEdit} error={errors.stateCode?.message} onValueChange={(next) => setValue("stateCode", next, { shouldDirty: true, shouldValidate: true })} />
                <TextareaField label="Address on invoices" optional rows={2} disabled={!canEdit} error={errors.address?.message} {...register("address")} />
              </div>
            ) : null}

            <Label className="flex min-h-11 items-center justify-between gap-3">
              <span className="flex flex-col"><span className="font-medium text-sm">Prices include tax</span><span className="text-muted-foreground text-xs">On: a ₹1,000 price is what the {t.customer} pays. Off: tax is added on top.</span></span>
              <Switch checked={values.pricesIncludeTax} disabled={!canEdit || !values.registered} onCheckedChange={(next) => setValue("pricesIncludeTax", next, { shouldDirty: true })} />
            </Label>

            <div className="grid gap-4 sm:grid-cols-3">
              <SelectField label="Usual treatment" value={treatment} options={treatmentOptions} disabled={!canEdit} onValueChange={(next) => setValue("defaultTreatment", (next || "exempt") as TaxTreatment, { shouldDirty: true, shouldValidate: true })} />
              <TextField label="Usual rate (%)" inputMode="decimal" autoComplete="off" disabled={!canEdit || treatment !== "taxable"} error={errors.defaultRate?.message} {...register("defaultRate")} />
              <TextField label="HSN or SAC code" optional inputMode="numeric" autoComplete="off" disabled={!canEdit} error={errors.defaultSacCode?.message} {...register("defaultSacCode")} />
            </div>
            {treatment === "exempt" ? <p className="rounded-lg border bg-muted/50 p-3 text-sm"><span className="font-medium">Shown on invoices:</span> {HEALTH_EXEMPTION_NOTE}</p> : null}

            <section aria-labelledby="tax-sample-title" className="flex flex-col gap-1 rounded-lg border bg-muted/50 p-3">
              <h4 id="tax-sample-title" className="font-medium text-sm">What this does to a ₹1,000 {t.service}</h4>
              <SamplePreview values={values} />
            </section>

            <Label className="flex min-h-11 cursor-pointer items-start gap-3">
              <Checkbox className="mt-0.5" checked={values.confirm} disabled={!canEdit || !isOwner} onCheckedChange={(next) => setValue("confirm", next === true, { shouldDirty: true })} />
              <span className="flex flex-col">
                <span className="text-sm">I have confirmed this with my accountant</span>
                <span className="text-muted-foreground text-xs">
                  {settings.confirmedAt ? `Confirmed on ${new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }).format(new Date(settings.confirmedAt))}. ` : ""}
                  {isOwner ? "" : "Only the owner can confirm this."}
                </span>
              </span>
            </Label>
          </CardPanel>
          {canEdit ? <CardFooter className="flex justify-end"><Button type="submit" size="lg" className="min-h-11" loading={isSubmitting} disabled={!isDirty && !conflict}>Save tax settings</Button></CardFooter> : null}
        </form>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle render={<h2 />} className="text-base">Tax for each {t.service}</CardTitle>
          <CardDescription>Pick a different treatment for any {t.service}. The rest follow the usual treatment above. A change is saved straight away.</CardDescription>
        </CardHeader>
        <CardPanel><TaxServiceRules settings={settings} canEdit={canEdit} /></CardPanel>
      </Card>
    </div>
  );
}

/** Billing, Tax settings. Reading needs `invoices.issue`; saving needs `payments.settings`. */
export function TaxSettingsPanel() {
  const access = useStaffAccess();
  const settings = useTaxSettings();
  if (settings.isPending) return <div role="status" aria-label="Loading tax settings" className="flex flex-col gap-4"><Skeleton className="h-64 w-full rounded-xl" /><Skeleton className="h-40 w-full rounded-xl" /></div>;
  if (settings.isError) {
    return (
      <Alert variant="error">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>Tax settings could not be loaded</AlertTitle>
        <AlertDescription>
          <p>{settings.error instanceof Error ? settings.error.message : "Something went wrong."}</p>
          <Button size="sm" variant="outline" className="mt-2 min-h-11 sm:min-h-8" onClick={() => void settings.refetch()}>Try again</Button>
        </AlertDescription>
      </Alert>
    );
  }
  return <TaxSettingsForm key={settings.data.version} settings={settings.data} canEdit={access.can("payments.settings")} isOwner={access.role === "owner"} />;
}
