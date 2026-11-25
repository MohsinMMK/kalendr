"use client";

import { Plus, X } from "lucide-react";

import { OptionSelect } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { CheckboxGroup } from "@/components/ui/checkbox-group";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { attributeOperatorLabels, type AttributeOperator, type PeopleFilter, type PeopleRule, type PeopleWeight, type RoutingBuilderOptions } from "@/lib/routing-forms";
import type { FormField } from "@/lib/booking-forms";
import type { TermWords } from "@/lib/terminology";
import { ScrollAreaPrimitive, ScrollBar } from "@/components/ui/scroll-area";

type Attribute = RoutingBuilderOptions["attributes"][number];

const operatorsByKind: Record<Attribute["kind"], AttributeOperator[]> = {
  number: ["equals", "at_least"],
  single: ["equals", "one_of"],
  multiple: ["includes", "one_of"],
  text: ["equals", "includes", "one_of"],
};

const multipliers = Array.from({ length: 10 }, (_, index) => ({ value: String(index + 1), label: index === 0 ? "1 time (normal)" : `${index + 1} times` }));

interface Props {
  rule: PeopleRule;
  options: RoutingBuilderOptions;
  questions: readonly FormField[];
  /** The fallback cannot depend on an answer, so it can only compare with a fixed value. */
  fixedOnly: boolean;
  idPrefix: string;
  errors: Record<string, string>;
  errorBase: string;
  disabled: boolean;
  terms: Pick<TermWords, "provider" | "providers" | "Providers" | "service">;
  onChange: (rule: PeopleRule) => void;
}

function FixedValue({ label, attribute, operator, value, disabled, onChange }: {
  label: string; attribute: Attribute | undefined; operator: AttributeOperator; value: string | number | string[]; disabled: boolean; onChange: (value: string | number | string[]) => void;
}) {
  const list = Array.isArray(value) ? value : value === "" ? [] : [String(value)];
  if (attribute?.kind === "number") {
    return <Input size="lg" type="number" inputMode="numeric" aria-label={label} disabled={disabled} value={typeof value === "number" ? value : Number.isFinite(Number(value)) && value !== "" ? Number(value) : ""} onChange={(event) => onChange(event.target.value === "" ? "" : Number(event.target.value))} />;
  }
  const choices = attribute?.options ?? [];
  if (choices.length > 0 && operator === "one_of") {
    return (
      <CheckboxGroup aria-label={label} value={list} onValueChange={(next) => onChange(next)} disabled={disabled} className="gap-1">
        {choices.map((choice) => <Label key={choice} className="flex min-h-11 cursor-pointer items-center gap-3 font-normal sm:min-h-8"><Checkbox value={choice} /> {choice}</Label>)}
      </CheckboxGroup>
    );
  }
  if (choices.length > 0) return <OptionSelect aria-label={label} value={list[0] ?? ""} placeholder="Choose a value" disabled={disabled} options={choices.map((choice) => ({ value: choice, label: choice }))} onValueChange={onChange} />;
  return <Input size="lg" aria-label={label} disabled={disabled} maxLength={300} placeholder={operator === "one_of" ? "Values, separated by commas" : "The value"} value={list.join(operator === "one_of" ? ", " : "")}
    onChange={(event) => onChange(operator === "one_of" ? event.target.value.split(",").map((part) => part.trim()).filter(Boolean) : event.target.value)} />;
}

