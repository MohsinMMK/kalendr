"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Repeat, RotateCw, TriangleAlert } from "lucide-react";

import { DateField } from "@/components/date-picker";
import { SelectField, TextField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import type { Appointment } from "@/lib/domain";
import type { SeriesPreview, SeriesView } from "@/lib/series-contracts";

import { clinicDateKey, isClinicDateKey } from "./schedule-availability";
import { clockIn, keepValidAnswers, resolutionsFrom, unresolvedCount, bookedCount, type Answer, type Answers } from "./repeat-model";
import { VisitChecklist } from "./repeat-booking";
import { cancelSeries, loadSeries, moveSeries, previewSeriesMove, type SeriesChangeFields } from "./series-api";
import { useCatalogLookups } from "./clinic-catalog";

type Scope = "one" | "following" | "all";
type Step = "scope" | "confirm" | "when" | "check";

/** The visits a change could still touch: booked or requested, and still ahead. Finished and checked-in visits never change. */
export function openVisits(series: SeriesView, fromIndex: number, now = Date.now()) {
  return series.visits.filter((visit) => (visit.status === "booked" || visit.status === "requested") && visit.index >= fromIndex && new Date(visit.startsAt).getTime() > now);
}

/**
 * What to change when a visit that belongs to a repeating series is moved or cancelled: just this one, this and the ones
 * after it, or all that are still ahead. "Just this one" goes on to the ordinary screens; the other two change the series.
 */
export function SeriesScopeDialog({ action, appointment, open, onOpenChange, onThisOne, onDone }: {
  action: "reschedule" | "cancel";
  /** Only what the dialog reads, so the Repeating tab can anchor it on a series' next visit without loading the whole booking. */
  appointment: Pick<Appointment, "id" | "startsAt" | "locationId" | "serviceId" | "practitionerId" | "seriesId" | "seriesIndex">;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onThisOne: () => void;
  onDone: () => Promise<void> | void;
}) {
  const t = useTerms();
  const catalog = useCatalogLookups();
  const [series, setSeries] = useState<{ state: "loading" } | { state: "error"; message: string } | { state: "ready"; view: SeriesView }>({ state: "loading" });
  const [scope, setScope] = useState<Scope>("one");
  const [step, setStep] = useState<Step>("scope");
  const [date, setDate] = useState(clinicDateKey(appointment.startsAt));
  const [time, setTime] = useState(clockIn(appointment.startsAt));
  const [practitionerId, setPractitionerId] = useState(appointment.practitionerId);
  const [preview, setPreview] = useState<SeriesPreview | null>(null);
  const [answers, setAnswers] = useState<Answers>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = useRef(crypto.randomUUID());

  const seriesId = appointment.seriesId ?? "";
  // The dialog is mounted fresh each time it is opened, so it starts at the first step and only has to load the series.
  const run = useCallback(() => {
    loadSeries(seriesId).then((view) => setSeries({ state: "ready", view })).catch((cause: unknown) => setSeries({ state: "error", message: cause instanceof Error ? cause.message : "The series could not be loaded." }));
  }, [seriesId]);
  useEffect(() => { run(); }, [run]);
  const load = () => { setSeries({ state: "loading" }); run(); };

  const view = series.state === "ready" ? series.view : null;
  const fromIndex = appointment.seriesIndex ?? 1;
  const followingCount = view ? openVisits(view, fromIndex).length : 0;
  const allCount = view ? openVisits(view, 1).length : 0;
  const count = scope === "all" ? allCount : followingCount;
  const noun = (n: number) => `${n} ${n === 1 ? t.appointment : t.appointments}`;

  const fields = (): SeriesChangeFields | null => {
    if (!view || scope === "one") return null;
    const startsAt = new Date(`${date}T${time}:00+05:30`);
    if (!isClinicDateKey(date) || !/^\d{2}:\d{2}$/.test(time) || Number.isNaN(startsAt.getTime())) return null;
    return { scope, fromAppointmentId: appointment.id, expectedVersion: view.version, startsAt: startsAt.toISOString(), ...(practitionerId !== appointment.practitionerId ? { practitionerId } : {}) };
  };

  function next() {
    setError("");
    if (scope === "one") { onOpenChange(false); onThisOne(); return; }
    setStep(action === "cancel" ? "confirm" : "when");
  }

  async function check() {
    const body = fields();
    if (!body || !view) { setError("Choose a date and a time."); return; }
    setBusy(true);
    setError("");
    try {
      const result = await previewSeriesMove(view.id, body);
      setPreview(result);
      setAnswers({});
      key.current = crypto.randomUUID();
      setStep("check");
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "The dates could not be checked.");
    } finally { setBusy(false); }
  }

  function answer(index: number, next: Answer | null) {
    key.current = crypto.randomUUID();
    setAnswers((current) => { const copy = { ...current }; if (next) copy[index] = next; else delete copy[index]; return copy; });
  }

  async function confirm() {
    if (!view || scope === "one") return;
    setBusy(true);
    setError("");
    try {
      if (action === "cancel") {
        const result = await cancelSeries(view.id, { scope, fromAppointmentId: appointment.id, expectedVersion: view.version }, key.current);
        if (!result.changed) throw new Error("Nothing was cancelled.");
        toastManager.add({ title: `${noun(result.cancelledCount)} cancelled`, description: `The ${t.customer} gets one message.`, type: "success" });
      } else {
        const body = fields();
        if (!body || !preview) throw new Error("Check the dates first.");
        const result = await moveSeries(view.id, body, resolutionsFrom(answers, preview), key.current);
        if (!result.changed) {
          key.current = crypto.randomUUID();
          setAnswers((current) => keepValidAnswers(current, result.preview));
          setPreview(result.preview);
          setError("Something changed while you were choosing, so nothing was moved. Check the list again.");
          return;
        }
        toastManager.add({ title: `${noun(result.bookedCount)} moved`, description: `The ${t.customer} gets one message.`, type: "success" });
      }
      // Close at once; the screen behind catches up when its data has been read again.
      onOpenChange(false);
      void onDone();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "The change could not be saved.");
    } finally { setBusy(false); }
  }

  const open_ = preview ? unresolvedCount(answers, preview) : 0;
  const total = preview ? bookedCount(answers, preview) : 0;
  const title = action === "cancel" ? `Cancel ${t.appointment}` : `Move ${t.appointment}`;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {step === "scope" ? `This ${t.appointment} repeats. Which ones do you want to ${action === "cancel" ? "cancel" : "move"}?` : step === "confirm" ? `Cancel ${noun(count)}.` : step === "when" ? `Choose the new day and time. The ones after it follow the same pattern.` : `Check every new date.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-4">
          {error ? <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertDescription>{error}</AlertDescription></Alert> : null}
          {series.state === "loading" ? <div role="status" className="flex flex-col gap-2"><p className="text-sm text-muted-foreground">Loading the series…</p><Skeleton className="h-10" /><Skeleton className="h-10" /></div> : null}
          {series.state === "error" ? (
            <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertDescription className="flex flex-wrap items-center justify-between gap-2"><span>{series.message}</span><Button size="xs" variant="outline" onClick={load}><RotateCw aria-hidden="true" /> Try again</Button></AlertDescription></Alert>
          ) : null}
          {view && step === "scope" ? (
            <RadioGroup aria-label="Which ones" value={scope} onValueChange={(value) => setScope(value as Scope)}>
              <Label className="flex items-start gap-3"><Radio value="one" /><span><span className="font-medium">Just this one</span><span className="block text-xs font-normal text-muted-foreground">The others stay as they are.</span></span></Label>
              <Label className="flex items-start gap-3"><Radio value="following" disabled={followingCount === 0} /><span><span className="font-medium">This and the ones after it</span><span className="block text-xs font-normal text-muted-foreground">{noun(followingCount)} still ahead. Earlier ones stay as they are.</span></span></Label>
              <Label className="flex items-start gap-3"><Radio value="all" disabled={allCount === 0} /><span><span className="font-medium">All that are still ahead</span><span className="block text-xs font-normal text-muted-foreground">{noun(allCount)}. {t.Appointments} already finished or checked in are never changed.</span></span></Label>
            </RadioGroup>
          ) : null}
          {view && step === "confirm" ? (
            <p className="text-sm">{noun(count)} will be cancelled and the times given back. {t.Appointments} already finished or checked in stay as they are. The {t.customer} gets one message listing what was cancelled.</p>
          ) : null}
          {view && step === "when" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <DateField label="New date for this one" value={date} onValueChange={(next) => { if (isClinicDateKey(next)) setDate(next); }} />
              <TextField label="Time" type="time" value={time} onChange={(event) => setTime(event.target.value)} />
              <SelectField fieldClassName="sm:col-span-2" label={t.Practitioner} value={practitionerId} onValueChange={setPractitionerId} options={catalog.practitioners.filter((person) => person.locationIds.includes(appointment.locationId) && (!catalog.getService(appointment.serviceId) || catalog.getService(appointment.serviceId)!.practitionerIds.includes(person.id))).map((person) => ({ value: person.id, label: person.name }))} />
            </div>
          ) : null}
          {view && step === "check" && preview ? (
            <div className="flex flex-col gap-3">
              <p aria-live="polite" className="text-sm">{preview.clashCount === 0 ? "Every date is free." : `${preview.freeCount} of ${preview.visits.length} are free. ${open_ > 0 ? `Choose what to do about ${open_ === 1 ? "the clash" : `the ${open_} clashes`}.` : "All clashes are settled."}`}</p>
              <VisitChecklist preview={preview} answers={answers} onAnswer={answer} disabled={busy} />
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          {step === "scope" ? <>
            <DialogClose render={<Button variant="ghost" />}>Close</DialogClose>
            <Button onClick={next} disabled={!view}><Repeat aria-hidden="true" /> Continue</Button>
          </> : null}
          {step === "confirm" ? <>
            <Button variant="ghost" onClick={() => setStep("scope")} disabled={busy}>Back</Button>
            <Button variant="destructive" onClick={() => void confirm()} loading={busy}>Cancel {noun(count)}</Button>
          </> : null}
          {step === "when" ? <>
            <Button variant="ghost" onClick={() => setStep("scope")} disabled={busy}>Back</Button>
            <Button onClick={() => void check()} loading={busy}>Check the dates</Button>
          </> : null}
          {step === "check" ? <>
            <Button variant="ghost" onClick={() => setStep("when")} disabled={busy}>Back</Button>
            <Button onClick={() => void confirm()} loading={busy} disabled={open_ > 0 || total === 0}>Move {noun(total)}</Button>
          </> : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
