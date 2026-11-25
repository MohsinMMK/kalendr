"use client";

import { ServiceHoursTab } from "./service-hours-tab";
import { ServiceRoutingTab } from "./service-routing-tab";
import { ServiceLimitsTab } from "./service-limits-tab";
import { ServicePageTab } from "./service-page-tab";
import { ServiceApprovalTab } from "./service-approval-tab";
import { ServiceCancelPolicyTab } from "./service-cancel-policy-tab";
import { ServiceCalendarTab } from "./service-calendar-tab";
import { ServicePaymentTab } from "./service-payment-tab";
import { ServiceQuestionsTab } from "./service-questions-tab";
import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowLeft, Copy, ExternalLink, EyeOff, KeyRound, Link2, Lock, MoreHorizontal, SearchX, Settings2, Share2, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { ShareEmbedSheet } from "./share-embed/share-embed-sheet";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useForm, useWatch } from "react-hook-form";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsPanel } from "@/components/ui/tabs";
import { toastManager } from "@/components/ui/toast";
import { useMediaQuery } from "@/hooks/use-media-query";
import type { Service } from "@/lib/domain";
import { serviceSetupSchema, type ServiceSetup } from "@/lib/service-setup";
import { type LockableField, lockLabels, lockableFields } from "@/lib/service-templates";
import { useTerms } from "@/features/terms/business-profile-context";

import { useCatalogLookups } from "./clinic-catalog";
import { SpecialLinksSheet } from "./special-links-sheet";
import { useStaffAccess } from "./staff-access";
import {
  formValuesFrom, serviceFormSchema, serviceLink, updateFrom, type ServiceFormValues,
} from "./service-editor-model";
import {
  BasicsTab, LengthsTab, LookTab, TimingTab, WhereTab, type ServiceEditorContext,
} from "./service-editor-tabs";
import { staffMutation, staffQuery, useOptionalStaffSnapshot } from "./staff-snapshot-provider";
import { EditorNav, SettingsSearch } from "./service-editor-nav";
import { ServicePreview, ServicePreviewDrawer } from "./service-editor-preview";
import { ServiceOptimizedSlotsField } from "./service-optimized-slots-field";
import { ServiceRebookLinkField } from "./service-rebook-link-field";
import { groupOfTab, serviceEditorGroupLabels, type SettingIndexEntry } from "./service-editor-registry";
import { WhyNoSlotSheet } from "./why-no-slot-sheet";

export interface ServiceEditorTab {
  id: string;
  label: string;
  render: (context: ServiceEditorContext) => ReactNode;
  /** Keep the tab's state when another tab is opened. For a tab that holds changes of its own. */
  keepMounted?: boolean;
}

/**
 * The editor's tabs, in order. A later feature adds its tab by pushing one entry here
 * (for example `{ id: "limits", label: "Limits", render }`) and needs no change to the drawer itself.
 */
export const serviceEditorTabs: ServiceEditorTab[] = [
  { id: "basics", label: "Basics", render: (context) => <BasicsTab {...context} /> },
  { id: "lengths", label: "Lengths and prices", render: (context) => <LengthsTab {...context} /> },
  { id: "timing", label: "Timing", render: (context) => <><TimingTab {...context} /><ServiceOptimizedSlotsField serviceId={context.serviceId} saves={context.saves} /></> },
  { id: "where", label: "Where", render: (context) => <WhereTab {...context} /> },
  { id: "look", label: "Look", render: (context) => <LookTab {...context} /> },
  { id: "hours", label: "Hours", render: (context) => <ServiceHoursTab {...context} /> },
  { id: "routing", label: "Team routing", render: (context) => <ServiceRoutingTab {...context} />, keepMounted: true },
  { id: "limits", label: "Limits", render: (context) => <ServiceLimitsTab {...context} />, keepMounted: true },
  { id: "payment", label: "Payment", render: (context) => <ServicePaymentTab {...context} /> },
  { id: "page", label: "Booking page", render: (context) => <ServicePageTab {...context} /> },
  { id: "questions", label: "Contact and guests", render: (context) => <ServiceQuestionsTab {...context} /> },
  { id: "approval", label: "Approval", render: (context) => <ServiceApprovalTab {...context} /> },
  { id: "cancelling", label: "Cancelling and moving", render: (context) => <><ServiceCancelPolicyTab {...context} /><ServiceRebookLinkField serviceId={context.serviceId} saves={context.saves} /></> },
  { id: "calendar", label: "Calendar entry", render: (context) => <ServiceCalendarTab {...context} /> },
];

