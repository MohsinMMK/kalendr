"use client";

import { Ellipsis } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { SelectField, TextField } from "@/components/form-fields";
import { PersonAvatar } from "@/components/person-avatar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Frame, FrameDescription, FrameFooter, FrameHeader, FramePanel } from "@/components/ui/frame";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import type { Schedule, TimeRange } from "@/lib/availability-setup";

import { BookingLimitsButton } from "./booking-limits-panel";
import { copySchedule, createSchedule, deleteSchedule, listSchedules, updateSchedule } from "./availability-api";
import { ConflictNotice, describeFailure, savedToast, timezoneOptions } from "./availability-shared";
import { clinicDateKey } from "./schedule-availability";
import { ScheduleOverrides } from "./schedule-overrides";
import { weekIssue } from "./schedule-ranges";
import { WeeklyRangesEditor } from "./weekly-ranges-editor";

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; schedules: Schedule[] };
type NameMode = null | "create" | "rename" | "copy";

/**
 * One person's named schedules: pick one, edit its weekly ranges and date changes, make one the
 * default, rename, copy or delete it. Saves carry the version so a second manager is told, not overwritten.
 */
export function PersonSchedules({ practitionerId, name, title }: { practitionerId: string; name: string; title: string }) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<Schedule | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [conflict, setConflict] = useState(false);
  const [nameMode, setNameMode] = useState<NameMode>(null);
  const [nameValue, setNameValue] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    listSchedules(practitionerId, controller.signal).then((schedules) => {
      if (controller.signal.aborted) return;
      setLoad({ state: "ready", schedules });
      setConflict(false);
      setSelectedId((current) => schedules.some((entry) => entry.id === current) ? current : (schedules.find((entry) => entry.isDefault) ?? schedules[0])?.id ?? "");
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setLoad({ state: "error", message: cause instanceof Error ? cause.message : "Schedules could not be loaded." });
    });
    return () => controller.abort();
  }, [practitionerId, reloadKey]);

  const schedules = load.state === "ready" ? load.schedules : [];
  const selected = schedules.find((entry) => entry.id === selectedId) ?? null;
  const current = draft && draft.id === selected?.id && draft.version === selected.version ? draft : selected;
  const dirty = Boolean(current && selected && JSON.stringify(current.weekly) !== JSON.stringify(selected.weekly));
  const issue = current ? weekIssue(current.weekly) : null;

  const replace = useCallback((next: Schedule) => {
    setLoad((existing) => existing.state === "ready" ? { state: "ready", schedules: existing.schedules.map((entry) => entry.id === next.id ? next : entry.isDefault && next.isDefault ? { ...entry, isDefault: false } : entry) } : existing);
    setDraft(null);
  }, []);

  async function run(task: () => Promise<void>, fallback: string): Promise<void> {
    setSaving(true);
    setMessage("");
    try {
      await task();
    } catch (cause: unknown) {
      const failure = describeFailure(cause, fallback);
      if (failure.conflict) setConflict(true);
      else setMessage(failure.message);
    } finally {
      setSaving(false);
    }
  }

  const saveWeekly = async (): Promise<void> => {
    if (!selected || !current) return;
    await run(async () => {
      replace(await updateSchedule(selected.id, { expectedVersion: selected.version, weekly: current.weekly, timezone: current.timezone }));
      savedToast(`Hours saved for ${name}.`);
    }, "Hours could not be saved.");
  };

  const submitName = () => run(async () => {
    const value = nameValue.trim();
    if (nameMode === "create") {
      const created = await createSchedule({ practitionerId, name: value });
      setLoad({ state: "ready", schedules: [...schedules, created] });
      setSelectedId(created.id);
    } else if (nameMode === "copy" && selected) {
      const copy = await copySchedule(selected, value);
      setLoad({ state: "ready", schedules: [...schedules, copy] });
      setSelectedId(copy.id);
    } else if (nameMode === "rename" && selected) {
      replace(await updateSchedule(selected.id, { expectedVersion: selected.version, name: value }));
    }
    setNameMode(null);
    savedToast("Schedule saved.");
  }, "The schedule could not be saved.");

  const changeOverrides = async (body: { overrides?: Array<{ date: string; ranges: TimeRange[] | null }>; removeOverrideDates?: string[] }): Promise<void> => {
    if (!selected) return;
    await run(async () => {
      replace(await updateSchedule(selected.id, { expectedVersion: selected.version, ...body }));
      savedToast("Date changes saved.");
    }, "The date changes could not be saved.");
  };

  return (
    <Frame>
      <FrameHeader className="flex-row items-center gap-3">
        <PersonAvatar name={name} />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium">{name}</h3>
          <FrameDescription className="truncate text-xs">{title}</FrameDescription>
        </div>
        <BookingLimitsButton scope="practitioner" scopeId={practitionerId} label={name} />
      </FrameHeader>
      <FramePanel className="flex flex-col gap-4">
        {message ? <Alert variant="error"><AlertDescription>{message}</AlertDescription></Alert> : null}
        {conflict ? <ConflictNotice onReload={() => { setLoad({ state: "loading" }); setReloadKey((key) => key + 1); }} /> : null}
        {load.state === "loading" ? <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading schedules"><Skeleton className="h-11 w-full" /><Skeleton className="h-40 w-full" /></div> : null}
        {load.state === "error" ? (
          <Alert variant="error"><AlertDescription className="flex flex-wrap items-center justify-between gap-3">{load.message}<Button size="sm" variant="outline" onClick={() => { setLoad({ state: "loading" }); setReloadKey((key) => key + 1); }}>Try again</Button></AlertDescription></Alert>
        ) : null}
        {load.state === "ready" && schedules.length === 0 ? (
          <p className="text-sm text-muted-foreground">{name} has no working hours yet. Add a schedule to start.</p>
        ) : null}
        {load.state === "ready" ? (
          <div className="flex items-end gap-2">
            {schedules.length > 0 ? (
              <div className="min-w-0 flex-1">
                <SelectField label="Schedule" value={selectedId} onValueChange={(value) => { setSelectedId(value); setDraft(null); }} options={schedules.map((entry) => ({ value: entry.id, label: entry.isDefault ? `${entry.name} (default)` : entry.name }))} />
              </div>
            ) : null}
            <Menu>
              <MenuTrigger render={<Button variant="outline" size="icon-lg" aria-label={`More for ${name}'s schedules`} disabled={saving} />}><Ellipsis aria-hidden="true" /></MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={() => { setNameMode("create"); setNameValue(""); }}>New schedule…</MenuItem>
                {selected ? (
                  <>
                    <MenuItem onClick={() => { setNameMode("rename"); setNameValue(selected.name); }}>Rename…</MenuItem>
                    <MenuItem onClick={() => { setNameMode("copy"); setNameValue(`${selected.name} (copy)`); }}>Copy…</MenuItem>
                    <MenuItem disabled={selected.isDefault} onClick={() => void run(async () => { replace(await updateSchedule(selected.id, { expectedVersion: selected.version, isDefault: true })); savedToast(`${selected.name} is now the default.`); }, "Could not change the default.")}>Make default</MenuItem>
                    <MenuSeparator />
                    <MenuItem variant="destructive" disabled={selected.isDefault} onClick={() => void run(async () => { await deleteSchedule(selected.id); setLoad({ state: "ready", schedules: schedules.filter((entry) => entry.id !== selected.id) }); setSelectedId(""); savedToast("Schedule deleted."); }, "The schedule could not be deleted.")}>Delete</MenuItem>
                  </>
                ) : null}
              </MenuPopup>
            </Menu>
          </div>
        ) : null}
        {nameMode ? (
          <form className="flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); if (nameValue.trim()) void submitName(); }}>
            <div className="min-w-0 flex-1"><TextField label={nameMode === "rename" ? "New name" : nameMode === "copy" ? "Name for the copy" : "Schedule name"} value={nameValue} maxLength={80} autoFocus onChange={(event) => setNameValue(event.target.value)} /></div>
            <Button type="submit" size="lg" disabled={saving || !nameValue.trim()}>Save</Button>
            <Button type="button" variant="ghost" size="lg" onClick={() => setNameMode(null)}>Cancel</Button>
          </form>
        ) : null}
        {selected && current ? (
          <>
            <div className="max-w-sm">
              <SelectField label="Timezone" hint="The clock these times are read on." value={current.timezone} onValueChange={(zone) => setDraft({ ...current, timezone: zone })} options={timezoneOptions([current.timezone])} />
            </div>
            <WeeklyRangesEditor value={current.weekly} disabled={saving} onChange={(weekly) => setDraft({ ...current, weekly })} />
            <h4 className="pt-2 text-sm font-semibold">Different hours on certain dates</h4>
            <ScheduleOverrides
              overrides={current.overrides}
              today={clinicDateKey(new Date().toISOString())}
              disabled={saving || dirty}
              saving={saving}
              onApply={(dates, ranges) => changeOverrides({ overrides: dates.map((date) => ({ date, ranges })) })}
              onRemove={(date) => changeOverrides({ removeOverrideDates: [date] })}
            />
            {dirty ? <p className="text-xs text-muted-foreground">Save the weekly hours first, then change dates.</p> : null}
          </>
        ) : null}
      </FramePanel>
      {selected ? (
        <FrameFooter className="flex items-center justify-end gap-2">
          {issue ? <p role="alert" className="mr-auto text-xs text-destructive-foreground">{issue}</p> : null}
          <Button disabled={saving || Boolean(issue) || !(dirty || current?.timezone !== selected.timezone)} onClick={() => void saveWeekly()}>
            {saving ? <Spinner aria-hidden="true" /> : null}
            {saving ? "Saving…" : "Save hours"}
          </Button>
        </FrameFooter>
      ) : null}
    </Frame>
  );
}

