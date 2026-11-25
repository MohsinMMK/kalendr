"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { OptionSelect, SelectField, TextField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { useTerms } from "@/features/terms/business-profile-context";
import { campaignChannelLabels, campaignChannels, type CampaignChannel, type CampaignPreset, type CampaignSummary, type PresetActivation } from "@/lib/campaign-contracts";

import { campaignErrorText } from "./campaign-parts";
import { useCatalogLookups } from "./clinic-catalog";
import { staffMutation } from "./queries/http";
import { campaignKeys, type CampaignOptions } from "./queries/campaigns";

/** Turns on one ready-made campaign. Sends the choices and a fresh Idempotency-Key, so a double click cannot make two. */
export async function activatePresetRequest(preset: CampaignPreset, body: Partial<PresetActivation>, key: string): Promise<CampaignSummary> {
  return staffMutation<CampaignSummary>(`/api/staff/campaigns/presets/${preset.key}`, "POST", body, { idempotencyKey: key });
}

export function PresetDialog({ preset, options, onClose, onDone }: { preset: CampaignPreset | null; options: CampaignOptions | undefined; onClose: () => void; onDone: (campaign: CampaignSummary) => void }) {
  return (
    <Dialog open={Boolean(preset)} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogPopup>{preset ? <PresetForm preset={preset} options={options} onClose={onClose} onDone={onDone} /> : null}</DialogPopup>
    </Dialog>
  );
}

