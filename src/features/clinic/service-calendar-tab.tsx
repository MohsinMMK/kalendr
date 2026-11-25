"use client";

import { useQuery } from "@tanstack/react-query";
import { CalendarDays, Lock } from "lucide-react";
import { useMemo, useState } from "react";
import { useWatch } from "react-hook-form";

import { TextField } from "@/components/form-fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { type Entry, TITLE_MAX, customerEntry, placeholderHelp, renderWording, sampleValues, staffEntry, wordingPlaceholders } from "@/lib/event-wording";
import type { FormDefinition } from "@/lib/booking-forms";
import { defaultCalendarEntry, type CalendarEntry } from "@/lib/service-setup";

import { useCatalogLookups } from "./clinic-catalog";
import { staffQuery } from "./queries/http";
import { errorAt } from "./service-editor-model";
import { nestedRow, type ServiceEditorContext } from "./service-editor-tabs";
import { SettingRow } from "./setting-row";

type Target = "customerTitle" | "staffTitle" | "description";

function PreviewEntry({ heading, entry, note }: { heading: string; entry: Entry & { location?: string }; note?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="mb-1 flex items-center gap-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wide"><CalendarDays aria-hidden="true" className="size-3.5" /> {heading}</p>
      <p className="break-words font-medium text-sm">{entry.title}</p>
      {entry.description ? <p className="mt-1 whitespace-pre-line break-words text-muted-foreground text-xs">{entry.description}</p> : null}
      {entry.location ? <p className="mt-1 break-words text-muted-foreground text-xs">{entry.location}</p> : null}
      {note ? <p className="mt-2 flex items-center gap-1.5 text-muted-foreground text-xs"><Lock aria-hidden="true" className="size-3" /> {note}</p> : null}
    </div>
  );
}

/**
 * What the customer's invite and the staff calendars say for this service, with a live preview (feature 50). It is
 * `ServiceSetup.calendarEntry` and saves with the editor's Save button.
 */
