"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";

import { SelectField, TextareaField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Frame, FrameDescription, FrameFooter, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import { clockOptions, weekStartOptions, type OrgDefaults } from "@/lib/enterprise-contracts";

import { useOrgChange, useOrgDefaults } from "./api";
import { errorText, QueryState, serverFieldErrors } from "./shared";

const formSchema = z.object({
  timezone: z.string(),
  clock: z.enum(["", ...clockOptions]),
  weekStart: z.enum(["", ...weekStartOptions]),
  confirmationMessage: z.string().trim().max(600, "Use 600 characters or fewer."),
  reminderMessage: z.string().trim().max(600, "Use 600 characters or fewer."),
});
type FormValues = z.infer<typeof formSchema>;

const zones = (() => {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["Asia/Kolkata", "UTC"];
  }
})();

const toForm = (defaults: OrgDefaults): FormValues => ({
  timezone: defaults.timezone ?? "", clock: defaults.clock ?? "", weekStart: defaults.weekStart ?? "",
  confirmationMessage: defaults.confirmationMessage ?? "", reminderMessage: defaults.reminderMessage ?? "",
});

/** Settings > Organisation > Defaults: what a new branch or service starts from, so each one doesn't begin blank. */
export function DefaultsTab() {
  const query = useOrgDefaults();
  return <QueryState query={query} label="Defaults">{(defaults) => <DefaultsForm defaults={defaults} />}</QueryState>;
}

function DefaultsForm({ defaults }: { defaults: OrgDefaults }) {
  const change = useOrgChange();
  const t = useTerms();
  const { register, control, handleSubmit, reset, setError, formState: { errors, isDirty } } = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: toForm(defaults) });
  useEffect(() => { reset(toForm(defaults)); }, [defaults, reset]);

  const submit = handleSubmit(async (values) => {
    try {
      await change.mutateAsync({ path: "/api/staff/org-defaults", method: "PUT", body: {
        timezone: values.timezone || null, clock: values.clock || null, weekStart: values.weekStart || null,
        confirmationMessage: values.confirmationMessage || null, reminderMessage: values.reminderMessage || null, version: defaults.version,
      } });
      toastManager.add({ title: "Defaults saved", description: "New branches and services start from these. Existing ones are not changed.", type: "success" });
    } catch (cause: unknown) {
      const fields = serverFieldErrors(cause);
      if (fields.timezone) setError("timezone", { message: fields.timezone });
    }
  });
  const formError = change.isError && Object.keys(serverFieldErrors(change.error)).length === 0 ? errorText(change.error, "The defaults could not be saved.") : "";

  return (
    <form onSubmit={(event) => void submit(event)} noValidate>
      <Frame>
        <FrameHeader>
          <FrameTitle>Organisation defaults</FrameTitle>
          <FrameDescription>What a new branch or service starts with. Changing these never changes one that already exists.</FrameDescription>
        </FrameHeader>
        <FramePanel className="flex flex-col gap-5">
          {formError ? <Alert variant="error"><AlertDescription>{formError}</AlertDescription></Alert> : null}
          <Controller control={control} name="timezone" render={({ field }) => (
            <SelectField label="Time zone" optional error={errors.timezone?.message} value={field.value} onValueChange={field.onChange} options={[{ value: "", label: "No default" }, ...zones.map((zone) => ({ value: zone, label: zone.replace(/_/g, " ") }))]} />
          )} />
          <div className="grid gap-5 sm:grid-cols-2">
            <Controller control={control} name="clock" render={({ field }) => (
              <SelectField label="Clock" optional value={field.value} onValueChange={(value) => field.onChange(value)} options={[{ value: "", label: "No default" }, { value: "12h", label: "12-hour (3:30 pm)" }, { value: "24h", label: "24-hour (15:30)" }]} />
            )} />
            <Controller control={control} name="weekStart" render={({ field }) => (
              <SelectField label="Week starts on" optional value={field.value} onValueChange={(value) => field.onChange(value)} options={[{ value: "", label: "No default" }, { value: "monday", label: "Monday" }, { value: "sunday", label: "Sunday" }, { value: "saturday", label: "Saturday" }]} />
            )} />
          </div>
          <TextareaField label={`Confirmation wording`} optional rows={3} hint={`A starting note in the confirmation a ${t.customer} gets. Plain words, no links.`} error={errors.confirmationMessage?.message} {...register("confirmationMessage")} />
          <TextareaField label="Reminder wording" optional rows={3} hint="A starting note in reminders." error={errors.reminderMessage?.message} {...register("reminderMessage")} />
        </FramePanel>
        <FrameFooter className="flex justify-end">
          <Button type="submit" size="lg" disabled={change.isPending || !isDirty}>{change.isPending ? <Spinner aria-hidden="true" /> : null}Save defaults</Button>
        </FrameFooter>
      </Frame>
    </form>
  );
}
