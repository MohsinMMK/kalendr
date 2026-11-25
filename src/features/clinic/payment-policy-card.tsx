"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { SelectField, TextField } from "@/components/form-fields";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Frame, FrameDescription, FrameFooter, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import { afterWindowRules, noShowRules, policyWording, type PaymentPolicy, type PaymentSettingsView, type ServicePayment } from "@/lib/payments";

import { paymentKeys } from "./queries/payments";
import { StaffApiError, staffMutation } from "./queries/http";

/** The example the preview is written for, so the wording is concrete: a ₹800 service that takes a ₹200 deposit. */
export const examplePayment: ServicePayment = { mode: "deposit", priceMinor: 80000, depositMinor: 20000, dueNowMinor: 20000, dueLaterMinor: 60000, currency: "INR" };

const policyFormSchema = z.object({
  amount: z.string().trim().regex(/^\d{1,4}$/, "Enter a whole number, like 24. Use 0 to allow it any time before it starts."),
  unit: z.enum(["hours", "days"]),
  afterWindowRule: z.enum(afterWindowRules),
  noShowRule: z.enum(noShowRules),
}).superRefine((value, context) => {
  if (/^\d{1,4}$/.test(value.amount) && hoursOf(value) > 8760) context.addIssue({ code: "custom", path: ["amount"], message: "That is more than a year. Use 365 days or fewer." });
});
type PolicyFormValues = z.infer<typeof policyFormSchema>;

function hoursOf(value: Pick<PolicyFormValues, "amount" | "unit">): number {
  return Number(value.amount) * (value.unit === "days" ? 24 : 1);
}

export function formValuesFromPolicy(policy: PaymentPolicy): PolicyFormValues {
  const days = policy.freeCancelHours > 0 && policy.freeCancelHours % 24 === 0;
  return { amount: String(days ? policy.freeCancelHours / 24 : policy.freeCancelHours), unit: days ? "days" : "hours", afterWindowRule: policy.afterWindowRule, noShowRule: policy.noShowRule };
}

const unitOptions = [{ value: "hours", label: "hours" }, { value: "days", label: "days" }];
const afterWindowOptions = [
  { value: "no_refund", label: "No refund" },
  { value: "keep_deposit", label: "Keep the deposit, refund the rest" },
];
const noShowOptions = [
  { value: "deposit", label: "Keep the deposit" },
  { value: "everything", label: "Keep everything paid" },
];

/** Settings, Payments: the cancellation and refund rules, with the words customers will read before they pay. */
export function PaymentPolicyCard({ policy }: { policy: PaymentPolicy }) {
  const t = useTerms();
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const [conflict, setConflict] = useState(false);
  const form = useForm<PolicyFormValues>({ resolver: zodResolver(policyFormSchema), defaultValues: formValuesFromPolicy(policy) });
  const { register, handleSubmit, setValue, setError, control, reset, formState: { errors, isDirty, isSubmitting } } = form;
  const values = useWatch({ control });

  const parsed = policyFormSchema.safeParse(values);
  const preview = parsed.success
    ? policyWording({ freeCancelHours: hoursOf(parsed.data), afterWindowRule: parsed.data.afterWindowRule, noShowRule: parsed.data.noShowRule }, examplePayment, t.visit)
    : "";

  const submit = handleSubmit(async (next) => {
    setMessage("");
    try {
      const saved = await staffMutation<PaymentPolicy>("/api/staff/payment-policy", "PUT", {
        freeCancelHours: hoursOf(next), afterWindowRule: next.afterWindowRule, noShowRule: next.noShowRule, version: policy.version,
      });
      queryClient.setQueryData<PaymentSettingsView>(paymentKeys.settings(), (current) => (current ? { ...current, policy: saved } : current));
      reset(formValuesFromPolicy(saved));
      toastManager.add({ title: "Policy saved. New bookings use it.", type: "success" });
    } catch (cause: unknown) {
      if (cause instanceof StaffApiError && cause.code === "version_conflict") { setConflict(true); return; }
      if (cause instanceof StaffApiError && cause.fieldErrors.freeCancelHours?.[0]) { setError("amount", { type: "server", message: cause.fieldErrors.freeCancelHours[0] }); return; }
      setMessage(cause instanceof Error ? cause.message : "The policy could not be saved. Try again.");
    }
  });

  async function loadTheirs() {
    await queryClient.invalidateQueries({ queryKey: paymentKeys.settings() });
  }

  return (
    <Frame>
      <form noValidate aria-label="Cancellation and refund policy" onSubmit={(event) => void submit(event)}>
        <FrameHeader>
          <FrameTitle>Cancellations and refunds</FrameTitle>
          <FrameDescription>Three simple rules. {t.Customers} read them before they pay, and each booking keeps the words it was shown.</FrameDescription>
        </FrameHeader>
        <FramePanel className="flex flex-col gap-4">
          {conflict ? (
            <Alert variant="warning">
              <AlertTitle>Someone else changed this policy</AlertTitle>
              <AlertDescription>
                <p>Load their version to keep working. Your unsaved changes here will be replaced.</p>
                <Button type="button" size="sm" variant="outline" className="mt-2 min-h-11 sm:min-h-8" onClick={() => void loadTheirs()}>Load their version</Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {message ? <Alert variant="error"><AlertDescription>{message}</AlertDescription></Alert> : null}
          <div className="grid grid-cols-[minmax(0,1fr)_7rem] items-start gap-3">
            <TextField label={`Free cancellation until`} inputMode="numeric" autoComplete="off" hint={`How long before a ${t.visit} someone can cancel or move it for a full refund.`} error={errors.amount?.message} {...register("amount")} />
            <SelectField label="Unit" value={values.unit ?? "hours"} options={unitOptions} onValueChange={(next) => setValue("unit", next === "days" ? "days" : "hours", { shouldDirty: true, shouldValidate: true })} />
          </div>
          <SelectField label="After that" value={values.afterWindowRule ?? "no_refund"} options={afterWindowOptions} onValueChange={(next) => setValue("afterWindowRule", next === "keep_deposit" ? "keep_deposit" : "no_refund", { shouldDirty: true })} />
          <SelectField label={`If the ${t.customer} does not come`} value={values.noShowRule ?? "deposit"} options={noShowOptions} onValueChange={(next) => setValue("noShowRule", next === "everything" ? "everything" : "deposit", { shouldDirty: true })} />
          <section aria-labelledby="policy-preview-title" className="flex flex-col gap-1 rounded-lg border bg-muted/50 p-3">
            <h4 id="policy-preview-title" className="font-medium text-sm">What {t.customers} will read</h4>
            <p className="text-muted-foreground text-xs">For an example {t.service} that costs ₹800 with a ₹200 deposit.</p>
            <p className="mt-1 text-sm" aria-live="polite">{preview || "Fix the number above to see the wording."}</p>
          </section>
        </FramePanel>
        <FrameFooter className="flex justify-end">
          <Button type="submit" size="lg" className="min-h-11" loading={isSubmitting} disabled={!isDirty && !conflict}>Save policy</Button>
        </FrameFooter>
      </form>
    </Frame>
  );
}
