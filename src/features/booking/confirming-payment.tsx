"use client";

import { Clock3, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { StartPaymentInput } from "@/lib/payments";

import { useTerms } from "../terms/business-profile-context";
import { fetchPaymentStatus } from "./online-payment";
import { StepHeader } from "./steps/step-header";

export type PaymentOutcome = { state: "waiting" | "confirmed" | "expired" | "cancelled"; appointmentStatus?: string };

/** Ask every 2 seconds, then every 5 after 20 seconds, and give up waiting on screen after 3 minutes. */
export const pollFastMs = 2_000;
export const pollSlowMs = 5_000;
export const pollSlowAfterMs = 20_000;
export const pollStopAfterMs = 180_000;

/** The check the booking flow uses: POST /api/public/bookings/pay/status. */
export function paymentStatusCheck(input: StartPaymentInput): () => Promise<PaymentOutcome> {
  return async () => {
    const status = await fetchPaymentStatus(input);
    return { state: status.state, appointmentStatus: status.appointmentStatus };
  };
}

type Phase = "waiting" | "slow" | "expired" | "cancelled";

/**
 * "Confirming your payment…" Only the server's `confirmed` shows success; the provider's own "success" never does.
 * A failed check is not shown: it is tried again on the next beat.
 */
export function ConfirmingPayment({
  check,
  onConfirmed,
  onExpired,
  manageHref,
}: {
  check: () => Promise<PaymentOutcome>;
  onConfirmed: (outcome: PaymentOutcome) => void;
  /** The time was let go (or the booking cancelled). The caller shows its own expired state when it does not handle this. */
  onExpired?: () => void;
  manageHref?: string;
}) {
  const t = useTerms();
  const [phase, setPhase] = useState<Phase>("waiting");
  const [round, setRound] = useState(0);
  const latest = useRef({ check, onConfirmed, onExpired });
  useEffect(() => {
    latest.current = { check, onConfirmed, onExpired };
  });

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const started = Date.now();

    async function tick() {
      let outcome: PaymentOutcome | undefined;
      try {
        outcome = await latest.current.check();
      } catch {
        outcome = undefined;
      }
      if (stopped) return;
      if (outcome?.state === "confirmed") {
        stopped = true;
        latest.current.onConfirmed(outcome);
        return;
      }
      if (outcome?.state === "expired" || outcome?.state === "cancelled") {
        stopped = true;
        setPhase(outcome.state);
        latest.current.onExpired?.();
        return;
      }
      const elapsed = Date.now() - started;
      if (elapsed >= pollStopAfterMs) {
        setPhase("slow");
        return;
      }
      timer = window.setTimeout(() => void tick(), elapsed >= pollSlowAfterMs ? pollSlowMs : pollFastMs);
    }

    timer = window.setTimeout(() => void tick(), 0);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [round]);

  if (phase === "expired" || phase === "cancelled") {
    return (
      <section aria-labelledby="confirming-heading" className="flex flex-col gap-5">
        <StepHeader
          titleId="confirming-heading"
          title={phase === "expired" ? "Your held time was let go" : `This ${t.appointment} was cancelled`}
          description={phase === "expired" ? "The payment did not arrive in time. If money was taken, it is refunded to you automatically." : "Nothing is left to pay."}
        />
        {manageHref ? (
          <div>
            <Button size="lg" render={<a href={manageHref} />}>
              See your {t.appointment}
            </Button>
          </div>
        ) : null}
      </section>
    );
  }

  const slow = phase === "slow";
  return (
    <section aria-labelledby="confirming-heading" aria-busy={!slow} className="flex flex-col gap-5">
      <StepHeader
        titleId="confirming-heading"
        title={slow ? "Still waiting for your payment" : "Confirming your payment…"}
        description={slow ? undefined : "This usually takes a few seconds. Please keep this page open."}
      />
      <Alert variant={slow ? "info" : "default"} role="status">
        {slow ? <Clock3 aria-hidden="true" /> : <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" />}
        <AlertTitle>{slow ? "Still waiting" : "Waiting for your bank"}</AlertTitle>
        <AlertDescription>
          {slow
            ? `Still waiting — we'll message you when it's confirmed, you can close this page.`
            : `Do not pay again. Your ${t.appointment} is confirmed as soon as the payment arrives.`}
        </AlertDescription>
      </Alert>
      {slow ? (
        <div className="flex flex-wrap gap-3">
          <Button size="lg" variant="outline" onClick={() => { setPhase("waiting"); setRound((current) => current + 1); }}>
            Check again
          </Button>
          {manageHref ? (
            <Button size="lg" variant="ghost" render={<a href={manageHref} />}>
              Open your booking
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
