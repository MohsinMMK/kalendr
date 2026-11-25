"use client";

import { useId, useMemo, useState, type ReactNode } from "react";
import { CalendarOff, Ellipsis, Pencil, UsersRound } from "lucide-react";

import { DatePicker } from "@/components/date-picker";
import { SelectField, TextField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { PersonAvatar } from "@/components/person-avatar";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Frame, FrameDescription, FrameFooter, FrameHeader, FramePanel } from "@/components/ui/frame";
import { TimePicker } from "@/components/reui/time-picker";
import { Label } from "@/components/ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import { timingSummary, type TimingResult } from "@/lib/timing-automation";
import {
  groupRulesIntoWindows,
  windowsShareHours,
  type WorkingHourWindow,
} from "@/lib/working-hours";

import { AvailabilityExtras } from "./availability-extras";
import { useCatalogLookups } from "./clinic-catalog";
import { appointmentDateTime, appointmentTime } from "./clinic-format";
import { addClinicDays, clinicDateKey, clinicDateTime, clinicTimeMinutes } from "./schedule-availability";
import { staffMutation, useOptionalStaffSnapshot } from "./staff-snapshot-provider";

const weekDays = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 7, label: "Sun" },
];


function clockLabel(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  if (hours === undefined || minutes === undefined || Number.isNaN(hours) || Number.isNaN(minutes)) return value;
  return `${hours % 12 || 12}:${String(minutes).padStart(2, "0")} ${hours < 12 ? "am" : "pm"}`;
}

export interface ClosedTimeForm {
  date: string;
  allDay: boolean;
  start: string;
  end: string;
}

