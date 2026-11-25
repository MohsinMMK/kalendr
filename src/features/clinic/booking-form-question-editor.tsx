"use client";

import { ArrowDown, ArrowUp, MoreHorizontal, Plus, Trash2, X } from "lucide-react";

import { TextField } from "@/components/form-fields";
import { Button } from "@/components/ui/button";
import { FramePanel } from "@/components/ui/frame";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Select, SelectGroup, SelectGroupLabel, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { formFieldTypeLabels, formLimits, hasOptions, type FormField, type FormFieldType } from "@/lib/booking-forms";

import { ConditionsEditor } from "./booking-form-conditions";
import { HiddenBadge, LinkSettings } from "./booking-form-link-settings";
import { fieldTypeGroups } from "./booking-form-rules";

const typeItems = fieldTypeGroups.flatMap((group) => group.types).map((type) => ({ value: type, label: formFieldTypeLabels[type] }));

function TypeSelect({ id, value, disabled, onValueChange }: { id: string; value: FormFieldType; disabled: boolean; onValueChange: (type: FormFieldType) => void }) {
  return (
    <Select items={typeItems} value={value} disabled={disabled} onValueChange={(next) => { if (next) onValueChange(next as FormFieldType); }}>
      <SelectTrigger id={id} size="lg"><SelectValue /></SelectTrigger>
      <SelectPopup>
        {fieldTypeGroups.map((group) => (
          <SelectGroup key={group.label}>
            <SelectGroupLabel>{group.label}</SelectGroupLabel>
            {group.types.map((type) => <SelectItem key={type} value={type}>{formFieldTypeLabels[type]}</SelectItem>)}
          </SelectGroup>
        ))}
      </SelectPopup>
    </Select>
  );
}

export interface QuestionEditorProps {
  field: FormField;
  fields: readonly FormField[];
  index: number;
  errors: Record<string, string>;
  disabled: boolean;
  onChange: (change: (field: FormField) => FormField) => void;
  onTypeChange: (type: FormFieldType) => void;
  onMove: (by: -1 | 1) => void;
  onRemove: () => void;
}

export function QuestionEditor({ field, fields, index, errors, disabled, onChange, onTypeChange, onMove, onRemove }: QuestionEditorProps) {
  const base = `fields.${index}`;
  const id = `booking-form-q-${field.id}`;
  const number = index + 1;
  const count = fields.length;
  const consent = field.type === "consent";
  const options = field.options ?? [];
  const optionsError = errors[`${base}.options`] ?? options.map((_, at) => errors[`${base}.options.${at}`]).find(Boolean);

  function setOption(at: number, value: string) {
    onChange((before) => ({ ...before, options: (before.options ?? []).map((option, i) => (i === at ? value : option)) }));
  }

  return (
    <FramePanel className="flex flex-col gap-3" role="group" aria-labelledby={`${id}-heading`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <p id={`${id}-heading`} className="font-medium text-sm">Question {number}</p>
          {field.hidden ? <HiddenBadge /> : null}
        </div>
        <Menu>
          <MenuTrigger render={<Button type="button" variant="ghost" size="icon" aria-label={`More for question ${number}`} disabled={disabled} />}>
            <MoreHorizontal aria-hidden="true" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem disabled={index === 0} onClick={() => onMove(-1)}><ArrowUp aria-hidden="true" /> Move up</MenuItem>
            <MenuItem disabled={index === count - 1} onClick={() => onMove(1)}><ArrowDown aria-hidden="true" /> Move down</MenuItem>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={onRemove}><Trash2 aria-hidden="true" /> Remove</MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] sm:items-start">
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-type`}>Answer type</Label>
          <TypeSelect id={`${id}-type`} value={field.type} disabled={disabled} onValueChange={onTypeChange} />
        </div>
        <TextField
          label={consent ? "What they agree to" : "Question"}
          value={field.label}
          onChange={(event) => onChange((before) => ({ ...before, label: event.target.value }))}
          maxLength={formLimits.label}
          error={errors[`${base}.label`]}
          disabled={disabled}
        />
      </div>
      <TextField
        label="Help text"
        optional
        hint="A short hint shown under the question."
        value={field.help ?? ""}
        onChange={(event) => {
          const help = event.target.value;
          onChange((before) => {
            const next: FormField = { ...before, help };
            if (!help) delete next.help;
            return next;
          });
        }}
        maxLength={formLimits.help}
        error={errors[`${base}.help`]}
        disabled={disabled}
      />
      {hasOptions(field.type) ? (
        <div className="flex flex-col gap-2" role="group" aria-labelledby={`${id}-options`}>
          <p id={`${id}-options`} className="font-medium text-sm">Options</p>
          {options.map((option, at) => (
            <div key={at} className="flex items-center gap-2">
              <Input
                aria-label={`Option ${at + 1} for question ${number}`}
                value={option}
                placeholder={`Option ${at + 1}`}
                maxLength={formLimits.option}
                onChange={(event) => setOption(at, event.target.value)}
                aria-invalid={errors[`${base}.options.${at}`] ? true : undefined}
                disabled={disabled}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove option ${at + 1} from question ${number}`}
                onClick={() => onChange((before) => ({ ...before, options: (before.options ?? []).filter((_, i) => i !== at) }))}
                disabled={disabled || options.length <= 2}
              >
                <X aria-hidden="true" />
              </Button>
            </div>
          ))}
          {optionsError ? <p className="text-xs text-destructive-foreground">{optionsError}</p> : null}
          <div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onChange((before) => ({ ...before, options: [...(before.options ?? []), ""] }))}
              disabled={disabled || options.length >= formLimits.options}
            >
              <Plus aria-hidden="true" /> Add option
            </Button>
          </div>
        </div>
      ) : null}
      {field.hidden ? null : (
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <Label htmlFor={`${id}-required`} className="font-medium">Required</Label>
            <p className="text-xs text-muted-foreground">
              {consent ? "An agreement box must always be ticked." : "They cannot book without answering."}
            </p>
          </div>
          <Switch
            id={`${id}-required`}
            checked={consent ? true : field.required}
            onCheckedChange={(on) => onChange((before) => ({ ...before, required: on }))}
            disabled={disabled || consent}
          />
        </div>
      )}
      {field.hidden ? null : (
        <ConditionsEditor field={field} index={index} fields={fields} errors={errors} disabled={disabled} onChange={(showWhen) => onChange((before) => {
          const { showWhen: _old, ...rest } = before;
          void _old;
          return showWhen ? { ...rest, showWhen } : rest;
        })} />
      )}
      <LinkSettings field={field} errors={{ prefillKey: errors[`${base}.prefillKey`], hidden: errors[`${base}.hidden`] }} disabled={disabled} onChange={onChange} />
    </FramePanel>
  );
}
