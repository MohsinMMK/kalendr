"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Eye } from "lucide-react";
import { useEffect, useState } from "react";
import { Controller, useForm } from "react-hook-form";
import type { z } from "zod";

import { TextareaField } from "@/components/form-fields";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { StaffApiError } from "@/features/clinic/queries/http";
import { useStepUp } from "@/features/clinic/step-up-dialog";
import { impersonateInputSchema } from "@/lib/admin-contracts";

import { adminActions } from "./admin-api";
import { useAdminCan } from "./admin-role";
import { actionErrorText } from "./reason-dialog";

type Values = z.input<typeof impersonateInputSchema>;

/**
 * "View as this business": the only way to see a business's own screens. It asks why, says plainly what
 * happens, and offers write access only to the super role.
 */
export function ImpersonateDialog({ tenantId, businessName, open, onOpenChange, onStarted }: {
  tenantId: string;
  businessName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called after the session starts. The page opens the business's home screen. */
  onStarted: () => void;
}) {
  const can = useAdminCan();
  const { runWithStepUp } = useStepUp();
  const [failure, setFailure] = useState("");
  const form = useForm<Values>({ resolver: zodResolver(impersonateInputSchema) as never, defaultValues: { reason: "", write: false } });
  const { errors, isSubmitting } = form.formState;

  useEffect(() => {
    if (!open) { form.reset({ reason: "", write: false }); queueMicrotask(() => setFailure("")); }
  }, [open, form]);

  const submit = form.handleSubmit(async (values) => {
    setFailure("");
    try {
      await runWithStepUp(() => adminActions.impersonate(tenantId, { reason: values.reason, write: can.viewAsWrite && Boolean(values.write) }));
      onStarted();
    } catch (cause: unknown) {
      const reasonError = cause instanceof StaffApiError ? cause.fieldErrors.reason?.[0] : undefined;
      if (reasonError) form.setError("reason", { message: reasonError });
      else setFailure(actionErrorText(cause));
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>View as {businessName}</DialogTitle>
            <DialogDescription>You will see this business&apos;s own screens, including customer details, the way its staff do.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            <Alert variant="info">
              <Eye aria-hidden="true" />
              <AlertTitle>What happens next</AlertTitle>
              <AlertDescription>
                <ul className="list-disc ps-4">
                  <li>The session lasts 30 minutes, then ends by itself.</li>
                  <li>A bright banner shows on every screen until you end it.</li>
                  <li>Every page you open is logged, and the business owner can see the session in their Activity log.</li>
                  {can.viewAsWrite ? null : <li>It is read-only: nothing you click can be saved.</li>}
                </ul>
              </AlertDescription>
            </Alert>
            <TextareaField label="Why do you need to look?" rows={3} maxLength={300} placeholder="For example: owner reports reminders stopped on Monday" hint="At least 10 characters. Do not write customer names or contact details." error={errors.reason?.message} {...form.register("reason")} />
            {can.viewAsWrite ? (
              <Controller control={form.control} name="write" render={({ field }) => (
                <Field className="w-full">
                  <div className="flex items-center justify-between gap-3">
                    <FieldLabel>Allow changes</FieldLabel>
                    <Switch aria-label="Allow changes" checked={Boolean(field.value)} onCheckedChange={field.onChange} />
                  </div>
                  <FieldDescription>Off by default. Turn on only when you must fix something for them. Changes are logged under your name.</FieldDescription>
                </Field>
              )} />
            ) : null}
            {failure ? <Alert variant="error"><AlertDescription>{failure}</AlertDescription></Alert> : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" size="lg" className="min-h-11" onClick={() => onOpenChange(false)} disabled={isSubmitting}>Cancel</Button>
            <Button type="submit" size="lg" className="min-h-11" disabled={isSubmitting}>
              {isSubmitting ? <Spinner aria-hidden="true" /> : null}
              Start viewing
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
