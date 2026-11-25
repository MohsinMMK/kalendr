"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarOff, CalendarPlus } from "lucide-react";

import { SelectField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { Drawer, DrawerDescription, DrawerFooter, DrawerHeader, DrawerPanel, DrawerPopup, DrawerTitle } from "@/components/ui/drawer";
import { useTerms } from "@/features/terms/business-profile-context";
import { demoQueues, demoWaitlist } from "@/lib/demo-data";
import type { Patient, Service, TimeSlot, WaitlistEntry } from "@/lib/domain";
import type { TermWords } from "@/lib/terminology";

import { useCatalogLookups } from "./clinic-catalog";
import { appointmentDateTime, appointmentTime } from "./clinic-format";
import { compatibleSlots, usePreviewAppointments } from "./preview-appointments";
import { clinicDateKey, clinicTimeMinutes, minutesTime } from "./schedule-availability";
import { staffMutation, useOptionalStaffSnapshot } from "./staff-snapshot-provider";
import { Fact } from "./task-ui";
import { patientName } from "./patient-directory";
import { useNewVisit, type NewVisitPrefill } from "./new-visit-sheet";

export interface SelectedOpening { dateKey: string; minute: number; practitionerId?: string }
interface OpeningCandidate { service: Service; slot: TimeSlot }

const waitlistStorageKey = "kalendr-preview-followups-v1";

function dateLabel(iso: string): string {
  return new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "Asia/Kolkata" }).format(new Date(iso));
}

function waitlistName(entry: WaitlistEntry, patients: Patient[], t: TermWords): string {
  const patient = patients.find((item) => item.id === entry.patientId);
  if (patient) return patientName(patient);
  return demoQueues.find((item) => item.id === entry.id.replace("waitlist_", "queue_"))?.patientName ?? `Waitlist ${t.customer}`;
}


