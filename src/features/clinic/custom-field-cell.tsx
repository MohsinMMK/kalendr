"use client";

import { Check, ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Menu, MenuCheckboxItem, MenuGroup, MenuItem, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import type { CustomerFieldDefinition } from "@/lib/customer-contracts";
import { encodeMultiValue, formatFieldValue, parseMultiValue } from "@/lib/customer-field-values";
import { cn } from "@/lib/utils";

/** What a saved answer looks like in a cell: a link you can follow, a badge, a tick, or plain text. */
export function FieldValueView({ definition, value, plain = false }: { definition: CustomerFieldDefinition; value: string; /** Text only, for inside a button, where a link would nest one control in another. */ plain?: boolean }) {
  if (!value) return <span className="text-muted-foreground/60">&nbsp;</span>;
  switch (definition.kind) {
    case "boolean":
      return <span className="flex items-center gap-1.5">{value === "true" ? <Check aria-hidden="true" className="size-4 text-success" /> : null}{formatFieldValue(definition, value)}</span>;
    case "choice":
      return <Badge variant="outline" className="max-w-full truncate">{value}</Badge>;
    case "multichoice":
      // Spaces between the badges, so the cell's spoken name ("Yoga Spin") reads the same as its visible text.
      return <span className="flex flex-wrap gap-1">{parseMultiValue(value).map((choice) => <span key={choice}><Badge variant="outline">{choice}</Badge>{" "}</span>)}</span>;
    case "email":
      if (plain) return <span className="truncate">{value}</span>;
      return <a href={`mailto:${value}`} className="truncate underline-offset-2 hover:underline" onClick={(event) => event.stopPropagation()}>{value}</a>;
    case "phone":
      if (plain) return <span className="truncate tabular-nums">{value}</span>;
      return <a href={`tel:${value.replace(/[^\d+]/g, "")}`} className="truncate tabular-nums underline-offset-2 hover:underline" onClick={(event) => event.stopPropagation()}>{value}</a>;
    case "link":
      if (plain) return <span className="truncate">{value.replace(/^https?:\/\//, "")}</span>;
      return <a href={value} target="_blank" rel="noopener noreferrer" className="truncate underline-offset-2 hover:underline" onClick={(event) => event.stopPropagation()}>{value.replace(/^https?:\/\//, "")}</a>;
    case "number":
      return <span className="tabular-nums">{value}</span>;
    default:
      return <span className="truncate">{formatFieldValue(definition, value)}</span>;
  }
}

const inputType = (kind: CustomerFieldDefinition["kind"]) => (kind === "date" ? "date" : kind === "email" ? "email" : kind === "phone" ? "tel" : kind === "link" ? "url" : "text");

/**
 * One cell of one of the business's own fields, editable in place for people who may change a customer: click, type, Enter.
 * A tick box saves as you click; a list opens a menu; text, numbers, dates, phone, email and links take an input that saves on Enter
 * or when you leave it, and Escape puts the old answer back. The server checks the answer again and says what is wrong in a toast.
 */
export function FieldCell({ definition, value: saved, canEdit, customerName, onSave }: {
  definition: CustomerFieldDefinition;
  /** The saved answer. */
  value: string;
  canEdit: boolean;
  /** For screen readers: whose answer this is. */
  customerName: string;
  /** Resolves when saved; rejects with a message when refused. An empty string clears the answer. */
  onSave: (next: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  // What was just chosen, shown until the save has come back and the saved answer catches up. Without it a second tick in an
  // open list would be worked out from the old answer and wipe the first.
  const [chosen, setChosen] = useState<string | null>(null);
  const value = chosen ?? saved;
  const finished = useRef(false);
  // Enter or Escape closes the input; focus goes back to the cell rather than to the page.
  const cell = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (!editing && refocus.current) { refocus.current = false; cell.current?.focus(); }
  }, [editing]);
  // Saves go one after another, so two quick ticks cannot reach the server out of order.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const latest = useRef(0);
  // The name holds what the cell shows (a screen reader and speech control say the same words as the screen).
  const shown = definition.kind === "multichoice" ? parseMultiValue(value).join(" ") : formatFieldValue(definition, value);
  const label = `${definition.label} for ${customerName}: ${shown || "not set"}`;

  /** Never rejects: a refused answer was already explained in a toast, and the old answer stays. */
  function save(next: string): Promise<void> {
    const turn = ++latest.current;
    setChosen(next);
    setSaving(true);
    const run = queue.current.then(async () => {
      try { await onSave(next); } catch { /* shown by onSave; the old answer comes back below */ }
    }).finally(() => {
      if (turn === latest.current) { setChosen(null); setSaving(false); }
    });
    queue.current = run;
    return run;
  }

  if (!canEdit) return <div className="min-h-6"><FieldValueView definition={definition} value={value} /></div>;

  // Cell clicks would also open the customer's profile.
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();

  if (definition.kind === "boolean") {
    return (
      <div className="flex min-h-6 items-center" onClick={stop}>
        <Checkbox checked={value === "true"} disabled={saving} aria-label={label} onCheckedChange={(checked) => void save(checked ? "true" : "false")} />
      </div>
    );
  }

  if (definition.kind === "choice" || definition.kind === "multichoice") {
    const picked = definition.kind === "multichoice" ? parseMultiValue(value) : value ? [value] : [];
    return (
      <div className="min-h-6" onClick={stop}>
        <Menu>
          <MenuTrigger render={<button type="button" aria-label={label} className={cn("-mx-1 block min-h-6 w-[calc(100%+0.5rem)] cursor-pointer rounded-md px-1 text-start outline-2 outline-transparent hover:bg-accent focus-visible:outline-ring", saving && "opacity-60")} />}>
            <FieldValueView definition={definition} value={value} />
          </MenuTrigger>
          <MenuPopup align="start" className="w-56">
            {definition.kind === "choice" ? (
              <MenuRadioGroup value={value} onValueChange={(next) => void save(typeof next === "string" ? next : "")}>
                {definition.choices.map((choice) => <MenuRadioItem key={choice} value={choice}>{choice}</MenuRadioItem>)}
              </MenuRadioGroup>
            ) : (
              <MenuGroup>
                {definition.choices.map((choice) => (
                  <MenuCheckboxItem
                    key={choice}
                    checked={picked.includes(choice)}
                    onCheckedChange={(checked) => {
                      const next = definition.choices.filter((item) => (item === choice ? checked : picked.includes(item)));
                      void save(next.length ? encodeMultiValue(next) : "");
                    }}
                  >
                    {choice}
                  </MenuCheckboxItem>
                ))}
              </MenuGroup>
            )}
            {picked.length ? (
              <>
                <MenuSeparator />
                <MenuItem onClick={() => void save("")}>Clear</MenuItem>
              </>
            ) : null}
          </MenuPopup>
        </Menu>
      </div>
    );
  }

  if (editing) {
    const commit = (next: string) => {
      if (finished.current) return;
      finished.current = true;
      setEditing(false);
      if (next.trim() !== value) void save(next.trim());
    };
    return (
      <div onClick={stop}>
        <Input
          autoFocus
          size="sm"
          type={inputType(definition.kind)}
          inputMode={definition.kind === "number" ? "decimal" : undefined}
          defaultValue={value}
          aria-label={label}
          maxLength={500}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === "Enter") { event.preventDefault(); refocus.current = true; commit(event.currentTarget.value); }
            if (event.key === "Escape") { event.preventDefault(); refocus.current = true; finished.current = true; setEditing(false); }
          }}
          onBlur={(event) => commit(event.currentTarget.value)}
        />
      </div>
    );
  }

  const href = !value ? null : definition.kind === "email" ? `mailto:${value}` : definition.kind === "phone" ? `tel:${value.replace(/[^\d+]/g, "")}` : definition.kind === "link" ? value : null;
  return (
    <div className="-mx-1 flex min-h-6 w-[calc(100%+0.5rem)] items-center gap-1" onClick={stop}>
      <button
        type="button"
        ref={cell}
        aria-label={label}
        aria-disabled={saving || undefined}
        className={cn("block min-h-6 min-w-0 flex-1 cursor-text rounded-md px-1 text-start outline-2 outline-transparent hover:bg-accent focus-visible:outline-ring", saving && "opacity-60")}
        onClick={() => { if (saving) return; finished.current = false; setEditing(true); }}
      >
        <FieldValueView definition={definition} value={value} plain />
      </button>
      {href ? (
        <a href={href} target={definition.kind === "link" ? "_blank" : undefined} rel="noopener noreferrer" aria-label={`Open ${definition.label} for ${customerName}`} className="shrink-0 rounded-md p-1 text-muted-foreground outline-2 outline-transparent hover:bg-accent hover:text-foreground focus-visible:outline-ring">
          <ExternalLink aria-hidden="true" className="size-3.5" />
        </a>
      ) : null}
    </div>
  );
}
