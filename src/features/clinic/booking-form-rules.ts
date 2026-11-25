import {
  hasOptions,
  multiChoiceTypes,
  singleChoiceTypes,
  type ConditionOperator,
  type FieldCondition,
  type FormDefinitionDraft,
  type FormField,
  type FormFieldType,
} from "@/lib/booking-forms";

/** Pure rules the form builder uses for "Show this when…", moving questions and per-service required switches. */

export const maxConditions = 3;

export type ConditionValueKind = "choice" | "yes_no" | "text";

export const fieldTypeGroups: ReadonlyArray<{ label: string; types: readonly FormFieldType[] }> = [
  { label: "Basic", types: ["short_text", "long_text", "number", "date", "yes_no", "consent"] },
  { label: "Choices", types: ["single_choice", "radio", "multiple_choice", "checkbox_group", "multi_select"] },
  { label: "Contact and address", types: ["name_split", "email", "phone", "address", "emails", "url"] },
];

export function valueKind(type: FormFieldType): ConditionValueKind {
  if (type === "yes_no" || type === "consent") return "yes_no";
  return hasOptions(type) ? "choice" : "text";
}

/** Which operators make sense for the answer to this kind of question. */
export function operatorsFor(type: FormFieldType): ConditionOperator[] {
  if (valueKind(type) === "yes_no") return ["equals", "not_equals"];
  if (multiChoiceTypes.includes(type)) return ["contains", "one_of"];
  if (singleChoiceTypes.includes(type)) return ["equals", "not_equals", "one_of"];
  return ["equals", "not_equals", "contains"];
}

export const yesNoChoices = [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }];

export function valueChoices(field: FormField): Array<{ value: string; label: string }> {
  if (valueKind(field.type) === "yes_no") return yesNoChoices;
  return [...new Set((field.options ?? []).map((option) => option.trim()).filter(Boolean))].map((option) => ({ value: option, label: option }));
}

/** Questions a condition on the question at `index` may look at: earlier ones that are shown to the customer. */
export function earlierFields(fields: readonly FormField[], index: number): FormField[] {
  return fields.slice(0, index).filter((field) => !field.hidden);
}

export function newCondition(source: FormField): FieldCondition {
  const operator = operatorsFor(source.type)[0]!;
  const first = valueKind(source.type) === "text" ? "" : valueChoices(source)[0]?.value ?? "";
  return { fieldId: source.id, operator, value: operator === "one_of" ? (first ? [first] : []) : first };
}

/** Moves a condition to another question, keeping the operator and value only when they still make sense. */
export function retarget(condition: FieldCondition, source: FormField): FieldCondition {
  if (!operatorsFor(source.type).includes(condition.operator)) return newCondition(source);
  if (valueKind(source.type) === "text") return { fieldId: source.id, operator: condition.operator, value: typeof condition.value === "string" ? condition.value : condition.value[0] ?? "" };
  const known = new Set(valueChoices(source).map((choice) => choice.value));
  const kept = (Array.isArray(condition.value) ? condition.value : [condition.value]).filter((value) => known.has(value));
  if (kept.length === 0) return newCondition(source);
  return { fieldId: source.id, operator: condition.operator, value: condition.operator === "one_of" ? kept : kept[0]! };
}

/** Changes the operator, turning one value into a list (or the reverse) as the operator needs. */
export function withOperator(condition: FieldCondition, operator: ConditionOperator): FieldCondition {
  const list = Array.isArray(condition.value) ? condition.value : condition.value ? [condition.value] : [];
  return { ...condition, operator, value: operator === "one_of" ? list : (list[0] ?? "") };
}

export const dependsOn = (field: FormField, id: string): boolean => (field.showWhen ?? []).some((condition) => condition.fieldId === id);

