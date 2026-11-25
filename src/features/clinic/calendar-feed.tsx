"use client";

import { useState } from "react";
import { Copy, Rss } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import type { CalendarFeedView } from "@/lib/calendar-sync";

import { ConfirmDialog, touchTarget } from "./calendar-confirm";
import { useCreateFeed, useRevokeFeed } from "./queries/calendars";

/**
 * A private address another calendar app can subscribe to. The server keeps only a hash of it, so the address
 * can be copied right after it is made and never again; after a reload the choices are "make a new one" or "turn off".
 */
export function CalendarFeed({ feed }: { feed: CalendarFeedView }) {
  const t = useTerms();
  const create = useCreateFeed();
  const revoke = useRevokeFeed();
  const [address, setAddress] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"replace" | "off" | null>(null);

  function make() {
    create.mutate(undefined, {
      onSuccess: (created) => { setAddress(created.url); setConfirm(null); },
      onError: (error) => { setConfirm(null); toastManager.add({ title: "The link could not be made", description: error.message, type: "error" }); },
    });
  }

  function turnOff() {
    revoke.mutate(undefined, {
      onSuccess: () => { setAddress(null); setConfirm(null); toastManager.add({ title: "The link is turned off", type: "success" }); },
      onError: (error) => { setConfirm(null); toastManager.add({ title: "The link could not be turned off", description: error.message, type: "error" }); },
    });
  }

  async function copy() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      toastManager.add({ title: "Link copied", description: "Paste it into the other calendar as a subscription.", type: "success" });
    } catch {
      toastManager.add({ title: "Could not copy", description: "Select the link and copy it.", type: "error" });
    }
  }

  return (
    <section aria-labelledby="calendar-feed-title" className="flex flex-col gap-2">
      <h3 id="calendar-feed-title" className="flex items-center gap-2 text-sm font-medium"><Rss aria-hidden="true" className="size-4" />Subscribe to your Kalendr day in another calendar</h3>
      <p className="text-xs text-muted-foreground">
        Add your {t.appointments} to any calendar app that can subscribe to a link. It only shows your {t.appointments} and updates by itself. Anyone with the link can see it, so keep it private.
      </p>
      {address ? (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <Input readOnly value={address} aria-label="Your private calendar link" onFocus={(event) => event.currentTarget.select()} className="font-mono text-xs" />
            <Button variant="outline" size="icon" className="min-h-11 min-w-11 sm:min-h-8 sm:min-w-8" aria-label="Copy link" onClick={() => void copy()}><Copy aria-hidden="true" /></Button>
          </div>
          <p className="text-xs text-muted-foreground">Copy it now. For your safety it cannot be shown again.</p>
        </div>
      ) : feed.active ? (
        <p className="text-xs text-muted-foreground">Your link is on. It cannot be shown again, so make a new one if you need to copy it.</p>
      ) : null}
      <div className="flex flex-nowrap items-center gap-2">
        {feed.active ? (
          <>
            <Button variant="outline" className={`${touchTarget} shrink-0`} onClick={() => setConfirm("replace")}>Make a new link</Button>
            <Button variant="destructive-outline" className={`${touchTarget} shrink-0`} onClick={() => setConfirm("off")}>Turn off</Button>
          </>
        ) : (
          <Button className={`${touchTarget} shrink-0`} loading={create.isPending} onClick={make}>Create link</Button>
        )}
      </div>
      <ConfirmDialog
        open={confirm === "replace"}
        onOpenChange={(open) => { if (!open) setConfirm(null); }}
        title="Make a new link?"
        description="The old link stops working. Any calendar using it will stop updating until you add the new one."
        confirmLabel="Make a new link"
        busy={create.isPending}
        onConfirm={make}
      />
      <ConfirmDialog
        open={confirm === "off"}
        onOpenChange={(open) => { if (!open) setConfirm(null); }}
        title="Turn off the link?"
        description="The link stops working straight away. Calendars using it will stop updating."
        confirmLabel="Turn off"
        destructive
        busy={revoke.isPending}
        onConfirm={turnOff}
      />
    </section>
  );
}
