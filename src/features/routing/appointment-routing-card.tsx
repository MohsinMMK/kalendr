"use client";

import { useState } from "react";
import { CheckIcon, ChevronDownIcon, XIcon } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Frame, FrameHeader, FramePanel } from "@/components/ui/frame";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { toastManager } from "@/components/ui/toast";
import { useCatalogLookups } from "@/features/clinic/clinic-catalog";
import { staffMutation } from "@/features/clinic/queries/http";
import { useStaffAccess } from "@/features/clinic/staff-access";
import { useTerms } from "@/features/terms/business-profile-context";
import { conditionOperatorLabels } from "@/lib/booking-forms";
import type { RoutingTrace, WrongAssignmentInput } from "@/lib/routing-forms";

import { useAppointmentRouting } from "./use-appointment-routing";

const NO_ONE = "none";

function expectedText(value: string | string[]): string {
  return [value].flat().join(" or ");
}

function TraceList({ trace }: { trace: RoutingTrace }) {
  return (
    <div className="flex flex-col gap-4 pt-3 text-sm">
      <section aria-label="Routes checked">
        <h3 className="mb-1.5 font-medium text-xs text-muted-foreground">Routes checked</h3>
        <ul className="flex flex-col gap-2">
          {trace.routes.map((route) => (
            <li key={route.routeId} className="flex flex-col gap-1 rounded-lg border p-2.5">
              <p className="flex items-center gap-1.5 font-medium">
                {route.matched ? <CheckIcon aria-hidden="true" className="size-4 text-success" /> : <XIcon aria-hidden="true" className="size-4 text-muted-foreground" />}
                <span>{route.name}</span>
                <span className="font-normal text-muted-foreground text-xs">{route.matched ? "matched" : "did not match"}</span>
              </p>
              {route.skipped === "no_people" ? <p className="text-muted-foreground text-xs">Nobody fit the people rule, so the next route was tried.</p> : null}
              {route.conditions.length === 0 ? <p className="text-muted-foreground text-xs">Applies to everyone.</p> : (
                <ul className="flex flex-col gap-0.5 text-xs">
                  {route.conditions.map((condition, index) => (
                    <li key={`${condition.fieldId}-${index}`} className="flex items-start gap-1.5">
                      {condition.passed ? <CheckIcon aria-label="Passed" className="mt-0.5 size-3.5 shrink-0 text-success" /> : <XIcon aria-label="Failed" className="mt-0.5 size-3.5 shrink-0 text-destructive" />}
                      <span className="min-w-0 break-words">{condition.label} {conditionOperatorLabels[condition.operator]} {expectedText(condition.expected)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </section>
      {trace.people.length > 0 ? (
        <section aria-label="People considered">
          <h3 className="mb-1.5 font-medium text-xs text-muted-foreground">People considered</h3>
          <ul className="flex flex-col gap-1.5">
            {trace.people.map((person) => (
              <li key={person.personId} className="flex items-start gap-1.5">
                {person.passed ? <CheckIcon aria-label="Included" className="mt-0.5 size-4 shrink-0 text-success" /> : <XIcon aria-label="Left out" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 break-words">
                  {person.name}
                  {person.reasons.length > 0 ? <span className="text-muted-foreground text-xs"> · {person.reasons.join(", ")}</span> : null}
                  {person.multiplier > 1 ? <span className="text-muted-foreground text-xs"> · counts {person.multiplier}x</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function WrongAssignmentDialog({ appointmentId, open, onOpenChange }: { appointmentId: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTerms();
  const catalog = useCatalogLookups();
  const [personId, setPersonId] = useState(NO_ONE);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const choices = [{ value: NO_ONE, label: "I am not sure" }, ...catalog.practitioners.map((person) => ({ value: person.id, label: person.name }))];

  async function send() {
    setBusy(true);
    setError("");
    const body: WrongAssignmentInput = {
      appointmentId,
      ...(personId !== NO_ONE ? { correctPractitionerId: personId } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    };
    try {
      await staffMutation("/api/staff/routing-forms/wrong-assignments", "POST", body);
      toastManager.add({ title: "Sent to the owner", description: "Thanks. The form can be fixed from this.", type: "success" });
      setNote("");
      setPersonId(NO_ONE);
      onOpenChange(false);
    } catch (failure: unknown) {
      setError(failure instanceof Error ? failure.message : "This could not be sent. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>This should have gone to someone else</DialogTitle>
          <DialogDescription>Tell the owner who should have had this {t.appointment}. Nothing changes on the booking.</DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          <Field>
            <FieldLabel id="wrong-person-label">Who should have had it?</FieldLabel>
            <Select value={personId} onValueChange={(next) => next && setPersonId(next)} items={choices}>
              <SelectTrigger aria-labelledby="wrong-person-label"><SelectValue /></SelectTrigger>
              <SelectPopup>{choices.map((choice) => <SelectItem key={choice.value} value={choice.value}>{choice.label}</SelectItem>)}</SelectPopup>
            </Select>
          </Field>
          <Field>
            <FieldLabel>Note (optional)</FieldLabel>
            <Textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} rows={3} />
          </Field>
          {error ? <Alert variant="error" role="alert"><AlertDescription>{error}</AlertDescription></Alert> : null}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
          <Button loading={busy} onClick={() => void send()}>Send</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** How a routing form (feature 46) sent this booking where it went. Shows nothing for a booking that was not routed. */
export function AppointmentRoutingCard({ appointmentId }: { appointmentId: string }) {
  const access = useStaffAccess();
  const view = useAppointmentRouting(appointmentId);
  const [flagging, setFlagging] = useState(false);
  if (!view) return null;

  return (
    <section aria-label="Routed by" className="lg:col-start-1">
      <Frame>
        <FrameHeader className="px-3 py-2">
          <h2 className="font-medium text-sm">Routed by</h2>
        </FrameHeader>
        <FramePanel className="flex flex-col gap-3 p-4">
          <p className="text-sm">{view.summary}</p>
          <p className="text-muted-foreground text-xs">{view.formName} · {view.routeName}</p>
          <Collapsible>
            <CollapsibleTrigger render={<Button variant="outline" size="sm" className="min-h-11 sm:min-h-0" />}>
              See how this was decided <ChevronDownIcon aria-hidden="true" />
            </CollapsibleTrigger>
            <CollapsiblePanel><TraceList trace={view.trace} /></CollapsiblePanel>
          </Collapsible>
          {access.can("routing.report") ? (
            <div>
              <Button variant="ghost" size="sm" className="min-h-11 sm:min-h-0" onClick={() => setFlagging(true)}>This should have gone to someone else</Button>
              <WrongAssignmentDialog appointmentId={appointmentId} open={flagging} onOpenChange={setFlagging} />
            </div>
          ) : null}
        </FramePanel>
      </Frame>
    </section>
  );
}
