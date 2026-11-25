"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown, Search } from "lucide-react";

import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "@/components/ui/combobox";
import { inlineTriggerClass } from "@/components/inline-field";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export interface Choice {
  id: string;
  label: string;
  detail?: string;
  leading?: ReactNode;
}

const choiceText = (choice: Choice) => `${choice.label} ${choice.detail ?? ""}`.toLocaleLowerCase();

/**
 * A value that opens a searchable list, like a Notion select. Built on the coss Combobox with the search
 * box inside the popup, so it is keyboard-first and announced as a combobox.
 */
export function ChoiceField({ label, value, choices, onPick, placeholder, empty, loading, disabled, header, body, onOpenChange, className }: {
  label: string;
  value?: Choice;
  choices: Choice[];
  onPick: (id: string) => void;
  placeholder: string;
  empty: string;
  loading?: boolean;
  disabled?: boolean;
  /** Shown above the search, such as the day for times. */
  header?: ReactNode;
  /** Replaces the search and list while set, such as a calendar for picking another day. */
  body?: ReactNode;
  /** Lets a caller load its choices only when the list opens. */
  onOpenChange?: (open: boolean) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  // The current value may not be among the choices (a time, say), so selection is matched by id.
  const selected = value ? choices.find((choice) => choice.id === value.id) ?? null : null;
  return (
    <Combobox<Choice>
      items={choices}
      value={selected}
      open={open}
      disabled={disabled}
      autoHighlight
      onOpenChange={(next) => { setOpen(next); onOpenChange?.(next); }}
      itemToStringLabel={(choice) => choice.label}
      isItemEqualToValue={(a, b) => a.id === b.id}
      filter={(choice, query) => choiceText(choice).includes(query.trim().toLocaleLowerCase())}
      onValueChange={(choice) => {
        // Only a pick from the open list counts: typing on the closed trigger must never save a change.
        if (!open || !choice) return;
        onPick(choice.id);
        setOpen(false);
        onOpenChange?.(false);
      }}
    >
      <ComboboxTrigger aria-label={`${label}: ${value?.label ?? placeholder}`} className={cn(inlineTriggerClass, className)}>
        {value?.leading}
        <span className={cn("min-w-0 truncate", !value && "text-muted-foreground/72")}>{value?.label ?? placeholder}</span>
        {value?.detail ? <span className="shrink-0 text-xs text-muted-foreground">{value.detail}</span> : null}
        {loading
          ? <Spinner className="ms-auto size-3.5" />
          : <ChevronDown aria-hidden="true" className="ms-auto size-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 group-data-popup-open:opacity-100" />}
      </ComboboxTrigger>
      <ComboboxPopup aria-label={label} className="w-72">
        {header ? <div className="border-b p-1.5">{header}</div> : null}
        {body ?? (
          <>
            <div className="border-b p-1.5">
              <ComboboxInput
                size="sm"
                showTrigger={false}
                startAddon={<Search />}
                placeholder="Search"
                aria-label={`Search ${label.toLocaleLowerCase()}`}
                className="border-transparent bg-transparent shadow-none before:hidden has-focus-visible:border-transparent has-focus-visible:ring-0"
              />
            </div>
            <ComboboxEmpty>{loading ? "Loading…" : empty}</ComboboxEmpty>
            <ComboboxList>
              {(choice: Choice) => (
                <ComboboxItem key={choice.id} value={choice}>
                  <span className="flex min-w-0 items-center gap-2">
                    {choice.leading}
                    <span className="min-w-0 flex-1 truncate">{choice.label}</span>
                    {choice.detail ? <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{choice.detail}</span> : null}
                  </span>
                </ComboboxItem>
              )}
            </ComboboxList>
          </>
        )}
      </ComboboxPopup>
    </Combobox>
  );
}
