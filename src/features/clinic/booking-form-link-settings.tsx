"use client";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { builtInPrefillKeys, formFieldTypeLabels, type FormField, type FormFieldType } from "@/lib/booking-forms";

/** Hidden questions are plain answers: text, number, date, email, phone or web address. */
const hideableTypes: readonly FormFieldType[] = ["short_text", "long_text", "number", "date", "email", "phone", "url"];

export const canBeHidden = (field: FormField): boolean => hideableTypes.includes(field.type);

interface LinkSettingsProps {
  field: FormField;
  errors: { prefillKey?: string; hidden?: string };
  disabled: boolean;
  onChange: (change: (field: FormField) => FormField) => void;
}

/**
 * Fill a question from the booking link (`?campaign=diwali`). A hidden question is never shown: it only records what
 * the link carried, such as which campaign sent the customer. A locked one shows the value but cannot be changed.
 */
export function LinkSettings({ field, errors, disabled, onChange }: LinkSettingsProps) {
  const id = `booking-form-q-${field.id}`;
  const on = field.prefillKey !== undefined || Boolean(field.hidden);
  const key = field.prefillKey ?? "";
  const hideable = canBeHidden(field);

  function turnOn(next: boolean) {
    onChange((before) => {
      const { prefillKey, hidden, lockWhenPrefilled, ...rest } = before;
      void prefillKey; void hidden; void lockWhenPrefilled;
      return next ? { ...rest, prefillKey: "" } : rest;
    });
  }

  function setHidden(next: boolean) {
    onChange((before) => {
      const { showWhen, lockWhenPrefilled, ...rest } = before;
      void showWhen; void lockWhenPrefilled;
      return next ? { ...rest, hidden: true, required: false } : { ...rest, hidden: false };
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Label htmlFor={`${id}-link`} className="font-medium">Fill this from the booking link</Label>
          <p className="text-muted-foreground text-xs">For a source or campaign you put in the link, so nobody types it.</p>
        </div>
        <Switch id={`${id}-link`} checked={on} onCheckedChange={turnOn} disabled={disabled} />
      </div>
      {on ? (
        <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-key`}>Link name</Label>
            <Input id={`${id}-key`} size="lg" value={key} maxLength={30} placeholder="campaign" autoCapitalize="none" autoCorrect="off" spellCheck={false}
              aria-invalid={errors.prefillKey ? true : undefined} aria-describedby={`${id}-key-help`} disabled={disabled}
              onChange={(event) => onChange((before) => ({ ...before, prefillKey: event.target.value.trim() }))} />
            {errors.prefillKey ? <p role="alert" id={`${id}-key-help`} className="text-destructive-foreground text-xs">{errors.prefillKey}</p> : (
              <p id={`${id}-key-help`} className="text-muted-foreground text-xs">
                Add it to the end of your booking link, like <code className="rounded bg-muted px-1">?{key || "campaign"}=diwali</code>. These names are already used and cannot be picked: {builtInPrefillKeys.join(", ")}.
              </p>
            )}
          </div>
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <Label htmlFor={`${id}-hidden`} className="font-medium">Hidden (filled from the link)</Label>
              <p className="text-muted-foreground text-xs">
                {hideable ? "Not shown to the customer. The value is saved with their answers." : `A hidden question cannot be a “${formFieldTypeLabels[field.type]}” question.`}
              </p>
            </div>
            <Switch id={`${id}-hidden`} checked={Boolean(field.hidden)} onCheckedChange={setHidden} disabled={disabled || !hideable} />
          </div>
          {errors.hidden ? <p role="alert" className="text-destructive-foreground text-xs">{errors.hidden}</p> : null}
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <Label htmlFor={`${id}-lock`} className="font-medium">Lock when filled from the link</Label>
              <p className="text-muted-foreground text-xs">{field.hidden ? "A hidden question is never shown, so there is nothing to lock." : "They see the value but cannot change it."}</p>
            </div>
            <Switch id={`${id}-lock`} checked={Boolean(field.lockWhenPrefilled) && !field.hidden} disabled={disabled || Boolean(field.hidden)}
              onCheckedChange={(next) => onChange((before) => ({ ...before, lockWhenPrefilled: next }))} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function HiddenBadge() {
  return <Badge variant="outline">Hidden</Badge>;
}
