"use client";

import { ChevronDown, Ellipsis, KeyRound, Pencil, Plus, Power, RefreshCw, Send, Trash2, Webhook } from "lucide-react";
import { useState } from "react";

import { RichMenu, RichMenuContent, RichMenuItem, RichMenuTrigger } from "@/components/rich-menu";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Skeleton } from "@/components/ui/skeleton";
import { toastManager } from "@/components/ui/toast";
import { MAX_WEBHOOK_ENDPOINTS } from "@/server/webhooks/contracts";

import { useDeleteWebhook, useRotateWebhookSecret, useSendTestEvent, useSetWebhookStatus, useWebhooks } from "./api";
import { DeliveryLog } from "./deliveries";
import { errorText, formatStamp, SecretRevealDialog } from "./shared";
import { WebhookDialog } from "./webhook-dialog";
import type { WebhookEndpoint } from "./webhook-types";

function StatusBadge({ endpoint }: { endpoint: WebhookEndpoint }) {
  if (endpoint.status === "active") return <Badge variant="success" size="lg">Active</Badge>;
  if (endpoint.disabledReason === "repeated_failure") return <Badge variant="error" size="lg">Turned off after repeated failures</Badge>;
  return <Badge variant="secondary" size="lg">Disabled by you</Badge>;
}

function lastDeliveryText(endpoint: WebhookEndpoint): string {
  const last = endpoint.lastDelivery;
  if (!last) return "Nothing sent yet";
  const result = last.status === "succeeded" ? "Delivered" : last.status === "gave_up" ? "Failed" : last.status === "retrying" ? "Will try again" : "Waiting to send";
  return `${result}${last.statusCode ? ` (HTTP ${last.statusCode})` : ""} · ${formatStamp(last.at)}`;
}

type Confirm = { kind: "delete" | "rotate"; endpoint: WebhookEndpoint };

