"use client";

import { useRef, useState, type ReactNode } from "react";

import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";

import { DateCalendar, dateFromKey, keyFromDate } from "@/components/date-picker";
import { PersonAvatar } from "@/components/person-avatar";
import { Button } from "@/components/ui/button";
import type { Appointment, BookingSource, TimeSlot } from "@/lib/domain";

import { ChoiceField, type Choice } from "./choice-field";
import { useCatalogLookups } from "./clinic-catalog";
import { appointmentTime } from "./clinic-format";
import { clinicDateKey } from "./preview-appointments";
import { staffBookingSources, useVisitEdits } from "./use-visit-edits";
import { useVisitMoves } from "./visit-moves";
import { CustomValue, InlineText, PropertyRows, useVisitProperties, type BuiltInProperty } from "./visit-properties";

/**
 * The parts of a visit staff change most, each as a Notion-style select that saves on pick: the time,
 * the person, the service, the room and how it was booked. Wherever a visit is shown, these are the same.
 */

export const bookedViaLabels: Record<BookingSource, string> = {
  online: "Online",
  widget: "Website widget",
  iframe: "Website",
  phone: "Phone",
  staff: "Staff",
  walk_in: "Walk-in",
  recall: "Recall",
  waitlist: "Waitlist",
  assistant: "Booking assistant",
};

const dayLabel = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });

/** The day before or after a `YYYY-MM-DD` day. */
function shiftDay(dateKey: string, days: number): string {
  const date = dateFromKey(dateKey) ?? new Date();
  date.setDate(date.getDate() + days);
  return keyFromDate(date);
}

const avatar = (name: string) => <PersonAvatar name={name} className="size-5 [&_[data-slot=avatar-fallback]]:text-[0.5625rem]" />;

