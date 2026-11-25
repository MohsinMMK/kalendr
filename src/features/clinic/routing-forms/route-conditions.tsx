"use client";

import { Plus, X } from "lucide-react";

import { OptionSelect } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CheckboxGroup } from "@/components/ui/checkbox-group";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { conditionOperatorLabels, type ConditionOperator, type FieldCondition, type FormField } from "@/lib/booking-forms";

import { operatorsFor, retarget, valueChoices, valueKind, withOperator } from "../booking-form-rules";
import { newRouteCondition } from "./builder-state";

const MAX_CONDITIONS = 6;

const questionName = (questions: readonly FormField[], field: FormField) => `Question ${questions.findIndex((entry) => entry.id === field.id) + 1}: ${field.label.trim() || "Untitled question"}`;

function ValueInput({ label, condition, source, invalid, disabled, onChange }: {
  label: string; condition: FieldCondition; source: FormField | undefined; invalid: boolean; disabled: boolean; onChange: (value: string | string[]) => void;
}) {
  if (!source) return <Input size="lg" aria-label={label} disabled value="" readOnly />;
  const wanted = Array.isArray(condition.value) ? condition.value : condition.value ? [condition.value] : [];
  const known = valueChoices(source);
  // An answer the owner later removed from the question still shows, so it can be seen and replaced.
  const items = [...known, ...wanted.filter((value) => !known.some((choice) => choice.value === value)).map((value) => ({ value, label: `${value} (no longer an option)` }))];
  if (condition.operator === "one_of") {
    return (
      <CheckboxGroup aria-label={label} value={wanted} onValueChange={(next) => onChange(next)} disabled={disabled} className="gap-1">
        {items.map((item) => (
          <Label key={item.value} className="flex min-h-11 cursor-pointer items-center gap-3 font-normal sm:min-h-8">
            <Checkbox value={item.value} /> {item.label}
          </Label>
        ))}
      </CheckboxGroup>
    );
  }
  if (valueKind(source.type) === "text") {
    return <Input size="lg" aria-label={label} aria-invalid={invalid || undefined} disabled={disabled} placeholder="The answer" maxLength={120} value={wanted[0] ?? ""} onChange={(event) => onChange(event.target.value)} />;
  }
  return <OptionSelect aria-label={label} value={wanted[0] ?? ""} placeholder="Choose an answer" options={items} disabled={disabled} onValueChange={onChange} />;
}

/** "When [question] [is / is not / includes / is one of] [answer]". All rows must hold; none means everyone. */
export function RouteConditions({ routeIndex, conditions, questions, errors, disabled, onChange }: {
  routeIndex: number;
  conditions: readonly FieldCondition[];
  questions: readonly FormField[];
  errors: Record<string, string>;
  disabled: boolean;
  onChange: (next: FieldCondition[]) => void;
}) {
  const sources = questions.filter((field) => !field.hidden);
  const update = (at: number, next: FieldCondition) => onChange(conditions.map((condition, i) => (i === at ? next : condition)));
  return (
    <div className="flex flex-col gap-3" role="group" aria-label={`When, for route ${routeIndex + 1}`}>
      <p className="font-medium text-sm">When</p>
      {conditions.length === 0 ? <p className="text-muted-foreground text-xs">No conditions, so this route matches everyone who gets this far.</p> : null}
      {conditions.map((condition, at) => {
        const source = sources.find((entry) => entry.id === condition.fieldId);
        const base = `routes.${routeIndex}.conditions.${at}`;
        const error = errors[`${base}.fieldId`] ?? errors[`${base}.value`] ?? (source ? undefined : "Choose one of the form's questions.");
        const name = `Route ${routeIndex + 1} condition ${at + 1}`;
        return (
          <div key={at} role="group" aria-label={`Condition ${at + 1}`} className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3">
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,8rem)]">
              <OptionSelect aria-label={`${name}: question`} value={source?.id ?? ""} placeholder="Choose a question" disabled={disabled}
                options={sources.map((entry) => ({ value: entry.id, label: questionName(questions, entry) }))}
                onValueChange={(id) => { const next = sources.find((entry) => entry.id === id); if (next) update(at, retarget(condition, next)); }} />
              <OptionSelect aria-label={`${name}: how the answer compares`} value={condition.operator} disabled={disabled || !source}
                options={(source ? operatorsFor(source.type) : (["equals"] as ConditionOperator[])).map((operator) => ({ value: operator, label: conditionOperatorLabels[operator] }))}
                onValueChange={(operator) => update(at, withOperator(condition, operator as ConditionOperator))} />
            </div>
            <ValueInput label={`${name}: answer`} condition={condition} source={source} invalid={Boolean(error)} disabled={disabled} onChange={(value) => update(at, { ...condition, value })} />
            {error ? <p role="alert" className="text-destructive-foreground text-xs">{error}</p> : null}
            <div>
              <Button type="button" variant="ghost" size="sm" className="min-h-11 sm:min-h-8" disabled={disabled} aria-label={`Remove ${name.toLowerCase()}`} onClick={() => onChange(conditions.filter((_, i) => i !== at))}>
                <X aria-hidden="true" /> Remove
              </Button>
            </div>
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" disabled={disabled || sources.length === 0 || conditions.length >= MAX_CONDITIONS}
          onClick={() => { const next = newRouteCondition(questions); if (next) onChange([...conditions, next]); }}>
          <Plus aria-hidden="true" /> Add a condition
        </Button>
        {conditions.length > 1 ? <p className="text-muted-foreground text-xs">All of these must be true.</p> : null}
      </div>
    </div>
  );
}