/** Developers > Webhooks: the addresses Kalendr sends events to, each with its delivery log. */
export function WebhooksTab() {
  const query = useWebhooks(true);
  const setStatus = useSetWebhookStatus();
  const remove = useDeleteWebhook();
  const rotate = useRotateWebhookSecret();
  const test = useSendTestEvent();
  const [editing, setEditing] = useState<{ endpoint: WebhookEndpoint | null } | null>(null);
  const [secret, setSecret] = useState<{ title: string; secret: string } | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  if (query.isPending) return <div role="status" aria-label="Loading webhooks" className="flex flex-col gap-3"><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /></div>;
  if (query.isError) {
    return (
      <Alert variant="error">
        <AlertTitle>Webhooks could not be loaded</AlertTitle>
        <AlertDescription>
          <p>{errorText(query.error, "Check your connection and try again.")}</p>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void query.refetch()}><RefreshCw aria-hidden="true" /> Retry</Button>
        </AlertDescription>
      </Alert>
    );
  }

  const endpoints = query.data.endpoints;
  const full = endpoints.length >= MAX_WEBHOOK_ENDPOINTS;
  const addButton = <Button type="button" size="lg" disabled={full} onClick={() => setEditing({ endpoint: null })}><Plus aria-hidden="true" /> Add address</Button>;

  async function toggle(endpoint: WebhookEndpoint, status: "active" | "disabled") {
    try {
      await setStatus.mutateAsync({ endpoint, status });
      toastManager.add({ title: status === "active" ? "Turned on" : "Turned off", type: "success" });
    } catch (cause: unknown) {
      toastManager.add({ title: "Could not change it", description: errorText(cause, "Try again."), type: "error" });
    }
  }

  async function sendTest(endpoint: WebhookEndpoint) {
    try {
      await test.mutateAsync(endpoint.id);
      setOpen(endpoint.id);
      toastManager.add({ title: "Test event queued", description: "It shows in the delivery log in a moment.", type: "success" });
    } catch (cause: unknown) {
      toastManager.add({ title: "Could not send a test event", description: errorText(cause, "Try again."), type: "error" });
    }
  }

  async function runConfirmed() {
    if (!confirm) return;
    const { kind, endpoint } = confirm;
    try {
      if (kind === "delete") {
        await remove.mutateAsync(endpoint.id);
        toastManager.add({ title: "Address deleted", type: "success" });
      } else {
        const result = await rotate.mutateAsync(endpoint.id);
        if (result?.secret) setSecret({ title: "Copy your new signing secret", secret: result.secret });
      }
    } catch (cause: unknown) {
      toastManager.add({ title: kind === "delete" ? "Could not delete the address" : "Could not make a new secret", description: errorText(cause, "Try again."), type: "error" });
    } finally {
      setConfirm(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {endpoints.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><Webhook aria-hidden="true" /></EmptyMedia>
            <EmptyTitle>No webhook addresses yet</EmptyTitle>
            <EmptyDescription>Add an address and Kalendr will tell it when something happens, such as a booking being made or cancelled.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>{addButton}</EmptyContent>
        </Empty>
      ) : (
        <Frame>
          <FrameHeader className="flex-row items-start justify-between gap-3">
            <div className="min-w-0">
              <FrameTitle>Webhook addresses</FrameTitle>
              <FrameDescription>{endpoints.length} of {MAX_WEBHOOK_ENDPOINTS}. Every message is signed with the address&apos;s secret.</FrameDescription>
            </div>
            {addButton}
          </FrameHeader>
          {endpoints.map((endpoint) => {
            const expanded = open === endpoint.id;
            const name = endpoint.description || endpoint.url;
            return (
              <FramePanel key={endpoint.id} className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="break-all font-medium">{endpoint.url}</p>
                    {endpoint.description ? <p className="text-muted-foreground text-sm">{endpoint.description}</p> : null}
                  </div>
                  <StatusBadge endpoint={endpoint} />
                </div>
                {endpoint.status === "disabled" && endpoint.disabledReason === "repeated_failure" ? (
                  <Alert variant="warning">
                    <AlertTitle>Kalendr stopped sending here</AlertTitle>
                    <AlertDescription>
                      <p>This address failed {endpoint.consecutiveFailures} times in a row, so we turned it off. Fix the problem on your side, then turn it back on.</p>
                      <Button type="button" size="sm" className="mt-2" disabled={setStatus.isPending} onClick={() => void toggle(endpoint, "active")}><Power aria-hidden="true" /> Turn back on</Button>
                    </AlertDescription>
                  </Alert>
                ) : null}
                <div className="flex flex-wrap gap-1" aria-label="Events sent to this address">
                  {endpoint.events.map((event) => <Badge key={event} variant="outline">{event}</Badge>)}
                </div>
                <p className="text-muted-foreground text-xs">Last message: {lastDeliveryText(endpoint)}</p>
                <div className="flex flex-nowrap items-center gap-2">
                  <Button type="button" variant="outline" aria-expanded={expanded} aria-controls={`deliveries-${endpoint.id}`} onClick={() => setOpen(expanded ? null : endpoint.id)}>
                    Deliveries <ChevronDown aria-hidden="true" className={expanded ? "rotate-180" : ""} />
                  </Button>
                  <Button type="button" variant="outline" disabled={endpoint.status !== "active" || test.isPending} onClick={() => void sendTest(endpoint)}>
                    <Send aria-hidden="true" /> Send test<span className="sr-only"> event to {name}</span>
                  </Button>
                  <RichMenu>
                    <RichMenuTrigger render={<Button type="button" variant="outline" size="icon-lg" className="ms-auto" aria-label={`More for ${name}`} />}><Ellipsis aria-hidden="true" /></RichMenuTrigger>
                    <RichMenuContent>
                      <RichMenuItem icon={<Pencil aria-hidden="true" />} onClick={() => setEditing({ endpoint })}>Edit</RichMenuItem>
                      <RichMenuItem icon={<KeyRound aria-hidden="true" />} onClick={() => setConfirm({ kind: "rotate", endpoint })}>Make a new secret</RichMenuItem>
                      {endpoint.status === "active"
                        ? <RichMenuItem icon={<Power aria-hidden="true" />} onClick={() => void toggle(endpoint, "disabled")}>Turn off</RichMenuItem>
                        : <RichMenuItem icon={<Power aria-hidden="true" />} onClick={() => void toggle(endpoint, "active")}>Turn on</RichMenuItem>}
                      <RichMenuItem destructive icon={<Trash2 aria-hidden="true" />} onClick={() => setConfirm({ kind: "delete", endpoint })}>Delete</RichMenuItem>
                    </RichMenuContent>
                  </RichMenu>
                </div>
                {expanded ? <div id={`deliveries-${endpoint.id}`}><DeliveryLog endpointId={endpoint.id} endpointLabel={name} /></div> : null}
              </FramePanel>
            );
          })}
        </Frame>
      )}
      {full ? <p className="text-muted-foreground text-xs">You have the most addresses allowed. Delete one to add another.</p> : null}

      <WebhookDialog
        open={editing !== null}
        endpoint={editing?.endpoint ?? null}
        onOpenChange={(next) => { if (!next) setEditing(null); }}
        onSaved={(result) => {
          setEditing(null);
          if (result.secret) setSecret({ title: "Copy your signing secret", secret: result.secret });
          else toastManager.add({ title: "Changes saved", type: "success" });
        }}
      />
      <SecretRevealDialog
        open={secret !== null}
        title={secret?.title ?? ""}
        description="Use it to check that a message really came from Kalendr."
        label="Signing secret"
        secret={secret?.secret ?? ""}
        onDone={() => setSecret(null)}
      />
      <AlertDialog open={confirm !== null} onOpenChange={(next) => { if (!next) setConfirm(null); }}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.kind === "delete" ? "Delete this address?" : "Make a new secret?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "delete"
                ? "Kalendr will stop sending events here, and its delivery log goes with it. This cannot be undone."
                : "The old secret stops working at once, so update your side with the new one straight away."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button type="button" variant="ghost" size="lg" />}>Cancel</AlertDialogClose>
            <Button type="button" size="lg" variant={confirm?.kind === "delete" ? "destructive" : "default"} disabled={remove.isPending || rotate.isPending} onClick={() => void runConfirmed()}>
              {confirm?.kind === "delete" ? "Delete address" : "Make new secret"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
