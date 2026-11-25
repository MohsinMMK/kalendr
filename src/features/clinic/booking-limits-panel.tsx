"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Ellipsis, Gauge, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { Controller, useFieldArray, useForm, useWatch, type UseFormReturn } from "react-hook-form";
import { z } from "zod";

import { OptionSelect, TextField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Combobox, ComboboxChip, ComboboxChips, ComboboxChipsInput, ComboboxEmpty, ComboboxItem, ComboboxList, ComboboxPopup, ComboboxValue,
} from "@/components/ui/combobox";
import { Dialog, DialogDescription, DialogHeader, DialogPanel, DialogPopup, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import {
  describeLimit, limitTeamSchema, limitValueMax, serviceCustomerRulesSchema,
  type BookingLimitsReplace, type BookingLimitsView, type LimitMeasure, type LimitPeriod, type LimitScope,
} from "@/lib/booking-limits";

import { getLimits, LimitsApiError, putLimits } from "./booking-limits-api";
import { useCatalogLookups } from "./clinic-catalog";
import { useStaffAccess } from "./staff-access";
import { useOptionalStaffSnapshot } from "./staff-snapshot-provider";

/* ------------------------------------------------------------------ form model */

export interface LimitRow {
  measure: LimitMeasure;
  period: LimitPeriod;
  /** Bookings for "count", minutes for "minutes". */
  maxValue: number;
  /** 1 is Monday and 7 is Sunday. Only matters for a weekly limit. */
  weekStart: 1 | 7;
}

export interface LimitsFormValues {
  limits: LimitRow[];
  serviceRules: { maxActivePerCustomer: number | null; offerRescheduleWhenCapped: boolean; firstSlotOnly: boolean };
  team: { name: string; memberIds: string[] };
}

const rowSchema = z.object({
  measure: z.enum(["count", "minutes"]),
  period: z.enum(["day", "week", "month", "year"]),
  maxValue: z.number({ error: "Enter a number." }).int("Use a whole number.").min(1, "Enter at least 1.").max(limitValueMax.minutes, "That is more time than a year holds."),
  weekStart: z.union([z.literal(1), z.literal(7)]),
}).refine((row) => row.measure !== "count" || row.maxValue <= limitValueMax.count, { message: "That is more bookings than one period can hold.", path: ["maxValue"] });

const rulesSchema = serviceCustomerRulesSchema.extend({
  maxActivePerCustomer: z.number({ error: "Enter a number, or leave it empty." }).int("Use a whole number.").min(1, "Enter at least 1.").max(50, "The most is 50.").nullable(),
});

/** The customer rules and the team are only checked where the panel shows them. */
export function limitsFormSchema(options: { serviceRules: boolean; team: boolean }) {
  return z.object({
    limits: z.array(rowSchema).max(12),
    serviceRules: options.serviceRules ? rulesSchema : z.any(),
    team: options.team ? limitTeamSchema : z.any(),
  }).superRefine((value, context) => {
    const seen = new Set<string>();
    value.limits.forEach((limit, index) => {
      const key = `${limit.measure}:${limit.period}`;
      if (seen.has(key)) context.addIssue({ code: "custom", path: ["limits", index, "period"], message: "There is already a limit like this. Change that one instead." });
      seen.add(key);
    });
  });
}

const noRules = { maxActivePerCustomer: null, offerRescheduleWhenCapped: false, firstSlotOnly: false } as const;

export function formFromView(view: BookingLimitsView | null): LimitsFormValues {
  return {
    limits: (view?.limits ?? []).map(({ measure, period, maxValue, weekStart }) => ({ measure, period, maxValue, weekStart })),
    serviceRules: view?.serviceRules ?? { ...noRules },
    team: { name: view?.team?.name ?? "", memberIds: view?.team?.memberIds ?? [] },
  };
}

/** What the PUT takes. A service sends its customer rules and a team sends its name and people. */
export function payloadFrom(
  target: { scope: LimitScope; scopeId: string | null },
  values: LimitsFormValues,
  options: { serviceRules?: boolean; team?: boolean },
): BookingLimitsReplace {
  return {
    target,
    limits: values.limits.map(({ measure, period, maxValue, weekStart }) => ({ measure, period, maxValue, weekStart })),
    ...(options.serviceRules ? { serviceRules: values.serviceRules } : {}),
    ...(options.team ? { team: { name: values.team.name.trim(), memberIds: values.team.memberIds } } : {}),
  };
}

const measureLabels: Record<LimitMeasure, string> = { count: "Bookings", minutes: "Booked time" };
const periodLabels: Record<LimitPeriod, string> = { day: "day", week: "week", month: "month", year: "year" };
const periodAdjective: Record<LimitPeriod, string> = { day: "a day", week: "a week", month: "a month", year: "a year" };

const defaultMax: Record<LimitMeasure, Record<LimitPeriod, number>> = {
  count: { day: 10, week: 40, month: 150, year: 1500 },
  minutes: { day: 8 * 60, week: 40 * 60, month: 160 * 60, year: 1900 * 60 },
};

const everyKind: Array<{ measure: LimitMeasure; period: LimitPeriod }> = (["count", "minutes"] as const).flatMap((measure) => (["day", "week", "month", "year"] as const).map((period) => ({ measure, period })));

/** Hours and minutes for a total of minutes, for the friendly booked-time input. */
export function minutesParts(total: number): { hours: number; minutes: number } {
  const safe = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  return { hours: Math.floor(safe / 60), minutes: safe % 60 };
}

const errorText = (message: unknown): string | undefined => (typeof message === "string" ? message : undefined);

function FieldMessage({ id, children }: { id: string; children?: string }) {
  return children ? <p id={id} role="alert" className="text-destructive-foreground text-xs">{children}</p> : null;
}

/* ------------------------------------------------------------------ one row */

function LimitRowEditor({ form, index, onRemove, disabled }: { form: UseFormReturn<LimitsFormValues>; index: number; onRemove: () => void; disabled: boolean }) {
  const row = useWatch({ control: form.control, name: `limits.${index}` });
  const errors = form.formState.errors.limits?.[index];
  const ordinal = index + 1;
  const set = <K extends keyof LimitRow>(key: K, value: LimitRow[K]) => form.setValue(`limits.${index}.${key}` as `limits.${number}.${K}`, value as never, { shouldDirty: true, shouldValidate: form.formState.isSubmitted });
  if (!row) return null;
  const parts = minutesParts(row.maxValue);
  const amountError = errorText(errors?.maxValue?.message);
  const periodError = errorText(errors?.period?.message);
  const valid = Number.isInteger(row.maxValue) && row.maxValue >= 1;
  return (
    <li className="flex flex-col gap-2 py-3" aria-label={`Limit ${ordinal}`}>
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-end gap-x-2 gap-y-3">
          <div className="w-full min-w-36 sm:w-40">
            <OptionSelect aria-label={`Limit ${ordinal}: what to count`} value={row.measure} disabled={disabled}
              options={[{ value: "count", label: measureLabels.count }, { value: "minutes", label: measureLabels.minutes }]}
              onValueChange={(next) => {
                const measure: LimitMeasure = next === "minutes" ? "minutes" : "count";
                if (measure === row.measure) return;
                set("measure", measure);
                set("maxValue", defaultMax[measure][row.period]);
              }} />
          </div>
          {row.measure === "count" ? (
            <div className="w-24">
              <Input size="lg" type="number" inputMode="numeric" min={1} max={limitValueMax.count} disabled={disabled}
                aria-label={`Limit ${ordinal}: most bookings`} aria-invalid={amountError ? true : undefined} aria-describedby={amountError ? `limit-${index}-error` : undefined}
                value={Number.isNaN(row.maxValue) ? "" : String(row.maxValue)}
                onChange={(event) => set("maxValue", event.target.value === "" ? Number.NaN : Number(event.target.value))} />
            </div>
          ) : (
            <div className="flex items-end gap-2">
              <div className="w-20">
                <Input size="lg" type="number" inputMode="numeric" min={0} disabled={disabled} aria-label={`Limit ${ordinal}: hours`} aria-invalid={amountError ? true : undefined}
                  aria-describedby={amountError ? `limit-${index}-error` : undefined}
                  value={Number.isNaN(row.maxValue) ? "" : String(parts.hours)}
                  onChange={(event) => set("maxValue", event.target.value === "" && parts.minutes === 0 ? Number.NaN : Math.max(0, Number(event.target.value) || 0) * 60 + parts.minutes)} />
              </div>
              <span className="pb-2.5 text-muted-foreground text-sm">h</span>
              <div className="w-20">
                <Input size="lg" type="number" inputMode="numeric" min={0} max={59} disabled={disabled} aria-label={`Limit ${ordinal}: minutes`} aria-invalid={amountError ? true : undefined}
                  value={Number.isNaN(row.maxValue) ? "" : String(parts.minutes)}
                  onChange={(event) => set("maxValue", parts.hours * 60 + Math.max(0, Number(event.target.value) || 0))} />
              </div>
              <span className="pb-2.5 text-muted-foreground text-sm">min</span>
            </div>
          )}
          <span className="pb-2.5 text-muted-foreground text-sm">per</span>
          <div className="w-28">
            <OptionSelect aria-label={`Limit ${ordinal}: how often`} value={row.period} disabled={disabled}
              options={(["day", "week", "month", "year"] as const).map((period) => ({ value: period, label: periodLabels[period] }))}
              onValueChange={(next) => {
                const period = (["day", "week", "month", "year"] as const).find((entry) => entry === next);
                if (period && period !== row.period) set("period", period);
              }} />
          </div>
          {row.period === "week" ? (
            <div className="w-full min-w-36 sm:w-40">
              <OptionSelect aria-label={`Limit ${ordinal}: the week starts on`} value={String(row.weekStart)} disabled={disabled}
                options={[{ value: "1", label: "Week starts Monday" }, { value: "7", label: "Week starts Sunday" }]}
                onValueChange={(next) => set("weekStart", next === "7" ? 7 : 1)} />
            </div>
          ) : null}
        </div>
        <Menu>
          <MenuTrigger render={<Button variant="ghost" size="icon-lg" className="shrink-0" aria-label={`More for limit ${ordinal}`} disabled={disabled} />}>
            <Ellipsis aria-hidden="true" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem variant="destructive" onClick={onRemove}><Trash2 aria-hidden="true" /> Remove this limit</MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      <FieldMessage id={`limit-${index}-error`}>{amountError}</FieldMessage>
      <FieldMessage id={`limit-${index}-period-error`}>{periodError}</FieldMessage>
      {valid && !amountError && !periodError ? <p className="text-muted-foreground text-xs">{describeLimit(row)}</p> : null}
    </li>
  );
}

/* ------------------------------------------------------------------ team fields */

function TeamFields({ form, disabled }: { form: UseFormReturn<LimitsFormValues>; disabled: boolean }) {
  const t = useTerms();
  const catalog = useCatalogLookups();
  const items = useMemo(() => catalog.practitioners.map((person) => ({ value: person.id, label: person.isActive === false ? `${person.name} (not bookable)` : person.name })), [catalog.practitioners]);
  const errors = form.formState.errors.team;
  const memberError = errorText(errors?.memberIds?.message);
  return (
    <div className="flex flex-col gap-4">
      <TextField label="Team name" maxLength={80} disabled={disabled} error={errorText(errors?.name?.message)} {...form.register("team.name")} />
      <Controller control={form.control} name="team.memberIds" render={({ field }) => {
        const selected = items.filter((item) => field.value.includes(item.value));
        return (
          <Field className="w-full" invalid={Boolean(memberError)}>
            <FieldLabel>People in this team</FieldLabel>
            <Combobox multiple items={items} value={selected} disabled={disabled}
              itemToStringLabel={(item: { value: string }) => items.find((entry) => entry.value === item.value)?.label ?? item.value}
              isItemEqualToValue={(a: { value: string }, b: { value: string }) => a.value === b.value}
              onValueChange={(next: Array<{ value: string }>) => { form.setValue("team.memberIds", next.map((item) => item.value), { shouldDirty: true, shouldValidate: form.formState.isSubmitted }); }}>
              <ComboboxChips>
                <ComboboxValue>
                  {(value: Array<{ value: string; label: string }>) => (
                    <>
                      {value.map((item) => <ComboboxChip key={item.value} aria-label={item.label}>{item.label}</ComboboxChip>)}
                      <ComboboxChipsInput aria-label="Find a person to add" placeholder={value.length ? "" : `Find ${t.aPractitioner}`} />
                    </>
                  )}
                </ComboboxValue>
              </ComboboxChips>
              <ComboboxPopup>
                <ComboboxEmpty>No one found.</ComboboxEmpty>
                <ComboboxList>
                  {(item: { value: string; label: string }) => <ComboboxItem key={item.value} value={item}>{item.label}</ComboboxItem>}
                </ComboboxList>
              </ComboboxPopup>
            </Combobox>
            {memberError ? <FieldMessage id="team-members-error">{memberError}</FieldMessage> : <FieldDescription>Their bookings are counted together against the limits below. Pick at least two.</FieldDescription>}
          </Field>
        );
      }} />
    </div>
  );
}

/* ------------------------------------------------------------------ service rules */

function RulesFields({ form, disabled }: { form: UseFormReturn<LimitsFormValues>; disabled: boolean }) {
  const t = useTerms();
  const rules = useWatch({ control: form.control, name: "serviceRules" });
  const error = errorText(form.formState.errors.serviceRules?.maxActivePerCustomer?.message);
  const setRule = <K extends keyof LimitsFormValues["serviceRules"]>(key: K, value: LimitsFormValues["serviceRules"][K]) =>
    form.setValue(`serviceRules.${key}` as `serviceRules.${K}`, value as never, { shouldDirty: true, shouldValidate: form.formState.isSubmitted });
  const capped = rules.maxActivePerCustomer !== null;
  return (
    <section className="flex flex-col gap-4" aria-label={`Limits for each ${t.customer}`}>
      <div>
        <h4 className="font-semibold text-sm">Limits for each {t.customer}</h4>
        <p className="mt-0.5 text-muted-foreground text-xs">These do not count towards the limits above.</p>
      </div>
      <Field className="w-full" invalid={Boolean(error)}>
        <FieldLabel>Most future bookings one {t.customer} can hold</FieldLabel>
        <Input size="lg" type="number" inputMode="numeric" min={1} max={50} placeholder="No limit" disabled={disabled} aria-invalid={error ? true : undefined}
          value={rules.maxActivePerCustomer === null ? "" : Number.isNaN(rules.maxActivePerCustomer) ? "" : String(rules.maxActivePerCustomer)}
          onChange={(event) => setRule("maxActivePerCustomer", event.target.value === "" ? null : Number(event.target.value))} />
        {error ? <FieldMessage id="cap-error">{error}</FieldMessage> : <FieldDescription>Leave it empty for no limit. Past and cancelled bookings do not count.</FieldDescription>}
      </Field>
      <SwitchRow label={`When a ${t.customer} is at the cap, offer them a link to move their booking`}
        hint={capped ? "They can move a booking they have instead of adding another." : "Set a cap first."}
        checked={rules.offerRescheduleWhenCapped} disabled={disabled || !capped} onCheckedChange={(next) => setRule("offerRescheduleWhenCapped", next)} />
      <SwitchRow label="Each person offers only their first free time of the day"
        hint={`${t.Customers} see one time for each person each day, so the day fills from the start.`}
        checked={rules.firstSlotOnly} disabled={disabled} onCheckedChange={(next) => setRule("firstSlotOnly", next)} />
    </section>
  );
}

function SwitchRow({ label, hint, checked, disabled, onCheckedChange }: { label: string; hint: string; checked: boolean; disabled?: boolean; onCheckedChange: (next: boolean) => void }) {
  return (
    <Field className="w-full">
      <Label className="min-h-11 items-center justify-between gap-4 font-normal">
        <span className="flex flex-col gap-0.5">
          <span className="font-medium text-sm">{label}</span>
          <span className="text-muted-foreground text-xs">{hint}</span>
        </span>
        <Switch checked={checked} disabled={disabled} onCheckedChange={onCheckedChange} aria-label={label} />
      </Label>
    </Field>
  );
}

/* ------------------------------------------------------------------ the panel */

export interface BookingLimitsPanelProps {
  scope: LimitScope;
  /** The service, person, branch, room or team. Null makes a new team. */
  scopeId: string | null;
  /** A service: also edit the customer cap and the first-slot switch. */
  serviceRules?: boolean;
  /** A team: also edit its name and people. */
  team?: boolean;
  /** Called with the saved limits. */
  onSaved?: (view: BookingLimitsView) => void;
  /** Tells a parent whether there are changes that are not saved. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Words for the thing being limited, such as "this room". */
  subject?: string;
  /** Extra items for the ⋯ menu beside Save. */
  moreItems?: ReactNode;
}

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; view: BookingLimitsView | null };