function FilterRow({ filter, at, props, onChange, onRemove }: { filter: PeopleFilter; at: number; props: Props; onChange: (next: PeopleFilter) => void; onRemove: () => void }) {
  const { options, questions, fixedOnly, idPrefix, errors, errorBase, disabled } = props;
  const attribute = options.attributes.find((entry) => entry.id === filter.attributeId);
  const name = `People rule ${at + 1}`;
  const operators = operatorsByKind[attribute?.kind ?? "text"];
  const error = errors[`${errorBase}.people.filters.${at}`];
  const question = filter.source.type === "question" ? filter.source.fieldId : "";
  const fixedValue = filter.source.type === "value" ? filter.source.value : "";
  return (
    <div role="group" aria-label={name} className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,9rem)]">
        <OptionSelect aria-label={`${name}: attribute`} value={filter.attributeId} placeholder="Choose an attribute" disabled={disabled}
          options={options.attributes.map((entry) => ({ value: entry.id, label: entry.name }))}
          onValueChange={(id) => { const next = options.attributes.find((entry) => entry.id === id); if (next) onChange({ ...filter, attributeId: id, operator: operatorsByKind[next.kind][0]!, source: { type: "value", value: next.kind === "number" ? 0 : "" } }); }} />
        <OptionSelect aria-label={`${name}: how it compares`} value={filter.operator} disabled={disabled} options={operators.map((operator) => ({ value: operator, label: attributeOperatorLabels[operator] }))}
          onValueChange={(operator) => onChange({ ...filter, operator: operator as AttributeOperator, source: filter.source.type === "value" ? { type: "value", value: operator === "one_of" ? [] : "" } : filter.source })} />
      </div>
      {fixedOnly ? null : (
        <OptionSelect aria-label={`${name}: compare with`} value={filter.source.type} disabled={disabled}
          options={[{ value: "question", label: "The answer to a question" }, { value: "value", label: "A fixed value" }]}
          onValueChange={(type) => onChange({ ...filter, source: type === "question" ? { type: "question", fieldId: questions.find((field) => !field.hidden)?.id ?? "" } : { type: "value", value: "" } })} />
      )}
      {filter.source.type === "question" && !fixedOnly ? (
        <OptionSelect aria-label={`${name}: question`} value={question} placeholder="Choose a question" disabled={disabled}
          options={questions.filter((field) => !field.hidden).map((field, index) => ({ value: field.id, label: `Question ${index + 1}: ${field.label.trim() || "Untitled question"}` }))}
          onValueChange={(fieldId) => onChange({ ...filter, source: { type: "question", fieldId } })} />
      ) : (
        <FixedValue label={`${name}: value`} attribute={attribute} operator={filter.operator} value={fixedValue} disabled={disabled} onChange={(value) => onChange({ ...filter, source: { type: "value", value } })} />
      )}
      {error ? <p role="alert" id={`${idPrefix}-filter-${at}-error`} className="text-destructive-foreground text-xs">{error}</p> : null}
      <div><Button type="button" variant="ghost" size="sm" className="min-h-11 sm:min-h-8" disabled={disabled} aria-label={`Remove ${name.toLowerCase()}`} onClick={onRemove}><X aria-hidden="true" /> Remove</Button></div>
    </div>
  );
}

function WeightRow({ weight, at, props, onChange, onRemove }: { weight: PeopleWeight; at: number; props: Props; onChange: (next: PeopleWeight) => void; onRemove: () => void }) {
  const { options, disabled } = props;
  const attribute = options.attributes.find((entry) => entry.id === weight.attributeId);
  const name = `Weight ${at + 1}`;
  return (
    <div role="group" aria-label={name} className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <OptionSelect aria-label={`${name}: attribute`} value={weight.attributeId} placeholder="Choose an attribute" disabled={disabled}
          options={options.attributes.map((entry) => ({ value: entry.id, label: entry.name }))} onValueChange={(attributeId) => onChange({ ...weight, attributeId, value: "" })} />
        {attribute && attribute.options.length > 0
          ? <OptionSelect aria-label={`${name}: value`} value={weight.value} placeholder="Choose a value" disabled={disabled} options={attribute.options.map((option) => ({ value: option, label: option }))} onValueChange={(value) => onChange({ ...weight, value })} />
          : <Input size="lg" aria-label={`${name}: value`} disabled={disabled} maxLength={300} placeholder="The value" value={weight.value} onChange={(event) => onChange({ ...weight, value: event.target.value })} />}
      </div>
      <OptionSelect aria-label={`${name}: counts`} value={String(weight.multiplier)} disabled={disabled} options={multipliers} onValueChange={(value) => onChange({ ...weight, multiplier: Number(value) })} />
      {props.errors[`${props.errorBase}.people.weights.${at}`] ? <p role="alert" className="text-destructive-foreground text-xs">{props.errors[`${props.errorBase}.people.weights.${at}`]}</p> : null}
      <div><Button type="button" variant="ghost" size="sm" className="min-h-11 sm:min-h-8" disabled={disabled} aria-label={`Remove ${name.toLowerCase()}`} onClick={onRemove}><X aria-hidden="true" /> Remove</Button></div>
    </div>
  );
}

