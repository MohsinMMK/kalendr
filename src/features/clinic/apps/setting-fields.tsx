"use client";

import { Controller, type Control, type FieldValues, type Path } from "react-hook-form";

import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { SettingField } from "@/lib/apps/catalog";

/**
 * Draws one app setting from its description (feature 55), so every app gets the same form without writing screens.
 * Values live under `settings.<key>`; the server checks them against the app's own schema and answers per field.
 */

interface MappedRow { enabled: boolean; target: string }

function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function asMapping(value: unknown): Record<string, MappedRow> {
  const result: Record<string, MappedRow> = {};
  if (typeof value !== "object" || value === null) return result;
  for (const [key, row] of Object.entries(value)) {
    if (typeof row === "object" && row !== null && "enabled" in row && "target" in row && typeof row.enabled === "boolean" && typeof row.target === "string") {
      result[key] = { enabled: row.enabled, target: row.target };
    }
  }
  return result;
}

export function SettingFieldInput<T extends FieldValues>({ field, control, error }: { field: SettingField; control: Control<T>; error: string | undefined }) {
  const name = `settings.${field.key}` as Path<T>;
  const invalid = Boolean(error);
  const hint = field.help ? <FieldDescription>{field.help}</FieldDescription> : null;

  if (field.kind === "text") {
    return (
      <Controller control={control} name={name} render={({ field: bound }) => (
        <Field invalid={invalid}>
          <FieldLabel>{field.label}</FieldLabel>
          <Input size="lg" autoComplete="off" maxLength={field.maxLength} placeholder={field.placeholder} aria-invalid={invalid}
            value={typeof bound.value === "string" ? bound.value : ""} onChange={(event) => bound.onChange(event.target.value)} onBlur={bound.onBlur} />
          {error ? <FieldError match>{error}</FieldError> : hint}
        </Field>
      )} />
    );
  }

  if (field.kind === "switch") {
    return (
      <Controller control={control} name={name} render={({ field: bound }) => (
        <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <Label htmlFor={`setting-${field.key}`} className="font-medium">{field.label}</Label>
            {field.help ? <p className="text-muted-foreground text-xs">{field.help}</p> : null}
          </div>
          <Switch id={`setting-${field.key}`} checked={bound.value === true} onCheckedChange={bound.onChange} />
        </div>
      )} />
    );
  }

  if (field.kind === "choices") {
    return (
      <Controller control={control} name={name} render={({ field: bound }) => {
        const chosen = asStrings(bound.value);
        return (
          <fieldset className="flex flex-col gap-2">
            <legend className="font-medium text-base/4.5 sm:text-sm/4">{field.label}</legend>
            <ul className="flex w-full flex-col divide-y rounded-lg border">
              {field.options.map((option) => (
                <li key={option.value}>
                  <Label className="flex min-h-11 items-start gap-3 px-3 py-2.5">
                    <Checkbox className="mt-0.5" checked={chosen.includes(option.value)}
                      onCheckedChange={(checked) => bound.onChange(checked ? [...chosen, option.value] : chosen.filter((item) => item !== option.value))} />
                    <span className="flex flex-col gap-0.5"><span className="font-medium">{option.label}</span>{option.help ? <span className="text-muted-foreground text-xs">{option.help}</span> : null}</span>
                  </Label>
                </li>
              ))}
            </ul>
            {error ? <p role="alert" className="text-destructive-foreground text-xs">{error}</p> : hint}
          </fieldset>
        );
      }} />
    );
  }

  return (
    <Controller control={control} name={name} render={({ field: bound }) => {
      const rows = asMapping(bound.value);
      const set = (key: string, patch: Partial<MappedRow>) => bound.onChange({ ...rows, [key]: { ...rows[key], ...patch } });
      return (
        <fieldset className="flex flex-col gap-2">
          <legend className="font-medium text-base/4.5 sm:text-sm/4">{field.label}</legend>
          {hint}
          <ul className="flex w-full flex-col divide-y rounded-lg border">
            {field.rows.map((row) => {
              const current = rows[row.key] ?? { enabled: row.locked === true, target: row.defaultTarget };
              return (
                <li key={row.key} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                  <Label className="flex min-h-11 items-center gap-3 sm:min-h-0">
                    <Checkbox checked={current.enabled} disabled={row.locked === true} onCheckedChange={(checked) => set(row.key, { enabled: checked === true, target: current.target })} />
                    <span className="font-medium">{row.label}{row.locked ? <span className="ms-2 font-normal text-muted-foreground text-xs">Always sent</span> : null}</span>
                  </Label>
                  <Input aria-label={`${row.label} goes to this property`} size="lg" className="sm:max-w-48" autoComplete="off" disabled={row.locked === true || !current.enabled}
                    value={current.target} onChange={(event) => set(row.key, { target: event.target.value, enabled: current.enabled })} />
                </li>
              );
            })}
          </ul>
          {error ? <p role="alert" className="text-destructive-foreground text-xs">{error}</p> : null}
        </fieldset>
      );
    }} />
  );
}
