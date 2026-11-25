"use client";

import { Ticket, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Frame, FrameHeader, FramePanel } from "@/components/ui/frame";
import { Skeleton } from "@/components/ui/skeleton";
import type { CustomerOffers } from "@/lib/offers-contracts";

import { creditsLeftText, MembershipStatusBadge, offerDay, PackageStatusBadge } from "../clinic/offers-parts";

interface PortalOffersAnswer {
  people: { clinicSlug: string; clinicName: string; patientId: string; name: string; offers: CustomerOffers }[];
}

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "done"; answer: PortalOffersAnswer };

async function loadOffers(signal: AbortSignal): Promise<PortalOffersAnswer> {
  const response = await fetch("/api/portal/offers", { cache: "no-store", signal, headers: { Accept: "application/json" } });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || typeof body !== "object" || body === null || !("data" in body)) {
    const message = typeof body === "object" && body !== null && "error" in body ? (body as { error?: { message?: unknown } }).error?.message : undefined;
    throw new Error(typeof message === "string" && message ? message : "Your packages could not be loaded.");
  }
  return (body as { data: PortalOffersAnswer }).data;
}

/**
 * Packages and memberships the customer holds, one block per business. Silent when there are none and in the preview, so a
 * customer who never bought one sees no empty section. Buying happens at the front desk.
 */
export function PortalOffers({ preview }: { preview: boolean }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => { setLoad({ state: "loading" }); setAttempt((value) => value + 1); }, []);

  useEffect(() => {
    if (preview) return;
    const controller = new AbortController();
    loadOffers(controller.signal)
      .then((answer) => setLoad({ state: "done", answer }))
      .catch((cause: unknown) => { if (!controller.signal.aborted) setLoad({ state: "error", message: cause instanceof Error ? cause.message : "Your packages could not be loaded." }); });
    return () => controller.abort();
  }, [preview, attempt]);

  if (preview) return null;
  if (load.state === "loading") return <div role="status" aria-label="Loading packages" className="flex flex-col gap-2"><Skeleton className="h-16 w-full" /></div>;
  if (load.state === "error") {
    return (
      <Alert variant="error">
        <TriangleAlert aria-hidden="true" />
        <AlertDescription>
          <p>{load.message}</p>
          <Button type="button" size="sm" variant="outline" className="mt-2 min-h-11 sm:min-h-8" onClick={retry}>Try again</Button>
        </AlertDescription>
      </Alert>
    );
  }

  const holders = load.answer.people.filter((person) => person.offers.packages.length > 0 || person.offers.memberships.length > 0);
  if (!holders.length) return null;
  const several = new Set(load.answer.people.map((person) => `${person.clinicSlug}/${person.patientId}`)).size > 1;

  return (
    <section aria-label="Packages" className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 font-medium text-sm"><Ticket aria-hidden="true" className="size-4 text-muted-foreground" />Packages</h2>
      {holders.map((person) => (
        <Frame key={`${person.clinicSlug}/${person.patientId}`}>
          <FrameHeader className="px-3 py-2">
            <h3 className="font-medium text-sm">{person.clinicName}{several ? ` · ${person.name}` : ""}</h3>
          </FrameHeader>
          <FramePanel className="flex flex-col gap-3 p-3">
            {person.offers.packages.length ? (
              <ul aria-label={`Packages at ${person.clinicName}`} className="flex flex-col divide-y rounded-lg border">
                {person.offers.packages.map((pack) => (
                  <li key={pack.id} className="flex items-start justify-between gap-3 px-3 py-2">
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="break-words font-medium text-sm">{pack.name}</span>
                      <span className="font-medium text-sm tabular-nums">{creditsLeftText(pack.remaining, pack.creditsTotal)}</span>
                      <span className="text-muted-foreground text-xs">{pack.status === "expired" ? "Ended on" : "Valid until"} {offerDay(pack.expiresAt)}</span>
                    </span>
                    <PackageStatusBadge status={pack.status} />
                  </li>
                ))}
              </ul>
            ) : null}
            {person.offers.memberships.length ? (
              <ul aria-label={`Memberships at ${person.clinicName}`} className="flex flex-col divide-y rounded-lg border">
                {person.offers.memberships.map((membership) => (
                  <li key={membership.id} className="flex items-start justify-between gap-3 px-3 py-2">
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="break-words font-medium text-sm">{membership.planName}</span>
                      <span className="text-muted-foreground text-xs">{membership.status === "cancelled" ? "Ended" : "Paid up to"} {offerDay(membership.currentPeriodEnd)}</span>
                    </span>
                    <MembershipStatusBadge membership={membership} />
                  </li>
                ))}
              </ul>
            ) : null}
          </FramePanel>
        </Frame>
      ))}
    </section>
  );
}