/** Who may be offered: specific people, attribute filters, and attribute weights that make some people count more. */
export function PeopleRuleEditor(props: Props) {
  const { rule, options, idPrefix, disabled, terms, onChange } = props;
  const hasAttributes = options.attributes.length > 0;
  const firstAttribute = options.attributes[0];
  return (
    <div className="flex flex-col gap-4 rounded-lg border p-3" role="group" aria-labelledby={`${idPrefix}-people`}>
      <div>
        <p id={`${idPrefix}-people`} className="font-medium text-sm">People</p>
        <p className="text-muted-foreground text-xs">Leave this alone to offer everyone who does this {terms.service}. Narrow it to offer only some {terms.providers}.</p>
      </div>
      <div className="flex flex-col gap-2">
        <p id={`${idPrefix}-only`} className="font-medium text-xs">Only these {terms.providers} (optional)</p>
        {options.people.length === 0 ? <p className="text-muted-foreground text-xs">No {terms.providers} yet.</p> : (
          <ScrollAreaPrimitive.Root><ScrollAreaPrimitive.Viewport data-slot="scroll-area-viewport" className="max-h-44 rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"><ScrollAreaPrimitive.Content style={{ minWidth: 0 }}><CheckboxGroup aria-labelledby={`${idPrefix}-only`} value={rule.personIds} onValueChange={(personIds) => onChange({ ...rule, personIds })} disabled={disabled} className="gap-1">
            {options.people.map((person) => <Label key={person.id} className="flex min-h-11 cursor-pointer items-center gap-3 font-normal sm:min-h-8"><Checkbox value={person.id} /> {person.name}</Label>)}
          </CheckboxGroup></ScrollAreaPrimitive.Content></ScrollAreaPrimitive.Viewport><ScrollBar orientation="vertical" /></ScrollAreaPrimitive.Root>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <p className="font-medium text-xs">{terms.Providers} whose…</p>
        {rule.filters.map((filter, at) => (
          <FilterRow key={at} filter={filter} at={at} props={props} onChange={(next) => onChange({ ...rule, filters: rule.filters.map((entry, i) => (i === at ? next : entry)) })} onRemove={() => onChange({ ...rule, filters: rule.filters.filter((_, i) => i !== at) })} />
        ))}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" disabled={disabled || !hasAttributes || rule.filters.length >= 5}
            onClick={() => firstAttribute && onChange({ ...rule, filters: [...rule.filters, { attributeId: firstAttribute.id, operator: operatorsByKind[firstAttribute.kind][0]!, source: { type: "value", value: firstAttribute.kind === "number" ? 0 : "" } }] })}>
            <Plus aria-hidden="true" /> Add a rule
          </Button>
          {hasAttributes ? null : <p className="text-muted-foreground text-xs">Add attributes to your {terms.providers} first, such as language or seniority.</p>}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <p className="font-medium text-xs">Count some {terms.providers} more</p>
        {rule.weights.map((weight, at) => (
          <WeightRow key={at} weight={weight} at={at} props={props} onChange={(next) => onChange({ ...rule, weights: rule.weights.map((entry, i) => (i === at ? next : entry)) })} onRemove={() => onChange({ ...rule, weights: rule.weights.filter((_, i) => i !== at) })} />
        ))}
        <div>
          <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" disabled={disabled || !hasAttributes || rule.weights.length >= 10}
            onClick={() => firstAttribute && onChange({ ...rule, weights: [...rule.weights, { attributeId: firstAttribute.id, value: "", multiplier: 2 }] })}>
            <Plus aria-hidden="true" /> Add a weight
          </Button>
        </div>
      </div>
    </div>
  );
}
