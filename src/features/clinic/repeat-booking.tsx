"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarOff, CircleCheck, Repeat, RotateCw, TriangleAlert } from "lucide-react";

import { DateField } from "@/components/date-picker";
import { OptionSelect, SelectField, TextField } from "@/components/form-fields";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty";
import { Frame, FrameFooter, FrameHeader, FramePanel } from "@/components/ui/frame";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import { TogglePrimitive } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem, ToggleGroupPrimitive } from "@/components/ui/toggle-group";
import { useTerms } from "@/features/terms/business-profile-context";
import type { SeriesPreview, SeriesPreviewVisit, SeriesSaveResult } from "@/lib/series-contracts";
import type { RepeatRule } from "@/lib/series-rule";

import {
  bookedCount, draftSummary, draftToRule, intervalUnit, keepValidAnswers, repeatModes, resolutionsFrom, shownWeekdays, unresolvedCount, weekdayChoices,
  type Answer, type Answers, type RepeatDraft, type RepeatMode,
} from "./repeat-model";
import { previewNewSeries, saveNewSeries, type SeriesBookingBody } from "./series-api";

const dayFormat = (timeZone: string) => new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone });
const timeFormat = (timeZone: string) => new Intl.DateTimeFormat("en-IN", { hour: "numeric", minute: "2-digit", timeZone });

/**
 * The "Repeat" control on the new booking screen (feature 17): how it repeats, on which days, and when it stops, with a
 * plain sentence underneath that says what will be booked. Nothing is checked or saved until the next step.
 */
export function RepeatControl({ draft, onChange, startsOn, time }: { draft: RepeatDraft; onChange: (next: RepeatDraft) => void; startsOn: string; time: string | null }) {
  const t = useTerms();
  const result = draftToRule(draft, startsOn);
  const summary = time ? draftSummary(draft, startsOn, time, { visit: t.visit, visits: t.visits }) : "Choose an opening below to see when it repeats.";
  const repeating = draft.mode !== "none";
  const unit = repeating ? intervalUnit[draft.mode as Exclude<RepeatMode, "none">] : null;
  const weekdays = shownWeekdays(draft, startsOn);
  return (
    <Frame>
      <FrameHeader className="px-3 py-2"><h2 className="text-sm font-medium">Repeat</h2></FrameHeader>
      <FramePanel className="flex flex-col gap-4 p-4">
        <SelectField
          label={`Repeat this ${t.appointment}`}
          value={draft.mode}
          onValueChange={(next) => onChange({ ...draft, mode: next as RepeatMode, interval: 1, weekdays: [] })}
          options={repeatModes}
        />
        {repeating && unit ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label={`Every how many ${unit.many}`}
                type="number" inputMode="numeric" min={1} max={unit.max}
                value={String(draft.interval)}
                onChange={(event) => onChange({ ...draft, interval: Number(event.target.value) })}
              />
              <div className="flex flex-col gap-2">
                <span id="repeat-end-label" className="font-medium text-base/4.5 sm:text-sm/4">Stops</span>
                <SegmentedControl className="w-full sm:w-fit" render={<ToggleGroupPrimitive aria-labelledby="repeat-end-label" value={[draft.endKind]} onValueChange={(next: string[]) => { const value = next[0]; if (value === "count" || value === "until") onChange({ ...draft, endKind: value }); }} />}>
                  <SegmentedControlItem className="grow" render={<TogglePrimitive value="count" />}>After some times</SegmentedControlItem>
                  <SegmentedControlItem className="grow" render={<TogglePrimitive value="until" />}>On a date</SegmentedControlItem>
                </SegmentedControl>
              </div>
            </div>
            {draft.mode === "weekly" ? (
              <div className="flex flex-col gap-2">
                <span id="repeat-days-label" className="font-medium text-base/4.5 sm:text-sm/4">On these days</span>
                <ToggleGroup aria-labelledby="repeat-days-label" multiple variant="outline" className="flex-wrap" value={weekdays.map(String)} onValueChange={(next: string[]) => onChange({ ...draft, weekdays: next.map(Number).sort((a, b) => a - b) })}>
                  {weekdayChoices.map((day) => <ToggleGroupItem key={day.value} value={String(day.value)} className="min-w-11">{day.label}<span className="sr-only">{day.name.slice(day.label.length)}</span></ToggleGroupItem>)}
                </ToggleGroup>
              </div>
            ) : null}
            {draft.endKind === "count"
              ? <TextField label="How many times" type="number" inputMode="numeric" min={2} max={52} value={String(draft.count)} onChange={(event) => onChange({ ...draft, count: Number(event.target.value) })} hint="Up to 52 times, or 12 months." />
              : <DateField label="Last day" value={draft.until} onValueChange={(next) => onChange({ ...draft, until: next })} />}
            {result && "error" in result
              ? <p role="alert" className="flex items-center gap-2 text-sm text-destructive-foreground"><TriangleAlert aria-hidden="true" className="size-4 shrink-0" />{result.error}</p>
              : <p role="status" className="flex items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm"><Repeat aria-hidden="true" className="size-4 shrink-0 text-primary" /><span className={time ? "font-medium" : "text-muted-foreground"}>{summary}</span></p>}
          </>
        ) : <p className="text-sm text-muted-foreground">Turn this on to book the same {t.appointment} again on a rule, such as every Tuesday for eight weeks.</p>}
      </FramePanel>
    </Frame>
  );
}

