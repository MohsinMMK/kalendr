"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Ellipsis, Pencil, Plus, Tags, Trash2, UserRoundPen } from "lucide-react";
import { useEffect, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { RichMenu, RichMenuContent, RichMenuItem, RichMenuTrigger } from "@/components/rich-menu";
import { SelectField, TextareaField, TextField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import { attributeKindLabels, attributeKinds, type AttributeKind, type AttributeView, type PersonAttributesView } from "@/lib/enterprise-contracts";

import { useAttributes, useOrgChange } from "./api";
import { errorText, QueryState, serverFieldErrors } from "./shared";

const formSchema = z.object({
  name: z.string().trim().min(2, "Enter at least 2 characters.").max(60, "Use 60 characters or fewer."),
  kind: z.enum(attributeKinds),
  options: z.string(),
});
type FormValues = z.infer<typeof formSchema>;

const optionList = (text: string): string[] => text.split("\n").map((line) => line.trim()).filter(Boolean);

/** Settings > Organisation > Attributes: facts about each person (Language, Speciality) used to route bookings and filter reports. */
export function AttributesTab() {
  const query = useAttributes();
  const change = useOrgChange();
  const t = useTerms();
  const [editing, setEditing] = useState<AttributeView | "new" | null>(null);
  const [assigning, setAssigning] = useState<PersonAttributesView | null>(null);

  async function remove(attribute: AttributeView) {
    try {
      await change.mutateAsync({ path: `/api/staff/attributes/${encodeURIComponent(attribute.id)}`, method: "DELETE" });
      toastManager.add({ title: "Attribute deleted", description: "Its values were removed from everyone.", type: "success" });
    } catch (cause: unknown) {
      toastManager.add({ title: "Could not delete the attribute", description: errorText(cause, "Try again."), type: "error" });
    }
  }

  return (
    <QueryState query={query} label="Attributes">
      {({ attributes, people }) => (
        <div className="flex flex-col gap-4">
          {attributes.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon"><Tags aria-hidden="true" /></EmptyMedia>
                <EmptyTitle>No attributes yet</EmptyTitle>
                <EmptyDescription>Record things like Language, Speciality or Seniority for each {t.provider}. Routing rules and reports can then use them.</EmptyDescription>
              </EmptyHeader>
              <EmptyContent><Button type="button" size="lg" onClick={() => setEditing("new")}><Plus aria-hidden="true" /> New attribute</Button></EmptyContent>
            </Empty>
          ) : (
            <>
              <Frame>
                <FrameHeader className="flex-row items-start justify-between gap-3">
                  <div className="min-w-0">
                    <FrameTitle>Attributes</FrameTitle>
                    <FrameDescription>What you record about each {t.provider}.</FrameDescription>
                  </div>
                  <Button type="button" size="lg" onClick={() => setEditing("new")}><Plus aria-hidden="true" /> New attribute</Button>
                </FrameHeader>
                <FramePanel>
                  <ul aria-label="Attributes" className="flex flex-col divide-y">
                    {attributes.map((attribute) => (
                      <li key={attribute.id} className="flex items-start justify-between gap-3 py-3">
                        <div className="flex min-w-0 flex-col gap-1">
                          <span className="truncate font-medium">{attribute.name}</span>
                          <span className="flex flex-wrap gap-1">
                            <Badge variant="outline">{attributeKindLabels[attribute.kind]}</Badge>
                            {attribute.options.slice(0, 4).map((option) => <Badge key={option} variant="secondary">{option}</Badge>)}
                            {attribute.options.length > 4 ? <Badge variant="secondary">+{attribute.options.length - 4} more</Badge> : null}
                          </span>
                        </div>
                        <RichMenu>
                          <RichMenuTrigger render={<Button type="button" variant="ghost" size="icon-lg" aria-label={`More for ${attribute.name}`} />}><Ellipsis aria-hidden="true" /></RichMenuTrigger>
                          <RichMenuContent>
                            <RichMenuItem icon={<Pencil aria-hidden="true" />} onClick={() => setEditing(attribute)}>Edit attribute</RichMenuItem>
                            <RichMenuItem destructive icon={<Trash2 aria-hidden="true" />} onClick={() => void remove(attribute)}>Delete attribute</RichMenuItem>
                          </RichMenuContent>
                        </RichMenu>
                      </li>
                    ))}
                  </ul>
                </FramePanel>
              </Frame>
              <Frame>
                <FrameHeader>
                  <FrameTitle>People</FrameTitle>
                  <FrameDescription>Set the values for each {t.provider}.</FrameDescription>
                </FrameHeader>
                <FramePanel>
                  {people.length === 0 ? <p className="py-2 text-muted-foreground text-sm">No one is on a calendar yet.</p> : (
                    <ul aria-label={`${t.Practitioners} and their attributes`} className="flex flex-col divide-y">
                      {people.map((person) => (
                        <li key={person.practitionerId} className="flex items-center justify-between gap-3 py-2.5">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{person.name}</p>
                            <p className="truncate text-muted-foreground text-xs">
                              {Object.keys(person.values).length === 0 ? "Nothing set" : attributes.filter((attribute) => person.values[attribute.id] !== undefined).map((attribute) => `${attribute.name}: ${[person.values[attribute.id]].flat().join(", ")}`).join(" · ")}
                            </p>
                          </div>
                          <Button type="button" variant="outline" size="sm" onClick={() => setAssigning(person)}><UserRoundPen aria-hidden="true" /> Set<span className="sr-only"> values for {person.name}</span></Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </FramePanel>
              </Frame>
            </>
          )}
          <AttributeDialog target={editing} onClose={() => setEditing(null)} />
          <PersonDialog person={assigning} attributes={attributes} onClose={() => setAssigning(null)} />
        </div>
      )}
    </QueryState>
  );
}

function AttributeDialog({ target, onClose }: { target: AttributeView | "new" | null; onClose: () => void }) {
  const change = useOrgChange();
  const existing = target !== null && target !== "new" ? target : null;
  const { register, control, handleSubmit, reset, setError, formState: { errors } } = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: { name: "", kind: "single", options: "" } });
  const kind = useWatch({ control, name: "kind" });

  useEffect(() => {
    if (target === null) return;
    reset(existing ? { name: existing.name, kind: existing.kind, options: existing.options.join("\n") } : { name: "", kind: "single", options: "" });
    change.reset();
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps -- reset only when the dialog opens

  const choice = kind === "single" || kind === "multiple";
  const submit = handleSubmit(async (values) => {
    const options = choice ? optionList(values.options) : [];
    try {
      await change.mutateAsync(existing
        ? { path: `/api/staff/attributes/${encodeURIComponent(existing.id)}`, method: "PATCH", body: { name: values.name, ...(choice ? { options } : {}), version: existing.version } }
        : { path: "/api/staff/attributes", method: "POST", body: { name: values.name, kind: values.kind, options } });
      toastManager.add({ title: existing ? "Attribute saved" : "Attribute made", type: "success" });
      onClose();
    } catch (cause: unknown) {
      const fields = serverFieldErrors(cause);
      if (fields.name) setError("name", { message: fields.name });
      if (fields.options) setError("options", { message: fields.options });
    }
  });
  const formError = change.isError && Object.keys(serverFieldErrors(change.error)).length === 0 ? errorText(change.error, "The attribute could not be saved.") : "";

  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open && !change.isPending) onClose(); }}>
      <DialogPopup>
        <form onSubmit={(event) => void submit(event)} noValidate className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>{existing ? `Edit ${existing.name}` : "New attribute"}</DialogTitle>
            <DialogDescription>Choose what kind of answer it takes.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-5">
            {formError ? <Alert variant="error"><AlertDescription>{formError}</AlertDescription></Alert> : null}
            <TextField label="Name" autoComplete="off" placeholder="Language" error={errors.name?.message} {...register("name")} />
            <Controller control={control} name="kind" render={({ field }) => (
              <SelectField label="Kind" disabled={Boolean(existing)} hint={existing ? "The kind can't change once people have values." : undefined} value={field.value} onValueChange={(value) => field.onChange(value as AttributeKind)} options={attributeKinds.map((item) => ({ value: item, label: attributeKindLabels[item] }))} />
            )} />
            {choice ? <TextareaField label="Choices" rows={4} hint="One choice per line, at least two." error={errors.options?.message} {...register("options")} /> : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" size="lg" onClick={onClose} disabled={change.isPending}>Cancel</Button>
            <Button type="submit" size="lg" disabled={change.isPending}>{change.isPending ? <Spinner aria-hidden="true" /> : null}{existing ? "Save attribute" : "Make attribute"}</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

function PersonDialog({ person, attributes, onClose }: { person: PersonAttributesView | null; attributes: AttributeView[]; onClose: () => void }) {
  const change = useOrgChange();
  return (
    <Dialog open={person !== null} onOpenChange={(open) => { if (!open && !change.isPending) onClose(); }}>
      <DialogPopup>
        {person ? <PersonForm person={person} attributes={attributes} change={change} onClose={onClose} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function PersonForm({ person, attributes, change, onClose }: { person: PersonAttributesView; attributes: AttributeView[]; change: ReturnType<typeof useOrgChange>; onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string | number | string[] | null>>(() => ({ ...person.values }));

  async function save() {
    try {
      await change.mutateAsync({ path: `/api/staff/attributes/people/${encodeURIComponent(person.practitionerId)}`, method: "PUT", body: { values: Object.fromEntries(attributes.map((attribute) => [attribute.id, values[attribute.id] ?? null])) } });
      toastManager.add({ title: "Saved", type: "success" });
      onClose();
    } catch {
      // The error shows in the dialog.
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Values for {person.name}</DialogTitle>
        <DialogDescription>Leave one empty to clear it.</DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-5">
          {change.isError ? <Alert variant="error"><AlertDescription>{errorText(change.error, "The values could not be saved.")}</AlertDescription></Alert> : null}
          {attributes.map((attribute) => {
            const current = values[attribute.id];
            if (attribute.kind === "single") {
              return <SelectField key={attribute.id} label={attribute.name} optional value={typeof current === "string" ? current : ""} onValueChange={(value) => setValues((state) => ({ ...state, [attribute.id]: value || null }))} options={[{ value: "", label: "Not set" }, ...attribute.options.map((option) => ({ value: option, label: option }))]} />;
            }
            if (attribute.kind === "multiple") {
              const chosen = Array.isArray(current) ? current : [];
              return (
                <fieldset key={attribute.id} className="flex flex-col gap-1">
                  <legend className="mb-1 text-sm font-medium">{attribute.name}</legend>
                  <ul className="flex flex-col divide-y rounded-lg border">
                    {attribute.options.map((option) => {
                      const id = `attribute-${attribute.id}-${option}`;
                      return (
                        <li key={option} className="flex min-h-11 items-center gap-3 px-3 py-2">
                          <Checkbox id={id} aria-labelledby={`${id}-label`} checked={chosen.includes(option)} onCheckedChange={(checked: boolean) => setValues((state) => ({ ...state, [attribute.id]: checked ? [...chosen, option] : chosen.filter((entry) => entry !== option) }))} />
                          <label id={`${id}-label`} htmlFor={id} className="min-w-0 flex-1 text-sm">{option}</label>
                        </li>
                      );
                    })}
                  </ul>
                </fieldset>
              );
            }
            return (
              <TextField key={attribute.id} label={attribute.name} optional inputMode={attribute.kind === "number" ? "decimal" : undefined} autoComplete="off" value={current === undefined || current === null ? "" : String(current)}
                onChange={(event) => {
                  const text = event.target.value;
                  setValues((state) => ({ ...state, [attribute.id]: text === "" ? null : attribute.kind === "number" ? (Number.isFinite(Number(text)) ? Number(text) : state[attribute.id] ?? null) : text }));
                }} />
            );
          })}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="ghost" size="lg" onClick={onClose} disabled={change.isPending}>Cancel</Button>
          <Button type="button" size="lg" disabled={change.isPending} onClick={() => void save()}>{change.isPending ? <Spinner aria-hidden="true" /> : null}Save values</Button>
        </DialogFooter>
    </>
  );
}
