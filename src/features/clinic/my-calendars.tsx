"use client";

import { useEffect, useState } from "react";
import { CircleAlert, Info } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import {
  calendarProviderIds, calendarProviderLabels, eventTextLabels, eventTextSchema,
  type CalendarOverview, type CalendarProviderName,
} from "@/lib/calendar-sync";

import { AppleConnectDialog } from "./apple-connect-dialog";
import { touchTarget } from "./calendar-confirm";
import { CalendarConflicts } from "./calendar-conflicts";
import { CalendarFeed } from "./calendar-feed";
import { ConnectAction, ConnectionCard } from "./my-calendars-connection";
import { useCalendarOverview, useSaveEventText } from "./queries/calendars";

function SectionCard({ children, badge }: { children: React.ReactNode; badge?: React.ReactNode }) {
  const t = useTerms();
  return (
    <Card>
      <CardHeader>
        <CardTitle render={<h2 />} className="flex flex-wrap items-center gap-2">My calendars{badge}</CardTitle>
        <CardDescription>Connect a calendar so the times you are busy are never offered for booking, and new {t.appointments} show up in it.</CardDescription>
      </CardHeader>
      <CardPanel className="flex flex-col gap-5">{children}</CardPanel>
    </Card>
  );
}

/** Preview has no accounts or database, so nothing is fetched and the section says so. */
function PreviewState() {
  return (
    <SectionCard>
      <Alert variant="info">
        <Info aria-hidden="true" />
        <AlertDescription>Calendar sync is not available in the preview. It works once the business database is connected.</AlertDescription>
      </Alert>
    </SectionCard>
  );
}

