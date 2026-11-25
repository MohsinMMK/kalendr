"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Ban, FlaskConical, Pause, Pencil, Play, Trash2, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { ActionBar, type ActionMenuEntry, type BarAction } from "@/components/action-bar";
import { TextField } from "@/components/form-fields";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { ResponsiveDrawer, ResponsiveDrawerPopup } from "@/components/responsive-drawer";
import { DrawerDescription, DrawerHeader, DrawerPanel, DrawerTitle } from "@/components/ui/drawer";
import { Skeleton } from "@/components/ui/skeleton";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import { campaignChannelLabels, describeRule, type CampaignSummary, type CostEstimate } from "@/lib/campaign-contracts";
import { formatMoney } from "@/lib/money";

import { campaignErrorText, CampaignStatusBadge, isPlanLimit, kindLabel, pausedText } from "./campaign-parts";
import { useCatalogLookups } from "./clinic-catalog";
import { staffMutation } from "./queries/http";
import { campaignKeys, useCampaignAudience, useCampaignPreview } from "./queries/campaigns";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col rounded-lg border px-3 py-2">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="font-semibold text-lg tabular-nums">{value}</dd>
    </div>
  );
}

function CostLine({ cost }: { cost: CostEstimate }) {
  const left = Math.max(0, cost.includedThisMonth - cost.usedThisMonth);
  const past = cost.messages - cost.coveredByPlan;
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-muted/60 px-3 py-2 text-sm">
      <p className="font-medium">About {formatMoney(cost.estimateMinor, cost.currency)} for {cost.messages} {cost.channel === "whatsapp" ? "WhatsApp" : "text"} messages <span className="font-normal text-muted-foreground">(an estimate)</span></p>
      <p className="text-muted-foreground text-xs">Your plan includes {cost.includedThisMonth} a month; {cost.usedThisMonth} used so far, {left} left.</p>
      {past > 0 ? (
        <p className="text-xs">
          {past} of these are past what your plan includes.{" "}
          {cost.overage === "stop_marketing" ? "Marketing messages stop at the limit, so they will not be sent." : "They are sent and billed as extra."}
        </p>
      ) : null}
    </div>
  );
}

function AudienceCard({ campaign }: { campaign: CampaignSummary }) {
  const t = useTerms();
  const audience = useCampaignAudience(campaign.id, campaign.version);
  return (
    <section aria-labelledby="audience-title" className="flex flex-col gap-2 rounded-lg border p-3">
      <h3 id="audience-title" className="font-medium text-sm">Who it reaches</h3>
      {audience.isPending ? <div role="status" aria-label="Counting"><Skeleton className="h-10 w-full" /></div> : audience.isError || !audience.data ? (
        <div className="flex items-center justify-between gap-2 text-sm"><span>{audience.error instanceof Error ? audience.error.message : "Could not count."}</span><Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => void audience.refetch()}>Try again</Button></div>
      ) : (
        <>
          <p className="text-sm"><strong className="tabular-nums">Reaches {audience.data.eligible} {audience.data.eligible === 1 ? t.customer : t.customers}.</strong>{" "}
            {audience.data.leftOut.length > 0 ? `${audience.data.matching - audience.data.eligible} left out:` : "Nobody was left out."}</p>
          {audience.data.leftOut.length > 0 ? (
            <ul className="flex flex-col gap-1 text-sm">
              {audience.data.leftOut.map((entry) => <li key={entry.reason} className="flex justify-between gap-3"><span>{entry.label}</span><span className="tabular-nums text-muted-foreground">{entry.count}</span></li>)}
            </ul>
          ) : null}
          {audience.data.cost ? <CostLine cost={audience.data.cost} /> : null}
        </>
      )}
    </section>
  );
}

function PreviewCard({ campaign }: { campaign: CampaignSummary }) {
  const t = useTerms();
  const preview = useCampaignPreview(campaign.id, campaign.version);
  return (
    <section aria-labelledby="preview-title" className="flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2"><h3 id="preview-title" className="font-medium text-sm">What {t.aCustomer} gets</h3><Badge variant="outline">Only staff see this</Badge></div>
      {preview.isPending ? <div role="status" aria-label="Loading preview"><Skeleton className="h-24 w-full" /></div> : preview.isError || !preview.data ? (
        <div className="flex items-center justify-between gap-2 text-sm"><span>{preview.error instanceof Error ? preview.error.message : "Could not load the preview."}</span><Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => void preview.refetch()}>Try again</Button></div>
      ) : (
        <div className="flex flex-col gap-1 text-sm">
          <p className="text-muted-foreground text-xs">Filled in for {preview.data.customerFirstName}.</p>
          {preview.data.subject ? <p className="font-medium">{preview.data.subject}</p> : null}
          {preview.data.template ? <p>WhatsApp message: {preview.data.template.label}{preview.data.template.approved ? "" : " (waiting for Meta's approval)"}</p> : null}
          {preview.data.body ? <p className="whitespace-pre-wrap rounded-md bg-muted/60 p-2">{preview.data.body}</p> : null}
          <p className="text-muted-foreground text-xs">Booking link: <span className="break-all">{preview.data.bookLink}</span></p>
        </div>
      )}
    </section>
  );
}

