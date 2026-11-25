"use client";

import dynamic from "next/dynamic";
import { useId, type ComponentProps, type ReactNode } from "react";

import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { PhoneInput as PhoneInputType } from "@/components/reui/phone-input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

// The phone picker carries every country's number rules and flag, so only screens that show one load it.
const PhoneInput = dynamic(() => import("@/components/reui/phone-input").then((m) => m.PhoneInput), {
  loading: () => <Input size="lg" disabled aria-hidden="true" tabIndex={-1} />,
});

interface FieldShellProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  optional?: boolean;
  className?: string;
  children: ReactNode;
}

function FieldShell({ label, hint, error, optional, className, children }: FieldShellProps) {
  return (
    <Field invalid={Boolean(error)} className={cn("w-full", className)}>
      <div className="flex w-full items-baseline justify-between gap-3">
        <FieldLabel>{label}</FieldLabel>
        {optional ? <span className="text-muted-foreground text-xs">Optional</span> : null}
      </div>
      {children}
      {error ? <FieldError match>{error}</FieldError> : hint ? <FieldDescription>{hint}</FieldDescription> : null}
    </Field>
  );
}

type ShellProps = Omit<FieldShellProps, "children" | "className"> & { fieldClassName?: string };

export function TextField({
  label,
  hint,
  error,
  optional,
  fieldClassName,
  ...props
}: Omit<ComponentProps<typeof Input>, "size"> & ShellProps) {
  return (
    <FieldShell label={label} hint={hint} error={error} optional={optional} className={fieldClassName}>
      <Input size="lg" {...props} />
    </FieldShell>
  );
}

/**
 * A phone number with a country picker. The value is E.164 ("+919876543210") or "" while empty,
 * which the 7 to 32 character phone schemas accept. Numbers typed without a country code read as `defaultCountry`.
 */
export function PhoneField({
  id,
  label,
  hint,
  error,
  optional,
  fieldClassName,
  value,
  onChange,
  defaultCountry = "IN",
  required,
  autoComplete,
  autoFocus,
  placeholder,
  disabled,
}: ShellProps & {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  defaultCountry?: ComponentProps<typeof PhoneInputType>["defaultCountry"];
  required?: boolean;
  autoComplete?: string;
  autoFocus?: boolean;
  placeholder?: string;
  disabled?: boolean;
}) {
  const generatedId = useId();
  // Plain markup rather than Field: inside a Field the country button would be labelled as the number too.
  const inputId = id ?? generatedId;
  const noteId = `${inputId}-note`;
  return (
    <div className={cn("flex w-full flex-col items-start gap-2", fieldClassName)}>
      <div className="flex w-full items-baseline justify-between gap-3">
        <label htmlFor={inputId} className="inline-flex items-center gap-2 font-medium text-base/4.5 text-foreground sm:text-sm/4">{label}</label>
        {optional ? <span className="text-muted-foreground text-xs">Optional</span> : null}
      </div>
      <PhoneInput
        id={inputId}
        variant="lg"
        className="w-full"
        value={value}
        onChange={(next) => onChange(next ?? "")}
        defaultCountry={defaultCountry}
        required={required}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? noteId : undefined}
        inputMode="tel"
      />
      {error ? <p id={noteId} className="text-destructive-foreground text-xs">{error}</p> : hint ? <p id={noteId} className="text-muted-foreground text-xs">{hint}</p> : null}
    </div>
  );
}

export function TextareaField({
  label,
  hint,
  error,
  optional,
  fieldClassName,
  ...props
}: ComponentProps<typeof Textarea> & ShellProps) {
  return (
    <FieldShell label={label} hint={hint} error={error} optional={optional} className={fieldClassName}>
      <Textarea {...props} />
    </FieldShell>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface OptionSelectProps {
  id?: string;
  name?: string;
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  /** Shown when no option matches `value`. */
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  autoComplete?: string;
  className?: string;
  size?: "sm" | "default" | "lg";
  "aria-label"?: string;
  "aria-labelledby"?: string;
}

// Base UI reads "" as "no selection", so a real empty-valued option ("None") travels under a sentinel.
const emptyOptionValue = "__empty__";
const toItemValue = (value: string) => (value === "" ? emptyOptionValue : value);

/** Single-choice select on the coss Select primitive, driven by plain string options. */
export function OptionSelect({
  id,
  name,
  value,
  onValueChange,
  options,
  placeholder,
  disabled,
  required,
  autoComplete,
  className,
  size = "lg",
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
}: OptionSelectProps) {
  const selected = options.some((option) => option.value === value) ? value : null;
  return (
    <Select
      name={name}
      value={selected === null ? null : toItemValue(selected)}
      onValueChange={(next) => onValueChange(next === null || next === emptyOptionValue ? "" : next)}
      items={options.map(({ value: itemValue, label }) => ({ value: toItemValue(itemValue), label }))}
      disabled={disabled}
      required={required}
      autoComplete={autoComplete}
    >
      <SelectTrigger id={id} size={size} className={className} aria-label={ariaLabel} aria-labelledby={ariaLabelledBy}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectPopup>
        {options.map((option) => (
          <SelectItem key={option.value} value={toItemValue(option.value)} disabled={option.disabled}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

export function SelectField({
  label,
  hint,
  error,
  optional,
  fieldClassName,
  ...props
}: OptionSelectProps & ShellProps) {
  return (
    <FieldShell label={label} hint={hint} error={error} optional={optional} className={fieldClassName}>
      <OptionSelect {...props} />
    </FieldShell>
  );
}