function EventTextSetting({ overview }: { overview: CalendarOverview }) {
  const save = useSaveEventText();
  const items = eventTextSchema.options.map((value) => ({ value, label: eventTextLabels[value].label }));
  const current = eventTextLabels[overview.eventText];
  if (!overview.canManageSettings) {
    return (
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">What your calendar shows</p>
        <p className="text-sm">{current.label}</p>
        <p className="text-xs text-muted-foreground">{current.description} Only an owner or admin can change this.</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Label id="event-text-label" className="text-sm font-medium">What your calendar shows</Label>
      <Select
        value={overview.eventText}
        items={items}
        disabled={save.isPending}
        onValueChange={(next) => {
          const parsed = eventTextSchema.safeParse(next);
          if (!parsed.success || parsed.data === overview.eventText) return;
          save.mutate(parsed.data, {
            onSuccess: () => toastManager.add({ title: "Saved", description: "This applies to every calendar and link.", type: "success" }),
            onError: (error) => toastManager.add({ title: "That could not be saved", description: error.message, type: "error" }),
          });
        }}
      >
        <SelectTrigger size="lg" aria-labelledby="event-text-label"><SelectValue /></SelectTrigger>
        <SelectPopup>{items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectPopup>
      </Select>
      <p className="text-xs text-muted-foreground">{current.description} This applies to everyone&apos;s calendars and links.</p>
    </div>
  );
}

function ProviderCard({ provider, overview, onApple }: { provider: CalendarProviderName; overview: CalendarOverview; onApple: () => void }) {
  const availability = overview.providers.find((item) => item.provider === provider);
  const mine = overview.connections.filter((connection) => connection.mine).length;
  const atLimit = mine >= overview.maxConnections;
  const unavailable = !availability?.available;
  return (
    <li className="flex items-center justify-between gap-3 rounded-xl border p-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{calendarProviderLabels[provider]}</p>
        {unavailable ? <p className="text-xs text-muted-foreground">{availability?.reason ?? "Not available right now."}</p> : null}
      </div>
      <ConnectAction provider={provider} label="Connect" disabled={unavailable || atLimit} onApple={onApple} />
    </li>
  );
}

function Loaded({ overview }: { overview: CalendarOverview }) {
  const [apple, setApple] = useState(false);
  const mine = overview.connections.filter((connection) => connection.mine).length;
  const atLimit = mine >= overview.maxConnections;
  const trouble = overview.connections.filter((connection) => connection.mine && connection.status === "needs_reconnect").length;
  return (
    <>
      {overview.mode === "unavailable" ? (
        <Alert variant="info">
          <Info aria-hidden="true" />
          <AlertDescription>Calendar sync is not available in the preview.</AlertDescription>
        </Alert>
      ) : null}
      {trouble > 0 ? (
        <Alert variant="warning">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{trouble === 1 ? "One calendar needs reconnecting." : `${trouble} calendars need reconnecting.`} Until then it is not kept up to date.</AlertDescription>
        </Alert>
      ) : null}
      {overview.connections.length === 0 && overview.mode !== "unavailable" ? (
        <p className="text-sm text-muted-foreground">No calendar is connected yet. Connect the one you already use, and Kalendr will keep you from being booked while you are busy.</p>
      ) : null}
      {overview.connections.length > 0 ? (
        <ul aria-label="Connected calendars" className="flex flex-col gap-3">
          {overview.connections.map((connection) => <ConnectionCard key={connection.id} connection={connection} onReconnectApple={() => setApple(true)} />)}
        </ul>
      ) : null}
      {overview.mode !== "unavailable" ? (
        <section aria-labelledby="add-calendar-title" className="flex flex-col gap-2">
          <h3 id="add-calendar-title" className="text-sm font-medium">Add a calendar</h3>
          {atLimit ? <p className="text-xs text-muted-foreground">You can connect up to {overview.maxConnections} calendars. Disconnect one to add another.</p> : null}
          <ul className="flex flex-col gap-2">
            {calendarProviderIds.map((provider) => <ProviderCard key={provider} provider={provider} overview={overview} onApple={() => setApple(true)} />)}
          </ul>
        </section>
      ) : null}
      <CalendarConflicts conflicts={overview.conflicts} />
      {overview.mode !== "unavailable" ? <EventTextSetting overview={overview} /> : null}
      {overview.mode !== "unavailable" ? <CalendarFeed feed={overview.feed} /> : null}
      <AppleConnectDialog open={apple} onOpenChange={setApple} />
    </>
  );
}

/** Tells the person how the provider's sign-in went: the server sends them back here with ?calendar=connected or error. */
function useConnectResult() {
  useEffect(() => {
    const url = new URL(window.location.href);
    const result = url.searchParams.get("calendar");
    if (result !== "connected" && result !== "error") return;
    url.searchParams.delete("calendar");
    window.history.replaceState(null, "", url);
    if (result === "connected") toastManager.add({ title: "Calendar connected", description: "It is being checked now.", type: "success" });
    else toastManager.add({ title: "The calendar was not connected", description: "Nothing was changed. Try again.", type: "error" });
  }, []);
}

function LiveCalendars() {
  const query = useCalendarOverview();
  useConnectResult();
  const overview = query.data;
  return (
    <SectionCard badge={overview?.mode === "fake" ? <Badge variant="warning" size="lg">Test accounts</Badge> : null}>
      {query.isPending ? (
        <div role="status" aria-label="Loading your calendars" className="flex flex-col gap-3">
          {[0, 1].map((row) => <Skeleton key={row} className="h-16 w-full" />)}
        </div>
      ) : query.isError || !overview ? (
        <Alert variant="error">
          <CircleAlert aria-hidden="true" />
          <AlertDescription className="flex flex-wrap items-center gap-3">
            Your calendars could not be loaded.
            <Button size="sm" variant="outline" className={touchTarget} onClick={() => void query.refetch()}>Try again</Button>
          </AlertDescription>
        </Alert>
      ) : (
        <Loaded overview={overview} />
      )}
    </SectionCard>
  );
}

/** The "My calendars" section of the profile page. */
export function MyCalendars({ preview }: { preview: boolean }) {
  return preview ? <PreviewState /> : <LiveCalendars />;
}
