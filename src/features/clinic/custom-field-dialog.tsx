"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useId, useState } from "react";

import { SelectField, TextField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import {
  fieldDefinitionInputSchema, fieldDefinitionUpdateSchema, fieldKinds, isChoiceKind, type CustomerFieldDefinition, type FieldKind,
} from "@/lib/customer-contracts";
import { fieldKindHints, fieldKindLabels } from "@/lib/customer-field-values";

import { errorText } from "./customer-parts";
import { customerKeys } from "./queries/customers";
import { staffMutation, StaffApiError } from "./queries/http";

interface ChoiceRow {
  key: string;
  /** The name the choice had when the dialog opened; a changed name is sent as a rename so values follow it. */
  original: string | null;
  value: string;
}

const kindOptions = fieldKinds.map((kind) => ({ value: kind, label: fieldKindLabels[kind] }));
const asKind = (value: string): FieldKind => fieldKinds.find((kind) => kind === value) ?? "text";
const blankChoices = (): ChoiceRow[] => [0, 1].map((index) => ({ key: `new-${index}`, original: null, value: "" }));

/** Everything that changes after a field is saved: its own list, and every table and profile that shows it. */
function useFieldsChanged() {
  const client = useQueryClient();
  return async () => {
    // The customers key covers the table's answers and every open profile's own answers.
    await Promise.all([
      client.invalidateQueries({ queryKey: customerKeys.fields() }),
      client.invalidateQueries({ queryKey: customerKeys.all() }),
    ]);
  };
}

function readCleared(result: unknown): number {
  if (typeof result === "object" && result !== null && "cleared" in result && typeof result.cleared === "number") return result.cleared;
  return 0;
}

/**
 * Adds one of the business's own fields, or edits one: its name, its kind and, for the kinds that pick from a list, its choices.
 * Changing the kind or removing a choice clears the answers that no longer fit, and the dialog says so before it saves.
 */
export function CustomFieldDialog({ open, onOpenChange, definition, onSaved }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Present when editing; absent when adding. */
  definition?: CustomerFieldDefinition;
  onSaved?: (field: CustomerFieldDefinition) => void;
}) {
  // Reset the form each time the dialog opens or switches field, by remounting the body.
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        {open ? <FieldForm key={definition?.id ?? "new"} definition={definition} onClose={() => onOpenChange(false)} onSaved={onSaved} /> : null}
      </DialogPopup>
    </Dialog>
  );
}

