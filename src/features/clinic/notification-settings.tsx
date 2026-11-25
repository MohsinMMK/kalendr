"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { CircleAlert } from "lucide-react";
import { useEffect } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { SelectField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardPanel, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { toastManager } from "@/components/ui/toast";
import { PushToggle } from "@/features/app-support/push-toggle";
import { useTerms } from "@/features/terms/business-profile-context";
import { clockText, parseClock } from "@/lib/quiet-hours";
import { alertKindLabels, isAlertKind, type PreferenceView } from "@/lib/staff-alerts";

import { StaffApiError } from "./queries/http";
import { useMyNotifications, useSaveQuietAndDigest, useSetChannel, type MyNotifications } from "./queries/notifications";
import { ScrollArea } from "@/components/ui/scroll-area";

const channels = [
  { key: "inApp", label: "In the app", short: "App" },
  { key: "push", label: "Push on my phone", short: "Push" },
  { key: "email", label: "Email", short: "Email" },
] as const;

/** Events down the side, channels across the top, one switch in each cell. */
function ChannelGrid({ rows, onChange, disabled }: { rows: PreferenceView[]; onChange: (next: PreferenceView) => void; disabled: boolean }) {
  const t = useTerms();
  const labels = alertKindLabels(t);
  const known = rows.filter((row) => isAlertKind(row.kind));
  if (known.length === 0) return <p className="text-muted-foreground text-sm">There are no alerts for your role.</p>;
  return (
    <ScrollArea clampContentMinWidth={false}>
      <Table render={<div className="relative w-full overflow-visible!" />} aria-label="Which alerts reach you, and how">
        <TableHeader>
          <TableRow>
            <TableHead>What happened</TableHead>
            {channels.map((channel) => (
              <TableHead key={channel.key} className="w-16 text-center sm:w-28">
                <span className="sm:hidden">{channel.short}</span>
                <span className="max-sm:sr-only">{channel.label}</span>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {known.map((row) => {
            const info = labels[row.kind as keyof typeof labels];
            return (
              <TableRow key={row.kind}>
                <TableCell className="whitespace-normal">
                  <p className="font-medium text-sm">{info.label}</p>
                  <p className="text-muted-foreground text-xs">{info.description}</p>
                </TableCell>
                {channels.map((channel) => (
                  <TableCell key={channel.key} className="text-center">
                    <Switch
                      checked={row[channel.key]}
                      disabled={disabled}
                      aria-label={`${info.label}: ${channel.label}`}
                      onCheckedChange={(on) => onChange({ ...row, [channel.key]: on })}
                    />
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </ScrollArea>
  );
}

const timeFieldSchema = z.string().refine((value) => parseClock(value) !== null, "Enter a time like 07:30.");
const rhythmSchema = z.object({
  quiet: z.boolean(),
  quietStart: timeFieldSchema,
  quietEnd: timeFieldSchema,
  digest: z.boolean(),
  digestTime: timeFieldSchema,
  summary: z.enum(["off", "weekly", "monthly"]),
}).refine((value) => !value.quiet || value.quietStart !== value.quietEnd, { message: "Pick different start and end times.", path: ["quietEnd"] });
type RhythmValues = z.infer<typeof rhythmSchema>;

function valuesFrom(settings: MyNotifications): RhythmValues {
  return {
    quiet: settings.quietHours !== null,
    quietStart: clockText(settings.quietHours?.start ?? 22 * 60),
    quietEnd: clockText(settings.quietHours?.end ?? 7 * 60),
    digest: settings.digest.enabled,
    digestTime: clockText(settings.digest.minute),
    summary: settings.summary.frequency,
  };
}

/** Quiet hours for push and email, and the morning email of the day. Both are read in the business's own time. */
function Rhythm({ settings }: { settings: MyNotifications }) {
  const t = useTerms();
  const save = useSaveQuietAndDigest();
  const form = useForm<RhythmValues>({ resolver: zodResolver(rhythmSchema), defaultValues: valuesFrom(settings) });
  const { errors, isDirty } = form.formState;
  const quiet = useWatch({ control: form.control, name: "quiet" });
  const digest = useWatch({ control: form.control, name: "digest" });

  useEffect(() => form.reset(valuesFrom(settings)), [settings, form]);

  async function submit(values: RhythmValues): Promise<void> {
    try {
      await save.mutateAsync({
        quietHours: values.quiet ? { start: parseClock(values.quietStart) ?? 0, end: parseClock(values.quietEnd) ?? 0 } : null,
        digest: { enabled: values.digest, minute: parseClock(values.digestTime) ?? 420 },
        ...(settings.summary.available ? { summaryFrequency: values.summary } : {}),
      });
      toastManager.add({ title: "Saved", type: "success" });
    } catch (error: unknown) {
      toastManager.add({ title: error instanceof StaffApiError ? error.message : "Your choices could not be saved.", type: "error" });
    }
  }

  return (
    <form noValidate onSubmit={(event) => { void form.handleSubmit(submit)(event); }} className="flex flex-col gap-5 border-t pt-5">
      <div className="flex flex-col gap-3">
        <Controller control={form.control} name="quiet" render={({ field }) => (
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p id="quiet-hours-label" className="font-medium text-sm">Quiet hours</p>
              <p className="text-muted-foreground text-xs">Phone alerts and emails wait until quiet hours end. The bell in the app still shows everything straight away.</p>
            </div>
            <Switch checked={field.value} onCheckedChange={field.onChange} aria-labelledby="quiet-hours-label" />
          </div>
        )} />
        {quiet ? (
          <div className="grid grid-cols-2 gap-3 sm:max-w-sm">
            <Field invalid={Boolean(errors.quietStart)}>
              <FieldLabel>From</FieldLabel>
              <Input type="time" size="lg" step={300} {...form.register("quietStart")} />
              {errors.quietStart ? <FieldError match>{errors.quietStart.message}</FieldError> : null}
            </Field>
            <Field invalid={Boolean(errors.quietEnd)}>
              <FieldLabel>Until</FieldLabel>
              <Input type="time" size="lg" step={300} {...form.register("quietEnd")} />
              {errors.quietEnd ? <FieldError match>{errors.quietEnd.message}</FieldError> : null}
            </Field>
          </div>
        ) : null}
      </div>
      <div className="flex flex-col gap-3">
        <Controller control={form.control} name="digest" render={({ field }) => (
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p id="digest-label" className="font-medium text-sm">Morning summary by email</p>
              <p className="text-muted-foreground text-xs">One email with your day, requests waiting and yesterday&apos;s cancellations. Nothing is sent on a day with nothing to say.{settings.digestOnByDefault ? " It is on for you unless you turn it off." : ""}</p>
            </div>
            <Switch checked={field.value} onCheckedChange={field.onChange} aria-labelledby="digest-label" />
          </div>
        )} />
        {digest ? (
          <Field className="sm:max-w-40" invalid={Boolean(errors.digestTime)}>
            <FieldLabel>Send at</FieldLabel>
            <Input type="time" size="lg" step={300} {...form.register("digestTime")} />
            {errors.digestTime ? <FieldError match>{errors.digestTime.message}</FieldError> : <FieldDescription>Business time ({settings.timezone}).</FieldDescription>}
          </Field>
        ) : null}
      </div>
      {settings.summary.available ? (
        <Controller control={form.control} name="summary" render={({ field }) => (
          <SelectField
            label="Summary of your business by email"
            hint={`Bookings, cancellations, no-shows, new ${t.customers} and revenue for the last week or month, with the change from the time before. Weekly comes on Monday, monthly on the 1st.`}
            value={field.value}
            onValueChange={(value) => field.onChange(value === "weekly" || value === "monthly" ? value : "off")}
            options={[{ value: "off", label: "Off" }, { value: "weekly", label: "Every week" }, { value: "monthly", label: "Every month" }]}
            fieldClassName="sm:max-w-xs"
          />
        )} />
      ) : null}
      <Button type="submit" size="lg" className="self-start" disabled={!isDirty || save.isPending}>
        {save.isPending ? <Spinner aria-hidden="true" /> : null}
        Save
      </Button>
    </form>
  );
}

/** What this person hears about, and how: each event by app, push and email, quiet hours, and the morning summary. */
export function NotificationSettings() {
  const query = useMyNotifications();
  const setChannel = useSetChannel();
  return (
    <Card>
      <CardHeader>
        <CardTitle render={<h2 />}>Notifications</CardTitle>
        <CardDescription>Choose what you hear about and how. Phone and email alerts name the customer&apos;s first name, the service and the time, and never a phone number, email or note.</CardDescription>
      </CardHeader>
      <CardPanel className="flex flex-col gap-5">
        <PushToggle endpoint="/api/staff/push/subscribe" />
        {query.isPending ? (
          <div role="status" aria-label="Loading your notification choices" className="flex flex-col gap-3">
            {[0, 1, 2, 3, 4].map((row) => <Skeleton key={row} className="h-12 w-full" />)}
          </div>
        ) : query.isError ? (
          <Alert variant="error">
            <CircleAlert aria-hidden="true" />
            <AlertDescription className="flex flex-wrap items-center gap-3">
              Your notification choices could not be loaded.
              <Button size="sm" variant="outline" onClick={() => void query.refetch()}>Try again</Button>
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <ChannelGrid rows={query.data.preferences} disabled={setChannel.isPending} onChange={(next) => setChannel.mutate(next)} />
            {setChannel.isError ? <p role="alert" className="text-destructive-foreground text-sm">That change could not be saved. Try again.</p> : null}
            <Rhythm settings={query.data} />
          </>
        )}
      </CardPanel>
    </Card>
  );
}
