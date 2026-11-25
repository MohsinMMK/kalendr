"use client";

import { RefreshCw, RotateCcw } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toastManager } from "@/components/ui/toast";
import { isWebhookEventType } from "@/lib/api-scopes";

import { useDeliveries, useResendDelivery } from "./api";
import { errorText, formatStamp } from "./shared";
import { webhookEventDetails, type DeliveryStatus, type WebhookDelivery } from "./webhook-types";
import { ScrollArea } from "@/components/ui/scroll-area";

const statusText: Record<DeliveryStatus, { label: string; variant: "success" | "warning" | "error" | "secondary" }> = {
  succeeded: { label: "Delivered", variant: "success" },
  pending: { label: "Waiting to send", variant: "secondary" },
  retrying: { label: "Will try again", variant: "warning" },
  gave_up: { label: "Gave up", variant: "error" },
};

const eventLabel = (type: string): string => (isWebhookEventType(type) ? webhookEventDetails[type].label : type);

function DeliveryRow({ delivery, onResend, resending }: { delivery: WebhookDelivery; onResend: (id: string) => void; resending: boolean }) {
  const status = statusText[delivery.status];
  const label = eventLabel(delivery.eventType);
  return (
    <TableRow>
      <TableCell>
        <span className="font-medium">{label}</span>
        {delivery.isTest ? <Badge variant="info" className="ms-2">Test</Badge> : null}
        <span className="block text-muted-foreground text-xs">{formatStamp(delivery.createdAt)}</span>
      </TableCell>
      <TableCell><Badge variant={status.variant}>{status.label}</Badge></TableCell>
      <TableCell>{delivery.statusCode ?? (delivery.errorCode ? "No reply" : "—")}</TableCell>
      <TableCell>{delivery.durationMs !== null ? `${delivery.durationMs} ms` : "—"}</TableCell>
      <TableCell>{delivery.attempt}</TableCell>
      <TableCell>{delivery.status === "retrying" && delivery.nextAttemptAt ? formatStamp(delivery.nextAttemptAt) : "—"}</TableCell>
      <TableCell>
        <Button type="button" variant="outline" size="sm" disabled={resending} aria-label={`Resend ${label} from ${formatStamp(delivery.createdAt)}`} onClick={() => onResend(delivery.id)}>
          <RotateCcw aria-hidden="true" /> Resend
        </Button>
      </TableCell>
    </TableRow>
  );
}

/** The recent messages sent to one address, newest first, with Load more and a Resend for each. */
export function DeliveryLog({ endpointId, endpointLabel }: { endpointId: string; endpointLabel: string }) {
  const query = useDeliveries(endpointId, true);
  const resend = useResendDelivery(endpointId);

  async function onResend(id: string) {
    try {
      await resend.mutateAsync(id);
      toastManager.add({ title: "Queued to send again", type: "success" });
    } catch (cause: unknown) {
      toastManager.add({ title: "Could not resend", description: errorText(cause, "Try again."), type: "error" });
    }
  }

  if (query.isPending) return <div role="status" aria-label="Loading deliveries" className="flex flex-col gap-2"><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /></div>;
  if (query.isError) {
    return (
      <Alert variant="error">
        <AlertDescription>
          <p>The delivery log could not be loaded. {errorText(query.error, "")}</p>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void query.refetch()}><RefreshCw aria-hidden="true" /> Retry</Button>
        </AlertDescription>
      </Alert>
    );
  }
  const deliveries = query.data.pages.flatMap((page) => page.deliveries);
  if (deliveries.length === 0) return <p className="text-muted-foreground text-sm">Nothing has been sent to this address yet. Use Send test event to see one arrive.</p>;

  return (
    <div className="flex flex-col gap-3">
      <ScrollArea clampContentMinWidth={false} className="rounded-lg border">
        <Table render={<div className="relative w-full overflow-visible!" />} aria-label={`Recent deliveries to ${endpointLabel}`} className="min-w-[44rem]">
          <TableHeader>
            <TableRow>
              <TableHead>Event</TableHead><TableHead>Result</TableHead><TableHead>HTTP code</TableHead><TableHead>Time taken</TableHead><TableHead>Attempt</TableHead><TableHead>Next try</TableHead><TableHead><span className="sr-only">Actions</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {deliveries.map((delivery) => <DeliveryRow key={delivery.id} delivery={delivery} onResend={(id) => void onResend(id)} resending={resend.isPending} />)}
          </TableBody>
        </Table>
      </ScrollArea>
      {query.hasNextPage ? (
        <Button type="button" variant="outline" className="self-start" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
          {query.isFetchingNextPage ? <Spinner aria-hidden="true" /> : null}Load more
        </Button>
      ) : null}
      {query.isFetchNextPageError ? <p role="alert" className="text-destructive-foreground text-xs">More could not be loaded. Try again.</p> : null}
    </div>
  );
}
