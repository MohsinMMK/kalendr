"use client";

import { ArrowLeft, Plus } from "lucide-react";
import { useState } from "react";

import { TextField, TextareaField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CheckboxGroup } from "@/components/ui/checkbox-group";
import { Frame, FrameDescription, FrameFooter, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Label } from "@/components/ui/label";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import { BookingFormQuestion } from "@/features/booking/booking-form-question";
import {
  formDefinitionDraftSchema,
  formLimits,
  hasOptions,
  isFieldVisible,
  newFieldId,
  type FormAnswer,
  type FormDefinitionDraft,
  type FormField,
  type FormFieldType,
} from "@/lib/booking-forms";

import { useTerms } from "../terms/business-profile-context";
import { QuestionEditor } from "./booking-form-question-editor";
import { RequiredByService } from "./booking-form-required-by-service";
import { cleanDraft, moveBlocker, withoutConditionsOn } from "./booking-form-rules";
import { useCatalogLookups } from "./clinic-catalog";
import { StaffApiError } from "./queries/http";
import { staffMutation } from "./staff-snapshot-provider";

export interface Editing {
  /** The form's key when it already exists; null for a new form. */
  key: string | null;
  draft: FormDefinitionDraft;
}

export function cloneFields(fields: readonly FormField[]): FormField[] {
  return fields.map((field) => ({
    ...field,
    ...(field.options ? { options: [...field.options] } : {}),
    ...(field.showWhen ? { showWhen: field.showWhen.map((condition) => ({ ...condition, value: Array.isArray(condition.value) ? [...condition.value] : condition.value })) } : {}),
  }));
}

export function blankQuestion(existing: readonly FormField[]): FormField {
  return { id: newFieldId(existing), type: "short_text", label: "", required: false };
}

/** Error messages keyed by zod path, such as `fields.0.options`. The first message for a path wins. */
function errorsByPath(draft: FormDefinitionDraft): { errors: Record<string, string>; first: string } {
  const result = formDefinitionDraftSchema.safeParse(cleanDraft(draft));
  if (result.success) return { errors: {}, first: "" };
  const errors: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const path = issue.path.join(".");
    errors[path] ??= issue.message;
  }
  return { errors, first: result.error.issues[0]?.message ?? "Check the form and try again." };
}

interface FormEditorProps {
  initial: Editing;
  canChange: boolean;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}

