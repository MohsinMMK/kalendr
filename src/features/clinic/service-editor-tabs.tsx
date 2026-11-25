"use client";

import { Plus, X } from "lucide-react";
import { useState } from "react";
import { Controller, useWatch, type UseFormReturn } from "react-hook-form";

import { OptionSelect, SelectField, TextField, TextareaField } from "@/components/form-fields";
import { ImageUpload } from "@/components/image-upload";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Fieldset, FieldsetLegend } from "@/components/ui/fieldset";
import { Label } from "@/components/ui/label";
import { resourceKinds } from "@/lib/business-types";
import type { Location, Practitioner } from "@/lib/domain";
import { mediaIdFromUrl } from "@/lib/media";
import {
  locationOptionKinds, maxServiceLengths, serviceColors, slotIntervalChoices,
  type LocationOptionKind, type ServiceColor, type WindowKind,
} from "@/lib/service-setup";
import { capitalize, resourceKindLabel, type TermWords } from "@/lib/terminology";

import {
  errorAt, noticeMinutes, noticeParts, priceFromText, priceText, type NoticeUnit, type ServiceFormValues,
} from "./service-editor-model";
import { SettingRow } from "./setting-row";

/** A toggle that sits inside another row: no border or padding of its own. */
export const nestedRow = "gap-0 border-0 py-0";

/** What every tab gets, so a tab added later (limits, forms, routing) needs nothing else. */
export interface ServiceEditorContext {
  form: UseFormReturn<ServiceFormValues>;
  terms: TermWords;
  locations: Location[];
  practitioners: Practitioner[];
  /** The service's saved picture, if it has one. */
  imageUrl: string | null;
  /** False in preview mode, where nothing is sent. */
  saves: boolean;
  onImageChanged: () => Promise<void> | void;
  serviceId: string;
  /** The Limits tab saves on its own; it reports here whether it holds changes that are not saved. */
  onLimitsDirtyChange?: (dirty: boolean) => void;
  /** Fields only the service's template may change (feature 48). Empty for a service that follows no template. */
  locked?: ReadonlySet<string>;
}

const colorSwatch: Record<ServiceColor, string> = {
  blue: "bg-blue-500", violet: "bg-violet-500", emerald: "bg-emerald-500", amber: "bg-amber-500", rose: "bg-rose-500",
};

export function BasicsTab({ form, terms: t, locations, practitioners, locked }: ServiceEditorContext) {
  const lock = (field: string) => locked?.has(field) === true;
  const { register, setValue, control, formState: { errors } } = form;
  const basics = useWatch({ control, name: "basics" });
  const toggle = (list: string[], id: string, on: boolean) => (on ? [...new Set([...list, id])] : list.filter((entry) => entry !== id));
  return (
    <div className="flex flex-col">
      <SettingRow settingId="name" title="Basics" help={`What this ${t.service} is called, its link and how it is booked.`}>
        <TextField label="Name" error={errorAt(errors, "basics.name")} maxLength={160} disabled={lock("name")} hint={lock("name") ? "Set by the template" : undefined} {...register("basics.name")} />
        <TextField label="Category" optional maxLength={60} disabled={lock("category")} hint={lock("category") ? "Set by the template" : `Groups ${t.services} into filters on your booking page.`} error={errorAt(errors, "basics.category")}
          value={basics.category ?? ""} onChange={(event) => setValue("basics.category", event.target.value || null, { shouldDirty: true })} />
        <SelectField label="How it is booked" value={basics.bookingMode} onValueChange={(value) => setValue("basics.bookingMode", value === "request" ? "request" : "instant", { shouldDirty: true })}
          options={[{ value: "instant", label: "Instant booking" }, { value: "request", label: `${t.Business} approves first` }]} />
        <SelectField label={t.Resource} optional disabled={lock("resource")} hint={lock("resource") ? "Set by the template" : `Needed so two ${t.customers} never get the same one.`} value={basics.requiredResourceKind ?? ""}
          onValueChange={(value) => setValue("basics.requiredResourceKind", resourceKinds.find((kind) => kind === value) ?? null, { shouldDirty: true })}
          options={[{ value: "", label: "None needed" }, ...resourceKinds.map((kind) => ({ value: kind, label: capitalize(resourceKindLabel(kind)) }))]} />
        <TextField label="Link name" hint="Used in the direct link to this service." error={errorAt(errors, "basics.slug")} maxLength={80} {...register("basics.slug")} />
      </SettingRow>
      <SettingRow settingId="who" title={`${t.Practitioners} who offer this`} help={errorAt(errors, "basics.practitionerIds")}>
        <div className="flex flex-col">
          {practitioners.length === 0 ? <p className="text-muted-foreground text-sm">No {t.practitioners} yet.</p> : null}
          {practitioners.map((person) => (
            <Label key={person.id} className="min-h-11 font-normal">
              <Checkbox checked={basics.practitionerIds.includes(person.id)} onCheckedChange={(on) => setValue("basics.practitionerIds", toggle(basics.practitionerIds, person.id, on), { shouldDirty: true })} />
              {person.name}{person.isActive === false ? " (inactive)" : ""}
            </Label>
          ))}
        </div>
      </SettingRow>
      {locations.length > 1 ? (
        <SettingRow settingId="who" title={`${t.Locations} that offer this`} help={errorAt(errors, "basics.locationIds")}>
          <div className="flex flex-col">
            {locations.map((place) => (
              <Label key={place.id} className="min-h-11 font-normal">
                <Checkbox checked={basics.locationIds.includes(place.id)} disabled={basics.locationIds.length === 1 && basics.locationIds.includes(place.id)}
                  onCheckedChange={(on) => setValue("basics.locationIds", toggle(basics.locationIds, place.id, on), { shouldDirty: true })} />
                {place.name}
              </Label>
            ))}
          </div>
        </SettingRow>
      ) : null}
    </div>
  );
}

