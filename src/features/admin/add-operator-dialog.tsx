"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useState } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { SelectField, TextField, TextareaField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { StaffApiError } from "@/features/clinic/queries/http";
import { useStepUp } from "@/features/clinic/step-up-dialog";
import { platformRoles, reasonSchema } from "@/lib/admin-contracts";

import { roleLabels } from "./admin-format";
import { actionErrorText } from "./reason-dialog";

const formSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email address."),
  role: z.enum(platformRoles),
  active: z.boolean(),
  reason: reasonSchema,
});
type Values = z.infer<typeof formSchema>;

const roleOptions = platformRoles.map((role) => ({ value: role, label: roleLabels[role] }));

export function AddOperatorDialog({ open, onOpenChange, onSave }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (input: { email: string; role: Values["role"]; active: boolean; reason: string }) => Promise<unknown>;
}) {
  const { runWithStepUp } = useStepUp();
  const [failure, setFailure] = useState("");
  const form = useForm<Values>({ resolver: zodResolver(formSchema) as never, defaultValues: { email: "", role: "support", active: true, reason: "" } });
  const { errors, isSubmitting } = form.formState;
  const role = useWatch({ control: form.control, name: "role" });

  useEffect(() => {
    if (!open) { form.reset(); queueMicrotask(() => setFailure("")); }
  }, [open, form]);

  const submit = form.handleSubmit(async (values) => {
    setFailure("");
    try {
      await runWithStepUp(() => onSave(values));
      onOpenChange(false);
    } catch (cause: unknown) {
      const fieldErrors = cause instanceof StaffApiError ? cause.fieldErrors : {};
      if (fieldErrors.email?.[0]) form.setError("email", { message: fieldErrors.email[0] });
      else if (fieldErrors.reason?.[0]) form.setError("reason", { message: fieldErrors.reason[0] });
      else setFailure(actionErrorText(cause));
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>Add or change an operator</DialogTitle>
            <DialogDescription>Use their sign-in email. They need a Kalendr account and a second factor. To switch someone off, enter their email and turn Active off.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            <TextField label="Sign-in email" type="email" autoComplete="off" error={errors.email?.message} {...form.register("email")} />
            <SelectField label="Role" value={role} options={roleOptions} hint="Support can look and fix. Billing is read only for now. Super can change rollouts and operators." onValueChange={(next) => form.setValue("role", formSchema.shape.role.catch("support").parse(next))} />
            <Controller control={form.control} name="active" render={({ field }) => (
              <Field className="w-full">
                <div className="flex items-center justify-between gap-3">
                  <FieldLabel>Active</FieldLabel>
                  <Switch aria-label="Active" checked={field.value} onCheckedChange={field.onChange} />
                </div>
                <FieldDescription>Off means they can no longer open the console. Their past actions stay in the audit trail.</FieldDescription>
              </Field>
            )} />
            <TextareaField label="Reason" rows={2} maxLength={300} hint="Kept in the audit trail." error={errors.reason?.message} {...form.register("reason")} />
            {failure ? <Alert variant="error"><AlertDescription>{failure}</AlertDescription></Alert> : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" size="lg" className="min-h-11" onClick={() => onOpenChange(false)} disabled={isSubmitting}>Cancel</Button>
            <Button type="submit" size="lg" className="min-h-11" disabled={isSubmitting}>{isSubmitting ? <Spinner aria-hidden="true" /> : null}Save operator</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
