"use client";

import type { ReactNode } from "react";

import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxValue,
} from "@/components/ui/combobox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Fieldset, FieldsetLegend } from "@/components/ui/fieldset";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formLimits, type AddressAnswer, type FormAnswer, type FormField, type NameAnswer } from "@/lib/booking-forms";

/** The frame shared by questions made of several controls: a legend, help, the controls, a hint and the error. */
export function QuestionFieldset({
  id,
  field,
  required,
  error,
  locked,
  hideHelp,
  children,
}: {
  id: string;
  field: FormField;
  required: boolean;
  error?: string;
  locked?: boolean;
  /** The question shows its own help line (for example only once opened). */
  hideHelp?: boolean;
  children: ReactNode;
}) {
  const errorId = `${id}-error`;
  const helpId = `${id}-help`;
  return (
    <Fieldset
      id={id}
      tabIndex={-1}
      aria-describedby={error ? errorId : field.help && !hideHelp ? helpId : undefined}
      aria-invalid={error ? true : undefined}
      className="flex min-w-0 flex-col gap-2 outline-none"
    >
      <div className="flex w-full items-baseline justify-between gap-3">
        <FieldsetLegend id={`${id}-legend`} className="font-medium text-sm">{field.label}</FieldsetLegend>
        {required ? null : <span className="text-muted-foreground text-xs">Optional</span>}
      </div>
      {field.help && !hideHelp ? <p id={helpId} className="-mt-1 text-muted-foreground text-xs">{field.help}</p> : null}
      {children}
      {locked ? <p className="text-muted-foreground text-xs">Filled from your link</p> : null}
      {error ? <p id={errorId} role="alert" className="text-destructive-foreground text-xs">{error}</p> : null}
    </Fieldset>
  );
}

/**
 * Answers as large tappable chips in one wrapping row: one choice (tap it again to clear) or several.
 * Built on the coss ToggleGroup, so keys, focus and `aria-pressed` come from Base UI.
 */
