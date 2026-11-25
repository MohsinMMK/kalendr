"use client";

import { QrCodeIcon } from "lucide-react";
import { useMemo, useSyncExternalStore } from "react";

import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { bookingReference, checkInPath, qrCodePath } from "@/lib/check-in";

import { useTerms } from "../terms/business-profile-context";

const noSubscribe = () => () => {};

/** "Show this when you arrive": the check-in QR and a reference code to read out if scanning fails. */
export function CheckInCard({ manageToken, appointmentId }: { manageToken: string; appointmentId: string }) {
  const t = useTerms();
  // The QR holds the full address, which is only known in the browser.
  const origin = useSyncExternalStore(noSubscribe, () => window.location.origin, () => "");
  const qr = useMemo(() => (origin ? qrCodePath(`${origin}${checkInPath(manageToken)}`) : null), [origin, manageToken]);
  const reference = bookingReference(appointmentId);

  return (
    <Card>
      <CardHeader className="p-5 pb-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <QrCodeIcon aria-hidden="true" className="size-4 text-muted-foreground" />
          Show this when you arrive
        </CardTitle>
        <CardDescription>The {t.business} team scans it to check you in.</CardDescription>
      </CardHeader>
      <CardPanel className="flex flex-col items-center gap-3 p-5">
        <div className="rounded-xl border bg-white p-2">
          {qr ? (
            <svg
              role="img"
              aria-label={`Check-in code for your ${t.appointment}`}
              viewBox={`0 0 ${qr.size} ${qr.size}`}
              shapeRendering="crispEdges"
              className="size-[200px]"
            >
              <path d={qr.path} fill="#000" />
            </svg>
          ) : (
            <Skeleton className="size-[200px]" />
          )}
        </div>
        <p className="text-center text-muted-foreground text-sm">
          Reference <span className="font-medium font-mono text-foreground tracking-wider">{reference}</span>
        </p>
      </CardPanel>
    </Card>
  );
}
