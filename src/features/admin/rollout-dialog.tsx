"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { SelectField, TextField, TextareaField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { StaffApiError } from "@/features/clinic/queries/http";
import { useStepUp } from "@/features/clinic/step-up-dialog";
import { reasonSchema, rolloutInputSchema, type RolloutRow } from "@/lib/admin-contracts";

import { actionErrorText } from "./reason-dialog";

const formSchema = z.object({
  featureKey: rolloutInputSchema.shape.featureKey,
  mode: rolloutInputSchema.shape.mode,
  percent: z.string().trim(),
  tenantText: z.string(),
  reason: reasonSchema,
}).superRefine((value, context) => {
  if (value.mode === "percent") {
    const percent = Number(value.percent);
    if (value.percent === "" || !Number.isInteger(percent) || percent < 0 || percent > 100) context.addIssue({ code: "custom", path: ["percent"], message: "Enter a whole number from 0 to 100." });
  }
  if (value.mode === "listed" && parseIds(value.tenantText).length === 0) context.addIssue({ code: "custom", path: ["tenantText"], message: "List at least one business id." });
});
type Values = z.infer<typeof formSchema>;

export function parseIds(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((part) => part.trim()).filter(Boolean))];
}

const modeOptions = [
  { value: "off", label: "Off for everyone" },
  { value: "listed", label: "On for listed businesses" },
  { value: "percent", label: "On for a percentage" },
  { value: "all", label: "On for everyone" },
];

function defaults(row: RolloutRow | null): Values {
  return { featureKey: row?.featureKey ?? "", mode: row?.mode ?? "off", percent: String(row?.percent ?? 0), tenantText: row?.tenantIds.join("\n") ?? "", reason: "" };
}

export function RolloutDialog({ open, row, onOpenChange, onSave }: {
  open: boolean;
  /** The rollout being edited, or null to start a new one. */
  row: RolloutRow | null;
  onOpenChange: (open: boolean) => void;
  onSave: (input: { featureKey: string; mode: string; percent: number; tenantIds: string[]; reason: string }) => Promise<unknown>;
}) {
  const { runWithStepUp } = useStepUp();
  const [failure, setFailure] = useState("");
  const form = useForm<Values>({ resolver: zodResolver(formSchema) as never, defaultValues: defaults(row) });
  const { errors, isSubmitting } = form.formState;
  const mode = useWatch({ control: form.control, name: "mode" });

  useEffect(() => {
    if (open) { form.reset(defaults(row)); queueMicrotask(() => setFailure("")); }
  }, [open, row, form]);

  const submit = form.handleSubmit(async (values) => {
    setFailure("");
    try {
      await runWithStepUp(() => onSave({ featureKey: values.featureKey, mode: values.mode, percent: values.mode === "percent" ? Number(values.percent) : 0, tenantIds: values.mode === "listed" ? parseIds(values.tenantText) : [], reason: values.reason }));
      onOpenChange(false);
    } catch (cause: unknown) {
      const fieldErrors = cause instanceof StaffApiError ? cause.fieldErrors : {};
      const reasonError = fieldErrors.reason?.[0];
      if (reasonError) form.setError("reason", { message: reasonError });
      else setFailure(actionErrorText(cause));
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{row ? `Edit ${row.featureKey}` : "New rollout"}</DialogTitle>
            <DialogDescription>Choose who gets this feature. It takes effect straight away.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            <TextField label="Feature key" placeholder="for example: waitlist.v2" disabled={row !== null} error={errors.featureKey?.message ? "Use lowercase letters, numbers, dots, dashes or underscores, starting with a letter." : undefined} {...form.register("featureKey")} />
            <SelectField label="Who gets it" value={mode} options={modeOptions} onValueChange={(next) => form.setValue("mode", rolloutInputSchema.shape.mode.catch("off").parse(next), { shouldValidate: true })} />
            {mode === "percent" ? <TextField label="Percentage of businesses" type="number" inputMode="numeric" min={0} max={100} error={errors.percent?.message} hint="The same businesses stay in as the number grows." {...form.register("percent")} /> : null}
            {mode === "listed" ? <TextareaField label="Business ids" rows={4} placeholder="One id per line" hint="Copy ids from a business page." error={errors.tenantText?.message} {...form.register("tenantText")} /> : null}
            <TextareaField label="Reason" rows={2} maxLength={300} hint="Kept in the audit trail." error={errors.reason?.message} {...form.register("reason")} />
            {failure ? <Alert variant="error"><AlertDescription>{failure}</AlertDescription></Alert> : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" size="lg" className="min-h-11" onClick={() => onOpenChange(false)} disabled={isSubmitting}>Cancel</Button>
            <Button type="submit" size="lg" className="min-h-11" disabled={isSubmitting}>{isSubmitting ? <Spinner aria-hidden="true" /> : null}Save rollout</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
