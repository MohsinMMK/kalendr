"use client";

import { useUpgradePrompt } from "@/features/billing/upgrade-prompt";

import { RefreshCw } from "lucide-react";

import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import type { ChannelSettingsInput, ChannelState } from "@/lib/inbox-contracts";

import { useCatalogLookups } from "./clinic-catalog";
import { useChannelSettings, useSaveChannelSettings } from "./inbox-api";

type Template = ChannelState["templates"][number];

const statusDisplay: Record<Template["status"], { label: string; tone: "success" | "attention" | "danger" | "neutral" }> = {
  approved: { label: "Approved", tone: "success" },
  pending: { label: "Waiting for approval", tone: "attention" },
  rejected: { label: "Rejected", tone: "danger" },
  paused: { label: "Paused", tone: "neutral" },
};

const templateName = (key: string) => {
  const spaced = key.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

function TemplateList({ channel, templates }: { channel: string; templates: Template[] }) {
  if (!templates.length) return <p className="text-xs text-muted-foreground">No {channel} message templates are set up yet.</p>;
  return (
    <ul aria-label={`${channel} message templates`} className="flex flex-col divide-y rounded-lg border">
      {templates.map((template) => {
        const display = statusDisplay[template.status];
        return (
          <li key={`${template.key}-${template.language}`} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2">
            <span className="min-w-0 text-sm">{templateName(template.key)} <span className="text-xs text-muted-foreground">({template.language})</span></span>
            <StatusBadge tone={display.tone}>{display.label}</StatusBadge>
            {template.status === "rejected" && template.reason ? <p className="basis-full text-xs text-destructive-foreground">Rejected: {template.reason}</p> : null}
          </li>
        );
      })}
    </ul>
  );
}

function ChannelRow({ id, label, detail, state, onToggle, busy }: { id: string; label: string; detail: string; state: ChannelState; onToggle: (checked: boolean) => void; busy: boolean }) {
  return (
    <div className="flex flex-col gap-3 py-4 first:pt-1">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <Label htmlFor={id} className="font-medium">{label}</Label>
          <p className="text-xs text-muted-foreground">{detail}</p>
        </div>
        <Switch id={id} checked={state.enabled} disabled={busy} onCheckedChange={onToggle} />
      </div>
      <TemplateList channel={label} templates={state.templates} />
    </div>
  );
}

/** Settings > WhatsApp and text messages: which channels are on, and where each approved template stands. */
export function ChannelSettingsPanel() {
  const upgrade = useUpgradePrompt();
  const catalog = useCatalogLookups();
  const t = useTerms();
  const query = useChannelSettings(catalog.database);
  const save = useSaveChannelSettings();

  if (!catalog.database) {
    return <Alert role="note"><AlertDescription>These settings are saved on the {t.business} database, so they aren&apos;t part of the preview.</AlertDescription></Alert>;
  }
  if (query.isPending) return <div role="status" aria-label="Loading message settings" className="flex flex-col gap-3"><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /></div>;
  if (!query.data) {
    return (
      <Alert variant="error">
        <AlertTitle>Message settings could not be loaded</AlertTitle>
        <AlertDescription>
          <p>Check your connection and try again.</p>
          <Button variant="outline" size="sm" className="mt-2" onClick={() => void query.refetch()}><RefreshCw aria-hidden="true" /> Retry</Button>
        </AlertDescription>
      </Alert>
    );
  }

  const { whatsapp, sms } = query.data;
  const change = (input: ChannelSettingsInput, label: string) => save.mutate(input, {
    onSuccess: () => toastManager.add({ title: `${label} settings saved`, type: "success" }),
    onError: (error) => upgrade.fromError(error) || toastManager.add({ title: `Could not save ${label}`, description: error.message, type: "error" }),
  });

  return (
    <Frame>
      <FrameHeader>
        <FrameTitle>Channels</FrameTitle>
        <FrameDescription>Turn a channel off and {t.customers} get their updates by email instead. WhatsApp and text messages only send {t.customers} who agreed to them.</FrameDescription>
      </FrameHeader>
      {!whatsapp.configured || !sms.configured ? (
        <FramePanel>
          <Alert variant="warning">
            <AlertTitle>{!whatsapp.configured ? "Kalendr's WhatsApp number isn't connected yet; messages go by email until it is" : "Text messages aren't connected yet; messages go by email until they are"}</AlertTitle>
            {!whatsapp.configured && !sms.configured ? <AlertDescription>Text messages aren&apos;t connected yet either.</AlertDescription> : null}
          </Alert>
        </FramePanel>
      ) : null}
      <FramePanel className="flex flex-col divide-y py-1">
        <ChannelRow id="channel-whatsapp" label="WhatsApp" detail={`Reminders and replies on the ${t.customer}'s WhatsApp number`} state={whatsapp} busy={save.isPending} onToggle={(checked) => change({ whatsappEnabled: checked }, "WhatsApp")} />
        <ChannelRow id="channel-sms" label="SMS" detail={`A text message to the ${t.customer}'s mobile number${sms.provider ? ` (through ${sms.provider === "msg91" ? "MSG91" : "Twilio"})` : ""}`} state={sms} busy={save.isPending} onToggle={(checked) => change({ smsEnabled: checked }, "SMS")} />
      </FramePanel>
    </Frame>
  );
}
