"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { TextField } from "@/components/form-fields";
import { RadioCard } from "@/features/booking/radio-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { RadioGroup } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import { amountInputValue, parseAmountInput } from "@/lib/money";
import { amountDueNow, livePaymentExample, paymentModes, servicePaymentSchema, type PaymentSettingsView, type ServicePayment, type ServicePaymentInput } from "@/lib/payments";

import { paymentKeys, usePaymentSettings, useServicePayment } from "./queries/payments";
import { StaffApiError, staffMutation } from "./queries/http";
import { useStaffAccess } from "./staff-access";
import type { ServiceEditorContext } from "./service-editor-tabs";
import { SettingRow } from "./setting-row";

interface FormValues { price: string; mode: (typeof paymentModes)[number]; deposit: string }

/** What the form's text stands for, or the message for the field that is wrong. Uses the same rules as the server. */
export function inputFromForm(values: FormValues): { input: ServicePaymentInput | null; errors: Partial<Record<"price" | "deposit", string>> } {
  const errors: Partial<Record<"price" | "deposit", string>> = {};
  const priceText = values.price.trim();
  const priceMinor = priceText === "" ? null : parseAmountInput(priceText);
  if (priceText !== "" && priceMinor === null) errors.price = "Enter an amount, like 800 or 1,200.50.";
  const depositText = values.deposit.trim();
  const depositMinor = values.mode !== "deposit" || depositText === "" ? null : parseAmountInput(depositText);
  if (values.mode === "deposit" && depositText !== "" && depositMinor === null) errors.deposit = "Enter an amount, like 200.";
  if (Object.keys(errors).length) return { input: null, errors };
  const parsed = servicePaymentSchema.safeParse({ priceMinor, paymentMode: values.mode, depositMinor });
  if (parsed.success) return { input: parsed.data, errors };
  for (const issue of parsed.error.issues) {
    const field = issue.path[0] === "priceMinor" ? "price" : issue.path[0] === "depositMinor" ? "deposit" : null;
    if (field && !errors[field]) errors[field] = issue.message;
  }
  return { input: null, errors };
}

const formSchema = z.object({
  price: z.string(), mode: z.enum(paymentModes), deposit: z.string(),
}).superRefine((values, context) => {
  for (const [field, message] of Object.entries(inputFromForm(values).errors)) context.addIssue({ code: "custom", path: [field], message });
});

function valuesFrom(payment: ServicePayment): FormValues {
  return {
    price: payment.priceMinor === null ? "" : amountInputValue(payment.priceMinor),
    mode: payment.mode,
    deposit: payment.depositMinor === null ? "" : amountInputValue(payment.depositMinor),
  };
}

/** The service editor's Payment tab: price, how much is paid online, and a live example of what customers see. */
export function ServicePaymentTab({ serviceId, saves }: Pick<ServiceEditorContext, "serviceId" | "saves">) {
  const access = useStaffAccess();
  const allowed = access.can("payments.settings");
  const active = allowed && saves;
  const query = useServicePayment(serviceId, active);

  if (!allowed) {
    return <Alert variant="info"><AlertDescription>Only people who can set up online payments can change prices and deposits. Ask the owner.</AlertDescription></Alert>;
  }
  if (!saves) {
    return <Alert variant="info"><AlertDescription>Prices and deposits are not saved in the preview.</AlertDescription></Alert>;
  }
  if (query.isPending) {
    return <div role="status" aria-label="Loading payment settings" className="flex flex-col gap-3"><Skeleton className="h-11 w-full" /><Skeleton className="h-20 w-full" /><Skeleton className="h-11 w-full" /></div>;
  }
  if (query.isError) {
    return (
      <Alert variant="error">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>Payment settings could not be loaded</AlertTitle>
        <AlertDescription>
          <p>{query.error instanceof Error ? query.error.message : "Something went wrong."}</p>
          <Button type="button" size="sm" variant="outline" className="mt-2 min-h-11 sm:min-h-8" onClick={() => void query.refetch()}>Try again</Button>
        </AlertDescription>
      </Alert>
    );
  }
  return <ServicePaymentForm serviceId={serviceId} payment={query.data} />;
}