type Confirm = "cancel" | "delete" | null;

/** One campaign: its words, who it reaches, what a message looks like, its results and the actions to run it. */
export function CampaignDetail({ campaign, canEdit, onClose, onEdit }: { campaign: CampaignSummary | null; canEdit: boolean; onClose: () => void; onEdit: (campaign: CampaignSummary) => void }) {
  const t = useTerms();
  const catalog = useCatalogLookups();
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [testing, setTesting] = useState(false);
  const [phone, setPhone] = useState("");
  const [testKey, setTestKey] = useState(() => crypto.randomUUID());
  // After a test is queued the worker sends it a moment later; read the campaign again until it says the test went.
  const [waitingSince, setWaitingSince] = useState<number | null>(null);
  const tested = campaign?.tested ?? false;
  useEffect(() => {
    if (waitingSince === null || tested) return;
    const timer = window.setInterval(() => {
      if (Date.now() - waitingSince > 90_000) { setWaitingSince(null); return; }
      void queryClient.invalidateQueries({ queryKey: campaignKeys.list() });
    }, 2_500);
    return () => window.clearInterval(timer);
  }, [waitingSince, tested, queryClient]);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: campaignKeys.all() });
  async function run(work: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setError(null);
    try {
      await work();
      refresh();
      if (done) toastManager.add({ title: done, type: "success" });
    } catch (cause: unknown) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  }

  const open = campaign !== null;
  const status = (action: "start" | "pause" | "resume" | "cancel") => campaign && run(() => staffMutation(`/api/staff/campaigns/${campaign.id}/status`, "POST", { action, version: campaign.version }), { start: "Campaign turned on", pause: "Campaign paused", resume: "Campaign turned back on", cancel: "Campaign cancelled" }[action]);
  async function sendTest(number?: string) {
    if (!campaign) return;
    await run(async () => {
      await staffMutation(`/api/staff/campaigns/${campaign.id}/test`, "POST", number ? { phone: number } : {}, { idempotencyKey: testKey });
      setTestKey(crypto.randomUUID());
      setTesting(false);
      setWaitingSince(Date.now());
    }, "Test on its way");
  }

  const live = campaign && (campaign.status === "active" || campaign.status === "sending");
  const finished = campaign && (campaign.status === "completed" || campaign.status === "cancelled");
  const actions: BarAction[] = [];
  const menu: ActionMenuEntry[] = [];
  if (campaign && canEdit && !finished) {
    if (campaign.status === "draft") actions.push({ id: "start", label: "Turn on", icon: <Play aria-hidden="true" />, variant: "default", pinned: true, onSelect: () => void status("start"), disabled: busy });
    if (live) actions.push({ id: "pause", label: "Pause", icon: <Pause aria-hidden="true" />, variant: "default", pinned: true, onSelect: () => void status("pause"), disabled: busy });
    if (campaign.status === "paused") actions.push({ id: "resume", label: "Resume", icon: <Play aria-hidden="true" />, variant: "default", pinned: true, onSelect: () => void status("resume"), disabled: busy });
    actions.push({ id: "test", label: "Send me a test", icon: <FlaskConical aria-hidden="true" />, onSelect: () => { setError(null); if (campaign.channel === "email") void sendTest(); else setTesting(true); }, disabled: busy });
    if (campaign.status !== "sending") menu.push({ id: "edit", label: "Edit", icon: <Pencil aria-hidden="true" />, onSelect: () => onEdit(campaign) });
    menu.push({ id: "cancel", label: "Cancel campaign", icon: <Ban aria-hidden="true" />, destructive: true, onSelect: () => setConfirm("cancel") });
    if (campaign.status === "draft") menu.push({ id: "delete", label: "Delete", icon: <Trash2 aria-hidden="true" />, destructive: true, onSelect: () => setConfirm("delete") });
  }

  const stats = campaign?.stats;
  const serviceName = (id: string) => catalog.serviceName(id);
  return (
    <>
      <ResponsiveDrawer open={open} onOpenChange={(next) => { if (!next) { setError(null); onClose(); } }}>
        <ResponsiveDrawerPopup className="sm:max-w-xl">
          {campaign ? (
            <>
              <DrawerHeader>
                <DrawerTitle className="flex flex-wrap items-center gap-2">{campaign.name}<CampaignStatusBadge campaign={campaign} /></DrawerTitle>
                <DrawerDescription>
                  {kindLabel(campaign)} · {campaignChannelLabels[campaign.channel]}
                  {campaign.rule ? ` · ${describeRule(campaign.rule, serviceName)}` : campaign.segmentName ? ` · ${campaign.segmentName}` : ""}
                </DrawerDescription>
              </DrawerHeader>
              <DrawerPanel className="flex flex-col gap-4">
                {pausedText(campaign) ? <Alert variant="warning"><TriangleAlert aria-hidden="true" /><AlertTitle>Paused by itself</AlertTitle><AlertDescription>{pausedText(campaign)}</AlertDescription></Alert> : null}
                {error ? (
                  <Alert variant="error">
                    <TriangleAlert aria-hidden="true" />
                    <AlertDescription>
                      {campaignErrorText(error, "That did not work. Try again.")}
                      {isPlanLimit(error) ? <> <Link href="/billing" className="underline">See plans</Link></> : null}
                    </AlertDescription>
                  </Alert>
                ) : null}
                {actions.length > 0 ? <ActionBar actions={actions} menu={menu} overflowLabel={`More for ${campaign.name}`} /> : null}
                {waitingSince !== null && !campaign.tested ? <p className="text-sm" role="status">Test on its way. It reaches {campaign.channel === "email" ? "your sign-in email" : "your phone"} in a minute.</p> : campaign.kind === "one_off" && campaign.status === "draft" ? (
                  <p className="text-sm" role="status">{campaign.tested ? "Test sent. You can turn this on." : "Send yourself a test before this goes to everyone. Change the words and you will need a new one."}</p>
                ) : campaign.tested ? <p className="text-sm" role="status">Test sent for these words.</p> : null}

                <section aria-labelledby="results-title" className="flex flex-col gap-2">
                  <h3 id="results-title" className="font-medium text-sm">Results</h3>
                  <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                    <Stat label="Sent" value={String(stats?.sent ?? 0)} />
                    <Stat label="Delivered" value={String(stats?.delivered ?? 0)} />
                    <Stat label="Booked" value={String(stats?.booked ?? 0)} />
                    <Stat label="Revenue" value={formatMoney(stats?.revenueMinor ?? 0, stats?.currency ?? "INR")} />
                    <Stat label="Unsubscribed" value={String(stats?.unsubscribed ?? 0)} />
                    <Stat label="Not delivered" value={String((stats?.failed ?? 0) + (stats?.skipped ?? 0))} />
                  </dl>
                </section>

                {!finished ? <AudienceCard campaign={campaign} /> : null}
                <PreviewCard campaign={campaign} />
                <p className="text-muted-foreground text-xs">Any {t.customer} who agreed to marketing on {t.business}&apos;s booking page can unsubscribe from every message. Reminders about their bookings are not affected.</p>
              </DrawerPanel>
            </>
          ) : null}
        </ResponsiveDrawerPopup>
      </ResponsiveDrawer>

      <Dialog open={testing} onOpenChange={setTesting}>
        <DialogPopup>
          <form className="contents" onSubmit={(event) => { event.preventDefault(); void sendTest(phone.trim()); }}>
            <DialogHeader><DialogTitle>Send yourself a test</DialogTitle><DialogDescription>Enter your own number, with the country code. The test goes only to you.</DialogDescription></DialogHeader>
            <DialogPanel><TextField label="Your number" type="tel" autoComplete="tel" placeholder="+91 98000 00000" value={phone} onChange={(event) => setPhone(event.target.value)} error={error ? campaignErrorText(error, "The test could not be sent. Try again.") : undefined} /></DialogPanel>
            <DialogFooter><Button type="button" variant="ghost" className="min-h-11 sm:min-h-8" onClick={() => setTesting(false)}>Cancel</Button><Button type="submit" className="min-h-11 sm:min-h-8" loading={busy} disabled={!phone.trim()}>Send test</Button></DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>

      <AlertDialog open={confirm !== null} onOpenChange={(next) => { if (!next) setConfirm(null); }}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm === "delete" ? "Delete this campaign?" : "Cancel this campaign?"}</AlertDialogTitle>
            <AlertDialogDescription>{confirm === "delete" ? "It never sent anything, so nothing is lost." : "Messages still waiting will not be sent. Its results stay here."}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" className="min-h-11 sm:min-h-8" />}>Back</AlertDialogClose>
            <Button variant="destructive" className="min-h-11 sm:min-h-8" loading={busy} onClick={() => {
              const target = confirm;
              setConfirm(null);
              if (!campaign) return;
              if (target === "cancel") void status("cancel");
              else void run(async () => { await staffMutation(`/api/staff/campaigns/${campaign.id}`, "DELETE", {}); onClose(); }, "Campaign deleted");
            }}>{confirm === "delete" ? "Delete" : "Cancel campaign"}</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
