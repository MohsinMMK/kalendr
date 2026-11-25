"use client";

import { Ellipsis, Plus, UsersRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Frame, FrameDescription, FrameHeader, FramePanel } from "@/components/ui/frame";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import { describeLimit, type BookingLimitsView } from "@/lib/booking-limits";

import { deleteTeamLimits, listTeamLimits } from "./booking-limits-api";
import { BookingLimitsPanel } from "./booking-limits-panel";
import { useCatalogLookups } from "./clinic-catalog";

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; teams: BookingLimitsView[] };

/** "3 people · 8 bookings a day · 40 hours booked a week" for one team pool. */
export function teamSummary(view: BookingLimitsView, one: string, many: string): string {
  const count = view.team?.memberIds.length ?? 0;
  const limits = view.limits.map((limit) => describeLimit(limit));
  return [`${count} ${count === 1 ? one : many}`, limits.length ? limits.join(" · ") : "No limits yet"].join(" · ");
}

/**
 * Team limits: a hand-picked pool of people whose bookings count together. Make one, give it limits, and edit or
 * remove it later. This is the stand-in until real teams arrive.
 */
export function TeamLimitsSettings() {
  const t = useTerms();
  const catalog = useCatalogLookups();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState<BookingLimitsView | "new" | null>(null);
  const [removing, setRemoving] = useState<BookingLimitsView | null>(null);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const database = catalog.database;

  useEffect(() => {
    if (!database) return;
    const controller = new AbortController();
    listTeamLimits(controller.signal).then((teams) => {
      if (!controller.signal.aborted) setLoad({ state: "ready", teams });
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setLoad({ state: "error", message: cause instanceof Error ? cause.message : "The teams could not be loaded." });
    });
    return () => controller.abort();
  }, [database, reloadKey]);

  const reload = useCallback(() => { setLoad({ state: "loading" }); setReloadKey((key) => key + 1); }, []);

  async function remove(view: BookingLimitsView) {
    if (!view.team) return;
    setPending(true);
    setMessage("");
    try {
      await deleteTeamLimits(view.team.id);
      setRemoving(null);
      toastManager.add({ title: `${view.team.name} removed. Its limits no longer apply.`, type: "success" });
      reload();
    } catch (cause: unknown) {
      setMessage(cause instanceof Error ? cause.message : "The team could not be removed.");
    } finally {
      setPending(false);
    }
  }

  if (!database) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><UsersRound aria-hidden="true" /></EmptyMedia>
          <EmptyTitle>Team limits are not available in the preview</EmptyTitle>
          <EmptyDescription>They are saved on the {t.business} database. Start the local database to make one.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const teams = load.state === "ready" ? load.teams : [];
  return (
    <Frame>
      <FrameHeader className="flex-row flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold text-sm">Team limits</h3>
          <FrameDescription className="text-xs">Pick some {t.practitioners} and cap what they take on together, such as 20 {t.appointments} a day between three of them.</FrameDescription>
        </div>
        <Button size="lg" variant="outline" onClick={() => setEditing("new")}><Plus aria-hidden="true" /> New team</Button>
      </FrameHeader>
      <FramePanel className="py-1">
        {message ? <Alert variant="error" className="my-2"><AlertDescription>{message}</AlertDescription></Alert> : null}
        {load.state === "loading" ? (
          <div className="flex flex-col gap-2 py-3" role="status" aria-label="Loading the teams"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div>
        ) : null}
        {load.state === "error" ? (
          <Alert variant="error" className="my-2">
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span>{load.message}</span>
              <Button size="sm" variant="outline" onClick={reload}>Try again</Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {load.state === "ready" && teams.length === 0 ? (
          <Empty className="py-6">
            <EmptyHeader>
              <EmptyMedia variant="icon"><UsersRound aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>No teams yet</EmptyTitle>
              <EmptyDescription>Make a team to limit what a few {t.practitioners} take on together.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
        {teams.length > 0 ? (
          <ul className="flex flex-col divide-y">
            {teams.map((view) => (
              <li key={view.team?.id ?? "team"} className="flex items-center justify-between gap-3 py-3">
                <button type="button" className="min-h-11 min-w-0 flex-1 rounded-md text-start outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setEditing(view)}>
                  <span className="block truncate font-medium text-sm">{view.team?.name}</span>
                  <span className="block text-muted-foreground text-xs">{teamSummary(view, t.practitioner, t.practitioners)}</span>
                </button>
                <Menu>
                  <MenuTrigger render={<Button variant="ghost" size="icon-lg" aria-label={`More for ${view.team?.name ?? "team"}`} disabled={pending} />}><Ellipsis aria-hidden="true" /></MenuTrigger>
                  <MenuPopup align="end">
                    <MenuItem onClick={() => setEditing(view)}>Edit</MenuItem>
                    <MenuSeparator />
                    <MenuItem variant="destructive" onClick={() => setRemoving(view)}>Remove</MenuItem>
                  </MenuPopup>
                </Menu>
              </li>
            ))}
          </ul>
        ) : null}
      </FramePanel>

      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null); }}>
        <DialogPopup className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing === "new" || editing === null ? "New team" : editing.team?.name ?? "Team"}</DialogTitle>
            <DialogDescription>Choose the people and set what they can take on together.</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {editing !== null ? (
              <BookingLimitsPanel scope="team" scopeId={editing === "new" ? null : editing.team?.id ?? null} team subject="this team"
                onSaved={() => { setEditing(null); reload(); }} />
            ) : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>

      <AlertDialog open={removing !== null} onOpenChange={(open) => { if (!open && !pending) setRemoving(null); }}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing?.team?.name}?</AlertDialogTitle>
            <AlertDialogDescription>Its limits stop applying to new bookings. Bookings already made stay.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" disabled={pending} />}>Keep it</AlertDialogClose>
            <Button variant="destructive" disabled={pending} onClick={() => removing && void remove(removing)}>
              {pending ? <Spinner aria-hidden="true" /> : null}
              Remove team
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </Frame>
  );
}