/** The visit's time. Opens the free starts of a day, any day, and moves the visit to the one picked. */
export function VisitTimeField({ appointment, label = "Time" }: { appointment: Appointment; label?: string }) {
  const moves = useVisitMoves();
  const catalog = useCatalogLookups();
  const [day, setDay] = useState(() => clinicDateKey(appointment.startsAt));
  const [slots, setSlots] = useState<TimeSlot[]>([]);
  const [loading, setLoading] = useState(false);
  const [choosingDay, setChoosingDay] = useState(false);
  const request = useRef<AbortController | null>(null);
  const current = `${appointmentTime(appointment.startsAt)} – ${appointmentTime(appointment.endsAt)}`;
  const sameDay = day === clinicDateKey(appointment.startsAt);

  /** Shows the openings of another day, back in the list. */
  function pickDay(dateKey: string) {
    setDay(dateKey);
    setChoosingDay(false);
    load(dateKey);
  }

  function load(dateKey: string) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    moves.openings(appointment, dateKey, appointment.serviceId, controller.signal)
      .then((found) => { if (!controller.signal.aborted) setSlots(found); })
      .catch(() => { if (!controller.signal.aborted) setSlots([]); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
  }

  if (!moves.canMove(appointment)) return <span className="tabular-nums">{current}</span>;
  // One choice per time and person; the server picks a free room unless staff choose one.
  const unique = [...new Map(slots.map((slot) => [`${slot.startsAt}|${slot.practitionerId}`, slot])).values()];
  const choices: Choice[] = unique.map((slot) => ({
    id: `${slot.startsAt}|${slot.practitionerId}`,
    label: appointmentTime(slot.startsAt),
    detail: slot.practitionerId === appointment.practitionerId ? undefined : catalog.practitionerName(slot.practitionerId),
  }));
  return (
    <ChoiceField
      label={label}
      value={{ id: "current", label: current }}
      choices={choices}
      loading={loading || moves.movingId === appointment.id}
      placeholder="Pick a time"
      empty={sameDay ? "No other openings this day" : "No openings this day"}
      className="tabular-nums"
      onOpenChange={(open) => { setChoosingDay(false); if (open) load(day); else request.current?.abort(); }}
      header={(
        <div className="flex items-center gap-1">
          <Button type="button" size="icon-xs" variant="ghost" aria-label="Previous day" onClick={() => pickDay(shiftDay(day, -1))}><ChevronLeft aria-hidden="true" /></Button>
          <Button
            type="button"
            size="xs"
            variant={choosingDay ? "secondary" : "ghost"}
            aria-label={`Day for ${label.toLocaleLowerCase()}: ${dayLabel.format(dateFromKey(day))}`}
            aria-expanded={choosingDay}
            className="flex-1 font-medium"
            onClick={() => setChoosingDay((value) => !value)}
          >
            <CalendarDays aria-hidden="true" />{dayLabel.format(dateFromKey(day))}
          </Button>
          <Button type="button" size="icon-xs" variant="ghost" aria-label="Next day" onClick={() => pickDay(shiftDay(day, 1))}><ChevronRight aria-hidden="true" /></Button>
        </div>
      )}
      body={choosingDay ? (
        <div className="flex justify-center p-1">
          <DateCalendar value={day} onValueChange={pickDay} />
        </div>
      ) : undefined}
      onPick={(id) => {
        const slot = unique.find((item) => `${item.startsAt}|${item.practitionerId}` === id);
        if (slot) void moves.move(appointment, { startsAt: slot.startsAt, practitionerId: slot.practitionerId });
      }}
    />
  );
}

/** Who sees the customer. Lists the people who offer this service here; the server checks they're free. */
export function VisitPractitionerField({ appointment, label }: { appointment: Appointment; label: string }) {
  const moves = useVisitMoves();
  const catalog = useCatalogLookups();
  const name = catalog.practitionerName(appointment.practitionerId);
  if (!moves.canMove(appointment)) return <span className="inline-flex items-center gap-1.5">{avatar(name)}{name}</span>;
  const service = catalog.getService(appointment.serviceId);
  const choices: Choice[] = catalog.practitioners
    .filter((person) => person.isActive !== false && person.locationIds.includes(appointment.locationId) && (!service || service.practitionerIds.includes(person.id)))
    .map((person) => ({ id: person.id, label: person.name, leading: avatar(person.name) }));
  return (
    <ChoiceField
      label={label}
      value={{ id: appointment.practitionerId, label: name, leading: avatar(name) }}
      choices={choices}
      loading={moves.movingId === appointment.id}
      placeholder={`Choose a ${label.toLocaleLowerCase()}`}
      empty="No one else offers this here"
      onPick={(id) => { if (id !== appointment.practitionerId) void moves.move(appointment, { startsAt: appointment.startsAt, practitionerId: id }, `Could not change the ${label.toLocaleLowerCase()}`); }}
    />
  );
}

/** What the visit is for. Changing it keeps the time; the length and price follow the new service. */
export function VisitServiceField({ appointment, label = "Service" }: { appointment: Appointment; label?: string }) {
  const moves = useVisitMoves();
  const catalog = useCatalogLookups();
  const name = catalog.serviceName(appointment.serviceId);
  if (!moves.canMove(appointment)) return <span>{name}</span>;
  const choices: Choice[] = catalog.services
    .filter((service) => service.isActive !== false && service.locationIds.includes(appointment.locationId) && service.practitionerIds.includes(appointment.practitionerId))
    .map((service) => ({ id: service.id, label: service.name, detail: `${service.durationMinutes} min` }));
  return (
    <ChoiceField
      label={label}
      value={{ id: appointment.serviceId, label: name }}
      choices={choices}
      loading={moves.movingId === appointment.id}
      placeholder="Choose a service"
      empty="No other services here"
      onPick={(id) => { if (id !== appointment.serviceId) void moves.move(appointment, { startsAt: appointment.startsAt, practitionerId: appointment.practitionerId, serviceId: id }, "Could not change the service"); }}
    />
  );
}

/** The room or equipment the visit holds. Only rooms of the kind its service needs are offered. */
export function VisitRoomField({ appointment, label }: { appointment: Appointment; label: string }) {
  const moves = useVisitMoves();
  const catalog = useCatalogLookups();
  const names = appointment.resourceIds.map((id) => catalog.resourceName(id)).filter(Boolean).join(", ");
  const kind = catalog.getService(appointment.serviceId)?.resourceKind;
  if (!moves.canMove(appointment) || !kind) return names ? <span>{names}</span> : <span className="text-muted-foreground">None</span>;
  const choices: Choice[] = catalog.resources
    .filter((resource) => resource.isActive !== false && resource.locationId === appointment.locationId && resource.kind === kind)
    .map((resource) => ({ id: resource.id, label: resource.name }));
  const currentId = appointment.resourceIds[0];
  return (
    <ChoiceField
      label={label}
      value={currentId ? { id: currentId, label: names } : undefined}
      choices={choices}
      loading={moves.movingId === appointment.id}
      placeholder="None"
      empty={`No other ${label.toLocaleLowerCase()} here`}
      onPick={(id) => { if (id !== currentId) void moves.move(appointment, { startsAt: appointment.startsAt, practitionerId: appointment.practitionerId, resourceId: id }, `Could not change the ${label.toLocaleLowerCase()}`); }}
    />
  );
}

/** How the booking came in. Staff can correct the ways they took it; online sources are what happened. */
export function VisitSourceField({ appointment, label = "Booked via" }: { appointment: Appointment; label?: string }) {
  const edits = useVisitEdits();
  const text = bookedViaLabels[appointment.bookingSource];
  if (!edits.canEditVisit || !staffBookingSources.includes(appointment.bookingSource)) return <span>{text}</span>;
  return (
    <ChoiceField
      label={label}
      value={{ id: appointment.bookingSource, label: text }}
      choices={staffBookingSources.map((source) => ({ id: source, label: bookedViaLabels[source] }))}
      loading={edits.savingId === appointment.id}
      placeholder="Choose"
      empty="Nothing to choose"
      onPick={(id) => {
        const source = staffBookingSources.find((item) => item === id);
        if (source && source !== appointment.bookingSource) void edits.saveDetails(appointment, { bookingSource: source as "phone" | "staff" | "walk_in" });
      }}
    />
  );
}

/** The reason for the visit, edited in place. */
export function VisitReasonField({ appointment, label = "Reason" }: { appointment: Appointment; label?: string }) {
  const edits = useVisitEdits();
  return (
    <InlineText
      key={`${appointment.id}-reason`}
      label={label}
      value={appointment.reasonForVisit ?? ""}
      maxLength={500}
      disabled={!edits.canEditVisit}
      onCommit={(next) => edits.saveDetails(appointment, { reasonForVisit: next })}
    />
  );
}

/** Notes for the team, edited in place. Never sent to the customer. */
export function VisitNotesField({ appointment, label = "Notes" }: { appointment: Appointment; label?: string }) {
  const edits = useVisitEdits();
  return (
    <InlineText
      key={`${appointment.id}-notes`}
      multiline
      label={label}
      value={appointment.notes ?? ""}
      placeholder="Add a note for the team"
      maxLength={2000}
      disabled={!edits.canEditVisit}
      onCommit={(next) => edits.saveDetails(appointment, { notes: next })}
    />
  );
}

const noBuiltIns: BuiltInProperty[] = [];

/** The business's own properties on a visit, with the same add, rename and reorder controls as the board. */
export function VisitCustomProperties({ appointment, className, wrap = (rows) => rows }: { appointment: Appointment; className?: string; wrap?: (rows: ReactNode) => ReactNode }) {
  const edits = useVisitEdits();
  const properties = useVisitProperties(noBuiltIns);
  const values = appointment.customFields ?? {};
  if (!properties.all.length && !properties.canEdit) return null;
  return wrap(
    <PropertyRows
      className={className}
      properties={properties}
      renderValue={(property) => property.custom ? (
        <CustomValue
          key={`${appointment.id}-${property.custom.id}`}
          field={property.custom}
          value={values[property.custom.id]}
          disabled={!edits.canEditVisit}
          editor={properties.editor}
          canEditProperties={properties.canEdit}
          onChange={(next) => edits.saveDetails(appointment, { customFields: { [property.custom!.id]: next } })}
        />
      ) : null}
    />
  );
}
