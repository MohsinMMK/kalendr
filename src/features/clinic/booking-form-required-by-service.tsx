"use client";

import { useState } from "react";

import { OptionSelect } from "@/components/form-fields";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "@/components/ui/collapsible";
import type { FormDefinitionDraft, FormField } from "@/lib/booking-forms";

import { canOverrideRequired, requiredChoice, setRequiredChoice, type RequiredChoice } from "./booking-form-rules";

interface Props {
  draft: FormDefinitionDraft;
  services: ReadonlyArray<{ id: string; name: string }>;
  serviceWord: string;
  errors: Record<string, string>;
  disabled: boolean;
  onChange: (overrides: FormDefinitionDraft["requiredOverrides"]) => void;
}

/** For a form attached to chosen services: which questions are required on one service but not another. */
export function RequiredByService({ draft, services, serviceWord, errors, disabled, onChange }: Props) {
  const attached = services.filter((service) => draft.serviceIds.includes(service.id));
  const [picked, setPicked] = useState("");
  const serviceId = attached.some((service) => service.id === picked) ? picked : attached[0]?.id ?? "";
  const fields = draft.fields.filter(canOverrideRequired);
  const changes = Object.values(draft.requiredOverrides ?? {}).reduce((sum, entries) => sum + Object.keys(entries).length, 0);

  if (draft.appliesToAll) {
    return <p className="text-muted-foreground text-xs">This form is for every {serviceWord}, so a question is required or optional for all of them. Choose only some to set it for one.</p>;
  }
  if (attached.length === 0) return null;

  return (
    <Collapsible className="flex flex-col gap-3">
      <CollapsibleTrigger className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg border px-3 text-start font-medium text-sm">
        <span>Required on one {serviceWord} only</span>
        <span className="font-normal text-muted-foreground text-xs">{changes === 0 ? "Same everywhere" : `${changes} ${changes === 1 ? "difference" : "differences"}`}</span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="flex flex-col gap-3">
          <p className="text-muted-foreground text-xs">Pick a {serviceWord}, then change what is required just for it. Anything left on “Same as form” follows the question’s own Required switch.</p>
          <OptionSelect aria-label={`Set what is required for`} value={serviceId} options={attached.map((service) => ({ value: service.id, label: service.name }))} onValueChange={setPicked} disabled={disabled} />
          {errors[`requiredOverrides.${serviceId}`] ? <p role="alert" className="text-destructive-foreground text-xs">{errors[`requiredOverrides.${serviceId}`]}</p> : null}
          <ul className="flex flex-col divide-y rounded-lg border">
            {fields.map((field) => (
              <li key={field.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span className="min-w-0 flex-1 basis-40 text-sm">{field.label.trim() || "Untitled question"}</span>
                <div className="w-full sm:w-56">
                  <OptionSelect
                    aria-label={`${field.label.trim() || "Untitled question"}: required on this ${serviceWord}`}
                    value={requiredChoice(draft, serviceId, field)}
                    options={choiceOptions(field)}
                    onValueChange={(next) => onChange(setRequiredChoice(draft.requiredOverrides, serviceId, field, next as RequiredChoice))}
                    disabled={disabled}
                  />
                  {errors[`requiredOverrides.${serviceId}.${field.id}`] ? <p role="alert" className="mt-1 text-destructive-foreground text-xs">{errors[`requiredOverrides.${serviceId}.${field.id}`]}</p> : null}
                </div>
              </li>
            ))}
            {fields.length === 0 ? <li className="px-3 py-2 text-muted-foreground text-sm">No questions can change by {serviceWord}.</li> : null}
          </ul>
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

function choiceOptions(field: FormField): Array<{ value: RequiredChoice; label: string }> {
  return [
    { value: "same", label: `Same as form (${field.required ? "required" : "optional"})` },
    { value: "required", label: "Required" },
    { value: "optional", label: "Optional" },
  ];
}
