"use client";

import { Plus, X } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const nonBlank = (rows: readonly string[]): string[] => rows.map((row) => row.trim()).filter(Boolean);

/**
 * Email addresses added one row at a time, with Remove on each row. Used for guests and for an "add email
 * addresses" question. The parent holds only the filled-in addresses; blank rows live here while the customer types.
 */
export function EmailList({
  id,
  value,
  onChange,
  max,
  rowLabel,
  addLabel,
  invalid,
  describedBy,
  disabled,
}: {
  /** Row `n` gets the id `${id}-${n}`; the first row is the target for "jump to the error". */
  id: string;
  value: readonly string[];
  onChange: (next: string[]) => void;
  max: number;
  /** For example "Guest email". Each row is named "Guest email 2" for screen readers. */
  rowLabel: string;
  addLabel: string;
  invalid?: boolean;
  describedBy?: string;
  disabled?: boolean;
}) {
  const [rows, setRows] = useState<string[]>(() => (value.length > 0 ? [...value] : [""]));
  // The addresses changed from outside (a link filled them in): show those.
  if (nonBlank(rows).join("\n") !== nonBlank(value).join("\n")) {
    setRows(value.length > 0 ? [...value] : [""]);
  }

  function update(next: string[]) {
    setRows(next);
    onChange(nonBlank(next));
  }

  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-col gap-2">
        {rows.map((row, index) => (
          <li key={index} className="flex items-center gap-2">
            <Input
              id={`${id}-${index}`}
              size="lg"
              type="email"
              inputMode="email"
              autoComplete="off"
              enterKeyHint="next"
              aria-label={rows.length > 1 || index > 0 ? `${rowLabel} ${index + 1}` : rowLabel}
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              placeholder="name@example.com"
              value={row}
              maxLength={254}
              disabled={disabled}
              onChange={(event) => update(rows.map((current, at) => (at === index ? event.target.value : current)))}
            />
            {rows.length > 1 || row.trim() ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xl"
                aria-label={`Remove ${rowLabel.toLowerCase()} ${index + 1}`}
                disabled={disabled}
                onClick={() => update(rows.length > 1 ? rows.filter((_, at) => at !== index) : [""])}
              >
                <X aria-hidden="true" />
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {rows.length < max ? (
        <Button
          type="button"
          variant="outline"
          className="min-h-11 self-start sm:min-h-8"
          disabled={disabled || !rows[rows.length - 1]?.trim()}
          onClick={() => update([...rows, ""])}
        >
          <Plus aria-hidden="true" />
          {addLabel}
        </Button>
      ) : (
        <p className="text-muted-foreground text-xs">That is the most you can add ({max}).</p>
      )}
    </div>
  );
}