export function FormEditor({ initial, canChange, onCancel, onSaved }: FormEditorProps) {
  const t = useTerms();
  const catalog = useCatalogLookups();
  const [draft, setDraft] = useState<FormDefinitionDraft>(initial.draft);
  const [showErrors, setShowErrors] = useState(false);
  const [pending, setPending] = useState(false);
  const [serverMessage, setServerMessage] = useState("");
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [answers, setAnswers] = useState<Record<string, FormAnswer>>({});

  const check = errorsByPath(draft);
  const errors = { ...serverErrors, ...(showErrors ? check.errors : {}) };
  const message = serverMessage || (showErrors ? check.first : "");
  const disabled = !canChange || pending;
  const atLimit = draft.fields.length >= formLimits.fields;

  function update(patch: Partial<FormDefinitionDraft>) {
    setServerMessage("");
    setServerErrors({});
    setDraft((before) => ({ ...before, ...patch }));
  }

  function updateField(index: number, change: (field: FormField) => FormField) {
    setServerMessage("");
    setServerErrors({});
    const current = draft.fields[index];
    if (!current) return;
    let fields = draft.fields.map((field, at) => (at === index ? change(field) : field));
    const changed = fields[index]!;
    // A hidden question is never shown, so no other question can depend on its answer.
    if (changed.hidden && !current.hidden) {
      const stripped = withoutConditionsOn(fields, changed.id);
      fields = stripped.fields;
      if (stripped.changed > 0) toastManager.add({ title: "Questions that depended on this one now always show.", type: "info" });
    }
    setDraft((before) => ({ ...before, fields }));
  }

  function changeType(index: number, type: FormFieldType) {
    updateField(index, (field) => {
      const next: FormField = { ...field, type };
      if (hasOptions(type)) next.options = field.options && field.options.length > 0 ? field.options : ["", ""];
      else delete next.options;
      if (type === "consent") next.required = true;
      return next;
    });
    setAnswers((before) => {
      const next = { ...before };
      delete next[draft.fields[index]?.id ?? ""];
      return next;
    });
  }

  function moveField(index: number, by: -1 | 1) {
    const blocked = moveBlocker(draft.fields, index, by);
    if (blocked) {
      toastManager.add({ title: "That question cannot move there", description: blocked, type: "warning" });
      return;
    }
    setServerErrors({});
    setDraft((before) => {
      const target = index + by;
      if (target < 0 || target >= before.fields.length) return before;
      const fields = [...before.fields];
      [fields[index], fields[target]] = [fields[target]!, fields[index]!];
      return { ...before, fields };
    });
  }

  function removeField(index: number) {
    const removed = draft.fields[index];
    if (!removed) return;
    setServerErrors({});
    const stripped = withoutConditionsOn(draft.fields.filter((_, at) => at !== index), removed.id);
    if (stripped.changed > 0) toastManager.add({ title: "Questions that depended on it now always show.", type: "info" });
    setDraft((before) => ({ ...before, fields: stripped.fields }));
  }

  function addField() {
    setDraft((before) =>
      before.fields.length >= formLimits.fields ? before : { ...before, fields: [...before.fields, blankQuestion(before.fields)] },
    );
  }

  async function save() {
    setShowErrors(true);
    setServerMessage("");
    setServerErrors({});
    const result = formDefinitionDraftSchema.safeParse(cleanDraft(draft));
    if (!result.success) return;
    setPending(true);
    try {
      if (initial.key) await staffMutation(`/api/staff/forms/${encodeURIComponent(initial.key)}`, "PATCH", result.data);
      else await staffMutation("/api/staff/forms", "POST", result.data);
      await onSaved();
    } catch (cause: unknown) {
      setServerMessage(cause instanceof Error ? cause.message : "The booking form could not be saved.");
      if (cause instanceof StaffApiError) {
        setServerErrors(Object.fromEntries(Object.entries(cause.fieldErrors).flatMap(([path, messages]) => (messages[0] ? [[path, messages[0]]] : []))));
      }
      setPending(false);
    }
  }

  const previewFields = draft.fields.map((field) => ({
    ...field,
    label: field.label.trim() || "Untitled question",
    ...(field.options ? { options: [...new Set(field.options.map((option) => option.trim()).filter(Boolean))] } : {}),
  }));

  return (
    <form
      className="@container flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      noValidate
    >
      <div>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          <ArrowLeft aria-hidden="true" /> All booking forms
        </Button>
      </div>
      <div className="grid items-start gap-4 @3xl:grid-cols-[minmax(0,1fr)_18rem] @4xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <Frame>
            <FrameHeader>
              <FrameTitle>{initial.key ? "Edit form" : "New form"}</FrameTitle>
              <FrameDescription>
                {initial.key
                  ? `Saving creates a new version. Answers ${t.customers} already gave stay as they were.`
                  : `${t.Customers} answer these questions when they book.`}
              </FrameDescription>
            </FrameHeader>
            <FramePanel className="flex flex-col gap-4">
              <TextField
                label="Form name"
                value={draft.name}
                onChange={(event) => update({ name: event.target.value })}
                maxLength={formLimits.name}
                error={errors.name}
                disabled={disabled}
              />
              <TextareaField
                label="Short description"
                hint={`Shown to ${t.customers} above the questions.`}
                optional
                value={draft.description}
                onChange={(event) => update({ description: event.target.value })}
                maxLength={formLimits.description}
                error={errors.description}
                disabled={disabled}
              />
              <div className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <Label htmlFor="booking-form-active" className="font-medium">{t.Customers} see this form</Label>
                  <p className="text-xs text-muted-foreground">Turn it off to stop asking these questions without losing them.</p>
                </div>
                <Switch
                  id="booking-form-active"
                  checked={draft.isActive}
                  onCheckedChange={(on) => update({ isActive: on })}
                  disabled={disabled}
                />
              </div>
            </FramePanel>
          </Frame>

          <Frame>
            <FrameHeader>
              <FrameTitle id="booking-form-scope">Ask for</FrameTitle>
              <FrameDescription>Which {t.services} show this form when someone books.</FrameDescription>
            </FrameHeader>
            <FramePanel className="flex flex-col gap-4">
              <RadioGroup
                aria-labelledby="booking-form-scope"
                value={draft.appliesToAll ? "all" : "chosen"}
                onValueChange={(next) => update({ appliesToAll: next === "all" })}
                disabled={disabled}
                className="flex flex-col gap-2"
              >
                <Label className="flex cursor-pointer items-center gap-3 font-normal">
                  <Radio value="all" /> All {t.services}
                </Label>
                <Label className="flex cursor-pointer items-center gap-3 font-normal">
                  <Radio value="chosen" /> Only the {t.services} I choose
                </Label>
              </RadioGroup>
              {!draft.appliesToAll ? (
                <div className="flex flex-col gap-2 rounded-lg border p-3">
                  <p id="booking-form-services" className="font-medium text-sm">{t.Services}</p>
                  {catalog.services.length === 0 ? (
                    <p className="text-sm text-muted-foreground">Add {t.services} first, then choose them here.</p>
                  ) : (
                    <CheckboxGroup
                      aria-labelledby="booking-form-services"
                      value={draft.serviceIds}
                      onValueChange={(next) => update({ serviceIds: next })}
                      disabled={disabled}
                      className="gap-2"
                    >
                      {catalog.services.map((service) => (
                        <Label key={service.id} className="flex cursor-pointer items-center gap-3 font-normal">
                          <Checkbox value={service.id} />
                          {service.name}
                        </Label>
                      ))}
                    </CheckboxGroup>
                  )}
                  {errors.serviceIds ? <p className="text-xs text-destructive-foreground">{errors.serviceIds}</p> : null}
                </div>
              ) : null}
              <RequiredByService
                draft={draft}
                services={catalog.services}
                serviceWord={t.service}
                errors={errors}
                disabled={disabled}
                onChange={(requiredOverrides) => update({ requiredOverrides })}
              />
            </FramePanel>
          </Frame>

          <Frame>
            <FrameHeader>
              <FrameTitle>Questions</FrameTitle>
              <FrameDescription>
                {draft.fields.length} of {formLimits.fields} questions. {t.Customers} see them in this order.
              </FrameDescription>
            </FrameHeader>
            {draft.fields.length === 0 ? (
              <FramePanel>
                <p className="text-sm text-muted-foreground">No questions yet. Add one below.</p>
              </FramePanel>
            ) : null}
            {draft.fields.map((field, index) => (
              <QuestionEditor
                key={field.id}
                field={field}
                fields={draft.fields}
                index={index}
                errors={errors}
                disabled={disabled}
                onChange={(change) => updateField(index, change)}
                onTypeChange={(type) => changeType(index, type)}
                onMove={(by) => moveField(index, by)}
                onRemove={() => removeField(index)}
              />
            ))}
            <FrameFooter className="flex flex-col gap-3">
              {errors.fields ? <p className="text-xs text-destructive-foreground">{errors.fields}</p> : null}
              <div className="flex flex-wrap items-center gap-3">
                <Button type="button" variant="outline" onClick={addField} disabled={disabled || atLimit}>
                  <Plus aria-hidden="true" /> Add question
                </Button>
                {atLimit ? <p className="text-xs text-muted-foreground">A form can have up to {formLimits.fields} questions.</p> : null}
              </div>
            </FrameFooter>
          </Frame>

          <div className="flex flex-wrap items-center justify-between gap-3">
            {message ? <p role="alert" className="text-sm text-destructive-foreground">{message}</p> : <span />}
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>Cancel</Button>
              <Button type="submit" disabled={disabled}>
                {pending ? <Spinner aria-hidden="true" /> : null}
                Save booking form
              </Button>
            </div>
          </div>
        </div>

        <aside aria-labelledby="booking-form-preview-title" className="min-w-0 @3xl:sticky @3xl:top-0">
          <Frame>
            <FrameHeader>
              <FrameTitle id="booking-form-preview-title">Preview</FrameTitle>
              <FrameDescription>What {t.customers} see. Answers here are not saved.</FrameDescription>
            </FrameHeader>
            <FramePanel className="flex flex-col gap-5">
              <div className="flex flex-col gap-1">
                <p className="font-heading font-semibold text-base">{draft.name.trim() || "Untitled form"}</p>
                {draft.description.trim() ? <p className="text-sm text-muted-foreground">{draft.description}</p> : null}
              </div>
              {previewFields.length === 0 ? (
                <p className="text-sm text-muted-foreground">Questions you add appear here.</p>
              ) : (
                previewFields.filter((field) => isFieldVisible(field, answers, previewFields)).map((field) => (
                  <BookingFormQuestion
                    key={field.id}
                    field={field}
                    idPrefix="preview"
                    value={answers[field.id]}
                    onChange={(value) =>
                      setAnswers((before) => {
                        const next = { ...before };
                        if (value === undefined) delete next[field.id];
                        else next[field.id] = value;
                        return next;
                      })
                    }
                  />
                ))
              )}
            </FramePanel>
          </Frame>
        </aside>
      </div>
    </form>
  );
}

