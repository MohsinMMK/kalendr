"use client";

import { useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Megaphone, Repeat, Sparkles, TriangleAlert } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useState } from "react";

import { WorkspaceFrame, WorkspacePage } from "@/components/workspace-page";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import { campaignChannelLabels, describeRule, type CampaignPreset, type CampaignSummary } from "@/lib/campaign-contracts";
import { formatMoney } from "@/lib/money";

import { CampaignDetail } from "./campaign-detail";
import { CampaignFormSheet, type CampaignFormMode } from "./campaign-form";
import { campaignErrorText, CampaignStatusBadge, kindLabel } from "./campaign-parts";
import { activatePresetRequest, PresetDialog } from "./campaign-preset-dialog";
import { useCatalogLookups } from "./clinic-catalog";
import { campaignKeys, useCampaignOptions, useCampaigns } from "./queries/campaigns";
import { useStaffAccess } from "./staff-access";

function ListSkeleton() {
  return <div role="status" aria-label="Loading campaigns" className="flex flex-col gap-2 p-4"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>;
}

function CampaignRow({ campaign, onOpen, serviceName }: { campaign: CampaignSummary; onOpen: () => void; serviceName: (id: string) => string }) {
  const stats = campaign.stats;
  const what = campaign.rule ? describeRule(campaign.rule, serviceName) : campaign.segmentName ?? "A segment";
  return (
    <li>
      <button type="button" onClick={onOpen} aria-label={`Open ${campaign.name}`} className="flex min-h-16 w-full min-w-0 flex-col gap-1 px-3 py-2 text-start outline-none hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring sm:flex-row sm:items-center sm:gap-3">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 flex-wrap items-center gap-2"><span className="truncate font-medium text-sm">{campaign.name}</span><CampaignStatusBadge campaign={campaign} /></span>
          <span className="truncate text-muted-foreground text-xs">{kindLabel(campaign)} · {campaignChannelLabels[campaign.channel]} · {what}</span>
        </span>
        <span className="flex flex-wrap gap-x-3 text-muted-foreground text-xs tabular-nums">
          <span>{stats.sent} sent</span><span>{stats.booked} booked</span><span>{formatMoney(stats.revenueMinor, stats.currency)}</span><span>{stats.unsubscribed} unsubscribed</span>
        </span>
      </button>
    </li>
  );
}

function PresetRow({ preset, existing, busy, canEdit, onTurnOn, onOpen }: { preset: CampaignPreset; existing: CampaignSummary | undefined; busy: boolean; canEdit: boolean; onTurnOn: () => void; onOpen: () => void }) {
  return (
    <li className="flex min-h-16 items-center gap-3 px-3 py-2">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex flex-wrap items-center gap-2"><span className="font-medium text-sm">{preset.name}</span>{existing ? <Badge variant="success">On</Badge> : <Badge variant="secondary">Off</Badge>}</span>
        <span className="text-muted-foreground text-xs">{preset.description}</span>
      </span>
      {existing ? <Button size="sm" variant="outline" className="min-h-11 shrink-0 sm:min-h-8" onClick={onOpen}>Open</Button>
        : canEdit ? <Button size="sm" className="min-h-11 shrink-0 sm:min-h-8" loading={busy} onClick={onTurnOn} aria-label={`Turn on ${preset.name}`}>Turn on</Button> : null}
    </li>
  );
}