const scopeNoun = (scope: LimitScope, t: ReturnType<typeof useTerms>): string =>
  ({ service: t.service, practitioner: t.practitioner, location: t.location, resource: t.resource, team: "team" })[scope];

/**
 * The limits of one service, person, branch, room or team: a list of "[bookings or booked time] [number] per [day, week,
 * month or year]" rows that saves in one go. In preview mode, which has no database, it says so and shows nothing to edit.
 */
export function BookingLimitsPanel(props: BookingLimitsPanelProps) {
  const catalog = useCatalogLookups();
  const t = useTerms();
  if (!catalog.database) {
    return (
      <Alert variant="info">
        <AlertDescription>Booking limits are not available in the preview. They need the {t.business} database.</AlertDescription>
      </Alert>
    );
  }
  return <PanelBody {...props} />;
}

function PanelBody({ scope, scopeId, serviceRules = false, team = false, onSaved, onDirtyChange, subject, moreItems }: BookingLimitsPanelProps) {
  const t = useTerms();
  const staff = useOptionalStaffSnapshot();
  const isNew = scopeId === null;
  const [load, setLoad] = useState<Load>(isNew ? { state: "ready", view: null } : { state: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const schema = useMemo(() => limitsFormSchema({ serviceRules, team }), [serviceRules, team]);
  const form = useForm<LimitsFormValues>({ resolver: zodResolver(schema) as never, defaultValues: formFromView(null) });
  const { reset } = form;
  const { fields, append, remove } = useFieldArray({ control: form.control, name: "limits" });
  const dirty = form.formState.isDirty;
  const watchedLimits = useWatch({ control: form.control, name: "limits" });

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (scopeId === null) return;
    const controller = new AbortController();
    getLimits(scope, scopeId, controller.signal).then((view) => {
      if (controller.signal.aborted) return;
      reset(formFromView(view));
      setLoad({ state: "ready", view });
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setLoad({ state: "error", message: cause instanceof Error ? cause.message : "The limits could not be loaded." });
    });
    return () => controller.abort();
  }, [scope, scopeId, reloadKey, reset]);

  const retry = useCallback(() => { setLoad({ state: "loading" }); setReloadKey((key) => key + 1); }, []);

  const save = form.handleSubmit(async (values) => {
    setSaving(true);
    setMessage("");
    try {
      // Rows a person is not using (such as a week start for a daily limit) still go: the server ignores them.
      const view = await putLimits(payloadFrom({ scope, scopeId }, values, { serviceRules, team }));
      reset(formFromView(view));
      setLoad({ state: "ready", view });
      toastManager.add({ title: "Limits saved. New bookings follow them.", type: "success" });
      await staff?.refresh();
      onSaved?.(view);
    } catch (cause: unknown) {
      if (cause instanceof LimitsApiError) {
        let placed = false;
        for (const [path, messages] of Object.entries(cause.fieldErrors)) {
          if (/^(limits|serviceRules|team)\./.test(path)) {
            form.setError(path as never, { type: "server", message: messages[0] ?? "Check this." });
            placed = true;
          }
        }
        setMessage(placed && cause.code === "validation_error" ? "Some limits need a look. Check the marked fields." : cause.message);
      } else setMessage("The limits could not be saved. Try again.");
    } finally {
      setSaving(false);
    }
  }, () => setMessage("Some limits need a look. Check the marked fields."));

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    // The panel can sit inside another form (the service editor's), so Enter in a field must not submit that one.
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault();
  };

  if (load.state === "loading") {
    return (
      <div className="flex flex-col gap-3" role="status" aria-label="Loading the limits">
        <Skeleton className="h-11 w-full" /><Skeleton className="h-11 w-full" /><Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (load.state === "error") {
    return (
      <Alert variant="error">
        <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
          <span>{load.message}</span>
          <Button size="sm" variant="outline" onClick={retry}>Try again</Button>
        </AlertDescription>
      </Alert>
    );
  }

  const used = new Set((watchedLimits ?? []).map((row) => `${row.measure}:${row.period}`));
  const full = fields.length >= 12;
  const noun = subject ?? `this ${scopeNoun(scope, t)}`;
  const saved = load.view?.limits ?? [];
  const canSave = (dirty || isNew) && !saving;

  return (
    <div className="flex flex-col gap-5" onKeyDown={onKeyDown}>
      <p className="text-muted-foreground text-sm">
        A limit stops new bookings for {noun} once a day, week, month or year is full. Bookings that are already made stay. Staff can go past a limit by giving a reason.
      </p>
      {message ? <Alert variant="error"><AlertDescription>{message}</AlertDescription></Alert> : null}
      {team ? <TeamFields form={form} disabled={saving} /> : null}

      <section className="flex flex-col" aria-label="Limits">
        {fields.length === 0 ? (
          <div className="rounded-lg border border-dashed px-4 py-6 text-center">
            <Gauge aria-hidden="true" className="mx-auto mb-2 size-5 text-muted-foreground" />
            <p className="font-medium text-sm">No limits yet</p>
            <p className="mt-0.5 text-muted-foreground text-xs">{noun.charAt(0).toUpperCase() + noun.slice(1)} can be booked as much as its hours allow.</p>
          </div>
        ) : (
          <ul className="flex flex-col divide-y">
            {fields.map((field, index) => (
              <LimitRowEditor key={field.id} form={form} index={index} disabled={saving} onRemove={() => remove(index)} />
            ))}
          </ul>
        )}
        <div className="mt-3">
          <Menu>
            <MenuTrigger render={<Button variant="outline" size="lg" disabled={saving || full} />}>
              <Plus aria-hidden="true" /> Add a limit
            </MenuTrigger>
            <MenuPopup align="start">
              {everyKind.map((kind) => {
                const taken = used.has(`${kind.measure}:${kind.period}`);
                return (
                  <MenuItem key={`${kind.measure}:${kind.period}`} disabled={taken} onClick={() => append({ ...kind, maxValue: defaultMax[kind.measure][kind.period], weekStart: 1 }, { shouldFocus: false })}>
                    <span className="flex flex-col">
                      <span>{measureLabels[kind.measure]} {periodAdjective[kind.period]}</span>
                      {taken ? <span className="text-muted-foreground text-xs">Already added</span> : null}
                    </span>
                  </MenuItem>
                );
              })}
            </MenuPopup>
          </Menu>
          {full ? <p className="mt-1 text-muted-foreground text-xs">You can have up to 12 limits.</p> : null}
        </div>
        {saved.length > 0 && !dirty ? (
          <p className="mt-3 text-muted-foreground text-xs">In force now: {saved.map((limit) => describeLimit(limit)).join(" · ")}.</p>
        ) : null}
      </section>

      {serviceRules ? <RulesFields form={form} disabled={saving} /> : null}

      <div className="flex items-center justify-between gap-3 border-t pt-4">
        <div className="flex min-w-0 items-center gap-2">
          <Menu>
            <MenuTrigger render={<Button variant="outline" size="icon-lg" aria-label="More for limits" />}><Ellipsis aria-hidden="true" /></MenuTrigger>
            <MenuPopup align="start">
              <MenuItem disabled={!dirty || saving} onClick={() => { reset(formFromView(load.view)); setMessage(""); }}>Discard changes</MenuItem>
              {moreItems}
            </MenuPopup>
          </Menu>
          {dirty ? <span className="truncate text-muted-foreground text-xs">Not saved yet</span> : null}
        </div>
        <Button type="button" size="lg" disabled={!canSave} onClick={() => void save()}>
          {saving ? <Spinner aria-hidden="true" /> : null}
          {saving ? "Saving…" : isNew && team ? "Create team" : "Save limits"}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ a button that opens the panel */

/** A "Limits" button that opens the panel in a dialog, a bottom sheet on a phone. For a person, branch or room. */
export function BookingLimitsButton({ scope, scopeId, label, buttonLabel = "Limits", variant = "outline" }: {
  scope: LimitScope; scopeId: string; label: string; buttonLabel?: string; variant?: "outline" | "ghost";
}) {
  const [open, setOpen] = useState(false);
  // The server checks again; this keeps a person without the right from seeing a button that only refuses.
  if (!useStaffAccess().can("settings.manage")) return null;
  return (
    <BookingLimitsDialog open={open} onOpenChange={setOpen} scope={scope} scopeId={scopeId} label={label}
      trigger={<Button variant={variant} size="sm" className="min-h-11 sm:min-h-0" aria-label={`${buttonLabel} for ${label}`}><Gauge aria-hidden="true" /> {buttonLabel}</Button>} />
  );
}

/** The dialog alone, for a menu item that opens it. */
export function BookingLimitsDialog({ open, onOpenChange, scope, scopeId, label, trigger }: {
  open: boolean; onOpenChange: (open: boolean) => void; scope: LimitScope; scopeId: string; label: string; trigger?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {trigger ? <DialogTrigger render={trigger as never} /> : null}
      <DialogPopup className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Booking limits for {label}</DialogTitle>
          <DialogDescription>How much can be booked in a day, week, month or year.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {open ? <BookingLimitsPanel scope={scope} scopeId={scopeId} subject={label} /> : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
