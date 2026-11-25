"use client";

import { useState, type Ref } from "react";
import { Search, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";

/**
 * A page toolbar's search: a square search icon at rest that widens into the coss InputGroup search field when clicked
 * (or when its input is focused, as "/" does). It stays open while it holds text and folds back when emptied and left.
 * Put it first in the right-hand group of a toolbar, so it grows into the free space to its left without moving the
 * buttons beside it.
 */
export function ExpandingSearch({
  value,
  onValueChange,
  label,
  placeholder,
  inputRef,
  shortcut,
  className,
  openClassName = "w-56 sm:w-64",
}: {
  value: string;
  onValueChange: (value: string) => void;
  /** The input's accessible name, also the collapsed icon's tooltip text. */
  label: string;
  placeholder?: string;
  inputRef?: Ref<HTMLInputElement>;
  /** A key that focuses this search from the page, shown inside the open field. */
  shortcut?: string;
  className?: string;
  /** The open width. */
  openClassName?: string;
}) {
  const [focused, setFocused] = useState(false);
  const open = focused || value !== "";

  return (
    <div
      data-slot="expanding-search"
      data-open={open ? "" : undefined}
      className={cn(
        "shrink-0 overflow-hidden rounded-lg transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
        open ? openClassName : "w-8 sm:w-7",
        className,
      )}
    >
      <InputGroup
        className={cn("w-full", !open && "cursor-pointer hover:bg-accent/50 dark:hover:bg-input/64 [&_input]:cursor-pointer",
          // Folded, the input covers the whole square, so its click target stays full size.
          !open && "h-8 sm:h-7 [&_input]:absolute [&_input]:inset-0 [&_input]:size-full [&_input]:px-0 [&_input]:opacity-0")}
        title={open ? undefined : label}
      >
        <InputGroupAddon className={cn("transition-[padding] duration-300", !open && "w-full justify-center px-0")}>
          <Search aria-hidden="true" />
        </InputGroupAddon>
        <InputGroupInput
          ref={inputRef}
          type="search"
          size="sm"
          aria-label={label}
          placeholder={open ? placeholder : undefined}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.stopPropagation();
            if (value) onValueChange("");
            else event.currentTarget.blur();
          }}
        />
        {open && (value || shortcut) ? (
          <InputGroupAddon align="inline-end" className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-300">
            {value ? (
              // Keeps focus in the field, so clearing does not fold it shut.
              <Button variant="ghost" size="icon-xs" aria-label="Clear search" onMouseDown={(event) => event.preventDefault()} onClick={() => onValueChange("")}>
                <X aria-hidden="true" />
              </Button>
            ) : (
              <Kbd aria-hidden="true" className="max-sm:hidden">{shortcut}</Kbd>
            )}
          </InputGroupAddon>
        ) : null}
      </InputGroup>
    </div>
  );
}