/** Every visit of a series with its answer to a clash: skip it, or move it to another time that day. */
export function VisitChecklist({ preview, answers, onAnswer, disabled }: { preview: SeriesPreview; answers: Answers; onAnswer: (index: number, answer: Answer | null) => void; disabled?: boolean }) {
  const t = useTerms();
  const day = dayFormat(preview.timezone);
  const time = timeFormat(preview.timezone);
  return (
    <ol aria-label={`Every ${t.visit} in the series`} className="flex flex-col gap-2">
      {preview.visits.map((visit) => <VisitRow key={visit.index} visit={visit} answer={answers[visit.index]} onAnswer={onAnswer} day={day} time={time} disabled={disabled} />)}
    </ol>
  );
}

function VisitRow({ visit, answer, onAnswer, day, time, disabled }: { visit: SeriesPreviewVisit; answer: Answer | undefined; onAnswer: (index: number, answer: Answer | null) => void; day: Intl.DateTimeFormat; time: Intl.DateTimeFormat; disabled?: boolean }) {
  const when = `${day.format(new Date(visit.startsAt))}, ${time.format(new Date(visit.startsAt))}`;
  const value = !answer ? "" : answer.action === "skip" ? "skip" : answer.startsAt;
  return (
    <li className="flex flex-col gap-2 rounded-lg border px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium tabular-nums"><span className="me-2 text-xs font-normal text-muted-foreground">{visit.index}</span>{when}</p>
        {visit.state === "free"
          ? <StatusBadge tone="success">Free</StatusBadge>
          : answer ? <StatusBadge tone="attention">{answer.action === "skip" ? "Skipped" : `Moved to ${time.format(new Date(answer.startsAt))}`}</StatusBadge> : <StatusBadge tone="danger">{visit.reasonLabel ?? "Not available"}</StatusBadge>}
      </div>
      {visit.state === "clash" ? (
        <div className="flex flex-col gap-1">
          {answer ? <p className="text-xs text-muted-foreground">Clash: {visit.reasonLabel ?? "Not available"}.</p> : null}
          <OptionSelect
            size="default" disabled={disabled} value={value} aria-label={`What to do about ${when}`} placeholder="Choose what to do"
            onValueChange={(next) => onAnswer(visit.index, next === "" ? null : next === "skip" ? { action: "skip" } : { action: "move", startsAt: next })}
            options={[
              { value: "skip", label: "Skip this one" },
              ...visit.alternatives.map((slot) => ({ value: slot.startsAt, label: `Move to ${time.format(new Date(slot.startsAt))}` })),
            ]}
          />
          {visit.alternatives.length === 0 ? <p className="text-xs text-muted-foreground">No other time is free that day, so it can only be skipped.</p> : null}
        </div>
      ) : null}
    </li>
  );
}

type Loaded = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; preview: SeriesPreview };

/**
 * The step before saving: every visit checked, each clash answered, then one button that books them all in one action.
 * When something changed since the check, nothing is saved and the list comes back as it is now.
 */
