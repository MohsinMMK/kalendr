"use client";

import { useState, type ReactNode } from "react";
import { CalendarClock, CalendarPlus, Ban, ShieldAlert, Users } from "lucide-react";

import type { ActionMenuEntry } from "@/components/action-bar";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import type { Appointment, Service } from "@/lib/domain";

import { BookAgainDialog, CancelWithReasonDialog, EditGuestsDialog, RequestRescheduleDialog } from "./appointment-change-dialogs";
import { ReportSpamDialog } from "./report-spam-dialog";
import { staffMutation } from "./staff-snapshot-provider";

type Dialog = "reschedule" | "cancel" | "rebook" | "guests" | "spam";

const cancellable = ["requested", "booked", "checked_in", "reschedule_requested"];
const rebookable = ["cancelled", "declined", "expired", "no_show", "completed"];
const reportable = ["requested", "booked", "checked_in", "reschedule_requested", "pending_payment", "cancelled", "declined", "expired", "no_show", "completed"];
const guestEditable = ["requested", "booked", "reschedule_requested"];

/**
 * The staff changes that live in the appointment's more (⋯) menu: ask for a new time, cancel with a reason,
 * book again, edit guests. Returns the menu entries and the dialogs they open. Needs the database, so a
 * preview or a user without booking rights gets no entries.
 */
export function useAppointmentMoreActions({ appointment, version, service, enabled, refresh }: {
  appointment: Appointment | undefined;
  version: number | undefined;
  service: Service | undefined;
  enabled: boolean;
  refresh: () => Promise<void>;
}): { menu: ActionMenuEntry[]; dialogs: ReactNode } {
  const t = useTerms();
  const [open, setOpen] = useState<Dialog | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  // When the page opened: a visit that has already started is not offered a new time.
  const [openedAt] = useState(() => Date.now());

  async function send(appointment: Appointment, body: Record<string, unknown>, toast: { title: string; description?: string }): Promise<Record<string, unknown> | null> {
    if (!version) {
      setError(`This ${t.appointment} changed since you opened it. Refresh and try again.`);
      return null;
    }
    setPending(true);
    setError("");
    try {
      const data = await staffMutation<Record<string, unknown> | null>(`/api/staff/appointments/${appointment.id}`, "PATCH", { ...body, expectedVersion: version });
      await refresh();
      toastManager.add({ ...toast, type: "success" });
      return data ?? {};
    } catch (cause: unknown) {
      setError(cause instanceof Error && cause.message ? cause.message : `Could not save this ${t.appointment}. Try again.`);
      return null;
    } finally {
      setPending(false);
    }
  }

  function show(next: Dialog) { setError(""); setOpen(next); }
  const shared = { pending, error, onClose: () => setOpen(null) };
  const status = appointment?.status;
  const entries: ActionMenuEntry[] = [];
  if (enabled && appointment && status) {
    if (status === "booked" && Date.parse(appointment.startsAt) > openedAt) entries.push({ id: "ask-new-time", label: "Ask to choose a new time", icon: <CalendarClock aria-hidden="true" />, onSelect: () => show("reschedule") });
    if (rebookable.includes(status)) entries.push({ id: "book-again", label: "Book again", icon: <CalendarPlus aria-hidden="true" />, onSelect: () => show("rebook") });
    if (service?.intake?.allowGuests && guestEditable.includes(status)) entries.push({ id: "edit-guests", label: "Edit guests", icon: <Users aria-hidden="true" />, onSelect: () => show("guests") });
    if (reportable.includes(status) && appointment.spamState !== "reported") entries.push({ id: "report-spam", label: "Report as spam", icon: <ShieldAlert aria-hidden="true" />, destructive: true, onSelect: () => show("spam") });
    if (cancellable.includes(status)) entries.push({ kind: "separator", id: "cancel-sep" }, { id: "cancel-reason", label: "Cancel with a reason", icon: <Ban aria-hidden="true" />, destructive: true, onSelect: () => show("cancel") });
  }

  const dialogs = !enabled || !appointment ? null : <>
    {open === "reschedule" ? <RequestRescheduleDialog {...shared} onSubmit={async ({ message }) => {
      if (await send(appointment, { action: "request_reschedule", ...(message ? { message } : {}) }, { title: "Asked to choose a new time", description: `The ${t.customer} will get a message with a link.` })) setOpen(null);
    }} /> : null}
    {open === "cancel" ? <CancelWithReasonDialog {...shared} onSubmit={async ({ presetId, note, notifyCustomer }) => {
      if (await send(appointment, { action: "cancel", ...(presetId ? { presetId } : {}), ...(note ? { note } : {}), notifyCustomer }, { title: `${t.Appointment} cancelled`, description: notifyCustomer ? `The ${t.customer} will be told.` : `The ${t.customer} was not told.` })) setOpen(null);
    }} /> : null}
    {open === "rebook" ? <BookAgainDialog {...shared} appointment={appointment} onSubmit={async ({ startsAt, practitionerId }) => {
      const data = await send(appointment, { action: "rebook", startsAt, practitionerId }, { title: `${t.Appointment} booked again` });
      if (!data) return null;
      setOpen(null);
      return typeof data.appointmentId === "string" ? data.appointmentId : null;
    }} /> : null}
    {open === "spam" ? <ReportSpamDialog open onOpenChange={(next) => { if (!next) setOpen(null); }} pending={pending} error={error} repeats={Boolean(appointment.seriesId)} onSubmit={async (reasonCode) => {
      if (await send(appointment, { action: "report_spam", reasonCode }, { title: "Reported as spam", description: `The ${t.customer} was not told.` })) setOpen(null);
    }} /> : null}
    {open === "guests" ? <EditGuestsDialog {...shared} maxGuests={service?.intake?.maxGuests ?? 10} onSubmit={async ({ guests }) => {
      if (await send(appointment, { action: "edit_guests", guests }, { title: "Guests updated" })) setOpen(null);
    }} /> : null}
  </>;
  return { menu: entries, dialogs };
}
