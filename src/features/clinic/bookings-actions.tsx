"use client";

import { Ban, Check, CircleX, Ellipsis, ExternalLink, Mail, ShieldAlert, UserRoundCog, UserRoundX, X } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";

import { ActionMenuButton, type ActionMenuEntry } from "@/components/action-bar";
import { Button } from "@/components/ui/button";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import { BULK_MAX, type BookingRow, type BookingTab, type BulkInput, type BulkResult } from "@/lib/bookings-list";
import { appointmentLink } from "@/lib/staff-alerts";

import { BulkCancelDialog, BulkMessageDialog, BulkResultDialog, ConfirmDialog, ReassignDialog } from "./bookings-dialogs";
import { changeBooking, runBulkAction } from "./bookings-data";
import { CancelWithReasonDialog } from "./appointment-change-dialogs";
import { DeclineDialog } from "./decline-dialog";
import { ReportSpamDialog } from "./report-spam-dialog";
import { useStaffAccess } from "./staff-access";

type Dialog =
  | { kind: "reassign" | "cancel" | "message" | "no_show" | "spam" }
  | { kind: "reassign" | "cancel" | "decline" | "no_show_host" | "spam"; row: BookingRow };

const changeable = ["requested", "booked", "reschedule_requested"];
const cancellable = [...changeable, "checked_in"];
const verbs: Record<BulkInput["action"], string> = { confirm: "confirmed", cancel: "cancelled", mark_no_show: "marked as no-show", reassign: "moved", message: "messaged", report_spam: "reported as spam" };
const errorText = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback);

/**
 * Everything staff can do to bookings from this list: the ⋯ menu on a row, the bar that appears when some are
 * selected, the dialogs they open and the result of a bulk run. One failure never hides the successes.
 */
