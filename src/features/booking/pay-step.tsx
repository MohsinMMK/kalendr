"use client";

import { Clock3, ShieldCheck, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardFooter, CardPanel } from "@/components/ui/card";
import { formatMoney } from "@/lib/money";
import type { CheckoutSession } from "@/lib/payments";

import { useTerms } from "../terms/business-profile-context";
import { isExpiredError, openCheckout, PaymentRequestError } from "./online-payment";
import { StepHeader } from "./steps/step-header";
import { clockText, useCountdown } from "./use-countdown";

export interface PayStepProps {
  /** What is due now. Null when the screen does not know it (it is shown on the provider's page). */
  dueNowMinor: number | null;
  currency: string;
  /** When the held time is let go. */
  expiresAt: string | null;
  /** The amount left for the visit, when there is one. */
  dueLaterMinor?: number | null;
  /** Gets the provider's checkout for this booking (POST /api/public/bookings/pay or /pay-link). */
  start: () => Promise<CheckoutSession>;
  /** The provider's window said it went through. The caller moves to the confirming screen. */
  onConfirming: () => void;
  /** The held time ran out (or the server said so). */
  onExpired: () => void;
  /** Lets the flow's expired state offer a way back; absent for pay links, which have no time to pick. */
  expiredAction?: { label: string; onClick: () => void };
  /** What the held time is, shown above the amount (service and time). */
  details?: React.ReactNode;
  headingId?: string;
}

/**
 * "Pay now to keep this time." Counts down to the end of the hold, asks the server for the checkout and opens it.
 * The Razorpay window's success only moves on to the Confirming screen: nothing is marked paid here.
 */
export function PayStep({ dueNowMinor, currency, expiresAt, dueLaterMinor, start, onConfirming, onExpired, expiredAction, details }: PayStepProps) {
  const t = useTerms();
  const remaining = useCountdown(expiresAt);
  const [opening, setOpening] = useState(false);
  const [problem, setProblem] = useState("");
  const [expired, setExpired] = useState(false);
  const calledExpired = useRef(false);
  const runOut = expired || remaining === 0;

  useEffect(() => {
    if (runOut && !calledExpired.current) {
      calledExpired.current = true;
      onExpired();
    }
  }, [runOut, onExpired]);

  async function pay() {
    setProblem("");
    setOpening(true);
    try {
      const session = await start();
      await openCheckout(session, {
        onSubmitted: onConfirming,
        onDismissed: () => setOpening(false),
        onFailed: () => {
          setOpening(false);
          setProblem("That payment did not go through. Nothing was taken. You can try again.");
        },
      });
      // Hosted checkouts leave this page; Razorpay's window is open now and tells us when it closes.
    } catch (error) {
      setOpening(false);
      if (isExpiredError(error)) {
        setExpired(true);
        return;
      }
      setProblem(
        error instanceof PaymentRequestError || error instanceof Error
          ? error.message
          : "We could not open the payment. Try again.",
      );
    }
  }

  if (runOut) {
    return (
      <section aria-labelledby="pay-heading" className="flex flex-col gap-5">
        <StepHeader titleId="pay-heading" title="Your held time was let go" description={`Nobody was charged. Pick another time and we will hold it for you.`} />
        <Alert variant="info" role="status">
          <Clock3 aria-hidden="true" />
          <AlertTitle>The time ran out</AlertTitle>
          <AlertDescription>The {t.appointment} was not confirmed, so the time is free for others again.</AlertDescription>
        </Alert>
        {expiredAction ? (
          <div>
            <Button size="lg" onClick={expiredAction.onClick}>
              {expiredAction.label}
            </Button>
          </div>
        ) : null}
      </section>
    );
  }

  const amount = dueNowMinor === null ? null : formatMoney(dueNowMinor, currency);
  const low = remaining !== null && remaining <= 60;
  return (
    <section aria-labelledby="pay-heading" className="flex flex-col gap-5">
      <StepHeader
        titleId="pay-heading"
        title={amount ? `Pay ${amount} to keep your ${t.appointment}` : `Pay to keep your ${t.appointment}`}
        description={`We are holding your time. It is confirmed once the payment goes through.`}
      />
      {problem ? (
        <Alert variant="error" role="alert">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>The payment did not start</AlertTitle>
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardPanel className="flex flex-col gap-4">
          {details}
          <dl className="grid gap-3 sm:grid-cols-2">
            {amount ? (
              <div>
                <dt className="text-muted-foreground text-xs">To pay now</dt>
                <dd className="font-medium text-lg tabular-nums">{amount}</dd>
              </div>
            ) : null}
            {dueLaterMinor ? (
              <div>
                <dt className="text-muted-foreground text-xs">To pay at the {t.appointment}</dt>
                <dd className="font-medium text-lg tabular-nums">{formatMoney(dueLaterMinor, currency)}</dd>
              </div>
            ) : null}
          </dl>
          {remaining !== null ? (
            <>
              {/* The ticking text is not announced; the polite note speaks once, at one minute left. */}
              <p role="status" aria-live="polite" className="sr-only">
                {low ? "One minute left to pay." : ""}
              </p>
              <p aria-live="off" className="flex items-center gap-2 rounded-lg bg-muted/48 px-3 py-2 text-sm">
                <Clock3 aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                <span>
                  Time left to pay: <span className={low ? "font-semibold text-destructive-foreground tabular-nums" : "font-medium tabular-nums"}>{clockText(remaining)}</span>
                </span>
              </p>
            </>
          ) : null}
        </CardPanel>
        <CardFooter className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="flex items-center gap-2 text-muted-foreground text-xs">
            <ShieldCheck aria-hidden="true" className="size-4 shrink-0" />
            You pay on a secure page. We never see your card or UPI details.
          </p>
          <Button size="lg" loading={opening} onClick={() => void pay()}>
            {amount ? `Pay ${amount}` : "Pay now"}
          </Button>
        </CardFooter>
      </Card>
    </section>
  );
}
