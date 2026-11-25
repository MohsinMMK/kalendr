"use client";

import { Wallet } from "lucide-react";

import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { formatMoney } from "@/lib/money";
import type { PublicServicePayment } from "@/lib/payments";

import { useTerms } from "../terms/business-profile-context";

/** "Pay ₹200 now, ₹600 at the visit" (or "Pay ₹800 now"). */
export function paymentSummaryText(payment: PublicServicePayment, visitWord: string): string {
  const now = formatMoney(payment.dueNowMinor, payment.currency);
  return payment.dueLaterMinor > 0
    ? `Pay ${now} now, ${formatMoney(payment.dueLaterMinor, payment.currency)} at the ${visitWord}`
    : `Pay ${now} now`;
}

/**
 * Before the customer confirms: what they pay now, the exact policy words, and a required agreement.
 * The Confirm button stays off until it is ticked (the flow reads `agreed`).
 */
export function PaymentPolicyCard({
  payment,
  agreed,
  onAgreedChange,
}: {
  payment: PublicServicePayment;
  agreed: boolean;
  onAgreedChange: (agreed: boolean) => void;
}) {
  const t = useTerms();
  return (
    <section aria-labelledby="payment-policy-heading" className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <h2 id="payment-policy-heading" className="flex items-center gap-2 font-semibold text-base">
        <Wallet aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        {paymentSummaryText(payment, t.appointment)}
      </h2>
      <p className="text-muted-foreground text-sm">You pay on the next screen. Your time is held for 10 minutes while you pay.</p>
      <p id="payment-policy-text" className="whitespace-pre-line rounded-lg bg-muted/48 p-3 text-sm">
        {payment.policyText}
      </p>
      <Label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg sm:min-h-8">
        <Checkbox
          id="payment-policy-agree"
          className="mt-0.5"
          checked={agreed}
          onCheckedChange={(checked) => onAgreedChange(checked === true)}
          aria-describedby="payment-policy-text"
        />
        <span>I agree to this policy</span>
      </Label>
    </section>
  );
}
