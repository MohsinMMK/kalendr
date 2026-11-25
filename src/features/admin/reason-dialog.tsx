"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useState, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { TextareaField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { StaffApiError } from "@/features/clinic/queries/http";
import { useStepUp } from "@/features/clinic/step-up-dialog";

export function reasonSchemaOf(minLength: number) {
  return z.object({ reason: z.string().trim().min(minLength, `Say why, in at least ${minLength} characters.`).max(300, "Keep it under 300 characters.") });
}
type ReasonValues = z.infer<ReturnType<typeof reasonSchemaOf>>;

/** Turns a refusal into text; a step-up that was cancelled reads as a plain sentence. */
export function actionErrorText(cause: unknown): string {
  if (cause instanceof StaffApiError && cause.code === "step_up_required") return "A fresh authenticator code is needed for this. Try again and enter it.";
  return cause instanceof Error ? cause.message : "That did not work. Try again.";
}

/**
 * Every operator action that changes something asks for a reason first; it is kept in the audit trail.
 * The reason field shows its own error, and a refusal from the server shows above the buttons.
 */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  minLength = 5,
  destructive = false,
  children,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  minLength?: number;
  destructive?: boolean;
  /** Extra explanation shown between the description and the reason field. */
  children?: ReactNode;
  onConfirm: (reason: string) => Promise<unknown>;
}) {
  const { runWithStepUp } = useStepUp();
  const [failure, setFailure] = useState("");
  const form = useForm<ReasonValues>({ resolver: zodResolver(reasonSchemaOf(minLength)) as never, defaultValues: { reason: "" } });
  const { errors, isSubmitting } = form.formState;

  useEffect(() => {
    if (!open) { form.reset({ reason: "" }); queueMicrotask(() => setFailure("")); }
  }, [open, form]);

  const submit = form.handleSubmit(async (values) => {
    setFailure("");
    try {
      await runWithStepUp(() => onConfirm(values.reason));
      onOpenChange(false);
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
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-4">
            {children}
            <TextareaField label="Reason" rows={3} maxLength={300} placeholder="For example: owner phoned about a missed reminder" hint="Kept in the audit trail. Do not write customer names or contact details." error={errors.reason?.message} {...form.register("reason")} />
            {failure ? <Alert variant="error"><AlertDescription>{failure}</AlertDescription></Alert> : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" size="lg" className="min-h-11" onClick={() => onOpenChange(false)} disabled={isSubmitting}>Cancel</Button>
            <Button type="submit" size="lg" className="min-h-11" variant={destructive ? "destructive" : "default"} disabled={isSubmitting}>
              {isSubmitting ? <Spinner aria-hidden="true" /> : null}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
