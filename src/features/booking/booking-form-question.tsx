"use client";

import { useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formLimits, type FormAnswer, type FormField } from "@/lib/booking-forms";
import { GUESTS_MAX } from "@/lib/booking-intake";

import { EmailList } from "./email-list";
import { AddressQuestion, ChipChoice, MultiSelectQuestion, NameSplitQuestion, QuestionFieldset } from "./form-question-composites";

interface BookingFormQuestionProps {
  field: FormField;
  value: FormAnswer | undefined;
  onChange: (value: FormAnswer | undefined) => void;
  error?: string;
  /** Prefix for element ids, so two copies of a form (such as a builder preview) never share ids. */
  idPrefix?: string;
  disabled?: boolean;
  /** Whether an answer is needed for this service. A per-service setting can differ from `field.required`. */
  required?: boolean;
  /** Shown read-only because the booking link filled it in. */
  locked?: boolean;
  /**
   * For an optional text question: whether the customer tapped No. Kept by the caller so it survives leaving the screen;
   * it is never an answer and is never sent. Without it the choice is only remembered while this question is shown.
   */
  declined?: boolean;
  onDeclinedChange?: (declined: boolean) => void;
}

function Optional({ required }: { required: boolean }) {
  return required ? null : <span className="text-muted-foreground text-xs">Optional</span>;
}

/**
 * An optional free-text question starts as a tap: No or Yes. Yes opens the box; No (or never touching it) leaves no
 * answer. A saved answer, a link-filled one or an error keeps the box open.
 */
function OptionalTextQuestion({ id, field, value, onChange, error, locked, disabled, declined: declinedProp, onDeclinedChange }: Pick<BookingFormQuestionProps, "field" | "value" | "onChange" | "error" | "locked" | "disabled" | "declined" | "onDeclinedChange"> & { id: string }) {
  const text = typeof value === "string" ? value : "";
  const [yes, setYes] = useState(Boolean(text));
  const [localDeclined, setLocalDeclined] = useState(false);
  const declined = declinedProp ?? localDeclined;
  const setDeclined = (next: boolean) => {
    setLocalDeclined(next);
    onDeclinedChange?.(next);
  };
  const open = yes || Boolean(text) || Boolean(error) || Boolean(locked);
  const errorId = `${id}-error`;
  const helpId = `${id}-help`;
  const describedBy = error ? errorId : field.help ? helpId : undefined;
  return (
    <QuestionFieldset id={id} field={field} required error={error} locked={locked} hideHelp>
      <ChipChoice
        id={id}
        options={["No", "Yes"]}
        value={open ? ["Yes"] : declined ? ["No"] : []}
        disabled={disabled || locked}
        onChange={(next) => {
          const picked = next[0] as "Yes" | "No" | undefined;
          // Tapping the chosen chip again empties the group. Yes must stay (the typed text is kept), and No stays No.
          if (!picked) return;
          setYes(picked === "Yes");
          setDeclined(picked === "No");
          if (picked === "No") onChange(undefined);
        }}
      />
      {open ? (
        <div className="flex flex-col gap-1.5">
          {field.help ? <p id={helpId} className="text-muted-foreground text-xs">{field.help}</p> : null}
          {field.type === "long_text" ? (
            <Textarea id={`${id}-text`} aria-label={field.label} autoFocus={!text && !locked} value={text} maxLength={formLimits.longText}
              onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value)}
              aria-describedby={describedBy} disabled={disabled} readOnly={locked} />
          ) : (
            <Input id={`${id}-text`} size="lg" aria-label={field.label} autoFocus={!text && !locked} value={text} maxLength={formLimits.shortText} autoComplete="off"
              onChange={(event) => onChange(event.target.value === "" ? undefined : event.target.value)}
              aria-describedby={describedBy} disabled={disabled} readOnly={locked} />
          )}
        </div>
      ) : null}
    </QuestionFieldset>
  );
}

