"use client";

import { CalendarDays, CheckCircle2, LinkIcon, RefreshCw, ShieldCheck, TriangleAlert, Wallet } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardFooter, CardPanel } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { formatMoney } from "@/lib/money";

import { useTerms } from "../terms/business-profile-context";
import { formatDateTime } from "./booking-format";
import { ConfirmingPayment, type PaymentOutcome } from "./confirming-payment";
import { openCheckout, PaymentRequestError, postPublicJson, startPayLinkPayment } from "./online-payment";
import { StepHeader } from "./steps/step-header";

/**
 * What the pay link page shows (POST /api/public/bookings/pay-link/view { token }). No contact details, nothing
 * private beyond what the person holding the link already was sent.
 */
export interface PayLinkView {
  state: "open" | "paid" | "expired" | "invalid";
  businessName: string | null;
  serviceName: string | null;
  /** ISO start time of the visit, shown in `timezone`. */
  startsAt: string | null;
  timezone: string | null;
  locale: string | null;
  amountMinor: number | null;
  currency: string;
  policyText: string | null;
}

function viewPayLink(token: string): Promise<PayLinkView> {
  return postPublicJson<PayLinkView>("/api/public/bookings/pay-link/view", { token }, "We could not open this payment link. Try again.");
}

/** The page behind a payment link a business sent. */
export function PayLink({ token }: { token: string }) {
  const t = useTerms();
  const [view, setView] = useState<PayLinkView>();
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [problem, setProblem] = useState("");
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await viewPayLink(token));
      setLoadError("");
    } catch (error) {
      // A link the server does not know is shown as an invalid link, not as a failure to try again.
      if (error instanceof PaymentRequestError && (error.status === 404 || error.status === 400)) {
        setView({ state: "invalid", businessName: null, serviceName: null, startsAt: null, timezone: null, locale: null, amountMinor: null, currency: "INR", policyText: null });
        setLoadError("");
      } else {
        setLoadError(error instanceof Error ? error.message : "We could not open this payment link. Try again.");
      }
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    // Fetching the link's page is the external synchronization this effect performs.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function pay() {
    setProblem("");
    setOpening(true);
    try {
      const session = await startPayLinkPayment(token);
      await openCheckout(session, {
        onSubmitted: () => setConfirming(true),
        onDismissed: () => setOpening(false),
        onFailed: () => {
          setOpening(false);
          setProblem("That payment did not go through. Nothing was taken. You can try again.");
        },
      });
    } catch (error) {
      setOpening(false);
      if (error instanceof PaymentRequestError && (error.status === 410 || /expired|paid/i.test(error.code ?? ""))) {
        void load();
        return;
      }
      setProblem(error instanceof Error ? error.message : "We could not open the payment. Try again.");
    }
  }

  const check = useCallback(async (): Promise<PaymentOutcome> => {
    const latest = await viewPayLink(token);
    setView(latest);
    return { state: latest.state === "paid" ? "confirmed" : latest.state === "open" ? "waiting" : "expired" };
  }, [token]);

  if (loading) {
    return (
      <section aria-busy="true" aria-live="polite" className="mx-auto flex w-full max-w-xl flex-col gap-4">
        <span className="sr-only">Opening your payment link</span>
        <Skeleton aria-hidden="true" className="h-8 w-64 rounded-lg" />
        <Skeleton aria-hidden="true" className="h-56 rounded-2xl" />
      </section>
    );
  }

  if (!view) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TriangleAlert aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle className="font-semibold">
            <h1>We could not open this link</h1>
          </EmptyTitle>
          <EmptyDescription>{loadError}</EmptyDescription>
        </EmptyHeader>
        <Button
          size="lg"
          onClick={() => {
            setLoading(true);
            void load();
          }}
        >
          <RefreshCw aria-hidden="true" />
          Try again
        </Button>
      </Empty>
    );
  }

  if (confirming && view.state !== "paid") {
    return <ConfirmingPayment check={check} onConfirmed={() => setConfirming(false)} />;
  }

  if (view.state === "paid") {
    return (
      <section aria-labelledby="pay-link-heading" className="mx-auto flex w-full max-w-xl flex-col gap-5">
        <StepHeader titleId="pay-link-heading" title="This is paid" description={`Thank you. ${view.businessName ?? "The business"} has your payment.`} />
        <Alert variant="success" role="status">
          <CheckCircle2 aria-hidden="true" />
          <AlertTitle>Nothing more to pay</AlertTitle>
          <AlertDescription>Your {t.appointment} is confirmed. You do not need this link any more.</AlertDescription>
        </Alert>
      </section>
    );
  }

  if (view.state === "expired" || view.state === "invalid") {
    const expired = view.state === "expired";
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <LinkIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle className="font-semibold">
            <h1>{expired ? "This payment link has run out" : "This payment link does not work"}</h1>
          </EmptyTitle>
          <EmptyDescription>
            {expired
              ? `Ask ${view.businessName ?? `the ${t.business}`} to send you a new one.`
              : `The link may be mistyped, or it was replaced by a newer one. Ask ${view.businessName ?? `the ${t.business}`} for a new link.`}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const amount = view.amountMinor === null ? null : formatMoney(view.amountMinor, view.currency);
  return (
    <section aria-labelledby="pay-link-heading" className="mx-auto flex w-full max-w-xl flex-col gap-5">
      <StepHeader
        titleId="pay-link-heading"
        title={amount ? `Pay ${amount} to ${view.businessName ?? t.business}` : `Pay ${view.businessName ?? t.business}`}
        description={`This confirms your ${t.appointment}.`}
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
          <dl className="grid gap-3">
            {view.businessName ? (
              <div>
                <dt className="text-muted-foreground text-xs">{t.Business}</dt>
                <dd className="font-medium text-sm">{view.businessName}</dd>
              </div>
            ) : null}
            {view.serviceName ? (
              <div>
                <dt className="text-muted-foreground text-xs">{t.Service}</dt>
                <dd className="font-medium text-sm">{view.serviceName}</dd>
              </div>
            ) : null}
            {view.startsAt && view.timezone ? (
              <div className="relative ps-6">
                <CalendarDays aria-hidden="true" className="absolute start-0 top-0.5 size-4 text-muted-foreground" />
                <dt className="sr-only">When</dt>
                <dd className="font-medium text-sm">{formatDateTime(view.startsAt, view.locale ?? "en-IN", view.timezone)}</dd>
              </div>
            ) : null}
            {amount ? (
              <div className="relative ps-6">
                <Wallet aria-hidden="true" className="absolute start-0 top-0.5 size-4 text-muted-foreground" />
                <dt className="text-muted-foreground text-xs">To pay now</dt>
                <dd className="font-medium text-lg tabular-nums">{amount}</dd>
              </div>
            ) : null}
          </dl>
          {view.policyText ? <p className="whitespace-pre-line rounded-lg bg-muted/48 p-3 text-sm">{view.policyText}</p> : null}
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
