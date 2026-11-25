"use client";

import { PartyPopper, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";

import { DatePicker, keyFromDate } from "@/components/date-picker";
import { SelectField, TextField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Frame, FrameDescription, FrameFooter, FrameHeader, FramePanel } from "@/components/ui/frame";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useTerms } from "@/features/terms/business-profile-context";
import type { HolidayItem, HolidayListing, HolidaySettings } from "@/lib/availability-setup";

import { getHolidays, putHolidays } from "./availability-api";
import { ConflictNotice, describeFailure, savedToast } from "./availability-shared";
import { ScrollAreaPrimitive, ScrollBar } from "@/components/ui/scroll-area";

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; listing: HolidayListing };

const dayFormat = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });

export function holidayDateLabel(date: string): string {
  const [year = 0, month = 1, day = 1] = date.split("-").map(Number);
  return dayFormat.format(new Date(year, month - 1, day));
}

/** The settings with one holiday turned on (closed) or off (open) for its year. */
export function withHolidayClosed(settings: HolidaySettings, holiday: Pick<HolidayItem, "id" | "date">, closed: boolean): HolidaySettings {
  const year = holiday.date.slice(0, 4);
  const others = (settings.optedOut[year] ?? []).filter((id) => id !== holiday.id);
  const next = { ...settings.optedOut };
  if (closed) {
    if (others.length > 0) next[year] = others;
    else delete next[year];
  } else {
    next[year] = [...others, holiday.id];
  }
  return { ...settings, optedOut: next };
}

/**
 * Public holidays. The owner picks a country (and region) and each holiday in the next twelve
 * months has a switch: on means closed. Festivals the data does not list can be added as own closed days.
 */
