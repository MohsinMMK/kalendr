"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { BellRing, CalendarCheck, CalendarX, Hourglass, LoaderCircle, TriangleAlert } from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Card, CardHeader, CardPanel } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import type { WaitlistOrderRule } from "@/lib/waitlist";
import type { OfferTrailEntry, OpenSlotTrail, WaitlistOffersOverview } from "@/server/waitlist-staff";

import { appointmentDateTime, appointmentTime } from "./clinic-format";
import { staffKeys } from "./queries/keys";
import { staffMutation, staffQuery } from "./staff-snapshot-provider";
import { useStaffAccess } from "./staff-access";

const orderChoices: Array<{ value: WaitlistOrderRule; label: string }> = [
  { value: "longest_waiting", label: "Longest waiting first" },
  { value: "soonest_existing", label: "Soonest existing booking first" },
];

/** One line of an offer's trail, in plain words: who was asked and what happened. No contact detail. */
export function trailLine(entry: OfferTrailEntry, now = Date.now()): { text: string; tone: "success" | "attention" | "neutral" | "danger" } {
  switch (entry.status) {
    case "accepted": return { text: `took it at ${appointmentTime(entry.answeredAt ?? entry.expiresAt)}`, tone: "success" };
    case "declined": return { text: `passed on it at ${appointmentTime(entry.answeredAt ?? entry.expiresAt)}`, tone: "neutral" };
    case "expired": return { text: `did not answer by ${appointmentTime(entry.expiresAt)}`, tone: "neutral" };
    case "withdrawn":
      return { text: entry.endedReason === "staff" ? "released by staff" : entry.endedReason === "undeliverable" ? "could not be reached" : entry.endedReason === "too_close" ? "not asked: too close to the time" : "withdrawn", tone: "danger" };
    case "sent": {
      const minutes = Math.max(0, Math.ceil((Date.parse(entry.expiresAt) - now) / 60_000));
      return { text: minutes > 0 ? `asked at ${appointmentTime(entry.sentAt ?? entry.expiresAt)}, ${minutes} min left` : "waiting for the answer to run out", tone: "attention" };
    }
    default: return { text: `will be asked at ${appointmentTime(entry.sentAt ?? entry.expiresAt)}`, tone: "attention" };
  }
}

const stateBadge: Record<OpenSlotTrail["state"], { label: string; tone: "success" | "attention" | "neutral" }> = {
  live: { label: "Offered, waiting", tone: "attention" },
  taken: { label: "Taken", tone: "success" },
  released: { label: "Back on the booking page", tone: "neutral" },
};

/**
 * The waitlist's offers for staff (feature 21): how people are picked, a switch for automatic offers per service, and
 * each open time's trail. Offering a time by hand lives on the waitlist entry's own screen.
 */