export function useBookingActions({ rows, tab, selected, setSelected, people, refresh }: {
  rows: BookingRow[];
  tab: BookingTab;
  selected: ReadonlySet<string>;
  setSelected: (next: ReadonlySet<string>) => void;
  people: { value: string; label: string }[];
  refresh: () => Promise<unknown>;
}): { menuFor: (row: BookingRow) => ActionMenuEntry[]; bar: ReactNode; dialogs: ReactNode; canChange: boolean } {
  const t = useTerms();
  const access = useStaffAccess();
  const canBook = access.can("appointments.book");
  const canStatus = access.can("appointments.status");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ verb: string; result: BulkResult } | null>(null);
  // When the page opened: only a booking whose time has come can be marked as one nobody turned up for.
  const [openedAt] = useState(() => Date.now());
  const byId = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const chosen = rows.filter((row) => selected.has(row.id));

  const show = (next: Dialog) => { setError(""); setDialog(next); };
  const close = () => setDialog(null);

  async function bulk(input: Omit<BulkInput, "items">) {
    const body = { ...input, items: chosen.map((row) => ({ id: row.id, expectedVersion: row.version })) } as BulkInput;
    setPending(true); setError("");
    try {
      const outcome = await runBulkAction(body);
      // The ones that worked leave the selection; the ones that did not stay, ready to retry.
      setSelected(new Set(outcome.results.filter((item) => !item.ok).map((item) => item.id)));
      setDialog(null);
      setResult({ verb: verbs[input.action], result: outcome });
      void refresh();
    } catch (cause: unknown) {
      setError(errorText(cause, "Nothing was changed. Check your connection and try again."));
    } finally { setPending(false); }
  }

  async function one(row: BookingRow, body: Record<string, unknown>, title: string) {
    setPending(true); setError("");
    try {
      await changeBooking(row, body);
      setDialog(null);
      toastManager.add({ title, type: "success" });
      void refresh();
    } catch (cause: unknown) { setError(errorText(cause, `Could not change this ${t.appointment}. Try again.`)); }
    finally { setPending(false); }
  }

  const started = (row: BookingRow) => Date.parse(row.startsAt) <= openedAt;
  const menuFor = (row: BookingRow): ActionMenuEntry[] => {
    const entries: ActionMenuEntry[] = [{ id: "open", label: "Open", icon: <ExternalLink aria-hidden="true" />, href: appointmentLink(row.id) }];
    if (canBook && row.status === "requested") {
      entries.push({ id: "approve", label: "Approve", icon: <Check aria-hidden="true" />, onSelect: () => void one(row, { action: "approve" }, "Approved") }, { id: "decline", label: "Decline…", icon: <CircleX aria-hidden="true" />, onSelect: () => show({ kind: "decline", row }) });
    }
    if (canBook && changeable.includes(row.status)) entries.push({ id: "reassign", label: "Reassign…", icon: <UserRoundCog aria-hidden="true" />, onSelect: () => show({ kind: "reassign", row }) });
    if (canStatus && (row.status === "booked" || row.status === "checked_in") && started(row)) {
      entries.push({ id: "no-show", label: "Mark no-show", icon: <UserRoundX aria-hidden="true" />, onSelect: () => void one(row, { action: "mark_no_show", who: "customer" }, "Marked as no-show") },
        { id: "no-show-host", label: "Mark that we didn't turn up", icon: <UserRoundX aria-hidden="true" />, onSelect: () => show({ kind: "no_show_host", row }) });
    }
    if (canBook && cancellable.includes(row.status)) entries.push({ kind: "separator", id: "cancel-sep" }, { id: "cancel", label: "Cancel with a reason…", icon: <Ban aria-hidden="true" />, destructive: true, onSelect: () => show({ kind: "cancel", row }) });
    if (canBook) entries.push({ id: "spam", label: "Report as spam…", icon: <ShieldAlert aria-hidden="true" />, destructive: true, onSelect: () => show({ kind: "spam", row }) });
    return entries;
  };

  // ---- the bar over a selection ----
  const count = chosen.length;
  const confirmFirst = tab === "needs_approval" && canBook;
  const barMenu: ActionMenuEntry[] = [
    ...(canBook && !confirmFirst ? [{ id: "confirm", label: "Confirm", icon: <Check aria-hidden="true" />, onSelect: () => void bulk({ action: "confirm" }) }] : []),
    ...(canBook ? [{ id: "cancel", label: "Cancel with a reason…", icon: <Ban aria-hidden="true" />, destructive: true, onSelect: () => show({ kind: "cancel" }) }] : []),
    ...(canStatus ? [{ id: "no-show", label: "Mark no-show", icon: <UserRoundX aria-hidden="true" />, onSelect: () => show({ kind: "no_show" }) }, { id: "message", label: "Send a message…", icon: <Mail aria-hidden="true" />, onSelect: () => show({ kind: "message" }) }] : []),
    ...(canBook && confirmFirst ? [{ id: "reassign", label: "Reassign…", icon: <UserRoundCog aria-hidden="true" />, onSelect: () => show({ kind: "reassign" }) }] : []),
    ...(canBook ? [{ id: "spam", label: "Report as spam…", icon: <ShieldAlert aria-hidden="true" />, destructive: true, onSelect: () => show({ kind: "spam" }) }] : []),
    ...(count < Math.min(rows.length, BULK_MAX) ? [{ kind: "separator", id: "all-sep" } as ActionMenuEntry, { id: "all", label: `Select all ${rows.length} loaded`, onSelect: () => setSelected(new Set(rows.slice(0, BULK_MAX).map((row) => row.id))) }] : []),
  ];
  const primary = confirmFirst
    ? { label: "Confirm", run: () => void bulk({ action: "confirm" }) }
    : canBook ? { label: "Reassign…", run: () => show({ kind: "reassign" }) }
    : { label: "Mark no-show", run: () => show({ kind: "no_show" }) };
  const bar = count === 0 ? null : (
    <div role="region" aria-label="Selected bookings" className="sticky bottom-0 z-10 flex flex-nowrap items-center gap-2 border-t bg-background px-3 py-2 shadow-[0_-4px_12px_-8px_rgb(0_0_0/0.2)]">
      <span aria-live="polite" className="min-w-0 flex-1 truncate text-sm font-medium tabular-nums">{count} selected{count >= BULK_MAX ? `, the most at once (${BULK_MAX})` : ""}</span>
      <Button size="sm" onClick={primary.run} loading={pending && !dialog}>{primary.label}</Button>
      {barMenu.length > 0 ? <ActionMenuButton label="More actions" iconOnly variant="outline" icon={<Ellipsis aria-hidden="true" />} items={barMenu} className="pointer-coarse:size-11" /> : null}
      <Button size="icon-sm" variant="ghost" aria-label="Clear selection" className="pointer-coarse:size-11" onClick={() => setSelected(new Set())}><X aria-hidden="true" /></Button>
    </div>
  );

  // ---- the dialogs ----
  const shared = { pending, error, onClose: close };
  const row = dialog && "row" in dialog ? dialog.row : null;
  const dialogs = (
    <>
      {dialog?.kind === "reassign" ? <ReassignDialog {...shared} count={row ? 1 : count} people={people.filter((person) => person.value !== row?.practitioner.id)} onSubmit={(practitionerId) => row ? void one(row, { action: "reassign", practitionerId }, `Moved to ${people.find((p) => p.value === practitionerId)?.label ?? t.practitioner}`) : void bulk({ action: "reassign", practitionerId })} /> : null}
      {dialog?.kind === "cancel" && row ? <CancelWithReasonDialog {...shared} onSubmit={({ presetId, note, notifyCustomer }) => void one(row, { action: "cancel", ...(presetId ? { presetId } : {}), ...(note ? { note } : {}), notifyCustomer }, `${t.Appointment} cancelled`)} /> : null}
      {dialog?.kind === "cancel" && !row ? <BulkCancelDialog {...shared} count={count} onSubmit={(input) => void bulk({ action: "cancel", ...input })} /> : null}
      {dialog?.kind === "spam" ? <ReportSpamDialog open onOpenChange={(next) => { if (!next) close(); }} pending={pending} error={error} repeats onSubmit={(reasonCode) => row ? void one(row, { action: "report_spam", reasonCode }, "Reported as spam") : void bulk({ action: "report_spam", reasonCode })} /> : null}
      {dialog?.kind === "message" ? <BulkMessageDialog {...shared} count={count} onSubmit={(input) => void bulk({ action: "message", ...input })} /> : null}
      {dialog?.kind === "no_show" ? <ConfirmDialog {...shared} title={`Mark ${count} as no-show`} confirmLabel="Mark no-show" description={`This records that these ${t.customers} did not turn up.`} onSubmit={() => void bulk({ action: "mark_no_show" })} /> : null}
      {dialog?.kind === "no_show_host" && row ? <ConfirmDialog {...shared} title="Mark that we didn't turn up" confirmLabel="Mark it" description={`This records that the business missed this ${t.appointment}. The ${t.customer} is offered a free rebook.`} onSubmit={() => void one(row, { action: "mark_no_show", who: "host" }, "Recorded")} /> : null}
      {dialog?.kind === "decline" && row ? <DeclineDialog open onOpenChange={(next) => { if (!next) close(); }} pending={pending} error={error} onSubmit={(input) => void one(row, { action: "decline", reason: input.reason, ...(input.message ? { message: input.message } : {}) }, "Declined")} /> : null}
      {result ? <BulkResultDialog verb={result.verb} result={result.result} rows={byId} onClose={() => setResult(null)} /> : null}
    </>
  );

  return { menuFor, bar, dialogs, canChange: canBook || canStatus };
}
