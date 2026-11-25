"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Dumbbell, TriangleAlert } from "lucide-react";

import { DateField } from "@/components/date-picker";
import { SelectField, TextField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import { createSessionsSchema, type CreateSessionsResult } from "@/lib/classes-contracts";

import { classKeys, createSessions, dayHeading, fetchClassTypes, todayKey } from "./class-model";
import { useCatalogLookups } from "./clinic-catalog";
import { draftSummary, draftToRule, noRepeat, type RepeatDraft } from "./repeat-model";
import { RepeatControl } from "./repeat-booking";

/**
 * "New session": pick a class, a teacher and a place, a first date and time, and optionally a rule to repeat on.
 * When any date clashes nothing is created, and each clash is listed with its reason beside the date.
 */
export function NewSessionDialog({ initialServiceId, onClose, onCreated, onAddClass }: {
  /** A class to start on, such as the one just added. */
  initialServiceId?: string;
  onClose: () => void;
  onCreated: (firstDate: string) => void;
  /** Opens New class, for a business with no classes yet. */
  onAddClass?: () => void;
}) {
  const t = useTerms();
  const lookups = useCatalogLookups();
  const queryClient = useQueryClient();
  const types = useQuery({ queryKey: classKeys.types, queryFn: ({ signal }) => fetchClassTypes(signal) });
  const [serviceId, setServiceId] = useState("");
  const [practitionerId, setPractitionerId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [date, setDate] = useState(() => todayKey());
  const [time, setTime] = useState("09:00");
  const [seats, setSeats] = useState("");
  const [repeat, setRepeat] = useState<RepeatDraft>(noRepeat);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [clashes, setClashes] = useState<CreateSessionsResult["clashes"]>([]);

  const list = types.data ?? [];
  const chosen = list.find((item) => item.serviceId === serviceId) ?? null;
  const typeOptions = list.map((item) => ({ value: item.serviceId, label: item.name }));
  const teacherOptions = (chosen?.practitionerIds ?? []).map((id) => ({ value: id, label: lookups.practitionerName(id) }));
  const placeOptions = (chosen?.locationIds ?? []).map((id) => ({ value: id, label: lookups.locationName(id) }));
  const rule = draftToRule(repeat, date);

  // Start on the class just added. The cached list may not have it yet, so wait for the refetch that does.
  // Set during render (React's pattern for state that follows a prop), once, when the list first has the new class.
  const [preselected, setPreselected] = useState(false);
  if (!preselected && initialServiceId && list.some((item) => item.serviceId === initialServiceId)) {
    setPreselected(true);
    chooseClass(initialServiceId);
  }
  const summary = draftSummary(repeat, date, time, { visit: "session", visits: "sessions" });

  function chooseClass(next: string) {
    const picked = list.find((item) => item.serviceId === next);
    setServiceId(next);
    setSeats(picked ? String(picked.capacity) : "");
    setPractitionerId(picked?.practitionerIds.length === 1 ? picked.practitionerIds[0]! : "");
    setLocationId(picked?.locationIds.length === 1 ? picked.locationIds[0]! : "");
    setClashes([]);
  }

  async function submit() {
    setError("");
    setClashes([]);
    if (rule && "error" in rule) { setError(rule.error); return; }
    const capacity = seats.trim() === "" ? undefined : Number(seats);
    const parsed = createSessionsSchema.safeParse({ serviceId, practitionerId, locationId, date, time, ...(capacity !== undefined ? { capacity } : {}), ...(rule && "rule" in rule ? { repeat: rule.rule } : {}) });
    if (!parsed.success) { setError("Choose a class, a teacher, a place, a date and a time. Seats must be 1 to 500."); return; }
    setPending(true);
    try {
      const result = await createSessions(parsed.data);
      if (result.clashes.length > 0) { setClashes(result.clashes); return; }
      await queryClient.invalidateQueries({ queryKey: classKeys.all });
      toastManager.add({ title: result.created === 1 ? "Session added" : `${result.created} sessions added`, type: "success" });
      onCreated(date);
      onClose();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "The session could not be saved.");
    } finally {
      setPending(false);
    }
  }

  const ready = Boolean(serviceId && practitionerId && locationId && date && time);
  return (
    <Dialog open onOpenChange={(next) => { if (!next && !pending) onClose(); }}>
      <DialogPopup showCloseButton={!pending}>
        <form onSubmit={(event) => { event.preventDefault(); if (!pending && ready) void submit(); }} className="contents" noValidate>
          <DialogHeader>
            <DialogTitle>New session</DialogTitle>
            <DialogDescription>Add one session, or a timetable that repeats.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            {error ? <Alert variant="error" role="alert"><TriangleAlert aria-hidden="true" /><AlertDescription>{error}</AlertDescription></Alert> : null}
            {types.isPending ? (
              <div aria-busy="true" role="status"><span className="sr-only">Loading your classes</span><Skeleton className="h-9 w-full" /></div>
            ) : types.isError ? (
              <Alert variant="error" role="alert"><TriangleAlert aria-hidden="true" /><AlertDescription className="flex flex-col items-start gap-2"><span>Your classes could not be loaded.</span><Button size="sm" variant="outline" type="button" onClick={() => void types.refetch()}>Try again</Button></AlertDescription></Alert>
            ) : list.length === 0 ? (
              <div className="flex flex-col items-start gap-3">
                <p className="text-sm text-muted-foreground">You have no classes yet. Add a class first: it sets the length, the seats, who teaches it and where.</p>
                {onAddClass ? <Button type="button" variant="outline" onClick={onAddClass}><Dumbbell aria-hidden="true" /> Add a class</Button> : null}
              </div>
            ) : (
              <>
                <SelectField label="Class" value={serviceId} onValueChange={chooseClass} options={typeOptions} placeholder="Choose a class" />
                <div className="grid gap-4 sm:grid-cols-2">
                  <SelectField label="Teacher" value={practitionerId} onValueChange={setPractitionerId} options={teacherOptions} placeholder={chosen ? `Choose a ${t.practitioner}` : "Choose a class first"} disabled={!chosen} />
                  <SelectField label="Place" value={locationId} onValueChange={setLocationId} options={placeOptions} placeholder={chosen ? "Choose a place" : "Choose a class first"} disabled={!chosen} />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <DateField label="First date" value={date} onValueChange={setDate} min={todayKey()} />
                  <TextField label="Start time" type="time" value={time} onChange={(event) => setTime(event.target.value)} />
                </div>
                <TextField label="Seats" type="number" inputMode="numeric" min={1} max={500} value={seats} onChange={(event) => setSeats(event.target.value)} hint={chosen ? `The class usually has ${chosen.capacity}.` : undefined} />
                <RepeatControl draft={repeat} onChange={setRepeat} startsOn={date} time={time || null} />
                {rule === null ? <p className="text-sm text-muted-foreground">{`One session on ${dayHeading(date)} at ${time}.`}</p> : summary ? <p className="sr-only">{summary}</p> : null}
              </>
            )}
            {clashes.length > 0 ? (
              <Alert variant="error" role="alert">
                <TriangleAlert aria-hidden="true" />
                <AlertDescription className="flex flex-col gap-2">
                  <span className="font-medium">Nothing was added. These dates clash:</span>
                  <ul aria-label="Dates that clash" className="flex flex-col gap-1">
                    {clashes.map((clash) => <li key={clash.date} className="text-sm"><span className="font-medium tabular-nums">{dayHeading(clash.date.slice(0, 10))}</span>: {clash.reason}</li>)}
                  </ul>
                  <span>Change the time, teacher or place, or end the timetable before these dates.</span>
                </AlertDescription>
              </Alert>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <DialogClose disabled={pending} render={<Button type="button" variant="ghost" />}>Not now</DialogClose>
            <Button type="submit" loading={pending} disabled={!ready}>{rule && "rule" in rule ? "Add timetable" : "Add session"}</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