export function WaitlistOffersPanel() {
  const t = useTerms();
  const { can } = useStaffAccess();
  const canManage = can("waitlist.manage");
  const [busy, setBusy] = useState("");
  const query = useQuery({
    queryKey: [...staffKeys.all, "waitlist-offers"],
    queryFn: ({ signal }) => staffQuery<WaitlistOffersOverview>("/api/staff/waitlist/offers", signal),
    // Live offers change on their own (an answer, a message sent): look again every 30 seconds while any is open.
    refetchInterval: (state) => (state.state.data?.slots.some((slot) => slot.state === "live") ? 30_000 : false),
  });
  const overview = query.data ?? null;
  const error = query.error instanceof Error ? query.error.message : query.error ? "The offers could not be loaded." : "";
  const load = async () => { await query.refetch(); };

  async function change(key: string, run: () => Promise<unknown>) {
    setBusy(key);
    try {
      await run();
      await load();
      toastManager.add({ title: "Saved", type: "success" });
    } catch (cause: unknown) {
      toastManager.add({ title: cause instanceof Error ? cause.message : "The change could not be saved.", type: "error" });
    } finally {
      setBusy("");
    }
  }

  if (error && !overview) {
    return (
      <Alert variant="error" role="alert">
        <TriangleAlert aria-hidden="true" />
        <AlertDescription className="flex flex-col items-start gap-2">
          <span>{error}</span>
          <Button size="sm" variant="outline" onClick={() => void load()}>Try again</Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (!overview) {
    return (
      <div aria-busy="true" className="flex flex-col gap-3" role="status">
        <span className="sr-only">Loading the offers</span>
        <Skeleton className="h-28 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader>
          <h2 className="text-sm font-medium">Automatic offers</h2>
          <p className="text-xs text-muted-foreground">{`When ${t.anAppointment} is cancelled or moved, the first ${t.customer} waiting for that time is messaged. They have 15 minutes (5 inside 3 hours) before the next person is asked. After three people, or inside 2 hours, the time goes back to the booking page. Nothing is sent at night.`}</p>
        </CardHeader>
        <CardPanel className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5 sm:max-w-xs">
            <Label id="waitlist-order-label">Who is asked first</Label>
            <Select
              value={overview.orderRule}
              disabled={!canManage || busy === "order"}
              onValueChange={(next) => { if (next && next !== overview.orderRule) void change("order", () => staffMutation("/api/staff/waitlist/settings", "PUT", { orderRule: next })); }}
              items={orderChoices}
            >
              <SelectTrigger id="waitlist-order-trigger" aria-labelledby="waitlist-order-label waitlist-order-trigger"><SelectValue /></SelectTrigger>
              <SelectPopup>{orderChoices.map((choice) => <SelectItem key={choice.value} value={choice.value}>{choice.label}</SelectItem>)}</SelectPopup>
            </Select>
          </div>
          <ul aria-label="Automatic offers by service" className="flex flex-col divide-y rounded-lg border">
            {overview.services.map((service) => (
              <li key={service.serviceId} className="flex min-h-11 items-center justify-between gap-3 px-3 py-2">
                <Label className="flex min-w-0 flex-col items-start gap-0.5">
                  <span className="truncate">{service.name}</span>
                  <span className="font-normal text-xs text-muted-foreground tabular-nums">{service.waiting} waiting</span>
                </Label>
                <Switch
                  aria-label={`Automatic offers for ${service.name}`}
                  checked={service.automatic}
                  disabled={!canManage || busy === service.serviceId}
                  onCheckedChange={(checked) => void change(service.serviceId, () => staffMutation(`/api/staff/waitlist/services/${service.serviceId}`, "PUT", { automatic: checked }))}
                />
              </li>
            ))}
          </ul>
          {canManage ? null : <p className="text-xs text-muted-foreground">You can see this but not change it. Ask the owner for the waitlist permission.</p>}
        </CardPanel>
      </Card>

      <section aria-label="Open times" className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">Open times</h2>
        {overview.slots.length === 0 ? (
          <Empty className="rounded-xl border p-4 md:p-6">
            <EmptyHeader>
              <EmptyMedia variant="icon"><BellRing aria-hidden="true" /></EmptyMedia>
              <EmptyTitle className="text-base">No offers yet</EmptyTitle>
              <EmptyDescription>{`When ${t.anAppointment} is cancelled and someone is waiting for that ${t.service}, the time appears here with who was asked.`}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : overview.slots.map((slot) => (
          <Card key={slot.chainId}>
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
              <div className="flex min-w-0 flex-col">
                <h3 className="truncate text-sm font-medium tabular-nums">{appointmentDateTime(slot.startsAt)}</h3>
                <p className="truncate text-xs text-muted-foreground">{slot.serviceName} · {slot.practitionerName}</p>
              </div>
              <StatusBadge tone={stateBadge[slot.state].tone}>{stateBadge[slot.state].label}</StatusBadge>
            </CardHeader>
            <CardPanel>
              <ol aria-label={`People asked about ${appointmentDateTime(slot.startsAt)}`} className="flex flex-col gap-2">
                {slot.offers.map((entry) => {
                  const line = trailLine(entry);
                  const live = entry.status === "scheduled" || entry.status === "sent";
                  return (
                    <li key={entry.offerId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                      <span className="flex min-w-0 items-center gap-2">
                        <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full border text-xs tabular-nums text-muted-foreground">{entry.position}</span>
                        <span className="min-w-0">
                          <span className="font-medium">{entry.personName}</span>{" "}
                          <span className="text-muted-foreground">{line.text}{entry.origin === "manual" ? " (offered by hand)" : ""}</span>
                        </span>
                      </span>
                      {live && canManage ? (
                        <Button size="sm" variant="outline" loading={busy === entry.offerId} onClick={() => void change(entry.offerId, () => staffMutation(`/api/staff/waitlist/offers/${entry.offerId}`, "DELETE", {}))}>
                          Release to booking page
                        </Button>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
              {slot.state === "live" ? (
                <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><Hourglass aria-hidden="true" className="size-3.5" /> This time is held and is not on the booking page.</p>
              ) : slot.state === "taken" ? (
                <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><CalendarCheck aria-hidden="true" className="size-3.5" /> Booked from the waitlist.</p>
              ) : (
                <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"><CalendarX aria-hidden="true" className="size-3.5" /> Nobody took it, so it is open to anyone on the booking page. To offer it to one person, open them on the Waitlist tab.</p>
              )}
            </CardPanel>
          </Card>
        ))}
        {busy ? <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircle aria-hidden="true" className="size-3.5 animate-spin motion-reduce:animate-none" /> Saving…</p> : null}
      </section>
    </div>
  );
}
