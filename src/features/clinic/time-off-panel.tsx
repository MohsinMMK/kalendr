"use client";

import { Ellipsis, Plane } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { DatePicker, keyFromDate } from "@/components/date-picker";
import { SelectField, TextField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty";
import { Frame, FrameDescription, FrameHeader, FramePanel } from "@/components/ui/frame";
import { Label } from "@/components/ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { Spinner } from "@/components/ui/spinner";
import { useStaffAccess } from "@/features/clinic/staff-access";
import { useTerms } from "@/features/terms/business-profile-context";
import { timeOffReasonLabels, timeOffReasons, type TimeOff, type TimeOffReason } from "@/lib/availability-setup";

import { createTimeOff, deleteTimeOff, isConflict, listTimeOff, updateTimeOff } from "./availability-api";
import { describeFailure, savedToast } from "./availability-shared";
import { HolidaysPanel, holidayDateLabel } from "./holidays-panel";
import { useCatalogLookups } from "./clinic-catalog";
import { TimeOffReassignDialog } from "./time-off-reassign-dialog";

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; items: TimeOff[] };

/** "Back on 3 December" from the last day away: the next morning. */
export function backOnNote(throughDate: string): string {
  const [year = 0, month = 1, day = 1] = throughDate.split("-").map(Number);
  const next = new Date(year, month - 1, day + 1);
  return `Back on ${next.getDate()} ${next.toLocaleString("en-GB", { month: "long" })}`;
}

/**
 * What a booker sees for one entry: the note on the booking page, and whose times appear while this person is away. The
 * words come from the same fields the booking page reads, so this line cannot drift from what the booker really gets.
 */
export function bookerView(item: Pick<TimeOff, "publicNote" | "coverPractitionerId">, coverName: string | null, words: { provider: string; service: string }): { note: string; times: string } {
  return {
    note: item.publicNote?.trim() ? `“${item.publicNote.trim()}”` : "No note shown",
    times: item.coverPractitionerId && coverName ? `Shows ${coverName}'s times for the same ${words.service}` : `No ${words.provider} times are offered`,
  };
}

/**
 * Which time-off tabs a person gets. Someone with a bookable profile of their own sees "My time off"; someone who can
 * manage everyone's hours (`hours.edit`, the permission the team panel and the server use) also gets the whole team's.
 * A login with no profile of its own sees the team's alone.
 */
export function timeOffTabs(ownPractitionerId: string | null, canManageHours: boolean): Array<{ value: "mine" | "team"; label: string }> {
  const tabs: Array<{ value: "mine" | "team"; label: string }> = [];
  if (ownPractitionerId) tabs.push({ value: "mine", label: "My time off" });
  if (canManageHours || !ownPractitionerId) tabs.push({ value: "team", label: "Team time off" });
  return tabs;
}

/**
 * The time-off screen: "My time off" is this person's days away with the note and cover person a booker sees; people who
 * manage hours also get "Team time off", and a login with no bookable profile of its own sees the team's instead.
 * "Holidays" is the business's closed days.
 */
export function TimeOffScreen() {
  const access = useStaffAccess();
  const own = access.ownPractitionerId;
  const tabs = timeOffTabs(own, access.can("hours.edit"));
  return (
    <Tabs defaultValue={tabs[0]?.value ?? "holidays"} className="gap-4">
      <TabsList variant="underline" aria-label="Time off">
        {tabs.map((tab) => <TabsTab key={tab.value} value={tab.value}>{tab.label}</TabsTab>)}
        <TabsTab value="holidays">Holidays</TabsTab>
      </TabsList>
      <TabsPanel value="mine"><TimeOffPanel ownPractitionerId={own} /></TabsPanel>
      <TabsPanel value="team"><TimeOffPanel /></TabsPanel>
      <TabsPanel value="holidays"><HolidaysPanel /></TabsPanel>
    </Tabs>
  );
}

/**
 * Out of office: dates, a reason, a note the booking page shows and, if wanted, a teammate whose
 * times the page offers instead while this person is away.
 */