export function ChipChoice({
  id,
  options,
  value,
  onChange,
  multiple = false,
  disabled,
}: {
  id: string;
  options: readonly string[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  multiple?: boolean;
  disabled?: boolean;
}) {
  return (
    <ToggleGroup
      aria-labelledby={`${id}-legend`}
      multiple={multiple}
      value={[...value]}
      onValueChange={(next: string[]) => onChange(next)}
      disabled={disabled}
      className="w-full flex-wrap gap-2"
    >
      {options.map((option, index) => (
        <ToggleGroupItem
          key={option}
          id={`${id}-${index}`}
          value={option}
          size="lg"
          className="h-auto min-h-11 whitespace-normal border-input px-4 py-2 text-start text-base data-pressed:border-primary data-pressed:bg-primary/10 sm:min-h-10 sm:text-sm"
        >
          {option}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function SubField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  invalid,
  disabled,
  className,
  maxLength = formLimits.shortText,
  inputMode,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  autoComplete?: string;
  invalid?: boolean;
  disabled?: boolean;
  className?: string;
  maxLength?: number;
  inputMode?: "numeric" | "text";
}) {
  return (
    <Field invalid={invalid} className={className}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        size="lg"
        value={value}
        autoComplete={autoComplete}
        inputMode={inputMode}
        maxLength={maxLength}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

/** First and last name as two boxes. The answer is `{ first, last }`. */
export function NameSplitQuestion({
  id,
  field,
  required,
  value,
  onChange,
  error,
  locked,
  disabled,
}: {
  id: string;
  field: FormField;
  required: boolean;
  value: FormAnswer | undefined;
  onChange: (value: FormAnswer | undefined) => void;
  error?: string;
  locked?: boolean;
  disabled?: boolean;
}) {
  const name: NameAnswer = value && typeof value === "object" && !Array.isArray(value) && "first" in value ? value : { first: "", last: "" };
  const set = (patch: Partial<NameAnswer>) => {
    const next = { ...name, ...patch };
    onChange(next.first === "" && next.last === "" ? undefined : next);
  };
  return (
    <QuestionFieldset id={id} field={field} required={required} error={error} locked={locked}>
      <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2">
        <SubField id={`${id}-first`} label="First name" value={name.first} autoComplete="off" invalid={Boolean(error)} disabled={disabled || locked} onChange={(first) => set({ first })} />
        <SubField id={`${id}-last`} label="Last name" value={name.last} autoComplete="off" invalid={Boolean(error)} disabled={disabled || locked} onChange={(last) => set({ last })} />
      </div>
    </QuestionFieldset>
  );
}

/** Street, second line, city, state and PIN code. The answer is `{ line1, line2?, city, state, pin }`. */
export function AddressQuestion({
  id,
  field,
  required,
  value,
  onChange,
  error,
  locked,
  disabled,
}: {
  id: string;
  field: FormField;
  required: boolean;
  value: FormAnswer | undefined;
  onChange: (value: FormAnswer | undefined) => void;
  error?: string;
  locked?: boolean;
  disabled?: boolean;
}) {
  const address: AddressAnswer = value && typeof value === "object" && !Array.isArray(value) && "line1" in value
    ? value
    : { line1: "", city: "", state: "", pin: "" };
  const set = (patch: Partial<AddressAnswer>) => {
    const merged = { ...address, ...patch };
    const next: AddressAnswer = {
      line1: merged.line1,
      ...(merged.line2 ? { line2: merged.line2 } : {}),
      city: merged.city,
      state: merged.state,
      pin: merged.pin,
    };
    onChange(Object.values(next).every((part) => part === "") ? undefined : next);
  };
  const invalid = Boolean(error);
  const off = disabled || locked;
  return (
    <QuestionFieldset id={id} field={field} required={required} error={error} locked={locked}>
      <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2">
        <SubField id={`${id}-line1`} className="min-[420px]:col-span-2" label="Address line 1" value={address.line1} autoComplete="address-line1" invalid={invalid} disabled={off} onChange={(line1) => set({ line1 })} />
        <SubField id={`${id}-line2`} className="min-[420px]:col-span-2" label="Address line 2 (optional)" value={address.line2 ?? ""} autoComplete="address-line2" disabled={off} onChange={(line2) => set({ line2 })} />
        <SubField id={`${id}-city`} label="City" value={address.city} autoComplete="address-level2" invalid={invalid} disabled={off} onChange={(city) => set({ city })} />
        <SubField id={`${id}-state`} label="State" value={address.state} autoComplete="address-level1" invalid={invalid} disabled={off} onChange={(state) => set({ state })} />
        <SubField id={`${id}-pin`} label="PIN code" value={address.pin} autoComplete="postal-code" inputMode="numeric" maxLength={10} invalid={invalid} disabled={off} onChange={(pin) => set({ pin })} />
      </div>
    </QuestionFieldset>
  );
}

/** A long list of options with search; the chosen ones show as chips. The answer is a list in the business's order. */
export function MultiSelectQuestion({
  id,
  field,
  required,
  value,
  onChange,
  error,
  locked,
  disabled,
}: {
  id: string;
  field: FormField;
  required: boolean;
  value: FormAnswer | undefined;
  onChange: (value: FormAnswer | undefined) => void;
  error?: string;
  locked?: boolean;
  disabled?: boolean;
}) {
  const options = field.options ?? [];
  const chosen = Array.isArray(value) ? value : [];
  return (
    <QuestionFieldset id={id} field={field} required={required} error={error} locked={locked}>
      <Combobox
        multiple
        items={options}
        value={chosen}
        disabled={disabled || locked}
        onValueChange={(next: string[]) => onChange(next.length ? options.filter((option) => next.includes(option)) : undefined)}
      >
        <ComboboxChips className="min-h-11 sm:min-h-8">
          <ComboboxValue>
            {(selected: string[]) => (
              <>
                {selected.map((item) => (
                  <ComboboxChip key={item} aria-label={item} removeProps={{ "aria-label": `Remove ${item}` }}>{item}</ComboboxChip>
                ))}
                <ComboboxChipsInput
                  id={`${id}-search`}
                  aria-labelledby={`${id}-legend`}
                  aria-invalid={error ? true : undefined}
                  placeholder={selected.length ? "" : "Search and pick"}
                />
              </>
            )}
          </ComboboxValue>
        </ComboboxChips>
        <ComboboxPopup>
          <ComboboxEmpty>Nothing matches. Check the spelling.</ComboboxEmpty>
          <ComboboxList>{(item: string) => <ComboboxItem key={item} value={item}>{item}</ComboboxItem>}</ComboboxList>
        </ComboboxPopup>
      </Combobox>
    </QuestionFieldset>
  );
}