export function RepeatReview({ booking, rule, summary, onSaved, onBack }: {
  booking: SeriesBookingBody;
  rule: RepeatRule;
  summary: string;
  onSaved: (result: Extract<SeriesSaveResult, { saved: true }>) => void;
  onBack: () => void;
}) {
  const t = useTerms();
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const [answers, setAnswers] = useState<Answers>({});
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const key = useRef(crypto.randomUUID());
  const bookingRef = useRef(booking);
  const ruleRef = useRef(rule);

  const run = useCallback(() => {
    previewNewSeries(bookingRef.current, ruleRef.current)
      .then((preview) => { setLoaded({ state: "ready", preview }); })
      .catch((cause: unknown) => setLoaded({ state: "error", message: cause instanceof Error ? cause.message : "The dates could not be checked." }));
  }, []);
  useEffect(() => { run(); }, [run]);
  const check = () => { setLoaded({ state: "loading" }); run(); };

  const preview = loaded.state === "ready" ? loaded.preview : null;
  const open = preview ? unresolvedCount(answers, preview) : 0;
  const total = preview ? bookedCount(answers, preview) : 0;

  function answer(index: number, next: Answer | null) {
    key.current = crypto.randomUUID();
    setNotice("");
    setAnswers((current) => {
      const copy = { ...current };
      if (next) copy[index] = next; else delete copy[index];
      return copy;
    });
  }

  async function save() {
    if (!preview) return;
    setSaving(true);
    try {
      const result = await saveNewSeries(booking, rule, resolutionsFrom(answers, preview), key.current);
      if (result.saved) { onSaved(result); return; }
      // Nothing was saved. Show the list as it is now and keep the answers that still apply.
      key.current = crypto.randomUUID();
      setAnswers((current) => keepValidAnswers(current, result.preview));
      setLoaded({ state: "ready", preview: result.preview });
      setNotice(`Something changed while you were choosing, so nothing was booked. Check the list again.`);
    } catch (cause: unknown) {
      setNotice(cause instanceof Error ? cause.message : `Could not book these ${t.appointments}. Try again.`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Frame className="min-w-0">
      <FrameHeader className="px-3 py-2">
        <h2 className="text-sm font-medium">Check every {t.visit}</h2>
        <p className="text-xs text-muted-foreground">{summary}</p>
      </FrameHeader>
      <FramePanel className="flex flex-col gap-3 p-4">
        {notice ? <Alert variant="warning"><TriangleAlert aria-hidden="true" /><AlertDescription>{notice}</AlertDescription></Alert> : null}
        {loaded.state === "loading" ? (
          <div role="status" className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">Checking every date…</p>
            <div aria-hidden="true" className="flex flex-col gap-2">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-12" />)}</div>
          </div>
        ) : null}
        {loaded.state === "error" ? (
          <Alert variant="error">
            <TriangleAlert aria-hidden="true" />
            <AlertDescription className="flex flex-wrap items-center justify-between gap-2"><span>{loaded.message}</span><Button size="xs" variant="outline" onClick={check}><RotateCw aria-hidden="true" /> Try again</Button></AlertDescription>
          </Alert>
        ) : null}
        {preview && preview.visits.length === 0 ? (
          <Empty className="p-4"><EmptyHeader><EmptyMedia variant="icon"><CalendarOff aria-hidden="true" /></EmptyMedia><EmptyDescription>This rule does not make any dates. Go back and change it.</EmptyDescription></EmptyHeader></Empty>
        ) : null}
        {preview && preview.visits.length > 0 ? (
          <>
            <p aria-live="polite" className="flex items-center gap-2 text-sm">
              {preview.clashCount === 0 ? <><CircleCheck aria-hidden="true" className="size-4 text-success-foreground" /> Every date is free.</> : <><TriangleAlert aria-hidden="true" className="size-4 text-warning-foreground" /> {preview.freeCount} of {preview.visits.length} are free. {open > 0 ? `Choose what to do about ${open === 1 ? "the clash" : `the ${open} clashes`}.` : "All clashes are settled."}</>}
            </p>
            {preview.capped ? <p className="text-xs text-muted-foreground">A series can run for 52 {t.visits} or 12 months, so the list stops here.</p> : null}
            <VisitChecklist preview={preview} answers={answers} onAnswer={answer} disabled={saving} />
          </>
        ) : null}
      </FramePanel>
      <FrameFooter className="flex flex-row flex-wrap justify-between gap-2 px-3 py-2">
        <Button variant="outline" onClick={onBack} disabled={saving}>Back</Button>
        <Button onClick={() => void save()} loading={saving} disabled={!preview || open > 0 || total === 0}>{total > 0 ? `Book ${total} ${total === 1 ? t.appointment : t.appointments}` : `Book ${t.appointments}`}</Button>
      </FrameFooter>
    </Frame>
  );
}
