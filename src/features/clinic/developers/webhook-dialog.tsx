"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";

import { useSaveWebhook, type WebhookFormValues } from "./api";
import { errorText, serverFieldErrors } from "./shared";
import { allWebhookEvents, webhookEventDetails, type WebhookEndpoint } from "./webhook-types";

const formSchema = z.object({
  url: z.string().trim().min(1, "Enter the address that should receive events.").max(2000, "That address is too long.")
    .refine((value) => /^https:\/\//i.test(value), "Addresses must use https and a public address."),
  description: z.string().trim().max(120, "Use 120 characters or fewer."),
  events: z.array(z.string()).min(1, "Pick at least one event."),
});

const empty: WebhookFormValues = { url: "", description: "", events: [...allWebhookEvents] };

/** Adds or edits a webhook address. `onSaved` gets the secret only when a new address was made. */
export function WebhookDialog({ open, endpoint, onOpenChange, onSaved }: {
  open: boolean;
  endpoint: WebhookEndpoint | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (result: { endpoint: WebhookEndpoint; secret: string | null }) => void;
}) {
  const save = useSaveWebhook();
  const { register, control, handleSubmit, reset, setError, formState: { errors } } = useForm<WebhookFormValues>({ resolver: zodResolver(formSchema), defaultValues: empty });

  useEffect(() => {
    if (!open) return;
    reset(endpoint ? { url: endpoint.url, description: endpoint.description ?? "", events: [...endpoint.events] } : empty);
    save.reset();
  }, [open, endpoint]); // eslint-disable-line react-hooks/exhaustive-deps -- reset only when the dialog opens

  const submit = handleSubmit(async (values) => {
    try {
      const result = await save.mutateAsync({ endpoint, values });
      if (result && "endpoint" in result) onSaved({ endpoint: result.endpoint, secret: "secret" in result && typeof result.secret === "string" ? result.secret : null });
    } catch (cause: unknown) {
      const fields = serverFieldErrors(cause);
      if (fields.url) setError("url", { message: fields.url });
      if (fields.description) setError("description", { message: fields.description });
      if (fields.events) setError("events", { message: fields.events });
    }
  });

  const formError = save.isError && Object.keys(serverFieldErrors(save.error)).length === 0 ? errorText(save.error, "The address could not be saved. Try again.") : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <form onSubmit={(event) => void submit(event)} noValidate className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>{endpoint ? "Edit webhook address" : "Add a webhook address"}</DialogTitle>
            <DialogDescription>Kalendr sends a signed message to this address each time one of the chosen events happens.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-5">
            {formError ? <Alert variant="error"><AlertDescription>{formError}</AlertDescription></Alert> : null}
            <Field invalid={Boolean(errors.url)}>
              <FieldLabel>Address</FieldLabel>
              <Input size="lg" type="url" inputMode="url" autoComplete="off" placeholder="https://example.com/kalendr-events" aria-invalid={Boolean(errors.url)} {...register("url")} />
              {errors.url ? <FieldError match>{errors.url.message}</FieldError> : <FieldDescription>Must start with https:// and be reachable from the internet.</FieldDescription>}
            </Field>
            <Field invalid={Boolean(errors.description)}>
              <div className="flex w-full items-baseline justify-between gap-3"><FieldLabel>Description</FieldLabel><span className="text-muted-foreground text-xs">Optional</span></div>
              <Input size="lg" autoComplete="off" placeholder="Sends bookings to our CRM" aria-invalid={Boolean(errors.description)} {...register("description")} />
              {errors.description ? <FieldError match>{errors.description.message}</FieldError> : null}
            </Field>
            <div className="flex flex-col gap-2">
              <span id="webhook-events-label" className="font-medium text-base/4.5 sm:text-sm/4">Events to send</span>
              <Controller control={control} name="events" render={({ field }) => (
                <ul role="group" aria-labelledby="webhook-events-label" className="flex w-full flex-col divide-y rounded-lg border">
                  {allWebhookEvents.map((event) => (
                    <li key={event}>
                      <Label className="flex min-h-11 items-start gap-3 px-3 py-2.5">
                        <Checkbox className="mt-0.5" aria-labelledby={`event-${event}`} checked={field.value.includes(event)} onCheckedChange={(checked) => field.onChange(checked ? [...field.value, event] : field.value.filter((item) => item !== event))} />
                        <span className="flex flex-col gap-0.5"><span id={`event-${event}`} className="font-medium">{webhookEventDetails[event].label}</span><span className="text-muted-foreground text-xs">{webhookEventDetails[event].description}</span></span>
                      </Label>
                    </li>
                  ))}
                </ul>
              )} />
              {errors.events ? <p role="alert" className="text-destructive-foreground text-xs">{errors.events.message}</p> : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" size="lg" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" size="lg" disabled={save.isPending}>{save.isPending ? <Spinner aria-hidden="true" /> : null}{save.isPending ? "Saving…" : endpoint ? "Save changes" : "Add address"}</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