function ServicePaymentForm({ serviceId, payment }: { serviceId: string; payment: ServicePayment }) {
  const t = useTerms();
  const queryClient = useQueryClient();
  const account = usePaymentSettings();
  const [message, setMessage] = useState("");
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: valuesFrom(payment) });
  const { register, handleSubmit, setValue, setError, control, reset, formState: { errors, isDirty, isSubmitting } } = form;
  const values = useWatch({ control }) as FormValues;

  const { input } = inputFromForm({ price: values.price ?? "", mode: values.mode ?? "none", deposit: values.deposit ?? "" });
  const example = input
    ? livePaymentExample({ mode: input.paymentMode, priceMinor: input.priceMinor, depositMinor: input.depositMinor, ...amountDueNow({ mode: input.paymentMode, priceMinor: input.priceMinor, depositMinor: input.depositMinor }), currency: payment.currency }, t.visit)
    : null;
  const noAccount = account.isSuccess && (account.data as PaymentSettingsView).account?.status !== "active";

  const save = handleSubmit(async (next) => {
    const { input: body } = inputFromForm(next);
    if (!body) return;
    setMessage("");
    try {
      const saved = await staffMutation<ServicePayment>(`/api/staff/services/${serviceId}/payment`, "PUT", body);
      queryClient.setQueryData(paymentKeys.service(serviceId), saved);
      reset(valuesFrom(saved));
      toastManager.add({ title: "Payment settings saved. New bookings use them.", type: "success" });
    } catch (cause: unknown) {
      if (cause instanceof StaffApiError) {
        const fields: Record<string, "price" | "deposit"> = { priceMinor: "price", depositMinor: "deposit" };
        const placed = Object.entries(cause.fieldErrors).filter(([path]) => fields[path]);
        for (const [path, messages] of placed) setError(fields[path]!, { type: "server", message: messages[0] ?? "Check this." });
        if (placed.length) return;
      }
      setMessage(cause instanceof Error ? cause.message : "The payment settings could not be saved. Try again.");
    }
  });

  const modeLabels = {
    none: { title: "No payment online", detail: `${t.Customers} book without paying. You can still take payment at the desk.` },
    deposit: { title: "Deposit", detail: `${t.Customers} pay part of the price to book. The rest is paid at the ${t.visit}.` },
    full: { title: "Full price", detail: `${t.Customers} pay everything when they book.` },
  } as const;

  return (
    // No <form> here: this tab sits inside the editor's form and saves on its own.
    <div onKeyDown={(event) => { if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault(); }}>
    <SettingRow settingId="payment" title="Payment" help={`This tab has its own Save. It does not wait for the Save at the bottom of the ${t.service} settings.`}>
      {noAccount && values.mode !== "none" ? (
        <Alert variant="warning">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>No payment account is connected</AlertTitle>
          <AlertDescription>
            <p>Until one is, {t.customers} can book this {t.service} without paying.</p>
            <Button type="button" size="sm" variant="outline" className="mt-2 min-h-11 sm:min-h-8" render={<a href="/settings" />}>Open settings, then choose Payments</Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {message ? <Alert variant="error"><AlertDescription>{message}</AlertDescription></Alert> : null}
      <TextField label={`Price (${payment.currency})`} inputMode="decimal" autoComplete="off" placeholder="800" hint={`What this ${t.service} costs. Leave empty if it has no set price.`} error={errors.price?.message} {...register("price")} />
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-medium text-sm">Payment when booking</legend>
        <RadioGroup value={values.mode ?? "none"} onValueChange={(next) => setValue("mode", next === "deposit" || next === "full" ? next : "none", { shouldDirty: true, shouldValidate: true })} aria-label="Payment when booking">
          {paymentModes.map((mode) => (
            <RadioCard key={mode} value={mode}>
              <span className="flex min-w-0 flex-col gap-0.5"><span className="font-medium text-sm">{modeLabels[mode].title}</span><span className="text-muted-foreground text-xs">{modeLabels[mode].detail}</span></span>
            </RadioCard>
          ))}
        </RadioGroup>
      </fieldset>
      {values.mode === "deposit" ? (
        <TextField label={`Deposit (${payment.currency})`} inputMode="decimal" autoComplete="off" placeholder="200" hint="Less than the price." error={errors.deposit?.message} {...register("deposit")} />
      ) : null}
      {example ? <p className="rounded-lg border bg-muted/50 px-3 py-2 text-sm" aria-live="polite">{example}</p> : null}
      <div className="flex justify-end">
        <Button type="button" size="lg" className="min-h-11" loading={isSubmitting} disabled={!isDirty} onClick={() => void save()}>Save payment settings</Button>
      </div>
    </SettingRow>
    </div>
  );
}
