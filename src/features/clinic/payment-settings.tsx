"use client";

import { Banknote, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { useTerms } from "@/features/terms/business-profile-context";

import { useCatalogLookups } from "./clinic-catalog";
import { PaymentAccountCard } from "./payment-account-card";
import { PaymentMismatchesCard } from "./payment-mismatches-card";
import { PaymentPolicyCard } from "./payment-policy-card";
import { usePaymentSettings } from "./queries/payments";

/** Settings, Payments: the payment account, the cancellation policy and anything that needs a look. Needs `payments.settings`. */
export function PaymentSettings() {
  const t = useTerms();
  const catalog = useCatalogLookups();
  const live = Boolean(catalog.database);
  const settings = usePaymentSettings(live);

  if (!live) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><Banknote aria-hidden="true" /></EmptyMedia>
          <EmptyTitle>Online payments need the {t.business} database</EmptyTitle>
          <EmptyDescription>Nothing here is stored in the preview.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  if (settings.isPending) {
    return (
      <div role="status" aria-label="Loading payment settings" className="flex flex-col gap-4">
        <Skeleton className="h-48 w-full rounded-xl" /><Skeleton className="h-72 w-full rounded-xl" />
      </div>
    );
  }
  if (settings.isError) {
    return (
      <Alert variant="error">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>Payment settings could not be loaded</AlertTitle>
        <AlertDescription>
          <p>{settings.error instanceof Error ? settings.error.message : "Something went wrong."}</p>
          <Button size="sm" variant="outline" className="mt-2 min-h-11 sm:min-h-8" onClick={() => void settings.refetch()}>Try again</Button>
        </AlertDescription>
      </Alert>
    );
  }
  const data = settings.data;
  return (
    <>
      <PaymentAccountCard settings={data} />
      <PaymentPolicyCard key={data.policy.version} policy={data.policy} />
      <PaymentMismatchesCard hasAccount={data.account !== null} />
    </>
  );
}
