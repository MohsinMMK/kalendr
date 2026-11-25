"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { TZDate } from "@date-fns/tz";
import { Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { useFieldArray, useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { OptionSelect, SelectField, TextareaField, TextField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ResponsiveDrawer, ResponsiveDrawerPopup } from "@/components/responsive-drawer";
import { DrawerDescription, DrawerFooter, DrawerHeader, DrawerPanel, DrawerTitle } from "@/components/ui/drawer";
import { useTerms } from "@/features/terms/business-profile-context";
import {
  campaignChannelLabels, campaignChannels, campaignFields, campaignInputSchema, ruleLabels, ruleTypes, type CampaignChannel, type CampaignInput, type CampaignSummary, type RuleType,
} from "@/lib/campaign-contracts";

import { campaignErrorText } from "./campaign-parts";
import { useCatalogLookups } from "./clinic-catalog";
import { staffMutation, StaffApiError } from "./queries/http";
import { campaignKeys, useSegments, type CampaignOptions } from "./queries/campaigns";

const formSchema = z.object({
  name: z.string().trim().min(1, "Give the campaign a name.").max(120, "Use 120 characters or fewer."),
  channel: z.enum(campaignChannels),
  subject: z.string(),
  body: z.string(),
  templateKey: z.string(),
  segmentId: z.string(),
  serviceId: z.string(),
  schedule: z.enum(["now", "later"]),
  scheduledLocal: z.string(),
  ruleType: z.enum(ruleTypes),
  recall: z.array(z.object({ serviceId: z.string(), days: z.string() })),
  daysAway: z.string(),
  daysBefore: z.string(),
  hoursAfter: z.string(),
});
type FormValues = z.infer<typeof formSchema>;

export type CampaignFormMode = { kind: "one_off" } | { kind: "automated"; ruleType?: RuleType } | { kind: "edit"; campaign: CampaignSummary };

/** "2026-12-01T10:30" read as the business's own clock, as an exact moment. */
export function localToIso(local: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number);
  const moment = new TZDate(y ?? 0, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0, 0, timeZone);
  return Number.isNaN(moment.getTime()) ? null : new Date(moment.getTime()).toISOString();
}

export function isoToLocal(iso: string | null, timeZone: string): string {
  if (!iso) return "";
  const moment = new TZDate(new Date(iso), timeZone);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${moment.getFullYear()}-${two(moment.getMonth() + 1)}-${two(moment.getDate())}T${two(moment.getHours())}:${two(moment.getMinutes())}`;
}

function defaults(mode: CampaignFormMode, timeZone: string): FormValues {
  const base: FormValues = {
    name: "", channel: "email", subject: "", body: "", templateKey: "", segmentId: "", serviceId: "", schedule: "now", scheduledLocal: "",
    ruleType: "recall", recall: [{ serviceId: "", days: "180" }], daysAway: "90", daysBefore: "14", hoursAfter: "24",
  };
  if (mode.kind === "automated") return { ...base, ruleType: mode.ruleType ?? "recall" };
  if (mode.kind !== "edit") return base;
  const campaign = mode.campaign;
  const rule = campaign.rule;
  return {
    ...base,
    name: campaign.name, channel: campaign.channel, subject: campaign.subject, body: campaign.body, templateKey: campaign.templateKey ?? "",
    segmentId: campaign.segmentId ?? "", serviceId: campaign.serviceId ?? "", schedule: campaign.scheduledAt ? "later" : "now", scheduledLocal: isoToLocal(campaign.scheduledAt, timeZone),
    ruleType: rule?.type ?? "recall",
    recall: rule?.type === "recall" ? rule.services.map((entry) => ({ serviceId: entry.serviceId, days: String(entry.intervalDays) })) : base.recall,
    daysAway: rule?.type === "win_back" ? String(rule.daysAway) : base.daysAway,
    daysBefore: rule?.type === "package_expiring" ? String(rule.daysBefore) : base.daysBefore,
    hoursAfter: rule?.type === "routing_abandoned" ? String(rule.hoursAfter) : base.hoursAfter,
  };
}

function buildInput(values: FormValues, kind: "one_off" | "automated", presetKey: string | null, timeZone: string): CampaignInput | { error: { path: keyof FormValues; message: string } } {
  const content = { channel: values.channel, subject: values.subject, body: values.body, templateKey: values.channel === "whatsapp" ? values.templateKey || null : null };
  if (kind === "one_off") {
    const scheduledAt = values.schedule === "later" ? localToIso(values.scheduledLocal, timeZone) : null;
    if (values.schedule === "later" && !scheduledAt) return { error: { path: "scheduledLocal", message: "Choose the date and time." } };
    const parsed = campaignInputSchema.safeParse({ kind, name: values.name, segmentId: values.segmentId, serviceId: values.serviceId || null, scheduledAt, ...content });
    return parsed.success ? parsed.data : { error: firstIssue(parsed.error) };
  }
  const days = (text: string) => Number(text.trim());
  const rule = values.ruleType === "recall" ? { type: "recall", services: values.recall.map((row) => ({ serviceId: row.serviceId, intervalDays: days(row.days) })) }
    : values.ruleType === "birthday" ? { type: "birthday" }
      : values.ruleType === "win_back" ? { type: "win_back", daysAway: days(values.daysAway) }
        : values.ruleType === "routing_abandoned" ? { type: "routing_abandoned", hoursAfter: days(values.hoursAfter) }
          : { type: "package_expiring", daysBefore: days(values.daysBefore) };
  const parsed = campaignInputSchema.safeParse({ kind, name: values.name, rule, presetKey, ...content });
  return parsed.success ? parsed.data : { error: firstIssue(parsed.error, values.ruleType) };
}

const fieldOf: Record<string, keyof FormValues> = { name: "name", subject: "subject", body: "body", templateKey: "templateKey", segmentId: "segmentId", rule: "recall", serviceId: "serviceId", scheduledAt: "scheduledLocal" };

/** The visible field that holds a rule's number: an error on `rule` must land where the person can see it. */
const ruleFieldOf: Record<FormValues["ruleType"], keyof FormValues> = { recall: "recall", birthday: "ruleType", win_back: "daysAway", routing_abandoned: "hoursAfter", package_expiring: "daysBefore" };

function formFieldOf(serverField: string, ruleType: FormValues["ruleType"]): keyof FormValues | undefined {
  return serverField === "rule" ? ruleFieldOf[ruleType] : fieldOf[serverField];
}

function firstIssue(error: z.ZodError, ruleType: FormValues["ruleType"] = "recall"): { path: keyof FormValues; message: string } {
  const issue = error.issues[0];
  const head = String(issue?.path[0] ?? "name");
  return { path: formFieldOf(head, ruleType) ?? "name", message: issue?.message ?? "Check this field." };
}

/** Create or edit a campaign. Mounted only while open so each opening starts clean. */
export function CampaignForm({ mode, options, onClose, onSaved }: { mode: CampaignFormMode; options: CampaignOptions | undefined; onClose: () => void; onSaved: (campaign: CampaignSummary) => void }) {
  const t = useTerms();
  const catalog = useCatalogLookups();
  const queryClient = useQueryClient();
  const timeZone = catalog.clinic.timezone;
  const kind = mode.kind === "edit" ? mode.campaign.kind : mode.kind;
  const segments = useSegments(kind === "one_off");
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [message, setMessage] = useState("");
  const form = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: defaults(mode, timeZone) });
  const { register, handleSubmit, setError, setValue, control, formState: { errors, isSubmitting } } = form;
  const recall = useFieldArray({ control, name: "recall" });
  const [channel, ruleType, schedule, templateKey, body] = useWatch({ control, name: ["channel", "ruleType", "schedule", "templateKey", "body"] });
  const watched = useWatch({ control });

  const services = catalog.services.filter((service) => service.isActive !== false).map((service) => ({ value: service.id, label: service.name }));
  const channelStatus = (value: CampaignChannel) => options?.channels.find((entry) => entry.channel === value);
  const approvedTemplates = options?.templates ?? [];
  const needsLine = channel === "whatsapp" ? templateKey === "campaign_offer" : channel === "sms";
  const editingPreset = mode.kind === "edit" ? mode.campaign.presetKey : null;
  const addField = (key: string) => setValue("body", `${body}${body && !body.endsWith(" ") && !body.endsWith("\n") ? " " : ""}{${key}}`, { shouldDirty: true });

  const submit = handleSubmit(async (values) => {
    setMessage("");
    const input = buildInput(values, kind, editingPreset, timeZone);
    if ("error" in input) { setError(input.error.path, { type: "validate", message: input.error.message }); return; }
    try {
      const saved = mode.kind === "edit"
        ? await staffMutation<CampaignSummary>(`/api/staff/campaigns/${mode.campaign.id}`, "PUT", { ...input, version: mode.campaign.version })
        : await staffMutation<CampaignSummary>("/api/staff/campaigns", "POST", input, { idempotencyKey });
      void queryClient.invalidateQueries({ queryKey: campaignKeys.all() });
      onSaved(saved);
    } catch (cause: unknown) {
      if (cause instanceof StaffApiError) {
        let placed = false;
        for (const serverField of Object.keys(fieldOf)) {
          const text = cause.fieldErrors[serverField]?.[0];
          const formField = formFieldOf(serverField, ruleType);
          if (text && formField) { setError(formField, { type: "server", message: text }); placed = true; }
        }
        if (placed) return;
      }
      setMessage(campaignErrorText(cause, "The campaign could not be saved. Try again."));
    }
  });

  const title = mode.kind === "edit" ? "Edit campaign" : kind === "one_off" ? "New one-off message" : "New automated campaign";
  return (
    <form noValidate aria-label={title} className="contents" onSubmit={(event) => void submit(event)}>
      <DrawerHeader>
        <DrawerTitle>{title}</DrawerTitle>
        <DrawerDescription>{kind === "one_off" ? `Goes once to a segment of ${t.customers} who agreed to marketing.` : `Runs every day and reaches each ${t.customer} once, as they qualify.`}</DrawerDescription>
      </DrawerHeader>
      <DrawerPanel className="flex flex-col gap-4">
        {message ? <Alert variant="error"><AlertDescription>{message}</AlertDescription></Alert> : null}
        <TextField label="Name" autoComplete="off" maxLength={120} placeholder={kind === "one_off" ? "Quiet Tuesday offer" : "6-month recall"} error={errors.name?.message} {...register("name")} />

        {kind === "one_off" ? (
          <>
            <SelectField
              label="Who it goes to" value={watched.segmentId ?? ""} onValueChange={(value) => setValue("segmentId", value, { shouldDirty: true })}
              placeholder={segments.isPending ? "Loading segments…" : "Choose a segment"} error={errors.segmentId?.message}
              options={(segments.data ?? []).map((segment) => ({ value: segment.id, label: `${segment.name} · ${segment.count} ${segment.count === 1 ? t.customer : t.customers}` }))}
              hint={<>Only {t.customers} who agreed to marketing are sent to. <Link href="/patients?view=segments" className="underline">Make a segment</Link></>}
            />
            <SelectField
              label={`Skip ${t.customers} who already have this booked`} optional value={watched.serviceId ?? ""} onValueChange={(value) => setValue("serviceId", value, { shouldDirty: true })}
              options={[{ value: "", label: `No ${t.service}` }, ...services]} error={errors.serviceId?.message}
            />
          </>
        ) : (
          <>
            <SelectField
              label="Runs when" value={ruleType} onValueChange={(value) => setValue("ruleType", ruleTypes.find((type) => type === value) ?? "recall", { shouldDirty: true })} disabled={Boolean(editingPreset)} error={errors.ruleType?.message}
              options={ruleTypes.map((type) => ({ value: type, label: ruleLabels[type].title }))} hint={ruleLabels[ruleType].hint}
            />
            {ruleType === "recall" ? (
              <fieldset className="flex flex-col gap-2">
                <legend className="font-medium text-sm">Which {t.service}, and how long after</legend>
                {recall.fields.map((row, index) => (
                  <div key={row.id} className="flex items-end gap-2">
                    <div className="min-w-0 flex-1">
                      <OptionSelect aria-label={`${t.Service} ${index + 1}`} value={watched.recall?.[index]?.serviceId ?? ""} onValueChange={(value) => setValue(`recall.${index}.serviceId`, value, { shouldDirty: true })} options={services} placeholder={`Choose ${t.aService}`} />
                    </div>
                    <div className="w-28 shrink-0">
                      <TextField label={index === 0 ? "Days after" : <span className="sr-only">Days after, {t.service} {index + 1}</span>} inputMode="numeric" autoComplete="off" {...register(`recall.${index}.days`)} />
                    </div>
                    {recall.fields.length > 1 ? <Button type="button" variant="ghost" size="icon" className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9" aria-label={`Remove ${t.service} ${index + 1}`} onClick={() => recall.remove(index)}><Trash2 aria-hidden="true" /></Button> : null}
                  </div>
                ))}
                {errors.recall?.message ? <p role="alert" className="text-destructive-foreground text-xs">{errors.recall.message}</p> : null}
                <Button type="button" size="sm" variant="outline" className="min-h-11 self-start sm:min-h-8" onClick={() => recall.append({ serviceId: "", days: "180" })}><Plus aria-hidden="true" />Add {t.aService}</Button>
              </fieldset>
            ) : null}
            {ruleType === "win_back" ? <TextField label="Days since their last visit" inputMode="numeric" autoComplete="off" hint="They are messaged once, when this many days have passed." error={errors.daysAway?.message} {...register("daysAway")} /> : null}
            {ruleType === "routing_abandoned" ? <TextField label="Hours after they answered" inputMode="numeric" autoComplete="off" hint="Only people who gave an email address you already have and agreed to marketing are messaged, once per form answer." error={errors.hoursAfter?.message} {...register("hoursAfter")} /> : null}
            {ruleType === "package_expiring" ? <TextField label="Days before the package runs out" inputMode="numeric" autoComplete="off" error={errors.daysBefore?.message} {...register("daysBefore")} /> : null}
          </>
        )}

        <SelectField
          label="Send by" value={channel} onValueChange={(value) => setValue("channel", campaignChannels.find((entry) => entry === value) ?? "email", { shouldDirty: true })}
          options={campaignChannels.map((entry) => ({ value: entry, label: `${campaignChannelLabels[entry]}${channelStatus(entry)?.ready === false ? " (not connected)" : ""}` }))}
          hint={channelStatus(channel)?.ready === false ? channelStatus(channel)?.reason : undefined}
        />

        {channel === "email" ? (
          <>
            <TextField label="Subject" autoComplete="off" maxLength={200} error={errors.subject?.message} {...register("subject")} />
            <TextareaField label="Message" rows={8} error={errors.body?.message} hint="An unsubscribe link and a booking button are added for you." {...register("body")} />
          </>
        ) : null}
        {channel === "whatsapp" ? (
          <SelectField
            label="Approved WhatsApp message" value={templateKey} onValueChange={(value) => setValue("templateKey", value, { shouldDirty: true })} placeholder="Choose a message" error={errors.templateKey?.message}
            options={approvedTemplates.map((entry) => ({ value: entry.key, label: entry.approved ? entry.label : `${entry.label} · Waiting for Meta's approval`, disabled: !entry.approved }))}
            hint="WhatsApp only sends wording Meta has approved. Replying STOP unsubscribes."
          />
        ) : null}
        {needsLine ? <TextField label="The one line of your message" autoComplete="off" maxLength={160} error={errors.body?.message} hint="One line, up to 160 characters." {...register("body")} /> : null}

        {channel === "email" || needsLine ? (
          <div className="flex flex-col gap-1.5">
            <Label className="font-medium text-sm">Put in a detail</Label>
            <div className="flex flex-wrap gap-1.5">
              {campaignFields.map((field) => (
                <Button key={field.key} type="button" size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => addField(field.key)}>{field.label}</Button>
              ))}
            </div>
          </div>
        ) : null}

        {kind === "one_off" ? (
          <div className="flex flex-col gap-2">
            <SelectField label="When" value={schedule} onValueChange={(value) => setValue("schedule", value === "later" ? "later" : "now", { shouldDirty: true })} options={[{ value: "now", label: "As soon as I turn it on" }, { value: "later", label: "At a time I choose" }]} />
            {schedule === "later" ? <TextField label={`Date and time (${timeZone})`} type="datetime-local" error={errors.scheduledLocal?.message} {...register("scheduledLocal")} /> : null}
          </div>
        ) : null}
        {mode.kind === "edit" ? <p className="text-muted-foreground text-xs">Saving new words means you will need to send yourself a test again before a one-off goes out.</p> : null}
      </DrawerPanel>
      <DrawerFooter>
        <Button type="button" variant="ghost" className="min-h-11 sm:min-h-8" onClick={onClose}>Cancel</Button>
        <Button type="submit" className="min-h-11 sm:min-h-8" loading={isSubmitting}>{mode.kind === "edit" ? "Save campaign" : "Create campaign"}</Button>
      </DrawerFooter>
    </form>
  );
}

export function CampaignFormSheet({ mode, onClose, ...props }: { mode: CampaignFormMode | null; options: CampaignOptions | undefined; onClose: () => void; onSaved: (campaign: CampaignSummary) => void }) {
  return (
    <ResponsiveDrawer open={Boolean(mode)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <ResponsiveDrawerPopup className="sm:max-w-lg">{mode ? <CampaignForm mode={mode} onClose={onClose} {...props} /> : null}</ResponsiveDrawerPopup>
    </ResponsiveDrawer>
  );
}