/** One question from a business's booking form, rendered with the matching coss control. */
export function BookingFormQuestion({ field, value, onChange, error, idPrefix = "form", disabled: disabledProp, required = field.required, locked, declined, onDeclinedChange }: BookingFormQuestionProps) {
  const id = `${idPrefix}-${field.id}`;
  // A text answer filled from the link stays selectable and is announced as read-only; the other controls switch off.
  const textLike = !["radio", "checkbox_group", "multi_select", "single_choice", "multiple_choice", "yes_no", "consent", "address", "name_split", "emails"].includes(field.type);
  const disabled = disabledProp || (locked && !textLike);
  const errorId = `${id}-error`;
  const helpId = `${id}-help`;
  const describedBy = error ? errorId : field.help ? helpId : undefined;

  if (field.type === "consent") {
    return (
      <div className="flex flex-col gap-1.5" id={id} tabIndex={-1}>
        <Label className="flex cursor-pointer items-start gap-3 font-normal">
          <Checkbox
            className="mt-0.5"
            checked={value === true}
            onCheckedChange={(checked) => onChange(checked ? true : undefined)}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy}
            disabled={disabled}
          />
          <span className="flex flex-col gap-0.5">
            <span className="font-medium text-sm">{field.label}</span>
            {field.help ? <span id={helpId} className="text-muted-foreground text-xs">{field.help}</span> : null}
          </span>
        </Label>
        {error ? <p id={errorId} className="text-destructive-foreground text-xs">{error}</p> : null}
      </div>
    );
  }

  if (field.type === "multi_select") {
    return <MultiSelectQuestion id={id} field={field} required={required} value={value} onChange={onChange} error={error} locked={locked} disabled={disabled} />;
  }

  if (field.type === "address") {
    return <AddressQuestion id={id} field={field} required={required} value={value} onChange={onChange} error={error} locked={locked} disabled={disabled} />;
  }

  if (field.type === "name_split") {
    return <NameSplitQuestion id={id} field={field} required={required} value={value} onChange={onChange} error={error} locked={locked} disabled={disabled} />;
  }

  if (field.type === "emails") {
    return (
      <QuestionFieldset id={id} field={field} required={required} error={error} locked={locked}>
        <EmailList
          id={`${id}-email`}
          value={Array.isArray(value) ? value : []}
          onChange={(next) => onChange(next.length ? next : undefined)}
          max={GUESTS_MAX}
          rowLabel="Email address"
          addLabel="Add another email address"
          invalid={Boolean(error)}
          describedBy={error ? errorId : undefined}
          disabled={disabled}
        />
      </QuestionFieldset>
    );
  }

  if (field.type === "radio" || field.type === "single_choice" || field.type === "yes_no" || field.type === "multiple_choice" || field.type === "checkbox_group") {
    const multiple = field.type === "multiple_choice" || field.type === "checkbox_group";
    const options = field.type === "yes_no" ? ["Yes", "No"] : (field.options ?? []);
    const chosen = multiple ? (Array.isArray(value) ? value : []) : field.type === "yes_no" ? (value === true ? ["Yes"] : value === false ? ["No"] : []) : typeof value === "string" ? [value] : [];
    return (
      <QuestionFieldset id={id} field={field} required={required} error={error} locked={locked}>
        <ChipChoice
          id={id}
          options={options}
          value={chosen}
          multiple={multiple}
          disabled={disabled}
          onChange={(next) => {
            if (multiple) {
              // Keep the business's order, whatever order the chips were tapped in.
              onChange(next.length ? options.filter((option) => next.includes(option)) : undefined);
            } else if (next.length === 0) {
              // A second tap on the chosen chip empties the group: a required question keeps its answer, an optional one clears.
              if (!required) onChange(undefined);
            }
            else onChange(field.type === "yes_no" ? next[0] === "Yes" : next[0]);
          }}
        />
      </QuestionFieldset>
    );
  }

  if ((field.type === "short_text" || field.type === "long_text") && !required) {
    return <OptionalTextQuestion id={id} field={field} value={value} onChange={onChange} error={error} locked={locked} disabled={disabled} declined={declined} onDeclinedChange={onDeclinedChange} />;
  }

  const text = typeof value === "string" ? value : "";
  const set = (next: string) => onChange(next === "" ? undefined : next);
  return (
    <Field invalid={Boolean(error)} className="w-full">
      <div className="flex w-full items-baseline justify-between gap-3">
        <FieldLabel htmlFor={id}>{field.label}</FieldLabel>
        <Optional required={required} />
      </div>
      {field.type === "long_text" ? (
        <Textarea id={id} value={text} onChange={(event) => set(event.target.value)} maxLength={formLimits.longText}
          aria-describedby={describedBy} disabled={disabled} readOnly={locked} />
      ) : (
        <Input
          id={id}
          size="lg"
          value={text}
          onChange={(event) => set(event.target.value)}
          type={field.type === "email" ? "email" : field.type === "phone" ? "tel" : field.type === "date" ? "date" : field.type === "url" ? "url" : "text"}
          inputMode={field.type === "number" ? "decimal" : field.type === "url" ? "url" : undefined}
          autoComplete={field.type === "email" ? "email" : field.type === "phone" ? "tel" : "off"}
          placeholder={field.type === "url" ? "https://" : undefined}
          maxLength={field.type === "url" ? 300 : formLimits.shortText}
          aria-describedby={describedBy}
          disabled={disabled}
          readOnly={locked}
        />
      )}
      {locked ? <FieldDescription id={helpId}>Filled from your link</FieldDescription> : null}
      {error ? <FieldError match id={errorId}>{error}</FieldError> : field.help && !locked ? <FieldDescription id={helpId}>{field.help}</FieldDescription> : null}
    </Field>
  );
}