function PresetForm({ preset, options, onClose, onDone }: { preset: CampaignPreset; options: CampaignOptions | undefined; onClose: () => void; onDone: (campaign: CampaignSummary) => void }) {
  const t = useTerms();
  const catalog = useCatalogLookups();
  const queryClient = useQueryClient();
  const [key] = useState(() => crypto.randomUUID());
  const [channel, setChannel] = useState<CampaignChannel>("email");
  const [rows, setRows] = useState([{ serviceId: "", days: String(preset.defaultIntervalDays) }]);
  const [daysAway, setDaysAway] = useState(String(preset.defaultDaysAway));
  const [daysBefore, setDaysBefore] = useState(String(preset.defaultDaysBefore));
  const [message, setMessage] = useState("");
  const [fieldError, setFieldError] = useState("");
  const [pending, setPending] = useState(false);
  const services = catalog.services.filter((service) => service.isActive !== false).map((service) => ({ value: service.id, label: service.name }));
  const status = options?.channels.find((entry) => entry.channel === channel);
  const whatsappApproved = options?.templates.find((entry) => entry.key === preset.templateKey)?.approved ?? false;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setMessage("");
    setFieldError("");
    const body: Partial<PresetActivation> = { channel, templateKey: channel === "whatsapp" ? preset.templateKey : null };
    if (preset.ruleType === "recall") {
      const parsed = rows.map((row) => ({ serviceId: row.serviceId, intervalDays: Number(row.days) }));
      if (parsed.some((row) => !row.serviceId || !Number.isInteger(row.intervalDays) || row.intervalDays < 7)) { setFieldError(`Choose a ${t.service} and a number of days, 7 or more, for each row.`); return; }
      body.recallServices = parsed;
    }
    if (preset.ruleType === "win_back") {
      if (!(Number(daysAway) >= 30)) { setFieldError("Enter 30 days or more."); return; }
      body.daysAway = Number(daysAway);
    }
    if (preset.ruleType === "package_expiring") {
      if (!(Number(daysBefore) >= 1)) { setFieldError("Enter 1 day or more."); return; }
      body.daysBefore = Number(daysBefore);
    }
    setPending(true);
    try {
      const campaign = await activatePresetRequest(preset, body, key);
      void queryClient.invalidateQueries({ queryKey: campaignKeys.all() });
      onDone(campaign);
    } catch (cause: unknown) {
      setMessage(campaignErrorText(cause, "It could not be turned on. Try again."));
    } finally {
      setPending(false);
    }
  }

  return (
    <form noValidate className="contents" aria-label={`Turn on ${preset.name}`} onSubmit={(event) => void submit(event)}>
      <DialogHeader><DialogTitle>Turn on {preset.name}</DialogTitle><DialogDescription>{preset.description}</DialogDescription></DialogHeader>
      <DialogPanel className="flex flex-col gap-4">
        {message ? <Alert variant="error"><AlertDescription>{message}</AlertDescription></Alert> : null}
        {preset.ruleType === "recall" ? (
          <fieldset className="flex flex-col gap-2">
            <legend className="font-medium text-sm">Which {t.service}, and how long after</legend>
            {rows.map((row, index) => (
              <div key={index} className="flex items-end gap-2">
                <div className="min-w-0 flex-1"><OptionSelect aria-label={`${t.Service} ${index + 1}`} value={row.serviceId} onValueChange={(value) => setRows(rows.map((entry, at) => (at === index ? { ...entry, serviceId: value } : entry)))} options={services} placeholder={`Choose a ${t.service}`} /></div>
                <div className="w-28 shrink-0"><TextField label={<span className="sr-only">Days after, {t.service} {index + 1}</span>} inputMode="numeric" autoComplete="off" value={row.days} onChange={(event) => setRows(rows.map((entry, at) => (at === index ? { ...entry, days: event.target.value } : entry)))} /></div>
                {rows.length > 1 ? <Button type="button" variant="ghost" size="icon" className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9" aria-label={`Remove ${t.service} ${index + 1}`} onClick={() => setRows(rows.filter((_, at) => at !== index))}><Trash2 aria-hidden="true" /></Button> : null}
              </div>
            ))}
            <p className="text-muted-foreground text-xs">Days after the visit. {preset.defaultIntervalDays} days is a good start for this kind of business.</p>
            <Button type="button" size="sm" variant="outline" className="min-h-11 self-start sm:min-h-8" onClick={() => setRows([...rows, { serviceId: "", days: String(preset.defaultIntervalDays) }])}><Plus aria-hidden="true" />Add a {t.service}</Button>
          </fieldset>
        ) : null}
        {preset.ruleType === "win_back" ? <TextField label="Days since their last visit" inputMode="numeric" autoComplete="off" value={daysAway} onChange={(event) => setDaysAway(event.target.value)} /> : null}
        {preset.ruleType === "package_expiring" ? <TextField label="Days before the package runs out" inputMode="numeric" autoComplete="off" value={daysBefore} onChange={(event) => setDaysBefore(event.target.value)} /> : null}
        {fieldError ? <p role="alert" className="text-destructive-foreground text-xs">{fieldError}</p> : null}
        <SelectField
          label="Send by" value={channel} onValueChange={(value) => setChannel(campaignChannels.find((entry) => entry === value) ?? "email")}
          options={campaignChannels.map((entry) => ({ value: entry, label: `${campaignChannelLabels[entry]}${options?.channels.find((item) => item.channel === entry)?.ready === false ? " (not connected)" : ""}`, disabled: entry === "whatsapp" && !options?.templates.find((item) => item.key === preset.templateKey)?.approved }))}
          hint={channel === "email" ? "Each message has an unsubscribe link." : status?.ready === false ? status.reason : undefined}
        />
        {!whatsappApproved ? <p className="text-muted-foreground text-xs">WhatsApp stays off until Meta approves our message for this campaign.</p> : null}
        {channel === "sms" ? <p className="text-muted-foreground text-xs">Text messages use an approved template and carry an unsubscribe link.</p> : null}
      </DialogPanel>
      <DialogFooter>
        <Button type="button" variant="ghost" className="min-h-11 sm:min-h-8" onClick={onClose}>Cancel</Button>
        <Button type="submit" className="min-h-11 sm:min-h-8" loading={pending}>Turn on</Button>
      </DialogFooter>
    </form>
  );
}