/** Why a question cannot swap places with its neighbour, or null when it can. Conditions may only look backwards. */
export function moveBlocker(fields: readonly FormField[], index: number, by: -1 | 1): string | null {
  const target = index + by;
  if (target < 0 || target >= fields.length) return null;
  const [upper, lower] = by === -1 ? [target, index] : [index, target];
  if (dependsOn(fields[lower]!, fields[upper]!.id)) {
    return `Question ${lower + 1} is shown only for an answer to question ${upper + 1}, so it has to stay after it. Change its "Show this when" first.`;
  }
  return null;
}

/** Removes every condition that names `id`. Returns the new questions and how many questions lost a condition. */
export function withoutConditionsOn(fields: readonly FormField[], id: string): { fields: FormField[]; changed: number } {
  let changed = 0;
  const next = fields.map((field) => {
    if (!dependsOn(field, id)) return field;
    changed += 1;
    const { showWhen, ...rest } = field;
    const kept = (showWhen ?? []).filter((condition) => condition.fieldId !== id);
    return kept.length > 0 ? { ...field, showWhen: kept } : rest;
  });
  return { fields: next, changed };
}

export type RequiredChoice = "same" | "required" | "optional";

/** A question whose required switch can differ by service. Agreements are always required and hidden ones never are. */
export const canOverrideRequired = (field: FormField): boolean => field.type !== "consent" && !field.hidden;

export function requiredChoice(draft: Pick<FormDefinitionDraft, "requiredOverrides">, serviceId: string, field: FormField): RequiredChoice {
  const value = draft.requiredOverrides?.[serviceId]?.[field.id];
  if (value === undefined) return "same";
  return value ? "required" : "optional";
}

/** Sets one choice. Only differences from the form are kept, so "same as form" and an equal value store nothing. */
export function setRequiredChoice(
  overrides: FormDefinitionDraft["requiredOverrides"],
  serviceId: string,
  field: FormField,
  choice: RequiredChoice,
): Record<string, Record<string, boolean>> | undefined {
  const next: Record<string, Record<string, boolean>> = {};
  for (const [id, entries] of Object.entries(overrides ?? {})) next[id] = { ...entries };
  const entries = next[serviceId] ?? {};
  if (choice === "same" || (choice === "required") === field.required) delete entries[field.id];
  else entries[field.id] = choice === "required";
  if (Object.keys(entries).length === 0) delete next[serviceId];
  else next[serviceId] = entries;
  return Object.keys(next).length > 0 ? next : undefined;
}

/** Drops overrides for services or questions that are no longer on the form, or that now match the form. */
export function prunedOverrides(draft: FormDefinitionDraft): FormDefinitionDraft["requiredOverrides"] {
  if (draft.appliesToAll || !draft.requiredOverrides) return undefined;
  const next: Record<string, Record<string, boolean>> = {};
  for (const [serviceId, entries] of Object.entries(draft.requiredOverrides)) {
    if (!draft.serviceIds.includes(serviceId)) continue;
    const kept: Record<string, boolean> = {};
    for (const field of draft.fields) {
      const value = entries[field.id];
      if (value !== undefined && canOverrideRequired(field) && value !== field.required) kept[field.id] = value;
    }
    if (Object.keys(kept).length > 0) next[serviceId] = kept;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/** The draft as it is saved: blank link names dropped, and per-service switches kept only where they still apply. */
export function cleanDraft(draft: FormDefinitionDraft): FormDefinitionDraft {
  const fields = draft.fields.map((field) => {
    if (field.prefillKey !== undefined && field.prefillKey.trim() === "") {
      const { prefillKey, lockWhenPrefilled, ...rest } = field;
      void prefillKey; void lockWhenPrefilled;
      return rest;
    }
    return field;
  });
  const cleaned = { ...draft, fields };
  const requiredOverrides = prunedOverrides(cleaned);
  const { requiredOverrides: _unused, ...rest } = cleaned;
  void _unused;
  return requiredOverrides ? { ...rest, requiredOverrides } : rest;
}