function clockFromMinutes(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** Turns a saved closed time back into the form's fields, or null when it spans days and the form cannot show it. */
export function closedTimeFormFor(block: { startsAt: string; endsAt: string }): ClosedTimeForm | null {
  const date = clinicDateKey(block.startsAt);
  const startMinutes = clinicTimeMinutes(block.startsAt);
  const endDate = clinicDateKey(block.endsAt);
  const endMinutes = clinicTimeMinutes(block.endsAt);
  if (startMinutes === 0 && endMinutes === 0 && endDate === addClinicDays(date, 1)) {
    return { date, allDay: true, start: "09:00", end: "13:00" };
  }
  if (endDate !== date) return null;
  return { date, allDay: false, start: clockFromMinutes(startMinutes), end: clockFromMinutes(endMinutes) };
}

/** The times the closed-time API takes for the form's fields. */
export function closedTimeRange(form: ClosedTimeForm) {
  return form.allDay
    ? { startsAt: clinicDateTime(form.date, "00:00"), endsAt: clinicDateTime(addClinicDays(form.date, 1), "00:00") }
    : { startsAt: clinicDateTime(form.date, form.start), endsAt: clinicDateTime(form.date, form.end) };
}

function saved(title: string) {
  toastManager.add({ title, type: "success" });
}

/** A compact from–to pair; each input carries its own accessible name. */
function TimeRange({ startLabel, endLabel, start, end, onStart, onEnd }: {
  startLabel: string;
  endLabel: string;
  start: string;
  end: string;
  onStart: (value: string) => void;
  onEnd: (value: string) => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <TimePicker aria-label={startLabel} className="min-w-0 flex-1" hourCycle={12} minuteStep={5} value={start || null} onValueChange={(next) => next && onStart(next)} />
      <span aria-hidden="true" className="text-xs text-muted-foreground">to</span>
      <TimePicker aria-label={endLabel} className="min-w-0 flex-1" hourCycle={12} minuteStep={5} value={end || null} onValueChange={(next) => next && onEnd(next)} />
    </div>
  );
}

/** One label + description + Switch row, with an optional control beneath on narrow screens. */
function SwitchRow({ label, detail, checked, onCheckedChange, children }: {
  label: string;
  detail?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
      <div className="flex min-w-48 flex-1 items-center justify-between gap-4">
        <div className="min-w-0">
          <Label htmlFor={id} className="font-medium">{label}</Label>
          {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
        </div>
        <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
      </div>
      {children ? <div className="w-full sm:w-72">{children}</div> : null}
    </div>
  );
}

export function AvailabilitySettings() {
  const catalog = useCatalogLookups();
  const staff = useOptionalStaffSnapshot();
  const [pendingId, setPendingId] = useState("");
  const [message, setMessage] = useState("");
  const t = useTerms();
  const hoursByPractitioner = useMemo(() => {
    const grouped = new Map<string, WorkingHourWindow[]>();
    for (const person of catalog.practitioners) {
      grouped.set(person.id, groupRulesIntoWindows(
        (staff?.snapshot?.availability ?? []).filter((rule) => rule.practitionerId === person.id),
      ));
    }
    return grouped;
  }, [catalog.practitioners, staff?.snapshot?.availability]);

  if (!catalog.database) return null;

  return (
    <div className="flex flex-col gap-4">
      {message ? (
        <Alert variant="error">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
      {catalog.practitioners.map((person) => (
        <PractitionerHours
          key={`${person.id}-${JSON.stringify(hoursByPractitioner.get(person.id) ?? [])}`}
          practitionerId={person.id}
          name={person.name}
          title={person.isActive === false ? `${person.title} · not bookable` : person.title}
          windows={hoursByPractitioner.get(person.id) ?? []}
          pending={pendingId === person.id}
          onSave={async (hours) => {
            setPendingId(person.id);
            setMessage("");
            try {
              const result = await staffMutation<{ timing?: TimingResult }>(`/api/staff/team/practitioners/${person.id}`, "PATCH", { hours });
              await staff?.refresh();
              saved(`Hours saved for ${person.name}. ${timingSummary(result.timing ?? { moved: [], unresolved: [] })}`);
            } catch (cause: unknown) {
              setMessage(cause instanceof Error ? cause.message : "Could not save hours.");
            } finally {
              setPendingId("");
            }
          }}
        />
      ))}
      {catalog.practitioners.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><UsersRound aria-hidden="true" /></EmptyMedia>
            <EmptyTitle>No {t.practitioners} yet</EmptyTitle>
            <EmptyDescription>Add {t.aPractitioner} on the {t.Practitioners} page before setting hours.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      <AvailabilityExtras />
      <ClosedTimeEditor
        pending={pendingId === "block"}
        onMessage={setMessage}
        onPending={(pending) => setPendingId(pending ? "block" : "")}
      />
    </div>
  );
}

function PractitionerHours({
  practitionerId,
  name,
  title,
  windows,
  pending,
  onSave,
}: {
  practitionerId: string;
  name: string;
  title: string;
  windows: WorkingHourWindow[];
  pending: boolean;
  onSave: (hours: Record<string, unknown>) => Promise<void>;
}) {
  const shared = windowsShareHours(windows);
  const first = windows[0];
  const [days, setDays] = useState(windows.map((window) => window.dayOfWeek));
  const [sameHours, setSameHours] = useState(shared);
  const [start, setStart] = useState(first?.startsAtLocal ?? "09:00");
  const [end, setEnd] = useState(first?.endsAtLocal ?? "17:00");
  const [lunch, setLunch] = useState(Boolean(first?.breakStartsAtLocal));
  const [lunchStart, setLunchStart] = useState(first?.breakStartsAtLocal ?? "13:00");
  const [lunchEnd, setLunchEnd] = useState(first?.breakEndsAtLocal ?? "14:00");
  const [perDay, setPerDay] = useState<Record<number, { start: string; end: string }>>(
    Object.fromEntries(windows.map((window) => [window.dayOfWeek, { start: window.startsAtLocal, end: window.endsAtLocal }])),
  );

  function toggleDay(day: number, checked: boolean) {
    setDays((current) => checked ? [...current, day].sort() : current.filter((value) => value !== day));
    if (checked) {
      setPerDay((current) => ({ ...current, [day]: current[day] ?? { start, end } }));
    }
  }

  return (
    <Frame>
      <FrameHeader className="flex-row items-center gap-3">
        <PersonAvatar name={name} />
        <div className="min-w-0">
          <h3 className="truncate text-sm font-medium">{name}</h3>
          <FrameDescription className="truncate text-xs">{title}</FrameDescription>
        </div>
      </FrameHeader>
      <FramePanel className="flex flex-col divide-y py-1">
        <SwitchRow
          label="Same hours on selected days"
          detail="Turn off to set different times for each day."
          checked={sameHours}
          onCheckedChange={setSameHours}
        >
          {sameHours ? (
            <TimeRange startLabel="Starts" endLabel="Ends" start={start} end={end} onStart={setStart} onEnd={setEnd} />
          ) : null}
        </SwitchRow>
        {weekDays.map((day) => {
          const open = days.includes(day.value);
          const times = perDay[day.value] ?? { start, end };
          const switchId = `${practitionerId}-day-${day.value}`;
          return (
            <div key={switchId} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-2.5">
              <div className="flex min-w-24 flex-1 items-center gap-3">
                <Switch id={switchId} checked={open} onCheckedChange={(checked) => toggleDay(day.value, checked)} />
                <Label htmlFor={switchId} className="font-medium">{day.label}</Label>
              </div>
              {!open ? (
                <p className="text-xs text-muted-foreground">Closed</p>
              ) : sameHours ? (
                <p className="text-xs text-muted-foreground tabular-nums">{clockLabel(start)} to {clockLabel(end)}</p>
              ) : (
                <div className="w-full sm:w-72">
                  <TimeRange
                    startLabel={`${day.label} starts`}
                    endLabel={`${day.label} ends`}
                    start={times.start}
                    end={times.end}
                    onStart={(value) => setPerDay((current) => ({ ...current, [day.value]: { ...times, start: value } }))}
                    onEnd={(value) => setPerDay((current) => ({ ...current, [day.value]: { ...times, end: value } }))}
                  />
                </div>
              )}
            </div>
          );
        })}
        <SwitchRow label="Lunch break" detail="Hides openings during this time." checked={lunch} onCheckedChange={setLunch}>
          {lunch ? (
            <TimeRange startLabel="Lunch starts" endLabel="Lunch ends" start={lunchStart} end={lunchEnd} onStart={setLunchStart} onEnd={setLunchEnd} />
          ) : null}
        </SwitchRow>
      </FramePanel>
      <FrameFooter className="flex justify-end">
        <Button disabled={pending || days.length === 0} onClick={() => {
          const includeSharedLunch = lunch && lunchStart > start && lunchEnd < end;
          const breakFields = includeSharedLunch ? { breakStartsAtLocal: lunchStart, breakEndsAtLocal: lunchEnd } : {};
          if (sameHours) {
            void onSave({ days, startsAtLocal: start, endsAtLocal: end, ...breakFields });
            return;
          }
          void onSave({
            windows: days.map((day) => {
              const times = perDay[day] ?? { start, end };
              const includeLunch = lunch && lunchStart > times.start && lunchEnd < times.end;
              return {
                dayOfWeek: day,
                startsAtLocal: times.start,
                endsAtLocal: times.end,
                ...(includeLunch ? { breakStartsAtLocal: lunchStart, breakEndsAtLocal: lunchEnd } : {}),
              };
            }),
          });
        }}>
          {pending ? <Spinner aria-hidden="true" /> : null}
          {pending ? "Saving…" : "Save hours"}
        </Button>
      </FrameFooter>
    </Frame>
  );
}

function ClosedTimeEditor({
  pending,
  onMessage,
  onPending,
}: {
  pending: boolean;
  onMessage: (value: string) => void;
  onPending: (pending: boolean) => void;
}) {
  const catalog = useCatalogLookups();
  const staff = useOptionalStaffSnapshot();
  const [date, setDate] = useState(clinicDateKey(new Date().toISOString()));
  const [allDay, setAllDay] = useState(true);
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("13:00");
  const [practitionerId, setPractitionerId] = useState("");
  const [reason, setReason] = useState("");
  const [editingId, setEditingId] = useState("");
  const blocks = staff?.snapshot?.scheduleBlocks ?? [];
  const t = useTerms();

  const editing = blocks.find((block) => block.id === editingId);

  function startEditing(block: (typeof blocks)[number], form: ClosedTimeForm) {
    setEditingId(block.id);
    setDate(form.date);
    setAllDay(form.allDay);
    if (!form.allDay) {
      setStart(form.start);
      setEnd(form.end);
    }
    setPractitionerId(block.practitionerId ?? "");
    setReason(block.reason ?? "");
    onMessage("");
  }

  function stopEditing() {
    setEditingId("");
    setReason("");
  }

  async function addBlock() {
    onPending(true);
    onMessage("");
    try {
      const { startsAt, endsAt } = closedTimeRange({ date, allDay, start, end });
      await staffMutation(editing ? `/api/staff/schedule-blocks/${editing.id}` : "/api/staff/schedule-blocks", editing ? "PATCH" : "POST", {
        startsAt,
        endsAt,
        practitionerId: practitionerId || null,
        locationId: editing?.locationId ?? null,
        reason,
      });
      await staff?.refresh();
      setReason("");
      setEditingId("");
      saved(editing ? "Closed time updated." : `Closed time saved. ${t.Customers} will not see those openings.`);
    } catch (cause: unknown) {
      onMessage(cause instanceof Error ? cause.message : "Could not save closed time.");
    } finally {
      onPending(false);
    }
  }

  return (
    <Frame>
      <FrameHeader>
        <h3 className="text-sm font-semibold">Closed days and leave</h3>
        <FrameDescription className="text-xs">Hide openings for a holiday, a half day, or {t.aPractitioner} who is away. Existing bookings stay; they still need a reschedule.</FrameDescription>
      </FrameHeader>
      <FramePanel className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="flex flex-col items-start gap-2">
            <Label htmlFor="block-date">Date</Label>
            <DatePicker id="block-date" size="lg" className="w-full" value={date} onValueChange={setDate} />
          </div>
          <SelectField
            label="Applies to"
            value={practitionerId}
            onValueChange={setPractitionerId}
            options={[
              { value: "", label: `Whole ${t.business}` },
              ...catalog.practitioners.map((person) => ({ value: person.id, label: person.name })),
            ]}
          />
          <TextField id="block-reason" label="Reason" optional value={reason} onChange={(event) => setReason(event.target.value)} />
        </div>
        <SwitchRow label="All day" checked={allDay} onCheckedChange={setAllDay}>
          {allDay ? null : (
            <TimeRange startLabel="From" endLabel="Until" start={start} end={end} onStart={setStart} onEnd={setEnd} />
          )}
        </SwitchRow>
        <div className="flex justify-end gap-2">
          {editing ? <Button variant="ghost" disabled={pending} onClick={stopEditing}>Cancel</Button> : null}
          <Button disabled={pending} onClick={() => void addBlock()}>
            {pending ? <Spinner aria-hidden="true" /> : null}
            {pending ? "Saving…" : editing ? "Save changes" : "Add closed time"}
          </Button>
        </div>
      </FramePanel>
      <FramePanel className="py-1">
        {blocks.length === 0 ? (
          <Empty className="py-6">
            <EmptyHeader>
              <EmptyMedia variant="icon"><CalendarOff aria-hidden="true" /></EmptyMedia>
              <EmptyDescription>No closed time yet.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="flex flex-col divide-y">
            {blocks.map((block) => {
              const person = block.practitionerId ? catalog.getPractitioner(block.practitionerId) : null;
              const form = closedTimeFormFor(block);
              return (
                <li key={block.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{person ? person.name : `Whole ${t.business}`}</p>
                    <p className="text-xs text-muted-foreground">
                      {appointmentDateTime(block.startsAt)} – {appointmentTime(block.endsAt)}
                      {block.reason ? ` · ${block.reason}` : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {form ? (
                      <Button variant="outline" size="sm" disabled={pending} aria-label={`Edit closed time on ${appointmentDateTime(block.startsAt)}`} onClick={() => startEditing(block, form)}>
                        <Pencil aria-hidden="true" />
                        Edit
                      </Button>
                    ) : null}
                    <Menu>
                      <MenuTrigger render={<Button variant="ghost" size="icon-sm" disabled={pending} aria-label={`More for closed time on ${appointmentDateTime(block.startsAt)}`} />}>
                        <Ellipsis aria-hidden="true" />
                      </MenuTrigger>
                      <MenuPopup align="end">
                        <MenuItem onClick={() => {
                          onPending(true);
                          onMessage("");
                          void (async () => {
                            try {
                              await staffMutation(`/api/staff/schedule-blocks/${block.id}`, "DELETE", {});
                              await staff?.refresh();
                              if (editingId === block.id) stopEditing();
                              saved("Closed time removed.");
                            } catch (cause: unknown) {
                              onMessage(cause instanceof Error ? cause.message : "Could not remove closed time.");
                            } finally {
                              onPending(false);
                            }
                          })();
                        }}>Remove</MenuItem>
                      </MenuPopup>
                    </Menu>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </FramePanel>
    </Frame>
  );
}