export function OpeningSheet({ opening, locationId, onClose }: { opening: SelectedOpening | null; locationId: string; onClose: () => void }) {
  const { openNewVisit } = useNewVisit();
  const { appointments, patients, operations, auditEvents, recordAudit, database } = usePreviewAppointments();
  const catalog = useCatalogLookups();
  const t = useTerms();
  const staff = useOptionalStaffSnapshot();
  const [candidateKey, setCandidateKey] = useState("");
  const [waitlistStates, setWaitlistStates] = useState<Record<string, string>>({});
  const [offerId, setOfferId] = useState("");
  const [offeredId, setOfferedId] = useState("");
  const [offerPending, setOfferPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    queueMicrotask(() => {
      try {
        const saved = window.sessionStorage.getItem(waitlistStorageKey);
        if (!saved) return;
        const parsed: unknown = JSON.parse(saved);
        if (typeof parsed === "object" && parsed !== null && "waitlistStates" in parsed && typeof parsed.waitlistStates === "object" && parsed.waitlistStates !== null) setWaitlistStates(parsed.waitlistStates as Record<string, string>);
      } catch (loadError: unknown) {
        console.error("Could not load preview waitlist states for Schedule", loadError);
      }
    });
  }, []);

  // The clicked time, or the next one that day that fits a service. Compatible openings already respect hours, blocks and buffers.
  const options: OpeningCandidate[] = useMemo(() => {
    if (!opening || database) return [];
    const all = catalog.services.filter((service) => service.locationIds.includes(locationId)).flatMap((service) => compatibleSlots({ service, locationId, appointments, notBefore: operations.clockIso, dateKey: opening.dateKey, availability: operations.schedule }).map((slot) => ({ service, slot })))
      .filter(({ slot }) => clinicTimeMinutes(slot.startsAt) >= opening.minute && (!opening.practitionerId || slot.practitionerId === opening.practitionerId));
    const first = Math.min(...all.map(({ slot }) => clinicTimeMinutes(slot.startsAt)));
    return all.filter(({ slot }) => clinicTimeMinutes(slot.startsAt) === first);
  }, [appointments, catalog.services, database, locationId, opening, operations.clockIso, operations.schedule]);
  const candidate = options.find((item) => `${item.service.id}|${item.slot.id}` === candidateKey) ?? options[0];

  const clinicWaitlist = database ? staff?.snapshot?.waitlist ?? [] : demoWaitlist;
  const matches = candidate ? clinicWaitlist.filter((entry) => entry.status === "active" && (waitlistStates[entry.id] ?? "active") === "active" && entry.serviceId === candidate.service.id && entry.locationId === locationId && (database || compatibleSlots({ service: candidate.service, locationId, appointments, patientId: entry.patientId, waitlist: entry, dateKey: clinicDateKey(candidate.slot.startsAt), availability: operations.schedule }).some((slot) => slot.startsAt === candidate.slot.startsAt && slot.practitionerId === candidate.slot.practitionerId && slot.resourceId === candidate.slot.resourceId))) : [];

  const prefill: NewVisitPrefill = {
    locationId,
    ...(opening ? { date: opening.dateKey } : {}),
    ...(candidate
      ? { serviceId: candidate.service.id, startsAt: candidate.slot.startsAt, practitionerId: candidate.slot.practitionerId, resourceId: candidate.slot.resourceId }
      : opening?.practitionerId ? { practitionerId: opening.practitionerId } : {}),
  };

  function close() {
    setCandidateKey("");
    setOfferId("");
    setOfferedId("");
    setError("");
    onClose();
  }

  function prepareOffer(entry: WaitlistEntry) {
    if (!candidate) return;
    if (database) {
      setOfferPending(true);
      void (async () => {
        try {
          await staffMutation(`/api/staff/waitlist/${entry.id}`, "PATCH", { status: "offered" });
          await staff?.refresh();
          setOfferedId(entry.id);
          setOfferId("");
          setError("");
        } catch (cause: unknown) {
          setError(cause instanceof Error ? cause.message : "Could not save the waitlist offer.");
        } finally {
          setOfferPending(false);
        }
      })();
      return;
    }
    try {
      const saved = window.sessionStorage.getItem(waitlistStorageKey);
      const parsed: unknown = saved ? JSON.parse(saved) : {};
      const existing = typeof parsed === "object" && parsed !== null ? parsed as Record<string, unknown> : {};
      const states = typeof existing.waitlistStates === "object" && existing.waitlistStates !== null ? existing.waitlistStates as Record<string, string> : {};
      window.sessionStorage.setItem(waitlistStorageKey, JSON.stringify({ ...existing, waitlistStates: { ...states, [entry.id]: "offered" } }));
      setWaitlistStates({ ...states, [entry.id]: "offered" });
      recordAudit({ id: `preview_waitlist_${entry.id}_${auditEvents.length + 1}`, clinicId: catalog.clinic.id, actorLabel: "Preview staff", action: `Prepared waitlist offer for ${appointmentDateTime(candidate.slot.startsAt)}`, outcome: "success", occurredAt: operations.clockIso });
      setOfferedId(entry.id);
      setOfferId("");
      setError("");
    } catch (saveError: unknown) {
      console.error("Could not save preview waitlist offer", saveError);
      setError("Could not save the offer preview in this browser. Try again.");
    }
  }

  const offered = clinicWaitlist.find((item) => item.id === offeredId);

  return <Drawer position="right" open={opening !== null} onOpenChange={(open) => { if (!open) close(); }}>
    <DrawerPopup showCloseButton variant="inset">
      <DrawerHeader>
        <DrawerTitle>{candidate ? "Selected opening" : `New ${t.appointment}`}</DrawerTitle>
        {candidate ? <DrawerDescription>{dateLabel(candidate.slot.startsAt)}, {appointmentTime(candidate.slot.startsAt)}</DrawerDescription> : opening ? <DrawerDescription>{minutesTime(opening.minute)}</DrawerDescription> : null}
      </DrawerHeader>
      <DrawerPanel>
        <div className="flex flex-col gap-4">
          {error ? <Alert variant="error"><AlertDescription>{error}</AlertDescription></Alert> : null}
          {candidate ? <>
            <SelectField label={`Service and ${t.resource}`} value={`${candidate.service.id}|${candidate.slot.id}`} onValueChange={(next) => { setCandidateKey(next); setOfferId(""); }} options={options.map((item) => ({ value: `${item.service.id}|${item.slot.id}`, label: `${item.service.name} · ${catalog.practitionerName(item.slot.practitionerId)} · ${item.slot.resourceId ? catalog.resourceName(item.slot.resourceId) : `No ${t.resource}`}` }))} />
            <dl className="grid grid-cols-2 gap-4">
              <Fact label="Length">{candidate.service.durationMinutes} min</Fact>
              <Fact label="Buffer after">{candidate.service.bufferAfterMinutes} min</Fact>
            </dl>
            <Separator />
            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Waitlist matches ({matches.length})</h3>
              {matches.map((entry) => <div key={entry.id} className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="min-w-0 truncate font-medium">{waitlistName(entry, patients, t)}</span>
                  {offerId !== entry.id ? <Button size="xs" variant="outline" onClick={() => setOfferId(entry.id)}>Review offer</Button> : null}
                </div>
                {offerId === entry.id ? <>
                  <p className="text-muted-foreground">Prepares an offer only. No message is sent and the time isn&apos;t held.</p>
                  <div className="flex gap-2">
                    <Button size="sm" loading={offerPending} onClick={() => prepareOffer(entry)}>Confirm offer</Button>
                    <Button size="sm" variant="ghost" onClick={() => setOfferId("")}>Back</Button>
                  </div>
                </> : null}
              </div>)}
              {offered ? <p role="status" className="text-sm">Offer prepared for {waitlistName(offered, patients, t)}. No message sent.</p> : null}
            </section>
          </> : database ? null : <Empty className="p-4">
            <EmptyHeader>
              <EmptyMedia variant="icon"><CalendarOff aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>No opening left</EmptyTitle>
              <EmptyDescription>Nothing fits from this time on. Try another day.</EmptyDescription>
            </EmptyHeader>
          </Empty>}
        </div>
      </DrawerPanel>
      <DrawerFooter variant="bare" className="flex-col! items-stretch">
        <Button onClick={() => { close(); openNewVisit(prefill); }}><CalendarPlus aria-hidden="true" /> {candidate ? "Book this opening" : "Choose a time"}</Button>
      </DrawerFooter>
    </DrawerPopup>
  </Drawer>;
}
