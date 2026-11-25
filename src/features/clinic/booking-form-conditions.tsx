"use client";

import { Plus, X } from "lucide-react";

import { OptionSelect } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import {
  Combobox, ComboboxChip, ComboboxChips, ComboboxChipsInput, ComboboxEmpty, ComboboxItem, ComboboxList, ComboboxPopup, ComboboxValue,
} from "@/components/ui/combobox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { conditionOperatorLabels, type ConditionOperator, type FieldCondition, type FormField } from "@/lib/booking-forms";

import {
  earlierFields, maxConditions, newCondition, operatorsFor, retarget, valueChoices, valueKind, withOperator,
} from "./booking-form-rules";

interface ConditionsProps {
  field: FormField;
  /** Position of this question, for naming controls and finding the errors the schema reports. */
  index: number;
  fields: readonly FormField[];
  errors: Record<string, string>;
  disabled: boolean;
  onChange: (showWhen: FieldCondition[] | undefined) => void;
}

const sourceName = (fields: readonly FormField[], source: FormField) =>
  `Question ${fields.findIndex((entry) => entry.id === source.id) + 1}: ${source.label.trim() || "Untitled question"}`;

/**
 * "Show this when…": the question appears only when every condition holds. The switch keeps the rows out of the way;
 * only earlier questions are offered, because a question can never depend on one that comes after it.
 */
export function ConditionsEditor({ field, index, fields, errors, disabled, onChange }: ConditionsProps) {
  const sources = earlierFields(fields, index);
  const conditions = field.showWhen ?? [];
  const on = conditions.length > 0;
  const switchId = `booking-form-q-${field.id}-when`;
  const hint = index === 0
    ? "The first question always shows."
    : sources.length === 0
      ? "Earlier questions are hidden ones, which cannot be used here."
      : "Show this question only for some answers to an earlier one.";

  function update(at: number, next: FieldCondition) {
    onChange(conditions.map((condition, i) => (i === at ? next : condition)));
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Label htmlFor={switchId} className="font-medium">Show this when…</Label>
          <p className="text-muted-foreground text-xs">{hint}</p>
        </div>
        <Switch
          id={switchId}
          checked={on}
          disabled={disabled || sources.length === 0}
          onCheckedChange={(next) => onChange(next ? [newCondition(sources[sources.length - 1]!)] : undefined)}
        />
      </div>
      {on ? (
        <div className="flex flex-col gap-3 rounded-lg border bg-muted/30 p-3">
          {conditions.map((condition, at) => {
            const source = sources.find((entry) => entry.id === condition.fieldId);
            const base = `fields.${index}.showWhen.${at}`;
            const sourceError = errors[`${base}.fieldId`] ?? (source ? undefined : "A question can only depend on one that comes before it.");
            const valueError = errors[`${base}.value`];
            return (
              <div key={at} role="group" aria-label={`Condition ${at + 1}`} className="flex flex-col gap-2">
                <p className="font-medium text-xs">{at === 0 ? "Show this question when" : "and"}</p>
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,8rem)_minmax(0,1.4fr)]">
                  <div className="flex flex-col gap-1">
                    <OptionSelect
                      aria-label={`Condition ${at + 1}: earlier question`}
                      value={source?.id ?? ""}
                      placeholder="Choose a question"
                      options={sources.map((entry) => ({ value: entry.id, label: sourceName(fields, entry) }))}
                      onValueChange={(id) => { const next = sources.find((entry) => entry.id === id); if (next) update(at, retarget(condition, next)); }}
                      disabled={disabled}
                    />
                  </div>
                  <OptionSelect
                    aria-label={`Condition ${at + 1}: how the answer compares`}
                    value={condition.operator}
                    options={(source ? operatorsFor(source.type) : (["equals"] as ConditionOperator[])).map((operator) => ({ value: operator, label: conditionOperatorLabels[operator] }))}
                    onValueChange={(operator) => update(at, withOperator(condition, operator as ConditionOperator))}
                    disabled={disabled || !source}
                  />
                  <ValueInput label={`Condition ${at + 1}: answer`} condition={condition} source={source} invalid={Boolean(valueError)} disabled={disabled} onChange={(value) => update(at, { ...condition, value })} />
                </div>
                {sourceError ? <p role="alert" className="text-destructive-foreground text-xs">{sourceError}</p> : null}
                {valueError ? <p role="alert" className="text-destructive-foreground text-xs">{valueError}</p> : null}
                <div>
                  <Button type="button" variant="ghost" size="sm" disabled={disabled} aria-label={`Remove condition ${at + 1}`} onClick={() => onChange(conditions.length === 1 ? undefined : conditions.filter((_, i) => i !== at))}>
                    <X aria-hidden="true" /> Remove
                  </Button>
                </div>
              </div>
            );
          })}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" size="sm" disabled={disabled || conditions.length >= maxConditions} onClick={() => onChange([...conditions, newCondition(sources[sources.length - 1]!)])}>
              <Plus aria-hidden="true" /> Add a condition
            </Button>
            <p className="text-muted-foreground text-xs">{conditions.length > 1 ? "All of these must be true." : `Up to ${maxConditions} conditions.`}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface ValueInputProps {
  label: string;
  condition: FieldCondition;
  source: FormField | undefined;
  invalid: boolean;
  disabled: boolean;
  onChange: (value: string | string[]) => void;
}

function ValueInput({ label, condition, source, invalid, disabled, onChange }: ValueInputProps) {
  const kind = source ? valueKind(source.type) : "text";
  const multiple = condition.operator === "one_of";
  const known = source ? valueChoices(source) : [];
  const wanted = Array.isArray(condition.value) ? condition.value : condition.value ? [condition.value] : [];
  // An answer the owner later removed from the options still shows, so they can see and replace it.
  const items = [...known, ...wanted.filter((value) => !known.some((choice) => choice.value === value)).map((value) => ({ value, label: `${value} (no longer an option)` }))];

  if (!source) return <Input size="lg" aria-label={label} disabled value="" readOnly />;
  if (multiple) {
    const selected = items.filter((item) => wanted.includes(item.value));
    return (
      <Combobox multiple items={items} value={selected} disabled={disabled}
        itemToStringLabel={(item: { value: string }) => items.find((entry) => entry.value === item.value)?.label ?? item.value}
        isItemEqualToValue={(a: { value: string }, b: { value: string }) => a.value === b.value}
        onValueChange={(next: Array<{ value: string }>) => onChange(next.map((item) => item.value))}>
        <ComboboxChips>
          <ComboboxValue>
            {(value: Array<{ value: string; label: string }>) => (
              <>
                {value.map((item) => <ComboboxChip key={item.value} aria-label={item.label}>{item.label}</ComboboxChip>)}
                <ComboboxChipsInput aria-label={label} aria-invalid={invalid || undefined} placeholder={value.length ? "" : "Pick answers"} />
              </>
            )}
          </ComboboxValue>
        </ComboboxChips>
        <ComboboxPopup>
          <ComboboxEmpty>No answers found.</ComboboxEmpty>
          <ComboboxList>
            {(item: { value: string; label: string }) => <ComboboxItem key={item.value} value={item}>{item.label}</ComboboxItem>}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    );
  }
  if (kind === "text") {
    return <Input size="lg" aria-label={label} aria-invalid={invalid || undefined} disabled={disabled} placeholder="The answer" maxLength={120} value={wanted[0] ?? ""} onChange={(event) => onChange(event.target.value)} />;
  }
  return <OptionSelect aria-label={label} value={wanted[0] ?? ""} placeholder="Choose an answer" options={items} disabled={disabled} onValueChange={onChange} />;
}
