"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2, Variable } from "lucide-react";

import { ActionMenuButton, type ActionMenuEntry } from "@/components/action-bar";
import { OptionSelect, SelectField, TextField, TextareaField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerDescription, DrawerFooter, DrawerHeader, DrawerPanel, DrawerPopup, DrawerTitle } from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useTerms } from "@/features/terms/business-profile-context";
import { deliveryModeLabels, deliveryModes, type DeliveryMode } from "@/lib/video-contracts";
import {
  MAX_STEPS,
  channelLabels,
  fillTemplate,
  templateKeysFor,
  templateVariables,
  triggerCatalogue,
  workflowChannelKeys,
  workflowInputSchema,
  workflowTemplateLabels,
  workflowTriggers,
  type WorkflowChannelKey,
  type WorkflowChannelStatus,
  type WorkflowFilters,
  type WorkflowInput,
  type WorkflowOptions,
  type WorkflowStepInput,
  type WorkflowTemplateKey,
  type WorkflowTrigger,
  type WorkflowView,
} from "@/lib/workflow-contracts";

/** What the server said was wrong with one field, keyed by path such as `steps.0.body`. */
export type FieldErrors = Record<string, string>;

/** Raised by the screen's request helper; the editor reads `fieldErrors` and `code`. */
export class WorkflowApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fieldErrors: FieldErrors;

  constructor(message: string, status = 0, code = "unknown", fieldErrors: FieldErrors = {}) {
    super(message);
    this.name = "WorkflowApiError";
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

interface DraftStep extends WorkflowStepInput {
  key: string;
}

interface Draft {
  name: string;
  trigger: WorkflowTrigger;
  offsetMinutes: number;
  filters: WorkflowFilters;
  active: boolean;
  steps: DraftStep[];
}

let stepCounter = 0;
const stepKey = () => `step-${(stepCounter += 1)}`;

function blankStep(channel: WorkflowChannelKey): DraftStep {
  return { key: stepKey(), channel, subject: "", body: "", templateKey: channel === "email" ? null : (templateKeysFor(channel)[0] ?? null), waitMinutes: 0, ignoreQuietHours: false, skipIfConfirmed: false };
}

function firstReadyChannel(options: WorkflowOptions): WorkflowChannelKey {
  return options.channels.find((channel) => channel.ready)?.key ?? "email";
}

function draftFor(workflow: WorkflowView | null, options: WorkflowOptions): Draft {
  if (!workflow) {
    return {
      name: "",
      trigger: "before_start",
      offsetMinutes: 1440,
      filters: { serviceIds: [], locationIds: [], practitionerIds: [], bookingSources: [], deliveryModes: [] },
      active: true,
      steps: [blankStep(firstReadyChannel(options))],
    };
  }
  return {
    name: workflow.name,
    trigger: workflow.trigger,
    offsetMinutes: workflow.offsetMinutes,
    filters: {
      serviceIds: [...workflow.filters.serviceIds],
      locationIds: [...workflow.filters.locationIds],
      practitionerIds: [...workflow.filters.practitionerIds],
      bookingSources: [...workflow.filters.bookingSources],
      deliveryModes: [...workflow.filters.deliveryModes],
    },
    active: workflow.active,
    steps: workflow.steps.map((step) => ({
      key: stepKey(),
      channel: step.channel,
      subject: step.subject,
      body: step.body,
      templateKey: step.templateKey,
      waitMinutes: step.waitMinutes,
      ignoreQuietHours: step.ignoreQuietHours,
      skipIfConfirmed: step.skipIfConfirmed,
    })),
  };
}

function toInput(draft: Draft): unknown {
  return {
    name: draft.name,
    trigger: draft.trigger,
    offsetMinutes: triggerCatalogue[draft.trigger].timed ? draft.offsetMinutes : 0,
    filters: draft.filters,
    active: draft.active,
    steps: draft.steps.map((step) => ({
      channel: step.channel,
      // WhatsApp and text steps send an approved message, so their own words are left out.
      subject: step.channel === "email" ? step.subject : "",
      body: step.channel === "email" ? step.body : "",
      templateKey: step.channel === "email" ? null : step.templateKey,
      waitMinutes: step.waitMinutes,
      ignoreQuietHours: step.ignoreQuietHours,
      skipIfConfirmed: step.skipIfConfirmed,
    })),
  };
}

/** Error messages keyed by zod path. The first message for a path wins. */
function checkDraft(draft: Draft): FieldErrors {
  const result = workflowInputSchema.safeParse(toInput(draft));
  if (result.success) return {};
  const errors: FieldErrors = {};
  for (const issue of result.error.issues) {
    const path = issue.path.join(".");
    errors[path] ??= issue.message;
  }
  return errors;
}

const exampleValues: Record<string, string> = Object.fromEntries(templateVariables.map((variable) => [variable.key, variable.example]));

const triggerOptions = workflowTriggers.map((key) => ({ value: key, label: triggerCatalogue[key].label }));

type Unit = "minutes" | "hours" | "days";
const unitSize: Record<Unit, number> = { minutes: 1, hours: 60, days: 1440 };
const unitOptions = [
  { value: "minutes", label: "minutes" },
  { value: "hours", label: "hours" },
  { value: "days", label: "days" },
];

function bestUnit(minutes: number): Unit {
  if (minutes > 2880 && minutes % 1440 === 0) return "days";
  if (minutes > 0 && minutes % 60 === 0) return "hours";
  return minutes === 0 ? "hours" : "minutes";
}

/** A number and a unit that together make a count of minutes. */
function DurationField({ label, hint, error, minutes, onChange, idPrefix }: {
  label: string;
  hint?: string;
  error?: string;
  minutes: number;
  onChange: (minutes: number) => void;
  idPrefix: string;
}) {
  const [unit, setUnit] = useState<Unit>(() => bestUnit(minutes));
  const [text, setText] = useState(() => String(minutes / unitSize[bestUnit(minutes)]));
  const inputId = `${idPrefix}-amount`;
  const noteId = `${idPrefix}-note`;

  function commit(nextText: string, nextUnit: Unit) {
    setText(nextText);
    const amount = Number.parseInt(nextText, 10);
    onChange(Number.isFinite(amount) && amount >= 0 ? amount * unitSize[nextUnit] : 0);
  }

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={inputId}>{label}</Label>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,9rem)] gap-2">
        <Input
          id={inputId}
          size="lg"
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          value={text}
          onChange={(event) => commit(event.target.value, unit)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? noteId : undefined}
        />
        <OptionSelect
          aria-label={`${label}: unit`}
          value={unit}
          onValueChange={(next) => {
            const nextUnit = next as Unit;
            setUnit(nextUnit);
            commit(text, nextUnit);
          }}
          options={unitOptions}
        />
      </div>
      {error ? <p id={noteId} className="text-xs text-destructive-foreground">{error}</p> : hint ? <p id={noteId} className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** Pick any number of things. Nothing picked means all of them. */
function MultiPick({ label, allLabel, options, value, onChange, disabled }: {
  label: string;
  allLabel: string;
  options: { id: string; name: string }[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const names = new Map(options.map((option) => [option.id, option.name]));
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Select
        multiple
        value={value}
        onValueChange={(next) => onChange(next as string[])}
        items={options.map((option) => ({ value: option.id, label: option.name }))}
        disabled={disabled || options.length === 0}
      >
        <SelectTrigger id={id} size="lg">
          <SelectValue>
            {(selected: string[]) => (selected.length === 0 ? allLabel : selected.map((item) => names.get(item) ?? item).join(", "))}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {options.map((option) => <SelectItem key={option.id} value={option.id}>{option.name}</SelectItem>)}
        </SelectPopup>
      </Select>
    </div>
  );
}

function channelOptions(statuses: WorkflowChannelStatus[], current: WorkflowChannelKey) {
  const known = new Map(statuses.map((status) => [status.key, status]));
  return workflowChannelKeys.map((key) => {
    const status = known.get(key);
    const ready = status ? status.ready : key === current;
    const label = status?.label ?? channelLabels[key];
    // A step already saved on a channel that is not ready stays selectable so it can be seen and moved.
    const selectable = ready || key === current;
    return {
      value: key,
      label: ready ? label : `${label} (not ready)`,
      disabled: !selectable,
      reason: ready ? "" : status?.reason || "This channel is not set up yet.",
    };
  });
}

function StepEditor({ step, index, count, errors, options, idPrefix, onChange, onMove, onRemove }: {
  step: DraftStep;
  index: number;
  count: number;
  errors: FieldErrors;
  options: WorkflowOptions;
  idPrefix: string;
  onChange: (patch: Partial<WorkflowStepInput>) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}) {
  const t = useTerms();
  const base = `steps.${index}`;
  const number = index + 1;
  const id = `${idPrefix}-step-${step.key}`;
  const channels = channelOptions(options.channels, step.channel);
  const currentChannel = channels.find((channel) => channel.value === step.channel);
  const isEmail = step.channel === "email";

  function insert(key: string) {
    const area = document.getElementById(`${id}-body`) as HTMLTextAreaElement | null;
    const start = area?.selectionStart ?? step.body.length;
    const end = area?.selectionEnd ?? step.body.length;
    const text = `{${key}}`;
    onChange({ body: `${step.body.slice(0, start)}${text}${step.body.slice(end)}` });
    requestAnimationFrame(() => {
      area?.focus();
      area?.setSelectionRange(start + text.length, start + text.length);
    });
  }

  const insertItems: ActionMenuEntry[] = templateVariables.map((variable) => ({
    id: variable.key,
    label: variable.label,
    hint: `{${variable.key}}`,
    onSelect: () => insert(variable.key),
  }));

  const previewBody = fillTemplate(step.body, exampleValues);
  const previewSubject = fillTemplate(step.subject, exampleValues);

  return (
    <li className="flex flex-col gap-4 rounded-xl border p-3 sm:p-4" aria-labelledby={`${id}-heading`}>
      <div className="flex flex-nowrap items-center justify-between gap-2">
        <h4 id={`${id}-heading`} className="min-w-0 truncate font-medium text-sm">Message {number}</h4>
        <div className="flex shrink-0 items-center gap-1">
          <Button type="button" variant="ghost" size="icon" aria-label={`Move message ${number} up`} disabled={index === 0} onClick={() => onMove(-1)}>
            <ArrowUp aria-hidden="true" />
          </Button>
          <Button type="button" variant="ghost" size="icon" aria-label={`Move message ${number} down`} disabled={index === count - 1} onClick={() => onMove(1)}>
            <ArrowDown aria-hidden="true" />
          </Button>
          <Button type="button" variant="ghost" size="icon" aria-label={`Remove message ${number}`} disabled={count <= 1} onClick={onRemove}>
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${id}-channel`}>How to send message {number}</Label>
        <OptionSelect
          id={`${id}-channel`}
          value={step.channel}
          onValueChange={(next) => {
            const channel = next as WorkflowChannelKey;
            const allowed = templateKeysFor(channel);
            onChange({ channel, ...(channel === "email" ? { templateKey: null } : { subject: "", templateKey: step.templateKey && allowed.includes(step.templateKey) ? step.templateKey : (allowed[0] ?? null) }) });
          }}
          options={channels}
        />
        {currentChannel?.reason ? <p className="text-xs text-muted-foreground">{currentChannel.reason}</p> : null}
        {channels.some((channel) => channel.disabled) ? (
          <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            {channels.filter((channel) => channel.disabled).map((channel) => (
              <li key={channel.value}>{channelLabels[channel.value]}: {channel.reason}</li>
            ))}
          </ul>
        ) : null}
        {errors[`${base}.channel`] ? <p className="text-xs text-destructive-foreground">{errors[`${base}.channel`]}</p> : null}
      </div>

      {!isEmail ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-template`}>Which message to send in message {number}</Label>
          <OptionSelect
            id={`${id}-template`}
            value={step.templateKey ?? ""}
            onValueChange={(next) => onChange({ templateKey: (next || null) as WorkflowTemplateKey | null })}
            options={templateKeysFor(step.channel).map((key) => ({ value: key, label: workflowTemplateLabels[key].label }))}
            placeholder="Choose a message"
          />
          {step.templateKey ? <p className="text-xs text-muted-foreground">{workflowTemplateLabels[step.templateKey].hint}</p> : null}
          <p className="text-xs text-muted-foreground">
            {channelLabels[step.channel]} messages use wording your provider has approved, so the text can&apos;t be changed here.
          </p>
          {errors[`${base}.templateKey`] ? <p className="text-xs text-destructive-foreground">{errors[`${base}.templateKey`]}</p> : null}
        </div>
      ) : null}

      {isEmail ? (
        <TextField
          id={`${id}-subject`}
          label={`Subject of message ${number}`}
          value={step.subject}
          onChange={(event) => onChange({ subject: event.target.value })}
          maxLength={200}
          error={errors[`${base}.subject`]}
        />
      ) : null}

      {isEmail ? (
      <div className="flex flex-col gap-2">
        <TextareaField
          id={`${id}-body`}
          label={`Words of message ${number}`}
          hint={`Use "Insert value" to put in the ${t.customer}'s name, the time and more.`}
          value={step.body}
          onChange={(event) => onChange({ body: event.target.value })}
          rows={5}
          maxLength={2000}
          error={errors[`${base}.body`]}
        />
        <div>
          <ActionMenuButton label="Insert value" icon={<Variable aria-hidden="true" />} items={insertItems} align="start" />
        </div>
        <div className="rounded-lg border bg-muted/40 p-3" role="group" aria-label={`Preview of message ${number}`}>
          <p className="mb-1 font-medium text-xs text-muted-foreground">Preview with example values</p>
          {isEmail && previewSubject ? <p className="break-words font-medium text-sm">{previewSubject}</p> : null}
          <p className="whitespace-pre-wrap break-words text-sm">{previewBody || <span className="text-muted-foreground">Nothing to preview yet.</span>}</p>
        </div>
      </div>
      ) : null}

      <DurationField
        idPrefix={`${id}-wait`}
        label={index === 0 ? "Wait before sending" : "Wait after the message before"}
        hint="0 means right away."
        minutes={step.waitMinutes}
        onChange={(waitMinutes) => onChange({ waitMinutes })}
        error={errors[`${base}.waitMinutes`]}
      />

      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Label htmlFor={`${id}-quiet`} className="font-medium">Send even in quiet hours</Label>
          <p className="text-xs text-muted-foreground">Turn on for messages that cannot wait.</p>
        </div>
        <Switch id={`${id}-quiet`} checked={step.ignoreQuietHours} onCheckedChange={(on) => onChange({ ignoreQuietHours: on })} />
      </div>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Label htmlFor={`${id}-skip`} className="font-medium">Skip if already confirmed</Label>
          <p className="text-xs text-muted-foreground">Does not send when the {t.customer} has confirmed.</p>
        </div>
        <Switch id={`${id}-skip`} checked={step.skipIfConfirmed} onCheckedChange={(on) => onChange({ skipIfConfirmed: on })} />
      </div>
    </li>
  );
}

