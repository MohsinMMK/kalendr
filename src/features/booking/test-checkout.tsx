"use client";

import { FlaskConical, TriangleAlert } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardPanel } from "@/components/ui/card";
import { formatMoney } from "@/lib/money";

import { postPublicJson } from "./online-payment";

/** Where the browser goes after the test: a failed test comes back to "Pay now", not to "Confirming…". */
export function returnAddress(returnTo: string, outcome: "paid" | "failed"): string {
  if (outcome === "paid") return returnTo;
  const url = new URL(returnTo, "http://kalendr.invalid");
  url.searchParams.delete("paid");
  return `${url.pathname}${url.search}`;
}

/**
 * The built-in test checkout. It looks like a provider's page, says plainly that no real money moves, and tells the
 * server which way the test went. The server then sends its own signed webhook, as a real provider would.
 */
export function TestCheckout({
  orderId,
  returnTo,
  amountMinor,
  currency,
  businessName,
}: {
  orderId: string;
  returnTo: string;
  amountMinor: number | null;
  currency: string;
  businessName: string | null;
}) {
  const [working, setWorking] = useState<"paid" | "failed">();
  const [problem, setProblem] = useState("");

  async function choose(outcome: "paid" | "failed") {
    setWorking(outcome);
    setProblem("");
    try {
      await postPublicJson("/api/public/bookings/test-checkout", { orderId, outcome }, "The test payment could not be sent. Try again.");
      window.location.assign(returnAddress(returnTo, outcome));
    } catch (error) {
      setWorking(undefined);
      setProblem(error instanceof Error ? error.message : "The test payment could not be sent. Try again.");
    }
  }

  return (
    <section aria-labelledby="test-checkout-heading" className="mx-auto flex w-full max-w-md flex-col gap-5">
      <Alert variant="warning" role="note">
        <FlaskConical aria-hidden="true" />
        <AlertTitle>TEST — no real money</AlertTitle>
        <AlertDescription>This page stands in for a payment provider. Nothing is charged.</AlertDescription>
      </Alert>
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 id="test-checkout-heading" className="font-heading font-semibold text-xl">
            {businessName ?? "Test checkout"}
          </h1>
          <Badge variant="warning">Test</Badge>
        </div>
        {amountMinor ? (
          <p className="text-sm">
            Amount: <span className="font-semibold tabular-nums">{formatMoney(amountMinor, currency)}</span>
          </p>
        ) : null}
      </div>
      {problem ? (
        <Alert variant="error" role="alert">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>That did not work</AlertTitle>
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      ) : null}
      <Card>
        <CardPanel className="flex flex-col gap-3">
          <Button size="lg" loading={working === "paid"} disabled={working === "failed"} onClick={() => void choose("paid")}>
            Pay with UPI (test)
          </Button>
          <Button size="lg" variant="outline" loading={working === "failed"} disabled={working === "paid"} onClick={() => void choose("failed")}>
            Payment fails (test)
          </Button>
        </CardPanel>
      </Card>
    </section>
  );
}
