"use client";

import { useState } from "react";
import { CircleAlert, CircleCheck, Clock } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import { calendarProviderLabels, type CalendarConnectionView, type CalendarSelectionView, type ConnectionStatus, type SelectionPatch } from "@/lib/calendar-sync";

import { ConfirmDialog, touchTarget } from "./calendar-confirm";
import { connectPath, isVersionConflict, useChangeSelection, useDisconnectCalendar } from "./queries/calendars";

const none = "none";

export function StatusBadge({ status }: { status: ConnectionStatus }) {
  if (status === "active") return <Badge variant="success"><CircleCheck aria-hidden="true" />Connected</Badge>;
  if (status === "pending") return <Badge variant="info"><Clock aria-hidden="true" />Checking…</Badge>;
  return <Badge variant="warning"><CircleAlert aria-hidden="true" />Needs reconnecting</Badge>;
}

/** Google and Outlook reconnect by going through the provider again; Apple asks for the password again. */
export function ConnectAction({ provider, label, variant = "default", disabled, onApple }: {
  provider: CalendarConnectionView["provider"];
  label: string;
  variant?: "default" | "outline";
  disabled?: boolean;
  onApple: () => void;
}) {
  if (disabled) return <Button variant={variant} className={`${touchTarget} shrink-0`} disabled>{label}</Button>;
  if (provider === "apple") return <Button variant={variant} className={`${touchTarget} shrink-0`} onClick={onApple}>{label}</Button>;
  return <Button variant={variant} className={`${touchTarget} shrink-0`} render={<a href={connectPath(provider)} />}>{label}</Button>;
}

function CalendarRow({ calendar, editable, busy, onChange }: {
  calendar: CalendarSelectionView;
  editable: boolean;
  busy: boolean;
  onChange: (patch: SelectionPatch) => void;
}) {
  const id = `blocks-${calendar.id}`;
  return (
    <li className="flex min-h-11 items-center justify-between gap-3 py-1">
      <Label htmlFor={id} className="min-w-0 flex-1 flex-col items-start gap-0 text-sm">
        <span className="truncate font-medium">{calendar.name}{calendar.primary ? " (main)" : ""}</span>
        <span className="text-xs font-normal text-muted-foreground">Blocks my availability{calendar.canWrite ? "" : " · read only"}</span>
      </Label>
      <Switch id={id} checked={calendar.blocksAvailability} disabled={!editable || busy}
        onCheckedChange={(blocksAvailability) => onChange({ blocksAvailability, version: calendar.version })} />
    </li>
  );
}

/** One connected account: who and how it is doing, which calendars block time, where new bookings go, and disconnecting. */
export function ConnectionCard({ connection, onReconnectApple }: { connection: CalendarConnectionView; onReconnectApple: () => void }) {
  const t = useTerms();
  const change = useChangeSelection();
  const disconnect = useDisconnectCalendar();
  const [confirm, setConfirm] = useState(false);
  const editable = connection.mine;
  const writable = connection.calendars.filter((calendar) => calendar.canWrite);
  const current = writable.find((calendar) => calendar.writesHere);
  const writeItems = [{ value: none, label: "Nowhere" }, ...writable.map((calendar) => ({ value: calendar.id, label: calendar.name }))];
  const provider = calendarProviderLabels[connection.provider];

  function patch(id: string, body: SelectionPatch) {
    change.mutate({ id, patch: body }, {
      onError: (error) => {
        if (isVersionConflict(error)) toastManager.add({ title: "This changed on another screen. Reloaded.", type: "warning" });
        else toastManager.add({ title: "That could not be saved", description: error.message, type: "error" });
      },
    });
  }

  function chooseWriteTarget(next: string | null) {
    const value = next ?? none;
    if (value === (current?.id ?? none)) return;
    if (value === none) {
      if (current) patch(current.id, { writesHere: false, version: current.version });
      return;
    }
    const target = writable.find((calendar) => calendar.id === value);
    if (target) patch(target.id, { writesHere: true, version: target.version });
  }

  function leave() {
    disconnect.mutate(connection.id, {
      onSuccess: () => { setConfirm(false); toastManager.add({ title: `${provider} disconnected`, type: "success" }); },
      onError: (error) => { setConfirm(false); toastManager.add({ title: "It could not be disconnected", description: error.message, type: "error" }); },
    });
  }

  return (
    <li className="flex flex-col gap-3 rounded-xl border p-3">
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium">{provider}</p>
          <StatusBadge status={connection.status} />
        </div>
        <p className="break-all text-xs text-muted-foreground">
          {connection.accountEmail ?? "Account"}{connection.mine ? "" : ` · ${connection.ownerName}'s calendar. Only they can change it.`}
        </p>
        {connection.status === "needs_reconnect" ? (
          <p className="text-xs">Sign in again so {t.appointments} keep syncing.</p>
        ) : connection.status === "pending" ? (
          <p className="text-xs text-muted-foreground">Checking the login. This takes a few seconds.</p>
        ) : null}
      </div>

      {connection.status === "active" && connection.calendars.length === 0 ? (
        <p className="text-xs text-muted-foreground">Finding your calendars…</p>
      ) : null}
      {connection.calendars.length > 0 ? (
        <ul aria-label={`${provider} calendars`} className="divide-y">
          {connection.calendars.map((calendar) => (
            <CalendarRow key={calendar.id} calendar={calendar} editable={editable && connection.status === "active"} busy={change.isPending}
              onChange={(body) => patch(calendar.id, body)} />
          ))}
        </ul>
      ) : null}

      {writable.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <Label id={`write-${connection.id}`} className="text-sm font-medium">Write new bookings to</Label>
          <Select value={current?.id ?? none} onValueChange={chooseWriteTarget} items={writeItems} disabled={!editable || change.isPending || connection.status !== "active"}>
            <SelectTrigger size="lg" aria-labelledby={`write-${connection.id}`}><SelectValue /></SelectTrigger>
            <SelectPopup>{writeItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectPopup>
          </Select>
        </div>
      ) : null}

      {editable ? (
        <div className="flex flex-nowrap items-center gap-2">
          {connection.status === "needs_reconnect" ? <ConnectAction provider={connection.provider} label="Reconnect" onApple={onReconnectApple} /> : null}
          <Button variant="outline" className={`${touchTarget} shrink-0`} onClick={() => setConfirm(true)}>Disconnect</Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Disconnect ${provider}?`}
        description="Your calendar stays as it is. Kalendr stops reading it and forgets the busy times it saved."
        confirmLabel="Disconnect"
        destructive
        busy={disconnect.isPending}
        onConfirm={leave}
      />
    </li>
  );
}