const wide = "(min-width: 640px)";

/** Bottom sheet on phones, side panel on wider screens. */
function useDrawerPosition(): "bottom" | "right" {
  const isWide = useSyncExternalStore(
    (notify) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => undefined;
      const query = window.matchMedia(wide);
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(wide).matches : false),
    () => false,
  );
  return isWide ? "right" : "bottom";
}

export interface WorkflowEditorProps {
  /** The workflow being changed; null for a new one. */
  workflow: WorkflowView | null;
  options: WorkflowOptions;
  /** Sends the checked body. Throws a WorkflowApiError when the server refuses it. */
  onSave: (input: WorkflowInput, idempotencyKey: string) => Promise<void>;
  onClose: () => void;
  /** Called when someone else changed this workflow first, to load the latest. */
  onReload: () => void;
}

export function WorkflowEditor({ workflow, options, onSave, onClose, onReload }: WorkflowEditorProps) {
  const t = useTerms();
  const position = useDrawerPosition();
  const idPrefix = useId();
  const [draft, setDraft] = useState<Draft>(() => draftFor(workflow, options));
  const [showErrors, setShowErrors] = useState(false);
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [formMessage, setFormMessage] = useState("");
  const [conflict, setConflict] = useState(false);
  const [pending, setPending] = useState(false);
  const idempotencyKey = useRef<string>("");
  useEffect(() => { idempotencyKey.current = crypto.randomUUID(); }, []);

  const errors: FieldErrors = { ...(showErrors ? checkDraft(draft) : {}), ...serverErrors };
  const trigger = triggerCatalogue[draft.trigger];
  const timingLabel = trigger.direction === "before" ? "Time before the start" : "Time after it ends";
  const nothingReady = options.channels.length > 0 && options.channels.every((channel) => !channel.ready);

  function change(patch: Partial<Draft>) {
    setServerErrors({});
    setFormMessage("");
    setDraft((before) => ({ ...before, ...patch }));
  }

  function changeStep(index: number, patch: Partial<WorkflowStepInput>) {
    setServerErrors({});
    setFormMessage("");
    setDraft((before) => ({ ...before, steps: before.steps.map((step, at) => (at === index ? { ...step, ...patch } : step)) }));
  }

  function moveStep(index: number, by: -1 | 1) {
    setDraft((before) => {
      const target = index + by;
      if (target < 0 || target >= before.steps.length) return before;
      const steps = [...before.steps];
      [steps[index], steps[target]] = [steps[target]!, steps[index]!];
      return { ...before, steps };
    });
  }

  function changeFilters(patch: Partial<WorkflowFilters>) {
    change({ filters: { ...draft.filters, ...patch } });
  }

  function changeTrigger(next: WorkflowTrigger) {
    const timed = triggerCatalogue[next].timed;
    change({ trigger: next, offsetMinutes: timed ? (draft.offsetMinutes > 0 ? draft.offsetMinutes : 60) : 0 });
  }

  async function submit() {
    setShowErrors(true);
    setServerErrors({});
    setFormMessage("");
    const result = workflowInputSchema.safeParse(toInput(draft));
    if (!result.success) return;
    setPending(true);
    try {
      await onSave(result.data, idempotencyKey.current);
    } catch (cause: unknown) {
      setPending(false);
      if (cause instanceof WorkflowApiError) {
        if (cause.code === "version_conflict") {
          setConflict(true);
          return;
        }
        setServerErrors(cause.fieldErrors);
        setFormMessage(Object.keys(cause.fieldErrors).length > 0 ? "Check the highlighted fields and try again." : cause.message);
        return;
      }
      setFormMessage("This could not be saved. Try again.");
    }
  }

  const stepErrorSummary = errors.steps;
  const shownTiming = trigger.timed;

  return (
    <Drawer open onOpenChange={(open) => { if (!open && !pending) onClose(); }} position={position}>
      <DrawerPopup className="sm:max-w-xl" showCloseButton>
        <form
          noValidate
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DrawerHeader>
            <DrawerTitle>{workflow ? "Edit workflow" : "New workflow"}</DrawerTitle>
            <DrawerDescription>Say when to send, who it is for, and what to send.</DrawerDescription>
          </DrawerHeader>
          <DrawerPanel className="flex flex-col gap-5">
            {conflict ? (
              <Alert variant="warning" role="alert">
                <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
                  <span>Someone else changed this workflow while you were editing. Reload to see their version, then make your change again.</span>
                  <Button type="button" variant="outline" size="sm" onClick={onReload}>Reload</Button>
                </AlertDescription>
              </Alert>
            ) : null}
            {formMessage ? (
              <Alert variant="error" role="alert"><AlertDescription>{formMessage}</AlertDescription></Alert>
            ) : null}
            {nothingReady ? (
              <Alert role="note"><AlertDescription>No way of sending is ready yet. You can save this workflow, but nothing is sent until a channel is set up.</AlertDescription></Alert>
            ) : null}

            <TextField
              label="Name"
              hint="Only you see this."
              value={draft.name}
              onChange={(event) => change({ name: event.target.value })}
              maxLength={160}
              error={errors.name}
            />

            <SelectField
              label="When to send"
              hint={trigger.hint}
              value={draft.trigger}
              onValueChange={(next) => changeTrigger(next as WorkflowTrigger)}
              options={triggerOptions}
            />

            {shownTiming ? (
              <DurationField
                idPrefix={`${idPrefix}-offset`}
                label={timingLabel}
                hint={trigger.direction === "before" ? `For example, 24 hours before the ${t.appointment} starts.` : `For example, 2 hours after the ${t.appointment} ends.`}
                minutes={draft.offsetMinutes}
                onChange={(offsetMinutes) => change({ offsetMinutes })}
                error={errors.offsetMinutes}
              />
            ) : null}

            <fieldset className="flex flex-col gap-3 rounded-xl border p-3 sm:p-4">
              <legend className="px-1 font-medium text-sm">Only for…</legend>
              <p className="text-xs text-muted-foreground">Leave a list empty to include everything. Pick some to narrow it down.</p>
              <MultiPick label={t.Services} allLabel={`All ${t.services}`} options={options.services} value={draft.filters.serviceIds} onChange={(serviceIds) => changeFilters({ serviceIds })} />
              <MultiPick label={t.Locations} allLabel={`All ${t.locations}`} options={options.locations} value={draft.filters.locationIds} onChange={(locationIds) => changeFilters({ locationIds })} />
              <MultiPick label="People" allLabel="Everyone" options={options.practitioners} value={draft.filters.practitionerIds} onChange={(practitionerIds) => changeFilters({ practitionerIds })} />
              <MultiPick
                label="Where it was booked"
                allLabel="Any source"
                options={options.bookingSources.map((source) => ({ id: source.key, name: source.label }))}
                value={draft.filters.bookingSources}
                onChange={(bookingSources) => changeFilters({ bookingSources })}
              />
              <MultiPick
                label="Ways of meeting"
                allLabel="Any way"
                options={deliveryModes.map((mode) => ({ id: mode, name: deliveryModeLabels[mode] }))}
                value={draft.filters.deliveryModes}
                onChange={(next) => changeFilters({ deliveryModes: next.filter((mode): mode is DeliveryMode => (deliveryModes as readonly string[]).includes(mode)) })}
              />
            </fieldset>

            <section aria-labelledby={`${idPrefix}-steps`} className="flex flex-col gap-3">
              <div className="flex items-baseline justify-between gap-3">
                <h3 id={`${idPrefix}-steps`} className="font-medium text-sm">Messages</h3>
                <span className="text-xs text-muted-foreground">{draft.steps.length} of {MAX_STEPS}</span>
              </div>
              <ol className="flex flex-col gap-3">
                {draft.steps.map((step, index) => (
                  <StepEditor
                    key={step.key}
                    step={step}
                    index={index}
                    count={draft.steps.length}
                    errors={errors}
                    options={options}
                    idPrefix={idPrefix}
                    onChange={(patch) => changeStep(index, patch)}
                    onMove={(by) => moveStep(index, by)}
                    onRemove={() => change({ steps: draft.steps.filter((_, at) => at !== index) })}
                  />
                ))}
              </ol>
              {stepErrorSummary ? <p className="text-xs text-destructive-foreground">{stepErrorSummary}</p> : null}
              <div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={draft.steps.length >= MAX_STEPS}
                  onClick={() => change({ steps: [...draft.steps, blankStep(firstReadyChannel(options))] })}
                >
                  <Plus aria-hidden="true" /> Add a message
                </Button>
                {draft.steps.length >= MAX_STEPS ? <p className="mt-2 text-xs text-muted-foreground">A workflow can send up to {MAX_STEPS} messages.</p> : null}
              </div>
            </section>

            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <Label htmlFor={`${idPrefix}-active`} className="font-medium">Turned on</Label>
                <p className="text-xs text-muted-foreground">Turn it off to stop sending without losing it.</p>
              </div>
              <Switch id={`${idPrefix}-active`} checked={draft.active} onCheckedChange={(active) => change({ active })} />
            </div>
          </DrawerPanel>
          <DrawerFooter>
            <Button type="button" variant="ghost" onClick={onClose} disabled={pending}>Cancel</Button>
            <Button type="submit" disabled={pending || conflict}>
              {pending ? <Spinner aria-hidden="true" /> : null}
              Save workflow
            </Button>
          </DrawerFooter>
        </form>
      </DrawerPopup>
    </Drawer>
  );
}