export function HolidaysPanel({ preview = false }: { preview?: boolean }) {
  const t = useTerms();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [draft, setDraft] = useState<HolidaySettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [conflict, setConflict] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [customDate, setCustomDate] = useState(keyFromDate(new Date()));
  const [customName, setCustomName] = useState("");

  useEffect(() => {
    if (preview) return;
    const controller = new AbortController();
    getHolidays(controller.signal).then((listing) => {
      if (controller.signal.aborted) return;
      setLoad({ state: "ready", listing });
      setConflict(false);
      setDraft(listing.settings ? { country: listing.settings.country, region: listing.settings.region, optedOut: listing.settings.optedOut, customDays: listing.settings.customDays } : null);
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setLoad({ state: "error", message: cause instanceof Error ? cause.message : "Holidays could not be loaded." });
    });
    return () => controller.abort();
  }, [reloadKey, preview]);

  const reload = () => { setLoad({ state: "loading" }); setReloadKey((key) => key + 1); };

  async function save(next: HolidaySettings): Promise<void> {
    if (load.state !== "ready") return;
    setSaving(true);
    setMessage("");
    try {
      const listing = await putHolidays({ ...next, ...(load.listing.settings ? { expectedVersion: load.listing.settings.version } : {}) });
      setLoad({ state: "ready", listing });
      setDraft(listing.settings ? { country: listing.settings.country, region: listing.settings.region, optedOut: listing.settings.optedOut, customDays: listing.settings.customDays } : null);
      savedToast("Holidays saved.");
    } catch (cause: unknown) {
      const failure = describeFailure(cause, "Holidays could not be saved.");
      if (failure.conflict) setConflict(true);
      else setMessage(failure.message);
    } finally {
      setSaving(false);
    }
  }

  const listing = load.state === "ready" ? load.listing : null;
  const suggested = listing?.suggestedCountry ?? "";
  const country = draft?.country ?? "";
  const dirty = Boolean(draft && listing && JSON.stringify(draft) !== JSON.stringify(listing.settings && { country: listing.settings.country, region: listing.settings.region, optedOut: listing.settings.optedOut, customDays: listing.settings.customDays }));
  const items = (listing?.holidays ?? []).filter((item) => item.type !== "custom");

  return (
    <Frame>
      <FrameHeader>
        <h3 className="text-sm font-semibold">Public holidays</h3>
        <FrameDescription className="text-xs">Close the {t.business} on the public holidays of one country. Switch a holiday off to stay open. A {t.practitioner} can still work a holiday by adding a date change to their hours.</FrameDescription>
      </FrameHeader>
      <FramePanel className="flex flex-col gap-4">
        {preview ? <Alert variant="info"><AlertDescription>Holidays are not available in the preview. They work on a real {t.business}.</AlertDescription></Alert> : null}
        {message ? <Alert variant="error"><AlertDescription>{message}</AlertDescription></Alert> : null}
        {conflict ? <ConflictNotice onReload={reload} /> : null}
        {load.state === "loading" && !preview ? <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading holidays"><Skeleton className="h-11 w-full" /><Skeleton className="h-32 w-full" /></div> : null}
        {load.state === "error" ? <Alert variant="error"><AlertDescription className="flex flex-wrap items-center justify-between gap-3">{load.message}<Button size="sm" variant="outline" onClick={reload}>Try again</Button></AlertDescription></Alert> : null}
        {listing ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <SelectField
                label="Country"
                hint={!draft && suggested ? "Suggested from your timezone." : undefined}
                value={country || suggested}
                onValueChange={(code) => setDraft({ country: code, region: null, optedOut: {}, customDays: draft?.customDays ?? [] })}
                options={listing.countries.map((entry) => ({ value: entry.code, label: entry.name }))}
                placeholder="Choose a country"
              />
              {listing.regions.length > 0 ? (
                <SelectField optional label="State or region" value={draft?.region ?? ""} onValueChange={(region) => draft && setDraft({ ...draft, region: region || null, optedOut: {} })} options={[{ value: "", label: "Whole country" }, ...listing.regions.map((entry) => ({ value: entry.code, label: entry.name }))]} />
              ) : null}
            </div>
            {!draft ? (
              <Button className="self-start" disabled={saving || !suggested} onClick={() => void save({ country: suggested, region: null, optedOut: {}, customDays: [] })}>
                {saving ? <Spinner aria-hidden="true" /> : null}
                Close on {suggested ? (listing.countries.find((entry) => entry.code === suggested)?.name ?? suggested) : "public"} holidays
              </Button>
            ) : null}
            {draft && !listing.dataAvailable ? (
              <Alert variant="warning"><AlertDescription>The holiday list for this country is not available right now. You can still add your own closed days below.</AlertDescription></Alert>
            ) : null}
            {draft && listing.dataAvailable && items.length === 0 ? (
              <Empty className="py-6"><EmptyHeader><EmptyMedia variant="icon"><PartyPopper aria-hidden="true" /></EmptyMedia><EmptyTitle>No public holidays listed</EmptyTitle><EmptyDescription>Nothing to close for in the next 12 months.</EmptyDescription></EmptyHeader></Empty>
            ) : null}
            {draft && items.length > 0 ? (
              <ScrollAreaPrimitive.Root className="rounded-xl border"><ScrollAreaPrimitive.Viewport data-slot="scroll-area-viewport" className="max-h-96 rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"><ScrollAreaPrimitive.Content style={{ minWidth: 0 }}><ul className="flex flex-col divide-y" aria-label="Holidays in the next 12 months">
                {items.map((item) => {
                  const closed = !(draft.optedOut[item.date.slice(0, 4)] ?? []).includes(item.id);
                  const switchId = `holiday-${item.id}-${item.date}`;
                  return (
                    <li key={switchId} className="flex min-h-12 items-center justify-between gap-3 px-3 py-2">
                      <div className="min-w-0">
                        <Label htmlFor={switchId} className="font-medium">{item.name}</Label>
                        <p className="text-xs text-muted-foreground">{holidayDateLabel(item.date)} · {closed ? "Closed" : "Open"}</p>
                      </div>
                      <Switch id={switchId} checked={closed} onCheckedChange={(on) => setDraft(withHolidayClosed(draft, item, on))} />
                    </li>
                  );
                })}
              </ul></ScrollAreaPrimitive.Content></ScrollAreaPrimitive.Viewport><ScrollBar orientation="vertical" /></ScrollAreaPrimitive.Root>
            ) : null}
            {draft ? (
              <div className="flex flex-col gap-3">
                <h4 className="text-sm font-semibold">Your own closed days</h4>
                {draft.customDays.length > 0 ? (
                  <ul className="flex flex-col divide-y rounded-xl border" aria-label="Your own closed days">
                    {draft.customDays.map((day) => (
                      <li key={day.date} className="flex min-h-12 items-center justify-between gap-3 px-3 py-2">
                        <div className="min-w-0"><p className="text-sm font-medium">{day.name}</p><p className="text-xs text-muted-foreground">{holidayDateLabel(day.date)}</p></div>
                        <Button type="button" variant="ghost" size="icon-lg" aria-label={`Remove ${day.name}`} onClick={() => setDraft({ ...draft, customDays: draft.customDays.filter((entry) => entry.date !== day.date) })}><X aria-hidden="true" /></Button>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="grid items-end gap-3 sm:grid-cols-[auto_1fr_auto]">
                  <div className="flex flex-col items-start gap-2"><Label htmlFor="custom-holiday-date">Date</Label><DatePicker id="custom-holiday-date" size="lg" value={customDate} onValueChange={setCustomDate} /></div>
                  <TextField label="Name" placeholder="Diwali" value={customName} maxLength={120} onChange={(event) => setCustomName(event.target.value)} />
                  <Button type="button" variant="outline" size="lg" disabled={!customName.trim() || draft.customDays.some((day) => day.date === customDate)} onClick={() => { setDraft({ ...draft, customDays: [...draft.customDays, { date: customDate, name: customName.trim() }].sort((a, b) => a.date.localeCompare(b.date)) }); setCustomName(""); }}>
                    <Plus aria-hidden="true" /> Add a closed day
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
        <p className="text-xs text-muted-foreground">Holiday data: date-holidays (CC BY-SA 4.0).</p>
      </FramePanel>
      {draft ? (
        <FrameFooter className="flex justify-end">
          <Button disabled={saving || !dirty} onClick={() => void save(draft)}>
            {saving ? <Spinner aria-hidden="true" /> : null}
            {saving ? "Saving…" : "Save holidays"}
          </Button>
        </FrameFooter>
      ) : null}
    </Frame>
  );
}
