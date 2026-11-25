"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck, Settings } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Drawer, DrawerDescription, DrawerHeader, DrawerPanel, DrawerPopup, DrawerTitle } from "@/components/ui/drawer";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useTerms } from "@/features/terms/business-profile-context";
import { demoAppointments } from "@/lib/demo-data";
import { isAppPath, type NotificationView } from "@/lib/staff-alerts";
import { cn } from "@/lib/utils";

import { useCatalogLookups } from "./clinic-catalog";
import { actionItems, dayVisits } from "./clinic-today";
import { clinicDateKey, usePreviewAppointments } from "./preview-appointments";
import { useMarkNotificationsRead, useNotificationsQuery } from "./queries/notifications";
import { useOptionalStaffSnapshot } from "./staff-snapshot-provider";
import { AttentionList } from "./today-panels";

/** "just now", "5 min ago", "2 h ago", then the date. */
export function ago(iso: string, now: number = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.round(minutes / 60)} h ago`;
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

type BellTab = "alerts" | "attention";

/** Today's booking requests, missing forms and long waits, with what the preview needs to give each an owner. */
function useAttention() {
  const t = useTerms();
  const staff = useOptionalStaffSnapshot();
  const catalog = useCatalogLookups();
  const { appointments, patients, operations, assignOwner, database } = usePreviewAppointments();
  const loading = Boolean(staff && !staff.snapshot);
  const dayKey = database ? clinicDateKey(operations.clockIso) : clinicDateKey(demoAppointments[0].startsAt);
  const items = loading ? [] : actionItems(dayVisits(appointments, dayKey), patients, operations.visitTimings, operations.clockIso, t);
  return { items, patients, practitioners: catalog.practitioners, owners: database ? undefined : operations.owners, assignOwner, database };
}

/** The alerts: newest first, an unread dot, and one tap opens the thing it is about. */
function AlertsList({ onOpen }: { onOpen: (item: NotificationView) => void }) {
  const query = useNotificationsQuery();
  if (query.isPending) {
    return (
      <div role="status" aria-label="Loading alerts" className="flex flex-col gap-3 p-4">
        {[0, 1, 2].map((row) => <Skeleton key={row} className="h-10 w-full" />)}
      </div>
    );
  }
  if (query.isError) {
    return (
      <Empty className="py-8">
        <EmptyHeader>
          <EmptyTitle>Alerts could not be loaded</EmptyTitle>
          <EmptyDescription role="alert">Check your connection and try again.</EmptyDescription>
        </EmptyHeader>
        <Button size="sm" variant="outline" onClick={() => void query.refetch()}>Try again</Button>
      </Empty>
    );
  }
  if (query.data.items.length === 0) {
    return (
      <Empty className="py-8">
        <EmptyHeader>
          <EmptyTitle>No alerts yet</EmptyTitle>
          <EmptyDescription>New online bookings, cancellations and payments show up here the moment they happen.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ul className="divide-y rounded-lg border">
      {query.data.items.map((item) => (
        <li key={item.id}>
          <button
            type="button"
            onClick={() => onOpen(item)}
            className="flex min-h-11 w-full items-start gap-3 px-4 py-3 text-start outline-none hover:bg-accent focus-visible:bg-accent"
          >
            <span aria-hidden="true" className={cn("mt-1.5 size-2 shrink-0 rounded-full", item.read ? "bg-transparent" : "bg-destructive")} />
            <span className="min-w-0 flex-1">
              <span className={cn("block text-sm", item.read ? "text-muted-foreground" : "font-medium")}>
                {item.read ? null : <span className="sr-only">Unread. </span>}
                {item.title}
              </span>
              <span className="block text-xs text-muted-foreground">{ago(item.at)}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function Count({ value }: { value: number }) {
  return value ? <span className="ms-1.5 rounded-full bg-background px-1.5 text-xs tabular-nums">{value}</span> : null;
}

/**
 * The one bell in the staff header. Its count is unread alerts plus what needs attention; it opens a side drawer with an Alerts
 * tab and a Needs attention tab. Alerts arrive live, with no refresh. In the preview there are no alerts, only Needs attention.
 */
export function NotificationBell({ preview = false }: { preview?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<BellTab>("alerts");
  const [error, setError] = useState("");
  const query = useNotificationsQuery(!preview);
  const markRead = useMarkNotificationsRead();
  const attention = useAttention();
  const unread = preview ? 0 : query.data?.unread ?? 0;
  const needs = attention.items.length;
  const total = unread + needs;
  const parts = [unread ? `${unread} unread` : "", needs ? `${needs} need attention` : ""].filter(Boolean);
  const label = parts.length ? `Notifications: ${parts.join(", ")}` : "Notifications";

  function show() {
    // Open on whichever tab has something new.
    setTab(preview || (needs > 0 && unread === 0) ? "attention" : "alerts");
    setOpen(true);
  }

  function openAlert(item: NotificationView) {
    if (!item.read) markRead.mutate({ ids: [item.id] });
    setOpen(false);
    if (item.link && isAppPath(item.link)) router.push(item.link);
  }

  const attentionList = (
    <AttentionList
      items={attention.items}
      patients={attention.patients}
      practitioners={attention.practitioners}
      owners={attention.owners}
      onAssign={attention.database ? undefined : (key, owner) => { setError(attention.assignOwner(key, owner) ? "" : "Could not save who owns this in this browser."); }}
    />
  );

  return (
    <>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger render={<Button variant="outline" size="icon-sm" className="relative" aria-label={label} onClick={show} />}>
            <Bell aria-hidden="true" />
            {total ? (
              // The count is drawn by CSS from data-count, so it is not a second piece of text beside the button's own label. White on
              // red-700 (red-600 in the dark theme) clears 4.5:1; the lighter destructive colour behind white text did not.
              <span
                aria-hidden="true"
                data-count={total > 99 ? "99+" : String(total)}
                className="absolute -end-1.5 -top-1.5 inline-flex min-w-4.5 items-center justify-center rounded-full bg-red-700 px-1 text-[0.6875rem] leading-4.5 font-medium text-white tabular-nums after:content-[attr(data-count)] dark:bg-red-600"
              />
            ) : null}
          </TooltipTrigger>
          <TooltipPopup>{total ? `${unread} unread, ${needs} need attention` : "No new notifications"}</TooltipPopup>
        </Tooltip>
      </TooltipProvider>
      <Drawer open={open} onOpenChange={setOpen} position="right">
        <DrawerPopup variant="inset" showCloseButton aria-label="Notifications">
          <DrawerHeader className="pe-14">
            <div className="flex items-center gap-2">
              <DrawerTitle>Notifications</DrawerTitle>
              <Button variant="ghost" size="icon-xs" aria-label="Notification settings" render={<Link href="/profile/notifications" onClick={() => setOpen(false)} />}>
                <Settings aria-hidden="true" />
              </Button>
            </div>
            <DrawerDescription>New alerts, booking requests, missing forms and long waits.</DrawerDescription>
          </DrawerHeader>
          <DrawerPanel>
            {preview ? attentionList : (
              <Tabs value={tab} onValueChange={(next) => setTab(next as BellTab)}>
                <TabsList className="w-full">
                  <TabsTab value="alerts">Alerts<Count value={unread} /></TabsTab>
                  <TabsTab value="attention">Needs attention<Count value={needs} /></TabsTab>
                </TabsList>
                <TabsPanel value="alerts" className="flex flex-col gap-2">
                  <div className="flex justify-end">
                    <Button variant="ghost" size="sm" disabled={!unread || markRead.isPending} onClick={() => markRead.mutate({ all: true })}>
                      <CheckCheck aria-hidden="true" /> Mark all read
                    </Button>
                  </div>
                  <AlertsList onOpen={openAlert} />
                </TabsPanel>
                <TabsPanel value="attention">{attentionList}</TabsPanel>
              </Tabs>
            )}
          </DrawerPanel>
        </DrawerPopup>
      </Drawer>
      {error ? <p role="alert" className="sr-only">{error}</p> : null}
    </>
  );
}
