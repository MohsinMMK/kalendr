"use client";

import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { CalendarDays, ChevronDown } from "lucide-react";

import { inlineTriggerClass } from "@/components/inline-field";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/** `YYYY-MM-DD` to a local-midnight Date, so calendar cells match the clinic date string. */
export function dateFromKey(key: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : undefined;
}

export function keyFromDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const displayFormat = new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });

/** The coss Calendar for one day, valued as a `YYYY-MM-DD` string and bounded by optional min and max days. */
export function DateCalendar({ value, onValueChange, min, max, isDateDisabled }: {
  value: string;
  onValueChange: (value: string) => void;
  min?: string;
  max?: string;
  isDateDisabled?: (date: Date) => boolean;
}) {
  const selected = dateFromKey(value);
  const minDate = min ? dateFromKey(min) : undefined;
  const maxDate = max ? dateFromKey(max) : undefined;
  return (
    <Calendar
      mode="single"
      selected={selected}
      defaultMonth={selected ?? minDate}
      startMonth={minDate}
      endMonth={maxDate}
      disabled={(date: Date) =>
        Boolean((minDate && date < minDate) || (maxDate && date > maxDate) || isDateDisabled?.(date))
      }
      onSelect={(date: Date | undefined) => { if (date) onValueChange(keyFromDate(date)); }}
    />
  );
}

/** Date input on the coss Popover + Calendar pattern, valued as a `YYYY-MM-DD` string. */
export function DatePicker({
  id,
  value,
  onValueChange,
  placeholder = "Choose a date",
  disabled,
  min,
  max,
  isDateDisabled,
  formatLabel,
  className,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledBy,
  ...buttonProps
}: {
  id?: string;
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  min?: string;
  max?: string;
  isDateDisabled?: (date: Date) => boolean;
  /** A shorter way to write the chosen date on the button, for tight spaces. */
  formatLabel?: (date: Date) => string;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
} & Pick<ComponentProps<typeof Button>, "size" | "aria-describedby" | "aria-invalid">) {
  const [open, setOpen] = useState(false);
  const selected = dateFromKey(value);
  const label = selected ? (formatLabel ?? displayFormat.format)(selected) : placeholder;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            id={id}
            size="lg"
            variant="outline"
            disabled={disabled}
            aria-label={ariaLabel ? `${ariaLabel}: ${label}` : undefined}
            aria-labelledby={ariaLabelledBy}
            className={cn("w-full justify-start font-normal", !selected && "text-muted-foreground", className)}
            {...buttonProps}
          />
        }
      >
        <CalendarDays aria-hidden="true" />
        {label}
      </PopoverTrigger>
      <PopoverPopup align="start">
        <DateCalendar
          value={value}
          min={min}
          max={max}
          isDateDisabled={isDateDisabled}
          onValueChange={(next) => { onValueChange(next); setOpen(false); }}
        />
      </PopoverPopup>
    </Popover>
  );
}

/** A DatePicker with a visible label. The trigger's accessible name reads the label, then the chosen date. */
export function DateField({
  label,
  fieldClassName,
  ...props
}: Omit<ComponentProps<typeof DatePicker>, "id" | "aria-label" | "aria-labelledby"> & {
  label: ReactNode;
  fieldClassName?: string;
}) {
  const id = useId();
  return (
    <div className={cn("flex w-full flex-col items-start gap-2", fieldClassName)}>
      <span id={`${id}-label`} className="font-medium text-base/4.5 sm:text-sm/4">{label}</span>
      <DatePicker id={id} aria-labelledby={`${id}-label ${id}`} {...props} />
    </div>
  );
}

/**
 * A date as a Notion-style property value: quiet text that opens the coss Calendar. With `onClear`, the
 * popup offers to empty it.
 */
export function InlineDatePicker({ label, value, onValueChange, onClear, placeholder = "Empty", disabled, min, max, isDateDisabled, className }: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  onClear?: () => void;
  placeholder?: string;
  disabled?: boolean;
  min?: string;
  max?: string;
  isDateDisabled?: (date: Date) => boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = dateFromKey(value);
  const text = selected ? displayFormat.format(selected) : placeholder;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger disabled={disabled} aria-label={`${label}: ${text}`} className={cn(inlineTriggerClass, "tabular-nums", className)}>
        <span className={cn("min-w-0 truncate", !selected && "text-muted-foreground/72")}>{text}</span>
        <ChevronDown aria-hidden="true" className="ms-auto size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-data-popup-open:opacity-100" />
      </PopoverTrigger>
      <PopoverPopup align="start" aria-label={label}>
        <DateCalendar
          value={value}
          min={min}
          max={max}
          isDateDisabled={isDateDisabled}
          onValueChange={(next) => { onValueChange(next); setOpen(false); }}
        />
        {onClear && selected ? (
          <div className="mt-2 flex justify-end border-t pt-2">
            <Button size="xs" variant="ghost" onClick={() => { onClear(); setOpen(false); }}>Clear</Button>
          </div>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}