/** Campaigns: ready-made recall, birthday and win-back messages, and one-off offers to a segment. Needs the database. */
export function CampaignsWorkspace() {
  const t = useTerms();
  const access = useStaffAccess();
  const catalog = useCatalogLookups();
  const live = catalog.database;
  const queryClient = useQueryClient();
  const campaigns = useCampaigns(live);
  const options = useCampaignOptions(live);
  const canEdit = access.can("campaigns.manage");
  const params = useSearchParams();
  // The address says which campaign is open (the bell links to /campaigns?campaign=…); a choice made here wins until the page is left.
  const [chosen, setChosen] = useState<{ id: string | null } | null>(null);
  const selectedId = chosen ? chosen.id : params.get("campaign");
  const [form, setForm] = useState<CampaignFormMode | null>(null);
  const [presetChoice, setPresetChoice] = useState<CampaignPreset | null>(null);
  const [turningOn, setTurningOn] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  function select(id: string | null) {
    const url = new URL(window.location.href);
    if (id) url.searchParams.set("campaign", id); else url.searchParams.delete("campaign");
    window.history.replaceState({}, "", url);
    setChosen({ id });
  }

  if (!live) {
    return (
      <WorkspacePage nav="campaigns">
      <WorkspaceFrame>
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon"><Megaphone aria-hidden="true" /></EmptyMedia>
          <EmptyTitle>Campaigns are not available in the preview</EmptyTitle>
          <EmptyDescription>Campaigns need the {t.business} database and your {t.customers}&apos; marketing choices. Nothing here is sent from the preview.</EmptyDescription>
        </EmptyHeader>
      </Empty>
      </WorkspaceFrame>
      </WorkspacePage>
    );
  }

  const list = campaigns.data ?? [];
  const selected = list.find((campaign) => campaign.id === selectedId) ?? null;
  const presetFor = (preset: CampaignPreset) => list.find((campaign) => campaign.presetKey === preset.key);

  async function turnOn(preset: CampaignPreset) {
    // A birthday greeting needs no choice: it goes on in one click, by email.
    if (preset.asks !== "nothing") { setPresetChoice(preset); return; }
    setTurningOn(preset.key);
    setMessage("");
    try {
      const campaign = await activatePresetRequest(preset, { channel: "email", templateKey: null }, crypto.randomUUID());
      void queryClient.invalidateQueries({ queryKey: campaignKeys.all() });
      toastManager.add({ title: `${preset.name} is on`, type: "success" });
      select(campaign.id);
    } catch (cause: unknown) {
      setMessage(campaignErrorText(cause, "It could not be turned on. Try again."));
    } finally {
      setTurningOn(null);
    }
  }

  return (
    <WorkspacePage
      nav="campaigns"
      bar={canEdit ? [{
        id: "new", label: "New campaign", variant: "default", pinned: true,
        items: [
          { id: "one-off", label: "One-off message to a segment", hint: "A festival offer, a new service, a quiet Tuesday", icon: <CalendarClock aria-hidden="true" />, onSelect: () => setForm({ kind: "one_off" }) },
          { id: "automated", label: "Automated", hint: "Recall, birthday, win-back, package about to expire", icon: <Repeat aria-hidden="true" />, onSelect: () => setForm({ kind: "automated" }) },
        ],
      }] : []}
    >
      {message ? <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertDescription>{message}</AlertDescription></Alert> : null}

      <WorkspaceFrame flush>
      <section aria-labelledby="your-campaigns" className="flex flex-col">
        <h2 id="your-campaigns" className="border-b bg-muted/40 px-4 py-2 font-medium text-sm">Your campaigns</h2>
        {campaigns.isPending ? <ListSkeleton /> : campaigns.isError ? (
          <Alert variant="error" className="m-4 w-auto">
            <TriangleAlert aria-hidden="true" />
            <AlertTitle>Campaigns could not be loaded</AlertTitle>
            <AlertDescription><p>{campaigns.error instanceof Error ? campaigns.error.message : "Something went wrong."}</p><Button size="sm" variant="outline" className="mt-2 min-h-11 sm:min-h-8" onClick={() => void campaigns.refetch()}>Try again</Button></AlertDescription>
          </Alert>
        ) : list.length === 0 ? (
          <Empty className="p-6">
            <EmptyHeader>
              <EmptyMedia variant="icon"><Megaphone aria-hidden="true" /></EmptyMedia>
              <EmptyTitle className="text-base">No campaigns yet</EmptyTitle>
              <EmptyDescription>Turn on a ready-made one below, such as a recall for people who are due back, or write a one-off message.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul aria-label="Campaigns" className="flex flex-col divide-y">
            {list.map((campaign) => <CampaignRow key={campaign.id} campaign={campaign} serviceName={catalog.serviceName} onOpen={() => select(campaign.id)} />)}
          </ul>
        )}
      </section>

      <section aria-labelledby="ready-made" className="flex flex-col border-t">
        <h2 id="ready-made" className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2 font-medium text-sm"><Sparkles aria-hidden="true" className="size-4" />Ready-made</h2>
        {options.isPending ? <ListSkeleton /> : options.isError || !options.data ? (
          <Alert variant="error" className="m-4 w-auto">
            <TriangleAlert aria-hidden="true" />
            <AlertDescription><p>{options.error instanceof Error ? options.error.message : "The ready-made campaigns could not be loaded."}</p><Button size="sm" variant="outline" className="mt-2 min-h-11 sm:min-h-8" onClick={() => void options.refetch()}>Try again</Button></AlertDescription>
          </Alert>
        ) : (
          <ul aria-label="Ready-made campaigns" className="flex flex-col divide-y">
            {options.data.presets.map((preset) => {
              const existing = presetFor(preset);
              return <PresetRow key={preset.key} preset={preset} existing={existing} canEdit={canEdit} busy={turningOn === preset.key} onTurnOn={() => void turnOn(preset)} onOpen={() => existing && select(existing.id)} />;
            })}
          </ul>
        )}
      </section>
      </WorkspaceFrame>

      <PresetDialog preset={presetChoice} options={options.data} onClose={() => setPresetChoice(null)} onDone={(campaign) => { setPresetChoice(null); toastManager.add({ title: `${campaign.name} is on`, type: "success" }); select(campaign.id); }} />
      <CampaignFormSheet mode={form} options={options.data} onClose={() => setForm(null)} onSaved={(campaign) => { setForm(null); select(campaign.id); }} />
      <CampaignDetail campaign={selected} canEdit={canEdit} onClose={() => select(null)} onEdit={(campaign) => setForm({ kind: "edit", campaign })} />
    </WorkspacePage>
  );
}