function FieldForm({ definition, onClose, onSaved }: { definition?: CustomerFieldDefinition; onClose: () => void; onSaved?: (field: CustomerFieldDefinition) => void }) {
  const t = useTerms();
  const changed = useFieldsChanged();
  const idBase = useId();
  const editing = Boolean(definition);
  const [label, setLabel] = useState(definition?.label ?? "");
  const [kind, setKind] = useState<FieldKind>(definition?.kind ?? "text");
  const [choices, setChoices] = useState<ChoiceRow[]>(() => definition && isChoiceKind(definition.kind)
    ? definition.choices.map((value, index) => ({ key: `old-${index}`, original: value, value }))
    : blankChoices());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const picksFromList = isChoiceKind(kind);
  const kindChanged = Boolean(definition) && kind !== definition?.kind;
  const cleanChoices = choices.map((row) => row.value.trim()).filter(Boolean);
  const removedChoice = Boolean(definition) && picksFromList && definition?.choices.some((original) => !choices.some((row) => row.original === original));

  function body() {
    const shared = { label: label.trim(), kind, choices: picksFromList ? cleanChoices : [] };
    if (!definition) return shared;
    const renames = Object.fromEntries(choices.flatMap((row) => (row.original && row.value.trim() && row.value.trim() !== row.original ? [[row.original, row.value.trim()] as const] : [])));
    return {
      ...(shared.label !== definition.label ? { label: shared.label } : {}),
      ...(kindChanged ? { kind } : {}),
      ...(picksFromList ? { choices: shared.choices, ...(Object.keys(renames).length ? { renames } : {}) } : {}),
      version: definition.version,
    };
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setErrors({}); setMessage("");
    const payload = body();
    const parsed = definition ? fieldDefinitionUpdateSchema.safeParse(payload) : fieldDefinitionInputSchema.safeParse(payload);
    if (!parsed.success) {
      setErrors(Object.fromEntries(parsed.error.issues.map((issue) => [String(issue.path[0] ?? "label"), issue.message])));
      return;
    }
    setBusy(true);
    try {
      const result = definition
        ? await staffMutation<unknown>(`/api/staff/customer-fields/${encodeURIComponent(definition.id)}`, "PATCH", payload)
        : await staffMutation<CustomerFieldDefinition>("/api/staff/customer-fields", "POST", payload);
      await changed();
      const cleared = readCleared(result);
      if (cleared > 0) toastManager.add({ title: `${cleared} ${cleared === 1 ? "answer" : "answers"} cleared`, description: "They did not fit the new setup.", type: "info" });
      const saved = typeof result === "object" && result !== null && "definition" in result ? (result.definition as CustomerFieldDefinition) : (result as CustomerFieldDefinition);
      onSaved?.(saved);
      onClose();
    } catch (cause: unknown) {
      if (cause instanceof StaffApiError && Object.keys(cause.fieldErrors).length > 0) setErrors(Object.fromEntries(Object.entries(cause.fieldErrors).map(([path, list]) => [path, list[0] ?? ""])));
      else setMessage(errorText(cause, editing ? "The field could not be saved. Try again." : "The field could not be added. Try again."));
    } finally {
      setBusy(false);
    }
  }

  const setChoice = (key: string, value: string) => setChoices((rows) => rows.map((row) => (row.key === key ? { ...row, value } : row)));

  return (
    <form noValidate aria-label={editing ? "Edit field" : "Add a field"} className="contents" onSubmit={(event) => void submit(event)}>
      <DialogHeader>
        <DialogTitle>{editing ? "Edit field" : "Add a field"}</DialogTitle>
        <DialogDescription>A detail your business keeps for every {t.customer}, like a birthday or how they found you. Everyone on your team sees it.</DialogDescription>
      </DialogHeader>
      <DialogPanel className="flex flex-col gap-4">
        {message ? <Alert variant="error"><AlertDescription>{message}</AlertDescription></Alert> : null}
        <TextField label="Name" value={label} maxLength={60} error={errors.label} autoFocus onChange={(event) => setLabel(event.target.value)} />
        <SelectField
          label="Kind"
          value={kind}
          hint={fieldKindHints[kind]}
          onValueChange={(next) => setKind(asKind(next))}
          options={kindOptions}
        />
        {kindChanged ? <Alert variant="warning"><AlertDescription>Answers that do not fit {fieldKindLabels[kind].toLowerCase()} are cleared when you save.</AlertDescription></Alert> : null}
        {picksFromList ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 font-medium text-sm">Choices</legend>
            {choices.map((row, index) => (
              <div key={row.key} className="flex items-center gap-2">
                <Input aria-label={`Choice ${index + 1}`} value={row.value} maxLength={60} onChange={(event) => setChoice(row.key, event.target.value)} />
                <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove choice ${index + 1}`} disabled={choices.length <= 2} onClick={() => setChoices((rows) => rows.filter((item) => item.key !== row.key))}>
                  <X aria-hidden="true" />
                </Button>
              </div>
            ))}
            {errors.choices ? <p id={`${idBase}-choices`} role="alert" className="text-destructive-foreground text-xs">{errors.choices}</p> : null}
            <Button type="button" size="sm" variant="outline" className="self-start" disabled={choices.length >= 30} onClick={() => setChoices((rows) => [...rows, { key: `new-${rows.length}-${Date.now()}`, original: null, value: "" }])}>
              <Plus aria-hidden="true" />Add a choice
            </Button>
            {removedChoice ? <p className="text-muted-foreground text-xs">Answers that used a removed choice are cleared when you save.</p> : null}
          </fieldset>
        ) : null}
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={busy || !label.trim()}>{busy ? <Spinner /> : null}{editing ? "Save field" : "Add field"}</Button>
      </DialogFooter>
    </form>
  );
}

/** Asks first, then archives the field: it leaves every table and profile, and its answers stay stored until the customer's data is erased. */
export function DeleteFieldDialog({ definition, onOpenChange }: { definition: CustomerFieldDefinition | null; onOpenChange: (open: boolean) => void }) {
  const t = useTerms();
  const changed = useFieldsChanged();
  const [busy, setBusy] = useState(false);
  // The name stays in the title while the dialog fades out, after the field has been let go.
  const [shown, setShown] = useState(definition);
  if (definition && definition !== shown) setShown(definition);

  async function remove() {
    if (!definition) return;
    setBusy(true);
    try {
      await staffMutation(`/api/staff/customer-fields/${encodeURIComponent(definition.id)}`, "PATCH", { archived: true, version: definition.version });
      await changed();
      toastManager.add({ title: `${definition.label} deleted`, type: "success" });
      onOpenChange(false);
    } catch (cause: unknown) {
      toastManager.add({ title: "The field could not be deleted", description: errorText(cause, "Try again."), type: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open={definition !== null} onOpenChange={onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete the {(definition ?? shown)?.label} field?</AlertDialogTitle>
          <AlertDialogDescription>
            It disappears from the {t.customers} table and from every {t.customer}&apos;s details for everyone on your team. The answers already saved are kept until you erase a {t.customer}&apos;s data.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="ghost" />}>Cancel</AlertDialogClose>
          <Button variant="destructive" disabled={busy} onClick={() => void remove()}>{busy ? <Spinner /> : null}Delete field</Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
