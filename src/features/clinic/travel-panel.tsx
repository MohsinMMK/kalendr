"use client";

import { Ellipsis, MapPinned } from "lucide-react";
import { useEffect, useState } from "react";

import { DatePicker, keyFromDate } from "@/components/date-picker";
import { SelectField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty";
import { Frame, FrameDescription, FrameHeader, FramePanel } from "@/components/ui/frame";
import { Label } from "@/components/ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useTerms } from "@/features/terms/business-profile-context";
import type { Schedule, TravelPeriod } from "@/lib/availability-setup";

import { createTravel, deleteTravel, listSchedules, listTravel } from "./availability-api";
import { describeFailure, savedToast, timezoneOptions } from "./availability-shared";
import { useCatalogLookups } from "./clinic-catalog";
import { holidayDateLabel } from "./holidays-panel";
import { convertRange } from "./schedule-ranges";

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; periods: TravelPeriod[]; home: Schedule | null };

/** The first working range of the default schedule, or a plain 9 to 5 when there is none to show. */
export function sampleRange(schedule: Schedule | null): { start: string; end: string } {
  for (const day of ["1", "2", "3", "4", "5", "6", "7"] as const) {
    const first = schedule?.weekly[day][0];
    if (first) return first;
  }
  return { start: "09:00", end: "17:00" };
}

/** Dates in another timezone. The weekly pattern is read there ("9 to 5 wherever I am"). */
export function TravelPanel() {
  const t = useTerms();
  const catalog = useCatalogLookups();
  const [practitionerId, setPractitionerId] = useState(catalog.practitioners[0]?.id ?? "");
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [startsOn, setStartsOn] = useState(keyFromDate(new Date()));
  const [endsOn, setEndsOn] = useState(keyFromDate(new Date()));
  const [timezone, setTimezone] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!practitionerId) return;
    const controller = new AbortController();
    Promise.all([listTravel(practitionerId, controller.signal), listSchedules(practitionerId, controller.signal)]).then(([periods, schedules]) => {
      if (!controller.signal.aborted) setLoad({ state: "ready", periods, home: schedules.find((entry) => entry.isDefault) ?? schedules[0] ?? null });
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setLoad({ state: "error", message: cause instanceof Error ? cause.message : "Travel dates could not be loaded." });
    });
    return () => controller.abort();
  }, [practitionerId, reloadKey]);

  const ready = load.state === "ready" ? load : null;
  const homeZone = ready?.home?.timezone ?? "";
  const sample = sampleRange(ready?.home ?? null);
  const preview = ready && homeZone && timezone ? convertRange(sample, timezone, homeZone) : null;
  const place = timezone.split("/").pop()?.replaceAll("_", " ") ?? "";
  const invalid = !practitionerId || !timezone || endsOn < startsOn;

  return (
    <Frame>
      <FrameHeader>
        <h3 className="text-sm font-semibold">Travel</h3>
        <FrameDescription className="text-xs">When {t.aPractitioner} works in another timezone, their weekly hours are read there.</FrameDescription>
      </FrameHeader>
      <FramePanel className="flex flex-col gap-4">
        {message ? <Alert variant="error"><AlertDescription>{message}</AlertDescription></Alert> : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <SelectField label={t.Practitioner} value={practitionerId} onValueChange={(value) => { setLoad({ state: "loading" }); setPractitionerId(value); }} options={catalog.practitioners.map((person) => ({ value: person.id, label: person.name }))} />
          <SelectField label="Timezone while away" value={timezone} placeholder="Choose a timezone" onValueChange={setTimezone} options={timezoneOptions()} />
          <div className="flex flex-col items-start gap-2"><Label htmlFor="travel-from">From</Label><DatePicker id="travel-from" size="lg" className="w-full" value={startsOn} onValueChange={(value) => { setStartsOn(value); if (endsOn < value) setEndsOn(value); }} /></div>
          <div className="flex flex-col items-start gap-2"><Label htmlFor="travel-until">Until</Label><DatePicker id="travel-until" size="lg" className="w-full" value={endsOn} min={startsOn} onValueChange={setEndsOn} /></div>
        </div>
        {preview ? (
          <p className="rounded-lg bg-muted/60 px-3 py-2 text-sm" aria-live="polite">
            {sample.start}–{sample.end} in {place} is <strong>{preview.start}–{preview.end}</strong> on {homeZone.split("/").pop()?.replaceAll("_", " ")} time.
          </p>
        ) : null}
        <div className="flex justify-end">
          <Button size="lg" disabled={saving || invalid} onClick={async () => {
            setSaving(true);
            setMessage("");
            try {
              const created = await createTravel({ practitionerId, startsOn, endsOn, timezone });
              setLoad(ready ? { ...ready, periods: [...ready.periods, created] } : load);
              savedToast("Travel dates saved.");
            } catch (cause: unknown) {
              setMessage(describeFailure(cause, "Travel dates could not be saved.").message);
            } finally {
              setSaving(false);
            }
          }}>{saving ? <Spinner aria-hidden="true" /> : null}{saving ? "Saving…" : "Add travel dates"}</Button>
        </div>
        {load.state === "loading" ? <Skeleton className="h-14 w-full" aria-label="Loading travel dates" /> : null}
        {load.state === "error" ? <Alert variant="error"><AlertDescription className="flex flex-wrap items-center justify-between gap-3">{load.message}<Button size="sm" variant="outline" onClick={() => { setLoad({ state: "loading" }); setReloadKey((key) => key + 1); }}>Try again</Button></AlertDescription></Alert> : null}
        {ready && ready.periods.length === 0 ? <Empty className="py-6"><EmptyHeader><EmptyMedia variant="icon"><MapPinned aria-hidden="true" /></EmptyMedia><EmptyDescription>No travel dates.</EmptyDescription></EmptyHeader></Empty> : null}
        {ready && ready.periods.length > 0 ? (
          <ul className="flex flex-col divide-y rounded-xl border" aria-label="Travel dates">
            {ready.periods.map((period) => (
              <li key={period.id} className="flex min-h-12 items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0"><p className="text-sm font-medium">{period.timezone.replaceAll("_", " ")}</p><p className="text-xs text-muted-foreground">{holidayDateLabel(period.startsOn)} to {holidayDateLabel(period.endsOn)}</p></div>
                <Menu>
                  <MenuTrigger render={<Button variant="ghost" size="icon-lg" aria-label={`More for the trip starting ${holidayDateLabel(period.startsOn)}`} />}><Ellipsis aria-hidden="true" /></MenuTrigger>
                  <MenuPopup align="end"><MenuItem onClick={async () => { try { await deleteTravel(period.id); setLoad({ ...ready, periods: ready.periods.filter((entry) => entry.id !== period.id) }); savedToast("Travel dates removed."); } catch (cause: unknown) { setMessage(describeFailure(cause, "They could not be removed.").message); } }}>Remove</MenuItem></MenuPopup>
                </Menu>
              </li>
            ))}
          </ul>
        ) : null}
      </FramePanel>
    </Frame>
  );
}
