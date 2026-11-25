"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { SelectField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Radio, RadioGroup } from "@/components/ui/radio-group";
import { Spinner } from "@/components/ui/spinner";
import { apiScopeLabels, apiScopes, apiWriteScopes, type ApiScope } from "@/lib/api-scopes";
import type { CreatedApiKey } from "@/server/api-keys-contracts";

import { useCreateApiKey } from "./api";
import { errorText, serverFieldErrors } from "./shared";

const readScopes = apiScopes.filter((scope) => !apiWriteScopes.includes(scope));

const presets: { id: string; label: string; scopes: readonly ApiScope[] }[] = [
  { id: "read", label: "Read only", scopes: readScopes },
  { id: "widget", label: "Booking widget", scopes: ["services:read", "staff:read", "availability:read", "appointments:write", "customers:write"] },
  { id: "full", label: "Full access", scopes: apiScopes },
];

const expiryOptions = [
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "730", label: "2 years (the longest)" },
];

const formSchema = z.object({
  name: z.string().trim().min(1, "Give the key a name.").max(80, "Use 80 characters or fewer."),
  mode: z.enum(["live", "test"]),
  scopes: z.array(z.enum(apiScopes)).min(1, "Choose at least one thing the key may do."),
  expiry: z.enum(["30", "90", "365", "730"]),
});
type FormValues = z.infer<typeof formSchema>;

/** Not inside the component: the clock is read when the form is sent, not while it renders. */
function expiryFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

const emptyForm: FormValues = { name: "", mode: "live", scopes: readScopes, expiry: "365" };

/** Makes a key. The result goes back to the caller, which shows it once. */
export function CreateKeyDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (created: CreatedApiKey) => void }) {
  const create = useCreateApiKey();
  const { register, control, handleSubmit, reset, setValue, setError, formState: { errors } } = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: emptyForm });
  const mode = useWatch({ control, name: "mode" });
  const scopes = useWatch({ control, name: "scopes" });

  useEffect(() => { if (open) { reset(emptyForm); create.reset(); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps -- reset only when the dialog opens

  function chooseMode(next: "live" | "test") {
    setValue("mode", next);
    // A test key cannot change anything, so the change-making options go with it.
    if (next === "test") setValue("scopes", scopes.filter((scope) => !apiWriteScopes.includes(scope)), { shouldValidate: true });
  }

  function applyPreset(preset: (typeof presets)[number]) {
    setValue("scopes", preset.scopes.filter((scope) => mode === "live" || !apiWriteScopes.includes(scope)), { shouldValidate: true });
  }

  const submit = handleSubmit(async (values) => {
    const expiresAt = expiryFromNow(Number(values.expiry));
    try {
      const created = await create.mutateAsync({ name: values.name, mode: values.mode, scopes: values.scopes, expiresAt });
      onCreated(created);
    } catch (cause: unknown) {
      const fields = serverFieldErrors(cause);
      if (fields.name) setError("name", { message: fields.name });
      if (fields.scopes) setError("scopes", { message: fields.scopes });
      if (fields.expiresAt) setError("expiry", { message: fields.expiresAt });
    }
  });

  const formError = create.isError && Object.keys(serverFieldErrors(create.error)).length === 0 ? errorText(create.error, "The key could not be created. Try again.") : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <form onSubmit={(event) => void submit(event)} noValidate className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>Create an API key</DialogTitle>
            <DialogDescription>A key lets other software use Kalendr for you. Choose only what it needs.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-5">
            {formError ? <Alert variant="error"><AlertDescription>{formError}</AlertDescription></Alert> : null}
            <Field invalid={Boolean(errors.name)}>
              <FieldLabel>Name</FieldLabel>
              <Input size="lg" autoComplete="off" placeholder="Website booking widget" aria-invalid={Boolean(errors.name)} {...register("name")} />
              {errors.name ? <FieldError match>{errors.name.message}</FieldError> : <FieldDescription>Only you see this. It helps you tell keys apart.</FieldDescription>}
            </Field>

            <div className="flex flex-col gap-2">
              <span id="key-mode-label" className="font-medium text-base/4.5 sm:text-sm/4">Kind of key</span>
              <RadioGroup aria-labelledby="key-mode-label" value={mode} onValueChange={(next) => chooseMode(next === "test" ? "test" : "live")}>
                <Label className="flex items-start gap-3 rounded-lg border p-3">
                  <Radio value="live" className="mt-0.5" aria-labelledby="key-mode-live" />
                  <span className="flex flex-col gap-0.5"><span id="key-mode-live" className="font-medium">Live</span><span className="text-muted-foreground text-xs">Works on your real bookings and customers. It can change them if you allow it.</span></span>
                </Label>
                <Label className="flex items-start gap-3 rounded-lg border p-3">
                  <Radio value="test" className="mt-0.5" aria-labelledby="key-mode-test" />
                  <span className="flex flex-col gap-0.5"><span id="key-mode-test" className="font-medium">Test</span><span className="text-muted-foreground text-xs">Can only read. Safe for trying things out, because it cannot book or change anything.</span></span>
                </Label>
              </RadioGroup>
            </div>

            <div className="flex flex-col gap-2">
              <span id="key-scopes-label" className="font-medium text-base/4.5 sm:text-sm/4">What it may do</span>
              <div role="group" aria-label="Quick choices" className="flex flex-wrap gap-2">
                {presets.map((preset) => <Button key={preset.id} type="button" size="sm" variant="outline" onClick={() => applyPreset(preset)}>{preset.label}</Button>)}
              </div>
              <Controller control={control} name="scopes" render={({ field }) => (
                <ul role="group" aria-labelledby="key-scopes-label" className="flex w-full flex-col divide-y rounded-lg border">
                  {apiScopes.map((scope) => {
                    const blocked = mode === "test" && apiWriteScopes.includes(scope);
                    return (
                      <li key={scope}>
                        <Label className="flex min-h-11 items-start gap-3 px-3 py-2.5 data-[blocked=true]:opacity-60" data-blocked={blocked}>
                          <Checkbox className="mt-0.5" aria-labelledby={`scope-${scope}`} disabled={blocked} checked={field.value.includes(scope)} onCheckedChange={(checked) => field.onChange(checked ? [...field.value, scope] : field.value.filter((item) => item !== scope))} />
                          <span className="flex flex-col gap-0.5">
                            <span id={`scope-${scope}`} className="font-medium">{apiScopeLabels[scope].label}</span>
                            <span className="text-muted-foreground text-xs">{blocked ? "Not available on a test key." : apiScopeLabels[scope].description}</span>
                          </span>
                        </Label>
                      </li>
                    );
                  })}
                </ul>
              )} />
              {errors.scopes ? <p role="alert" className="text-destructive-foreground text-xs">{errors.scopes.message}</p> : null}
            </div>

            <Controller control={control} name="expiry" render={({ field }) => (
              <SelectField label="Stops working after" hint="A key that ends on its own is safer if it is ever lost." error={errors.expiry?.message} value={field.value} onValueChange={field.onChange} options={expiryOptions} />
            )} />
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" size="lg" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" size="lg" disabled={create.isPending}>{create.isPending ? <Spinner aria-hidden="true" /> : null}{create.isPending ? "Creating…" : "Create key"}</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