export function ServiceCalendarTab({ form, terms: t, serviceId }: Pick<ServiceEditorContext, "form" | "terms" | "serviceId">) {
  const catalog = useCatalogLookups();
  const watched = useWatch({ control: form.control, name: "calendarEntry" });
  const entry: CalendarEntry = watched ?? defaultCalendarEntry;
  const basics = useWatch({ control: form.control, name: "basics" });
  const lengths = useWatch({ control: form.control, name: "lengths" });
  const { errors } = form.formState;
  const [target, setTarget] = useState<Target>("customerTitle");
  const forms = useQuery({ queryKey: ["staff", "forms"], queryFn: ({ signal }) => staffQuery<FormDefinition[]>("/api/staff/forms", signal), enabled: catalog.database, staleTime: 60_000 });

  // A question is addressed by its link name, or its id when it has none.
  const questions = useMemo(() => (forms.data ?? [])
    .filter((definition) => definition.isActive && (definition.appliesToAll || definition.serviceIds.includes(serviceId)))
    .flatMap((definition) => definition.fields.filter((field) => !["heading", "paragraph"].includes(field.type as string)).map((field) => ({ key: (field.prefillKey || field.id).toLowerCase(), label: field.label }))), [forms.data, serviceId]);
  const questionKeys = questions.map((question) => question.key);

  const place = catalog.locations.find((location) => basics.locationIds.includes(location.id)) ?? catalog.locations[0];
  const person = catalog.practitioners.find((practitioner) => basics.practitionerIds.includes(practitioner.id))?.name ?? "Alex";
  const usual = lengths.find((length) => length.isDefault) ?? lengths[0];
  const values = {
    ...sampleValues(catalog.clinic.name, place?.name ?? "Main location", place ? `${place.address}, ${place.city}` : "", basics.name || "Service", person, usual?.minutes ?? 30),
    answers: Object.fromEntries(questions.map((question) => [question.key, `(${question.label})`])),
  };
  const change = (patch: Partial<CalendarEntry>) => form.setValue("calendarEntry", { ...entry, ...patch }, { shouldDirty: true, shouldValidate: form.formState.isSubmitted });
  const unknownIn = (text: string | null) => (text ? renderWording(text, values, { questionKeys }).unknown : []);
  const insert = (token: string) => change({ [target]: `${entry[target] ?? ""}{${token}}` });

  const fallbackCustomer = `${basics.name || "Service"} · ${catalog.clinic.name}`;
  const fallbackStaff = `${basics.name || "Service"} – ${values.customer}`;
  const customer = customerEntry(entry, values, fallbackCustomer, "", questionKeys);
  const staff = staffEntry(entry, values, { title: fallbackStaff, description: null, location: place?.name ?? "" }, questionKeys);
  const unknown = [...new Set([...unknownIn(entry.customerTitle), ...unknownIn(entry.staffTitle), ...unknownIn(entry.description)])];

  return (
    <div className="flex flex-col">
      <SettingRow settingId="calendar-wording" title="Calendar entry wording" help={`Choose the words that go into the invite your ${t.customer} gets and into your team’s calendars. Leave a box empty to keep the usual wording.`}>
      <TextField label={`What the ${t.customer} sees as the title`} placeholder="{service} with {person}" maxLength={TITLE_MAX} value={entry.customerTitle ?? ""}
        onFocus={() => setTarget("customerTitle")} onChange={(event) => change({ customerTitle: event.target.value || null })} error={errorAt(errors, "calendarEntry.customerTitle")}
        hint={unknownIn(entry.customerTitle).length > 0 ? `Not a known placeholder: ${unknownIn(entry.customerTitle).map((name) => `{${name}}`).join(", ")}` : undefined} />
      <TextField label="What your team sees as the title" placeholder="{customer}: {service}" maxLength={TITLE_MAX} value={entry.staffTitle ?? ""}
        onFocus={() => setTarget("staffTitle")} onChange={(event) => change({ staffTitle: event.target.value || null })} error={errorAt(errors, "calendarEntry.staffTitle")}
        hint={unknownIn(entry.staffTitle).length > 0 ? `Not a known placeholder: ${unknownIn(entry.staffTitle).map((name) => `{${name}}`).join(", ")}` : undefined} />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="calendar-description">Description <span className="font-normal text-muted-foreground">(optional)</span></Label>
        <Textarea id="calendar-description" maxLength={1000} placeholder={"Bring your card.\n{business}, {location}"} value={entry.description ?? ""} onFocus={() => setTarget("description")} onChange={(event) => change({ description: event.target.value || null })} />
        {unknownIn(entry.description).length > 0 ? <p role="alert" className="text-destructive-foreground text-xs">Not a known placeholder: {unknownIn(entry.description).map((name) => `{${name}}`).join(", ")}</p> : null}
      </div>
      <section aria-label="Placeholders" className="flex flex-col gap-2">
        <h3 className="font-medium text-sm">Add a detail</h3>
        <div className="flex flex-wrap gap-1.5">
          {wordingPlaceholders.map((name) => <Button key={name} type="button" size="xs" variant="outline" title={placeholderHelp[name]} aria-label={`Add {${name}}: ${placeholderHelp[name]}`} onClick={() => insert(name)}>{`{${name}}`}</Button>)}
          {questions.map((question) => <Button key={question.key} type="button" size="xs" variant="outline" title={`Answer to “${question.label}”`} aria-label={`Add {${question.key}}: the answer to ${question.label}`} onClick={() => insert(question.key)}>{`{${question.key}}`}</Button>)}
        </div>
        <p className="text-muted-foreground text-xs">Fills in the box you last clicked. Questions are named by their link name.</p>
        {unknown.length > 0 ? <Badge variant="warning" className="self-start">Unknown: {unknown.map((name) => `{${name}}`).join(" ")}. It will show as typed.</Badge> : null}
      </section>
      </SettingRow>
      <section aria-label="Privacy" className="flex flex-col border-b py-4">
        <SettingRow settingId="calendar-wording" className={nestedRow} title="Keep notes and answers out of calendars" help={`The ${t.customer}’s notes and answers to your questions never go into any calendar entry.`} checked={entry.hideNotes} onCheckedChange={(next) => change({ hideNotes: next })} />
        <SettingRow settingId="calendar-wording" className={nestedRow} title="Show only “Busy” in team calendars" help={`For shared office calendars: your team’s entries say only “Busy: ${catalog.clinic.name}”. Kalendr still shows everything.`} checked={entry.hideDetails} onCheckedChange={(next) => change({ hideDetails: next })} />
      </section>
      <section aria-label="Preview" className="flex flex-col gap-2 py-4">
        <h3 className="font-medium text-sm">Preview with a sample booking</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          <PreviewEntry heading={`${t.Customer}’s invite`} entry={customer} />
          <PreviewEntry heading="Team calendar" entry={staff} note={entry.hideDetails ? "Nothing else is written: no description, place or name." : undefined} />
        </div>
      </section>
      {/* Lane C: field goes here */}
    </div>
  );
}