export function LengthsTab({ form, terms: t }: ServiceEditorContext) {
  const { setValue, control, formState: { errors } } = form;
  const lengths = useWatch({ control, name: "lengths" });
  // Typed prices stay as text until they parse, so "12." is not rewritten under the cursor.
  const [priceDrafts, setPriceDrafts] = useState<Record<number, string>>({});
  const set = (next: typeof lengths) => setValue("lengths", next, { shouldDirty: true, shouldValidate: true });
  // Handlers read the form's current value, not the last render's, so two quick edits never overwrite each other.
  const current = () => form.getValues("lengths");
  const change = (index: number, patch: Partial<(typeof lengths)[number]>) => set(current().map((length, at) => (at === index ? { ...length, ...patch } : length)));
  const rootError = errorAt(errors, "lengths");
  return (
    <SettingRow settingId="lengths" title="Lengths and prices" help={`Offer up to ${maxServiceLengths} lengths. ${t.Customers} pick one before they pick a time.`}>
      <div className="flex flex-col gap-3">
        {lengths.map((length, index) => {
          const draft = priceDrafts[index] ?? priceText(length.priceMinor);
          const parsed = priceFromText(draft);
          return (
            <div key={index} className="flex flex-col gap-3 rounded-lg border p-3">
              <div className="grid grid-cols-2 gap-3">
                <TextField label="Minutes" type="number" inputMode="numeric" min={5} max={480} value={String(length.minutes)} error={errorAt(errors, `lengths.${index}.minutes`)}
                  onChange={(event) => change(index, { minutes: Number(event.target.value) || 0 })} />
                <TextField label="Price (₹)" optional inputMode="decimal" hint="Leave empty if it varies." value={draft}
                  error={parsed === undefined ? "Enter an amount like 800 or 800.50." : errorAt(errors, `lengths.${index}.priceMinor`)}
                  onChange={(event) => {
                    setPriceDrafts((drafts) => ({ ...drafts, [index]: event.target.value }));
                    const next = priceFromText(event.target.value);
                    if (next !== undefined) change(index, { priceMinor: next });
                  }} />
              </div>
              <div className="flex min-h-11 items-center justify-between gap-3">
                <Label className="font-normal">
                  <Checkbox checked={length.isDefault} onCheckedChange={() => set(current().map((entry, at) => ({ ...entry, isDefault: at === index })))} />
                  Usual length
                </Label>
                {lengths.length > 1 ? (
                  <Button variant="ghost" size="sm" aria-label={`Remove the ${length.minutes} minute length`}
                    onClick={() => {
                      const kept = current().filter((_, at) => at !== index);
                      set(kept.some((entry) => entry.isDefault) ? kept : kept.map((entry, at) => ({ ...entry, isDefault: at === 0 })));
                      setPriceDrafts({});
                    }}>
                    <X aria-hidden="true" /> Remove
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      {rootError ? <p role="alert" className="text-destructive-foreground text-sm">{rootError}</p> : null}
      <Button variant="outline" disabled={lengths.length >= maxServiceLengths} onClick={() => { const now = current(); set([...now, { minutes: Math.min(480, Math.max(...now.map((length) => length.minutes)) + 15), priceMinor: null, isDefault: false }]); }}>
        <Plus aria-hidden="true" /> Add a length
      </Button>
    </SettingRow>
  );
}

const noticeUnits: { value: NoticeUnit; label: string }[] = [{ value: "minutes", label: "minutes" }, { value: "hours", label: "hours" }, { value: "days", label: "days" }];
const windowOptions: { value: WindowKind; label: string }[] = [
  { value: "rolling_days", label: "Up to a number of days ahead" },
  { value: "business_days", label: "Up to a number of open days ahead" },
  { value: "date_range", label: "Only between two dates" },
];

export function TimingTab({ form, terms: t }: ServiceEditorContext) {
  const { setValue, control, formState: { errors } } = form;
  const timing = useWatch({ control, name: "timing" });
  const lengths = useWatch({ control, name: "lengths" });
  const { unit } = noticeParts(timing.minimumNoticeMinutes);
  // Once someone picks or types in a unit it stays: typing 24 hours must not turn into "1 day" under their hands.
  const [pickedUnit, setPickedUnit] = useState<NoticeUnit | null>(null);
  const shownUnit = pickedUnit ?? unit;
  const amount = Math.round((timing.minimumNoticeMinutes / noticeMinutes(1, shownUnit)) * 100) / 100;
  const setTiming = <K extends keyof typeof timing>(key: K, value: (typeof timing)[K]) => setValue("timing", { ...form.getValues("timing"), [key]: value }, { shouldDirty: true, shouldValidate: true });
  const win = timing.window;
  const bufferError = (key: "bufferBeforeMinutes" | "bufferAfterMinutes") => errorAt(errors, `timing.${key}`);
  const intervalValue = timing.slotIntervalMinutes === null ? "same" : String(timing.slotIntervalMinutes);
  const numberField = (key: "bufferBeforeMinutes" | "bufferAfterMinutes" | "startOffsetMinutes", label: string, hint: string, max: number) => (
    <TextField label={label} type="number" inputMode="numeric" min={0} max={max} hint={hint} value={String(timing[key])} error={errorAt(errors, `timing.${key}`) ?? (key === "startOffsetMinutes" ? undefined : bufferError(key))}
      onChange={(event) => setTiming(key, Number(event.target.value) || 0)} />
  );
  return (
    <div className="flex flex-col">
      <p className="mb-4 rounded-lg bg-muted/60 px-3 py-2 text-muted-foreground text-xs">Applies to new bookings only. Bookings you already have do not move.</p>
      <SettingRow settingId="buffers" title="Buffers" help="Time kept free around each booking.">
        {numberField("bufferBeforeMinutes", "Buffer before (minutes)", `Blocks this much time before each ${t.appointment} for setting up. ${t.Customers} don't see it.`, 240)}
        {numberField("bufferAfterMinutes", "Buffer after (minutes)", `Blocks 10 minutes after each ${t.appointment} for cleaning, say. ${t.Customers} don't see it.`, 240)}
      </SettingRow>
      <SettingRow settingId="notice" title="Minimum notice" help="The soonest a booking can be made.">
        <Field className="w-full" invalid={Boolean(errorAt(errors, "timing.minimumNoticeMinutes"))}>
          <div className="grid grid-cols-[1fr_9rem] gap-2">
            <TextField label="Amount" aria-label="Minimum notice amount" type="number" inputMode="numeric" min={0} value={String(amount)} fieldClassName="[&>div:first-child]:sr-only"
              onChange={(event) => { setPickedUnit(shownUnit); setTiming("minimumNoticeMinutes", Math.round(noticeMinutes(Number(event.target.value) || 0, shownUnit))); }} />
            <OptionSelect aria-label="Minimum notice unit" value={shownUnit} options={noticeUnits}
              onValueChange={(next) => { const chosen = noticeUnits.find((entry) => entry.value === next)?.value ?? "minutes"; setPickedUnit(chosen); setTiming("minimumNoticeMinutes", noticeMinutes(amount, chosen)); }} />
          </div>
          <FieldDescription>The soonest a {t.customer} can book. Up to 90 days.</FieldDescription>
          <FieldError match>{errorAt(errors, "timing.minimumNoticeMinutes")}</FieldError>
        </Field>
      </SettingRow>
      <SettingRow settingId="window" title="How far ahead" help="The furthest date a booking can be made for.">
        <SelectField label="How far ahead" value={win.kind} options={windowOptions}
          onValueChange={(next) => {
            const kind = windowOptions.find((entry) => entry.value === next)?.value;
            if (!kind || kind === win.kind) return;
            setTiming("window", kind === "date_range" ? { kind, from: new Date().toISOString().slice(0, 10), through: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10) } : { kind, days: win.kind === "date_range" ? 30 : win.days });
          }} />
        {win.kind === "date_range" ? (
          <div className="grid grid-cols-2 gap-3">
            <TextField label="From" type="date" value={win.from} error={errorAt(errors, "timing.window.from")} onChange={(event) => setTiming("window", { ...win, from: event.target.value })} />
            <TextField label="Until" type="date" value={win.through} error={errorAt(errors, "timing.window.through")} onChange={(event) => setTiming("window", { ...win, through: event.target.value })} />
          </div>
        ) : (
          <TextField label={win.kind === "business_days" ? "Open days ahead" : "Days ahead"} type="number" inputMode="numeric" min={1} value={String(win.days)}
            hint={win.kind === "business_days" ? `Counts only days you are open. Closed days and holidays are skipped.` : `A ${t.customer} can book up to this many days from today.`}
            error={errorAt(errors, "timing.window.days")} onChange={(event) => setTiming("window", { ...win, days: Number(event.target.value) || 0 })} />
        )}
      </SettingRow>
      <SettingRow settingId="interval" title="Start times" help="How far apart the offered times are.">
        <SelectField label="Slot interval" hint="How far apart the offered start times are." value={intervalValue}
          options={[...slotIntervalChoices.map((minutes) => ({ value: String(minutes), label: `Every ${minutes} minutes` })), { value: "same", label: "Same as the length" }]}
          onValueChange={(next) => setTiming("slotIntervalMinutes", next === "same" ? null : Number(next))} />
        {numberField("startOffsetMinutes", "Start offset (minutes)", "Slots start this many minutes past the usual time, such as :05 or :10 past the hour.", 55)}
        {timing.slotIntervalMinutes === null && lengths.length > 1 ? <p className="text-muted-foreground text-xs">With several lengths, “same as the length” uses each length&apos;s own spacing.</p> : null}
      </SettingRow>
      {/* Lane B: optimized slots field goes here */}
    </div>
  );
}

const kindLabels: Record<LocationOptionKind, (t: TermWords) => { label: string; hint: string }> = {
  in_person: (t) => ({ label: "In person", hint: `At one of your ${t.locations}.` }),
  we_call: (t) => ({ label: "We call you", hint: `We ask for the ${t.customer}'s phone number.` }),
  they_call: () => ({ label: "You call us", hint: "Your phone number is shown after booking." }),
  video: () => ({ label: "Video", hint: "The link is added once video is set up." }),
  their_address: (t) => ({ label: "Their address", hint: `We ask the ${t.customer} for an address.` }),
};

export function WhereTab({ form, terms: t, locations }: ServiceEditorContext) {
  const { setValue, control, formState: { errors } } = form;
  const options = useWatch({ control, name: "locationOptions" });
  const set = (next: typeof options) => setValue("locationOptions", next, { shouldDirty: true, shouldValidate: true });
  const has = (kind: LocationOptionKind, locationId: string | null = null) => options.some((option) => option.kind === kind && option.locationId === locationId);
  const toggle = (kind: LocationOptionKind, locationId: string | null, on: boolean) => {
    if (on) set([...options, { kind, locationId, note: null }]);
    else set(options.filter((option) => !(option.kind === kind && option.locationId === locationId)));
  };
  const rootError = errorAt(errors, "locationOptions");
  return (
    <SettingRow settingId="meeting" title="Where it happens" help={options.length > 1 ? `With more than one choice, the ${t.customer} picks one when booking.` : `With one choice, the ${t.customer} is just told.`}>
      <Fieldset className="max-w-none gap-1">
        <FieldsetLegend className="font-medium text-sm">In person</FieldsetLegend>
        {locations.map((place) => (
          <Label key={place.id} className="min-h-11 font-normal">
            <Checkbox checked={has("in_person", place.id)} onCheckedChange={(on) => toggle("in_person", place.id, on)} />
            {place.name}
          </Label>
        ))}
      </Fieldset>
      {locationOptionKinds.filter((kind) => kind !== "in_person").map((kind) => {
        const { label, hint } = kindLabels[kind](t);
        return <SettingRow key={kind} settingId="meeting" title={label} help={hint} className={nestedRow} checked={has(kind)} onCheckedChange={(on) => toggle(kind, null, on)} />;
      })}
      {options.map((option, index) => {
        const place = locations.find((entry) => entry.id === option.locationId);
        const label = option.kind === "in_person" ? `Note for ${place?.name ?? "in person"}` : `Note for ${kindLabels[option.kind](t).label.toLowerCase()}`;
        return (
          <TextField key={`${option.kind}:${option.locationId ?? ""}`} label={label} optional maxLength={200} value={option.note ?? ""} error={errorAt(errors, `locationOptions.${index}.note`)}
            hint="Shown to the customer with this choice."
            onChange={(event) => set(options.map((entry, at) => (at === index ? { ...entry, note: event.target.value || null } : entry)))} />
        );
      })}
      {rootError ? <p role="alert" className="text-destructive-foreground text-sm">{rootError}</p> : null}
    </SettingRow>
  );
}

function ColorSelect({ label, value, onChange }: { label: string; value: ServiceColor | null; onChange: (value: ServiceColor | null) => void }) {
  return (
    <Field className="w-full">
      <FieldLabel>{label}</FieldLabel>
      <OptionSelect aria-label={label} value={value ?? ""} placeholder="Default colour"
        options={[{ value: "", label: "Default colour" }, ...serviceColors.map((color) => ({ value: color, label: capitalize(color) }))]}
        onValueChange={(next) => onChange(serviceColors.find((color) => color === next) ?? null)} />
      <div className="flex gap-1.5" aria-hidden="true">
        {serviceColors.map((color) => <span key={color} className={`size-3 rounded-full ${colorSwatch[color]} ${value === color ? "ring-2 ring-offset-1 ring-foreground" : "opacity-60"}`} />)}
      </div>
    </Field>
  );
}

export function LookTab({ form, terms: t, imageUrl, saves, onImageChanged, serviceId }: ServiceEditorContext) {
  const { setValue, control } = form;
  const look = useWatch({ control, name: "look" });
  const pictureId = imageUrl ? mediaIdFromUrl(imageUrl) : null;
  return (
    <div className="flex flex-col">
      <SettingRow settingId="look" title="Colour" help={`Used on the calendar for this ${t.service}.`}>
        <div className="grid gap-4 sm:grid-cols-2">
          <ColorSelect label="Light mode" value={look.colorLight} onChange={(value) => setValue("look.colorLight", value, { shouldDirty: true })} />
          <ColorSelect label="Dark mode" value={look.colorDark} onChange={(value) => setValue("look.colorDark", value, { shouldDirty: true })} />
        </div>
      </SettingRow>
      <SettingRow settingId="look" title="Description" help="Plain text. Line breaks are kept.">
        <Controller control={form.control} name="basics.description" render={({ field, fieldState }) => (
          <TextareaField label={`What ${t.customers} read`} className="min-h-28" maxLength={2000} error={fieldState.error?.message} {...field} />
        )} />
      </SettingRow>
      <SettingRow settingId="look" title="Picture" help="Shown on the booking page. Saves as soon as you add it.">
        <ImageUpload kind="service" ownerId={serviceId} label="Picture" url={imageUrl} saves={saves} onChanged={onImageChanged} />
        <SettingRow settingId="look" title="Show it as a banner" help={pictureId ? `Fills the top of this ${t.service}'s own page.` : "Add a picture first."} className={nestedRow}
          checked={look.bannerMediaId !== null && look.bannerMediaId === pictureId}
          onCheckedChange={(on) => setValue("look.bannerMediaId", on ? pictureId : null, { shouldDirty: true })} />
      </SettingRow>
    </div>
  );
}