export function TimeOffPanel({ ownPractitionerId = null }: { ownPractitionerId?: string | null } = {}) {
  const t = useTerms();
  const catalog = useCatalogLookups();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [practitionerId, setPractitionerId] = useState(ownPractitionerId ?? catalog.practitioners[0]?.id ?? "");
  const [startsOn, setStartsOn] = useState(keyFromDate(new Date()));
  const [throughDate, setThroughDate] = useState(keyFromDate(new Date()));
  const [reason, setReason] = useState<TimeOffReason>("leave");
  const [note, setNote] = useState("");
  const [cover, setCover] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const [editing, setEditing] = useState<TimeOff | null>(null);
  const [conflict, setConflict] = useState(false);
  const [reassigning, setReassigning] = useState<TimeOff | null>(null);

  const startEdit = (item: TimeOff) => {
    setEditing(item);
    setPractitionerId(item.practitionerId);
    setStartsOn(item.startsOn);
    setThroughDate(item.throughDate);
    setReason(item.reason);
    setNote(item.publicNote ?? "");
    setCover(item.coverPractitionerId ?? "");
    setMessage("");
    setConflict(false);
  };
  const stopEdit = () => { setEditing(null); setNote(""); setCover(""); setConflict(false); };

  useEffect(() => {
    const controller = new AbortController();
    listTimeOff(null, controller.signal).then((items) => {
      if (!controller.signal.aborted) setLoad({ state: "ready", items });
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setLoad({ state: "error", message: cause instanceof Error ? cause.message : "Out of office could not be loaded." });
    });
    return () => controller.abort();
  }, [reloadKey]);

  const run = useCallback(async (task: () => Promise<void>, fallback: string) => {
    setSaving(true);
    setMessage("");
    setConflict(false);
    try { await task(); } catch (cause: unknown) {
      if (isConflict(cause)) { setConflict(true); setMessage("Someone else changed this. Reload to see their change, then make yours again."); } else setMessage(describeFailure(cause, fallback).message);
    } finally { setSaving(false); }
  }, []);

  const allItems = load.state === "ready" ? load.items : [];
  const items = ownPractitionerId ? allItems.filter((entry) => entry.practitionerId === ownPractitionerId) : allItems;
  const invalid = !practitionerId || throughDate < startsOn || cover === practitionerId;
  const nameOf = (id: string) => catalog.getPractitioner(id)?.name ?? "Someone";

  return (
    <Frame>
      <FrameHeader>
        <h3 className="text-sm font-semibold">{ownPractitionerId ? "My time off" : "Time off"}</h3>
        <FrameDescription className="text-xs">Close {t.aPractitioner}&apos;s times for days away. Existing bookings stay and still need moving.</FrameDescription>
      </FrameHeader>
      <FramePanel className="flex flex-col gap-4">
        {message ? <Alert variant="error"><AlertDescription className="flex flex-wrap items-center justify-between gap-3">{message}{conflict ? <Button size="sm" variant="outline" onClick={() => { stopEdit(); setMessage(""); setLoad({ state: "loading" }); setReloadKey((key) => key + 1); }}>Reload</Button> : null}</AlertDescription></Alert> : null}
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (invalid) return;
            void run(async () => {
              if (editing) {
                const updated = await updateTimeOff(editing.id, { expectedVersion: editing.version, startsOn, throughDate, reason, publicNote: note.trim() || null, coverPractitionerId: cover || null });
                setLoad({ state: "ready", items: allItems.map((entry) => (entry.id === updated.id ? updated : entry)) });
                stopEdit();
                savedToast("Out of office updated.");
                return;
              }
              const created = await createTimeOff({ practitionerId, startsOn, throughDate, reason, publicNote: note.trim() || null, coverPractitionerId: cover || null });
              setLoad({ state: "ready", items: [...allItems, created] });
              setNote("");
              savedToast("Out of office saved.");
            }, "Out of office could not be saved.");
          }}
        >
          <SelectField label={t.Practitioner} disabled={editing !== null || ownPractitionerId !== null} value={practitionerId} onValueChange={setPractitionerId} options={catalog.practitioners.map((person) => ({ value: person.id, label: person.name }))} />
          <SelectField label="Reason" value={reason} onValueChange={(value) => setReason(timeOffReasons.find((entry) => entry === value) ?? "leave")} options={timeOffReasons.map((entry) => ({ value: entry, label: timeOffReasonLabels[entry] }))} />
          <div className="flex flex-col items-start gap-2"><Label htmlFor="time-off-from">From</Label><DatePicker id="time-off-from" size="lg" className="w-full" value={startsOn} onValueChange={(value) => { setStartsOn(value); if (throughDate < value) setThroughDate(value); }} /></div>
          <div className="flex flex-col items-start gap-2"><Label htmlFor="time-off-through">Last day away</Label><DatePicker id="time-off-through" size="lg" className="w-full" value={throughDate} min={startsOn} onValueChange={setThroughDate} /></div>
          <TextField optional label="Note on the booking page" hint={`Shown to ${t.customers}, for example "${backOnNote(throughDate)}".`} value={note} maxLength={200} onChange={(event) => setNote(event.target.value)} fieldClassName="sm:col-span-2" />
          <SelectField optional label="Offer someone else instead" hint={`While away, the booking page shows this ${t.provider}'s times for the same ${t.service}.`} value={cover} onValueChange={setCover} options={[{ value: "", label: "No one" }, ...catalog.practitioners.filter((person) => person.id !== practitionerId).map((person) => ({ value: person.id, label: person.name }))]} fieldClassName="sm:col-span-2" />
          <div className="flex items-center justify-end gap-2 sm:col-span-2">
            {!note.trim() ? <Button type="button" variant="ghost" size="lg" onClick={() => setNote(backOnNote(throughDate))}>Use “{backOnNote(throughDate)}”</Button> : null}
            <Button type="submit" size="lg" disabled={saving || invalid}>{saving ? <Spinner aria-hidden="true" /> : null}{saving ? "Saving…" : editing ? "Save changes" : "Add out of office"}</Button>
            {editing ? <Button type="button" variant="ghost" size="lg" onClick={stopEdit}>Cancel</Button> : null}
          </div>
        </form>
        {load.state === "loading" ? <Skeleton className="h-16 w-full" aria-label="Loading out of office" /> : null}
        {load.state === "error" ? <Alert variant="error"><AlertDescription className="flex flex-wrap items-center justify-between gap-3">{load.message}<Button size="sm" variant="outline" onClick={() => { setLoad({ state: "loading" }); setReloadKey((key) => key + 1); }}>Try again</Button></AlertDescription></Alert> : null}
        {load.state === "ready" && items.length === 0 ? (
          <Empty className="py-6"><EmptyHeader><EmptyMedia variant="icon"><Plane aria-hidden="true" /></EmptyMedia><EmptyDescription>No one is away.</EmptyDescription></EmptyHeader></Empty>
        ) : null}
        {items.length > 0 ? (
          <ul className="flex flex-col divide-y rounded-xl border" aria-label="Out of office">
            {[...items].sort((a, b) => a.startsOn.localeCompare(b.startsOn)).map((item) => (
              <li key={item.id} className="flex min-h-12 items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{nameOf(item.practitionerId)} · {timeOffReasonLabels[item.reason]}</p>
                  <p className="text-xs text-muted-foreground">
                    {holidayDateLabel(item.startsOn)}{item.throughDate !== item.startsOn ? ` to ${holidayDateLabel(item.throughDate)}` : ""}
                    {item.coverPractitionerId ? ` · ${nameOf(item.coverPractitionerId)} covers` : ""}
                  </p>
                  {(() => {
                    const view = bookerView(item, item.coverPractitionerId ? nameOf(item.coverPractitionerId) : null, { provider: t.provider, service: t.service });
                    return <p className="text-xs text-muted-foreground" data-testid="booker-view">A booker sees: {view.note}. {view.times}.</p>;
                  })()}
                </div>
                <Menu>
                  <MenuTrigger render={<Button variant="ghost" size="icon-lg" aria-label={`More for ${nameOf(item.practitionerId)}'s time away`} disabled={saving} />}><Ellipsis aria-hidden="true" /></MenuTrigger>
                  <MenuPopup align="end">
                    <MenuItem onClick={() => startEdit(item)}>Edit</MenuItem>
                    {item.coverPractitionerId ? (
                      <MenuItem disabled={!catalog.database} onClick={() => setReassigning(item)}>
                        Move bookings to {nameOf(item.coverPractitionerId)}{!catalog.database ? " (not in preview)" : ""}
                      </MenuItem>
                    ) : null}
                    <MenuItem onClick={() => void run(async () => { await deleteTimeOff(item.id); setLoad({ state: "ready", items: allItems.filter((entry) => entry.id !== item.id) }); savedToast("Out of office removed."); }, "It could not be removed.")}>Remove</MenuItem>
                  </MenuPopup>
                </Menu>
              </li>
            ))}
          </ul>
        ) : null}
      </FramePanel>
      {reassigning ? (
        <TimeOffReassignDialog
          open
          onOpenChange={(next) => { if (!next) setReassigning(null); }}
          timeOffId={reassigning.id}
          people={catalog.practitioners.filter((person) => person.id !== reassigning.practitionerId).map((person) => ({ id: person.id, name: person.name }))}
          locale={catalog.clinic.locale}
          zone={catalog.clinic.timezone}
        />
      ) : null}
    </Frame>
  );
}