/** Which template locks close which tab. Basics locks its own fields one by one inside the tab. */
const tabLocks: Record<string, readonly LockableField[]> = {
  lengths: ["lengths", "prices"], timing: ["timing"], where: ["meeting"], look: ["look"], page: ["booking_page"],
  questions: ["intake"], approval: ["approval"], cancelling: ["cancel_policy"],
};

/** The tab is read-only when the template locks what it edits, and says so. The server refuses the change either way. */
function LockedTab({ names, children }: { names: LockableField[]; children: ReactNode }) {
  return (
    <>
      <p className="mb-3 flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-muted-foreground text-xs"><Lock aria-hidden="true" className="size-3.5 shrink-0" /> Set by the template: {names.map((name) => lockLabels[name].toLowerCase()).join(", ")}. Change it in the template.</p>
      <fieldset disabled className="min-w-0 opacity-70">{children}</fieldset>
    </>
  );
}

interface ApiProblem { code: string; message: string; fieldErrors: Record<string, string[]> }

/** Saves with the version check, keeping the server's field errors so they can sit beside the fields. */
async function patchService(serviceId: string, body: unknown): Promise<ServiceSetup> {
  const response = await fetch(`/api/staff/services/${serviceId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const result: unknown = await response.json().catch(() => null);
  if (response.ok && typeof result === "object" && result !== null && "data" in result) return serviceSetupSchema.parse((result as { data: unknown }).data);
  const error = (typeof result === "object" && result !== null && "error" in result ? (result as { error: Partial<ApiProblem> }).error : {}) ?? {};
  const problem: ApiProblem = { code: error.code ?? "error", message: error.message ?? "The service could not be saved.", fieldErrors: error.fieldErrors ?? {} };
  throw Object.assign(new Error(problem.message), { problem });
}

function problemOf(cause: unknown): ApiProblem | null {
  return typeof cause === "object" && cause !== null && "problem" in cause ? (cause as { problem: ApiProblem }).problem : null;
}

/** A service shown from the catalog alone, for the preview, which has no database to load from. */
function setupFromCatalog(service: Service): ServiceSetup {
  const lengths = service.lengths?.length ? service.lengths : [{ minutes: service.durationMinutes, priceMinor: null, isDefault: true }];
  return serviceSetupSchema.parse({
    id: service.id,
    version: service.version ?? 1,
    basics: {
      name: service.name, description: service.description, category: service.category ?? null, bookingMode: service.bookingMode,
      requiredResourceKind: service.resourceKind ?? null, isActive: service.isActive !== false, visibility: service.visibility ?? "listed",
      slug: service.slug ?? "service", scheduleId: null, restrictionScheduleId: null, locationIds: service.locationIds, practitionerIds: service.practitionerIds,
    },
    timing: { bufferBeforeMinutes: service.bufferBeforeMinutes, bufferAfterMinutes: service.bufferAfterMinutes, minimumNoticeMinutes: 60, window: { kind: "rolling_days", days: 90 }, slotIntervalMinutes: 15, startOffsetMinutes: 0 },
    lengths,
    locationOptions: service.locationOptions?.length ? service.locationOptions : service.locationIds.map((locationId) => ({ kind: "in_person", locationId, note: null })),
    look: { colorLight: service.colorLight ?? null, colorDark: service.colorDark ?? null, bannerMediaId: null },
  });
}

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; setup: ServiceSetup };

/**
 * The full-page editor for one service. `initialTab` is the `?tab=` of the address, so deep links land on a tab.
 * The body remounts per service and per reload, so each load starts clean.
 */
export function ServiceEditor({ serviceId, initialTab }: { serviceId: string; initialTab?: string | undefined }) {
  const [epoch, setEpoch] = useState(0);
  return <ServiceEditorBody key={`${serviceId}:${epoch}`} serviceId={serviceId} initialTab={initialTab} onReload={() => setEpoch((count) => count + 1)} />;
}

function ServiceEditorBody({ serviceId, initialTab, onReload }: { serviceId: string; initialTab: string | undefined; onReload: () => void }) {
  const t = useTerms();
  const router = useRouter();
  const catalog = useCatalogLookups();
  const staff = useOptionalStaffSnapshot();
  const isWide = useMediaQuery("(min-width: 1024px)");
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const firstTab = serviceEditorTabs.some((entry) => entry.id === initialTab) ? initialTab! : serviceEditorTabs[0]?.id ?? "basics";
  const [tab, setTab] = useState(firstTab);
  // A tab that keeps its state starts loading when first opened, not when the page opens.
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set([firstTab]));
  const [limitsDirty, setLimitsDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [conflict, setConflict] = useState(false);
  const [linksOpen, setLinksOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [whyOpen, setWhyOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const canManageLinks = useStaffAccess().can("services.manage");

  const form = useForm<ServiceFormValues>({ resolver: zodResolver(serviceFormSchema) });
  const { reset } = form;
  const database = catalog.database;
  const catalogService = catalog.services.find((entry) => entry.id === serviceId);

  useEffect(() => {
    const controller = new AbortController();
    const request = database
      ? staffQuery<unknown>(`/api/staff/services/${serviceId}`, controller.signal).then((data) => serviceSetupSchema.parse(data))
      : catalogService ? Promise.resolve(setupFromCatalog(catalogService)) : Promise.reject(new Error(`This ${t.service} could not be found.`));
    request.then((setup) => {
      if (controller.signal.aborted) return;
      reset(formValuesFrom(setup));
      setLoad({ state: "ready", setup });
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return;
      setLoad({ state: "error", message: cause instanceof Error ? cause.message : `This ${t.service} could not be loaded.` });
    });
    return () => controller.abort();
    // The catalog row only seeds the preview; this loads once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId, database, reset]);

  const setup = load.state === "ready" ? load.setup : null;
  const lockedSet = new Set<string>(setup?.template?.lockedFields ?? []);
  const isActive = useWatch({ control: form.control, name: "basics.isActive" });
  const hidden = useWatch({ control: form.control, name: "basics.visibility" }) === "hidden";
  const name = useWatch({ control: form.control, name: "basics.name" });
  const isDirty = form.formState.isDirty;
  const title = name || catalogService?.name || t.Service;

  // Leaving with unsaved changes asks first. The browser shows its own wording.
  useEffect(() => {
    if (!isDirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [isDirty]);

  function selectTab(next: string) {
    setTab(next);
    setOpened((seen) => new Set(seen).add(next));
    // The address keeps the tab so a reload or a shared link comes back here. History API calls are part of Next's router state.
    const url = new URL(window.location.href);
    url.searchParams.set("tab", next);
    window.history.replaceState(window.history.state, "", url);
  }

  function goTo(entry: SettingIndexEntry) {
    selectTab(entry.tab);
    // The tab's content renders on the next frame; then the setting scrolls into view and takes focus.
    window.setTimeout(() => {
      const target = document.querySelector<HTMLElement>(`[data-setting="${entry.id}"]`) ?? document.getElementById("service-editor-panels");
      target?.scrollIntoView({ block: "start", behavior: "smooth" });
      target?.querySelector<HTMLElement>("input, button, [role=switch], textarea")?.focus({ preventScroll: true });
    }, 60);
  }

  const save = useCallback(async (values: ServiceFormValues) => {
    if (!setup) return;
    setSaving(true);
    setMessage("");
    try {
      const saved = await patchService(serviceId, updateFrom(values, setup.version));
      form.reset(formValuesFrom(saved));
      setLoad({ state: "ready", setup: saved });
      await staff?.refresh();
      toastManager.add({ title: `${saved.basics.name} saved. New bookings use the new settings.`, type: "success" });
    } catch (cause: unknown) {
      const problem = problemOf(cause);
      if (problem?.code === "version_conflict") setConflict(true);
      else {
        for (const [path, messages] of Object.entries(problem?.fieldErrors ?? {})) {
          form.setError(path as never, { type: "server", message: messages[0] ?? "Check this." });
        }
        setMessage(problem?.message ?? (cause instanceof Error ? cause.message : `The ${t.service} could not be saved.`));
      }
    } finally {
      setSaving(false);
    }
  }, [serviceId, form, setup, staff, t.service]);

  async function duplicate() {
    try {
      const copy = await staffMutation<{ serviceId: string }>(`/api/staff/services/${serviceId}/duplicate`, "POST", {});
      await staff?.refresh();
      toastManager.add({ title: "Copy made. You are editing it now.", type: "success" });
      router.push(`/services/${copy.serviceId}`);
    } catch (cause: unknown) {
      setMessage(cause instanceof Error ? cause.message : "The copy could not be made.");
    }
  }

  async function remove() {
    setDeleting(true);
    try {
      await staffMutation(`/api/staff/services/${serviceId}`, "DELETE", {});
      await staff?.refresh();
      form.reset(form.getValues());
      toastManager.add({ title: `${title} deleted.`, type: "success" });
      router.push("/services");
    } catch (cause: unknown) {
      setConfirmDelete(false);
      setMessage(cause instanceof Error ? cause.message : `The ${t.service} could not be deleted.`);
    } finally {
      setDeleting(false);
    }
  }

  function publicLink(): string {
    return serviceLink(window.location.origin, catalog.clinic.slug, form.getValues("basics.slug"));
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(publicLink());
      toastManager.add({ title: "Link copied.", type: "success" });
    } catch {
      toastManager.add({ title: "The link could not be copied. Select it from the address bar of the booking page instead.", type: "error" });
    }
  }

  const context: ServiceEditorContext | null = setup ? {
    form, terms: t, locations: catalog.locations, practitioners: catalog.practitioners, imageUrl: catalogService?.imageUrl ?? null,
    saves: catalog.database, onImageChanged: () => staff?.refresh(), serviceId, onLimitsDirtyChange: setLimitsDirty, locked: lockedSet,
  } : null;
  const labels = Object.fromEntries(serviceEditorTabs.map((entry) => [entry.id, entry.label]));
  const marks = { limits: limitsDirty ? <span className="ms-1 text-warning-foreground" title="Not saved yet" aria-label="(not saved yet)">•</span> : null };
  const previewBase = catalogService ?? null;
  const ready = Boolean(setup) && Boolean(context);

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-4 sm:p-6">
      <form id="service-editor-form" noValidate className="contents" onSubmit={(event) => {
        event.stopPropagation();
        void form.handleSubmit((values) => save(values), () => setMessage("Some settings need a look. Check the highlighted fields."))(event);
      }}>
        <header className="sticky top-0 z-20 -mx-4 flex items-center gap-2 border-b bg-background/95 px-4 py-2 backdrop-blur sm:-mx-6 sm:px-6">
          <Button render={<Link href="/services" onClick={(event) => { if (isDirty) { event.preventDefault(); setConfirmLeave(true); } }} />} variant="ghost" size="icon-lg" aria-label={`Back to ${t.services}`}><ArrowLeft aria-hidden="true" /></Button>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <h1 className="truncate font-heading font-semibold text-lg">{title}</h1>
            {hidden ? <Badge variant="warning" className="shrink-0"><EyeOff aria-hidden="true" /> Hidden</Badge> : null}
          </div>
          {ready ? (
            <Switch checked={isActive !== false} onCheckedChange={(next) => form.setValue("basics.isActive", next, { shouldDirty: true })} aria-label={`${t.Service} is on`} />
          ) : null}
          <div className="hidden items-center gap-1 md:flex">
            <Button type="button" variant="ghost" size="icon-lg" aria-label="Preview the booking page" disabled={!ready} onClick={() => window.open(publicLink(), "_blank", "noopener")}><ExternalLink aria-hidden="true" /></Button>
            <Button type="button" variant="ghost" size="icon-lg" aria-label="Copy link" disabled={!ready} onClick={() => void copyLink()}><Link2 aria-hidden="true" /></Button>
            <Button type="button" variant="ghost" size="icon-lg" aria-label="Share and embed" disabled={!ready} onClick={() => setShareOpen(true)}><Share2 aria-hidden="true" /></Button>
          </div>
          <Menu>
            <MenuTrigger render={<Button type="button" variant="outline" size="icon-lg" aria-label="More actions" disabled={!ready} />}><MoreHorizontal aria-hidden="true" /></MenuTrigger>
            <MenuPopup align="end">
              <MenuItem className="md:hidden" onClick={() => window.open(publicLink(), "_blank", "noopener")}><ExternalLink aria-hidden="true" /> Preview the booking page</MenuItem>
              <MenuItem className="md:hidden" onClick={() => void copyLink()}><Link2 aria-hidden="true" /> Copy link</MenuItem>
              <MenuItem className="md:hidden" onClick={() => setShareOpen(true)}><Share2 aria-hidden="true" /> Share and embed</MenuItem>
              {/* A copy is made from what is saved, so unsaved edits have to be saved first. */}
              <MenuItem onClick={() => void duplicate()} disabled={!database || isDirty}><Copy aria-hidden="true" /> {isDirty ? "Save before duplicating" : "Duplicate"}</MenuItem>
              {canManageLinks ? <MenuItem onClick={() => setLinksOpen(true)}><KeyRound aria-hidden="true" /> Special links…</MenuItem> : null}
              <MenuItem disabled={!database || saving} onClick={() => {
                const before = hidden ? "hidden" : "listed";
                form.setValue("basics.visibility", hidden ? "listed" : "hidden", { shouldDirty: true });
                // If another setting fails its check nothing saves, so the badge goes back to what is really saved.
                void form.handleSubmit((values) => save(values), () => {
                  form.setValue("basics.visibility", before, { shouldDirty: true });
                  setMessage("Some settings need a look. Check the highlighted fields.");
                })();
              }}>
                <EyeOff aria-hidden="true" /> {hidden ? "Show on the booking page" : "Hide from the booking page"}
              </MenuItem>
              <MenuSeparator />
              <MenuItem variant="destructive" disabled={!database} onClick={() => setConfirmDelete(true)}><Trash2 aria-hidden="true" /> Delete</MenuItem>
            </MenuPopup>
          </Menu>
          <Button type="submit" size="lg" disabled={!ready || saving || !database}>
            {saving ? <Spinner aria-hidden="true" /> : null}
            {saving ? "Saving…" : "Save"}
          </Button>
        </header>

        {load.state === "loading" ? (
          <div className="flex flex-col gap-3" role="status" aria-label={`Loading the ${t.service}`}>
            <Skeleton className="h-9 w-full" /><Skeleton className="h-11 w-full" /><Skeleton className="h-11 w-full" /><Skeleton className="h-24 w-full" />
          </div>
        ) : load.state === "error" ? (
          <Alert variant="error">
            <AlertTitle>This {t.service} could not be loaded</AlertTitle>
            <AlertDescription>
              <p>{load.message}</p>
              <Button type="button" size="sm" variant="outline" className="mt-2" onClick={onReload}>Try again</Button>
            </AlertDescription>
          </Alert>
        ) : context ? (
          <>
            {!database ? <p className="rounded-lg bg-muted/60 px-3 py-2 text-muted-foreground text-xs">This is a preview. Changes are not saved.</p> : null}
            {conflict ? (
              <Alert variant="warning">
                <AlertTitle>Someone else changed this {t.service}</AlertTitle>
                <AlertDescription>
                  <p>Load their version to keep working. Your unsaved changes here will be replaced.</p>
                  <Button type="button" size="sm" variant="outline" className="mt-2" onClick={onReload}>Reload</Button>
                </AlertDescription>
              </Alert>
            ) : null}
            {setup?.template ? (
              <Alert>
                <Lock aria-hidden="true" />
                <AlertTitle>Follows the template “{setup.template.name}”</AlertTitle>
                <AlertDescription>{lockedSet.size > 0 ? `Set by the template: ${lockableFields.filter((entry) => lockedSet.has(entry)).map((entry) => lockLabels[entry].toLowerCase()).join(", ")}. Everything else is yours to change here.` : "Nothing is locked, so everything can be changed here."}</AlertDescription>
              </Alert>
            ) : null}
            {message ? <Alert variant="error"><AlertDescription>{message}</AlertDescription></Alert> : null}
            <Tabs value={tab} orientation={isWide ? "vertical" : "horizontal"} onValueChange={(next) => selectTab(String(next))}
              className="grid grid-cols-1 items-start gap-4 data-[orientation=vertical]:grid data-[orientation=vertical]:grid-cols-[14rem_minmax(0,1fr)_21rem] lg:gap-6">
              <aside aria-label={`${t.Service} settings`} className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-20">
                <SettingsSearch onJump={goTo} />
                <EditorNav labels={labels} marks={marks} footer={(
                  <Button type="button" variant="outline" size="sm" className="min-h-11 justify-start" onClick={() => setWhyOpen(true)}><SearchX aria-hidden="true" /> Why is there no time?</Button>
                )} />
              </aside>
              <div id="service-editor-panels" className="flex min-w-0 flex-col gap-3">
                <div className="flex items-center justify-between gap-2 lg:hidden">
                  <p className="text-muted-foreground text-xs">{groupLabel(tab)}</p>
                  {previewBase ? <ServicePreviewDrawer control={form.control} base={previewBase} /> : null}
                </div>
                {serviceEditorTabs.map((entry) => <TabsPanel key={entry.id} value={entry.id} keepMounted={entry.keepMounted} className="min-w-0">{entry.keepMounted && !opened.has(entry.id) ? null : (() => {
                  const names = (tabLocks[entry.id] ?? []).filter((lock) => lockedSet.has(lock));
                  return names.length > 0 ? <LockedTab names={names}>{entry.render(context)}</LockedTab> : entry.render(context);
                })()}</TabsPanel>)}
              </div>
              {previewBase ? <aside aria-label="Preview" className="hidden min-w-0 lg:sticky lg:top-20 lg:block"><ServicePreview control={form.control} base={previewBase} /></aside> : null}
            </Tabs>
          </>
        ) : null}
      </form>

      <AlertDialog open={confirmDelete} onOpenChange={(next) => { if (!deleting) setConfirmDelete(next); }}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {title}?</AlertDialogTitle>
            <AlertDialogDescription>This cannot be undone. If it already has bookings or special links, it cannot be deleted; switch it off instead.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button type="button" variant="outline" />} disabled={deleting}>Keep it</AlertDialogClose>
            <Button type="button" variant="destructive" disabled={deleting} onClick={() => void remove()}>{deleting ? <Spinner aria-hidden="true" /> : null}Delete</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog open={confirmLeave} onOpenChange={setConfirmLeave}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
            <AlertDialogDescription>Your changes to {title} have not been saved and will be lost.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button type="button" variant="outline" />}>Keep editing</AlertDialogClose>
            <Button type="button" variant="destructive" onClick={() => { form.reset(form.getValues()); setConfirmLeave(false); router.push("/services"); }}>Leave without saving</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      {shareOpen ? <ShareEmbedSheet open onOpenChange={setShareOpen} initialServiceSlug={form.getValues("basics.slug")} /> : null}
      <SpecialLinksSheet serviceId={serviceId} serviceName={title} open={linksOpen} onOpenChange={setLinksOpen} />
      {whyOpen ? <WhyNoSlotSheet open onOpenChange={setWhyOpen} serviceId={serviceId}
        {...(form.getValues("basics.practitionerIds")[0] ? { practitionerId: form.getValues("basics.practitionerIds")[0]! } : {})}
        {...(form.getValues("basics.locationIds")[0] ? { locationId: form.getValues("basics.locationIds")[0]! } : {})} /> : null}
    </div>
  );
}

function groupLabel(tabId: string): string {
  return serviceEditorGroupLabels[groupOfTab(tabId)];
}

/** A link for a services list: opens that service's editor page. */
export function ServiceEditorButton({ serviceId, label = "More settings" }: { serviceId: string; label?: string }) {
  return <Button render={<Link href={`/services/${serviceId}`} />} variant="outline" size="sm"><Settings2 aria-hidden="true" /> {label}</Button>;
}

export type { ServiceEditorContext };
