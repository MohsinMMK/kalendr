"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Copy, FileDown, Pause, Trash2, TriangleAlert } from "lucide-react";
import { useDeferredValue, useMemo, useState } from "react";

import type { ActionMenuEntry, BarAction } from "@/components/action-bar";
import { WorkspacePage } from "@/components/workspace-page";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { toastManager } from "@/components/ui/toast";
import { useUpgradePrompt } from "@/features/billing/upgrade-prompt";
import { useTerms } from "@/features/terms/business-profile-context";
import type { RoutingBuilderOptions, RoutingFormDetail } from "@/lib/routing-forms";

import { useCatalogLookups } from "../clinic-catalog";
import { StaffApiError } from "../queries/http";
import { BasicsSection } from "./builder-basics";
import { QuestionsSection } from "./builder-questions";
import { RoutesSection } from "./builder-routes";
import { blankDraft, currentWarnings, draftFromForm, publicAddress, sameDraft, slugFromName, validate, type WorkingDraft } from "./builder-state";
import { PreviewPanel } from "./preview-panel";
import {
  createRoutingFormRequest, deleteRoutingFormRequest, pauseRoutingFormRequest, publishRoutingFormRequest, reportQuery, routingKeys, saveRoutingFormRequest, useRoutingForm,
} from "./queries";

type Pending = "save" | "publish" | "pause" | "delete" | null;

function BuilderBody({ initial, options, onBack, onSaved, onReload }: {
  initial: RoutingFormDetail | null; options: RoutingBuilderOptions; onBack: () => void; onSaved: (id: string) => void; onReload: () => Promise<void>;
}) {
  const t = useTerms();
  const catalog = useCatalogLookups();
  const client = useQueryClient();
  const upgrade = useUpgradePrompt();
  const [detail, setDetail] = useState<RoutingFormDetail | null>(initial);
  const [baseline, setBaseline] = useState<WorkingDraft>(() => (initial ? draftFromForm(initial.form) : blankDraft(options)));
  const [draft, setDraft] = useState<WorkingDraft>(baseline);
  const [slugTouched, setSlugTouched] = useState(Boolean(initial));
  const [showErrors, setShowErrors] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [message, setMessage] = useState("");
  const [conflict, setConflict] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [range] = useState(() => ({ from: new Date(Date.now() - 30 * 86_400_000).toISOString(), to: new Date().toISOString() }));

  const form = detail?.form ?? null;
  const dirty = !sameDraft(draft, baseline);
  const check = validate(draft);
  const errors = showErrors ? check.errors : {};
  const busy = pending !== null;
  const deferred = useDeferredValue(draft);
  const warnings = useMemo(() => currentWarnings(deferred, detail?.warnings ?? [], dirty), [deferred, detail, dirty]);
  const live = form?.status === "live";
  const address = publicAddress(catalog.clinic.slug, draft.slug);

  function change(patch: Partial<WorkingDraft>) {
    setMessage("");
    setDraft((before) => {
      const next = { ...before, ...patch };
      if (patch.name !== undefined && !slugTouched && patch.slug === undefined) next.slug = slugFromName(patch.name);
      return next;
    });
    if (patch.slug !== undefined) setSlugTouched(true);
  }

  function apply(result: RoutingFormDetail) {
    const next = draftFromForm(result.form);
    setDetail(result);
    setBaseline(next);
    setDraft(next);
    setShowErrors(false);
    client.setQueryData(routingKeys.form(result.form.id), result);
    void client.invalidateQueries({ queryKey: routingKeys.list() });
  }

  function fail(cause: unknown, fallback: string) {
    if (upgrade.fromError(cause)) return;
    if (cause instanceof StaffApiError && cause.code === "version_conflict") {
      setConflict(true);
      setMessage("Someone else changed this form while you were editing.");
      return;
    }
    setMessage(cause instanceof Error ? cause.message : fallback);
  }

  /** `stay` keeps a brand-new form on this screen; publish moves to the saved form itself once it is live, or the header would show the draft. */
  async function save(stay = false): Promise<RoutingFormDetail | null> {
    setShowErrors(true);
    setMessage("");
    if (!check.draft) { setMessage(check.first); return null; }
    setPending("save");
    try {
      const result = detail ? await saveRoutingFormRequest(detail.form.id, check.draft, detail.form.revision) : await createRoutingFormRequest(check.draft, crypto.randomUUID());
      apply(result);
      toastManager.add({ title: "Saved", type: "success" });
      if (!detail && !stay) onSaved(result.form.id);
      return result;
    } catch (cause: unknown) {
      fail(cause, "The form could not be saved.");
      return null;
    } finally {
      setPending(null);
    }
  }

  async function publish() {
    const created = !detail;
    const saved = dirty || created ? await save(true) : detail;
    if (!saved) return;
    setPending("publish");
    try {
      apply(await publishRoutingFormRequest(saved.form.id, saved.form.revision));
      toastManager.add({ title: "Published. Customers see this version now.", type: "success" });
      if (created) onSaved(saved.form.id);
    } catch (cause: unknown) {
      // A new form stays on this screen so the reason stays visible; it is saved, so trying again publishes the same form.
      fail(cause, "The form could not be published.");
    } finally {
      setPending(null);
    }
  }

  async function pause() {
    if (!detail) return;
    setPending("pause");
    try {
      const result = await pauseRoutingFormRequest(detail.form.id, detail.form.revision);
      // Pausing changes only the status; keep what is being typed.
      setDetail(result);
      client.setQueryData(routingKeys.form(result.form.id), result);
      void client.invalidateQueries({ queryKey: routingKeys.list() });
      toastManager.add({ title: "Paused. Customers can no longer open this form.", type: "success" });
    } catch (cause: unknown) {
      fail(cause, "The form could not be paused.");
    } finally {
      setPending(null);
    }
  }

  async function remove() {
    if (!detail) return;
    setPending("delete");
    try {
      await deleteRoutingFormRequest(detail.form.id);
      void client.invalidateQueries({ queryKey: routingKeys.list() });
      toastManager.add({ title: "Form deleted", type: "success" });
      onBack();
    } catch (cause: unknown) {
      setConfirmDelete(false);
      fail(cause, "The form could not be deleted.");
      setPending(null);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${address}`);
      toastManager.add({ title: "Link copied", type: "success" });
    } catch {
      toastManager.add({ title: "Could not copy", description: `Copy it by hand: ${address}`, type: "warning" });
    }
  }

  async function openPreview() {
    // The preview runs on the saved form, so a changed form is saved first.
    if (dirty || !detail) { if (!(await save())) return; }
    setPreviewOpen(true);
  }

  const blocked = check.draft ? "" : "Fix the problems marked on the form first.";
  const bar: BarAction[] = [
    { id: "save", label: "Save", variant: "default", pinned: true, disabled: busy || conflict || (Boolean(detail) && !dirty), onSelect: () => void save() },
    { id: "publish", label: live ? "Publish changes" : "Publish", variant: "outline", priority: 2, disabled: busy || conflict || Boolean(blocked) || (live && !dirty && !form?.hasUnpublishedChanges), hint: blocked ? "Fix the form first" : undefined, onSelect: () => void publish() },
    { id: "preview", label: "Preview", variant: "outline", priority: 1, disabled: busy || conflict || Boolean(blocked), onSelect: () => void openPreview() },
  ];
  const menu: ActionMenuEntry[] = [
    { id: "pause", label: "Pause form", icon: <Pause aria-hidden="true" />, hint: live ? undefined : "Only live forms", disabled: busy || conflict || !live, onSelect: () => void pause() },
    { id: "copy", label: "Copy link", icon: <Copy aria-hidden="true" />, disabled: !draft.slug, onSelect: () => void copyLink() },
    ...(detail ? [{ id: "export", label: "Export responses (CSV)", icon: <FileDown aria-hidden="true" />, href: `/api/staff/routing-forms/report/export?${reportQuery(detail.form.id, range.from, range.to)}` }] : []),
    { kind: "separator", id: "sep" },
    { id: "delete", label: "Delete form", icon: <Trash2 aria-hidden="true" />, destructive: true, disabled: busy || !detail, onSelect: () => setConfirmDelete(true) },
  ];
  const shared = { draft, options, errors, warnings, disabled: busy || conflict, terms: t };

  return (
    <WorkspacePage
      back={{ label: "All routing forms", onClick: onBack }}
      title={draft.name.trim() || "New routing form"}
      bar={bar}
      menu={menu}
    >
      <div className="flex flex-wrap items-center gap-2" role="status" aria-live="polite">
        {form?.status === "live" ? <Badge variant={form.hasUnpublishedChanges ? "warning" : "success"}>Live version {form.version}{form.hasUnpublishedChanges ? " · unpublished changes" : ""}</Badge> : form ? <StatusBadge tone="neutral">Draft</StatusBadge> : null}
        {form ? <Badge variant="outline">Version {form.version}</Badge> : <Badge variant="outline">Not saved yet</Badge>}
        {dirty ? <Badge variant="warning">Unsaved changes</Badge> : form ? <Badge variant="secondary">All changes saved</Badge> : null}
      </div>
      {conflict ? (
        <Alert variant="error">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Someone else changed this form</AlertTitle>
          <AlertDescription><p>Reload to see their changes. What you typed here will be lost.</p><Button size="sm" variant="outline" className="mt-2 min-h-11 sm:min-h-8" onClick={() => void onReload()}>Reload the form</Button></AlertDescription>
        </Alert>
      ) : message ? <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertDescription>{message}</AlertDescription></Alert> : null}
      <BasicsSection draft={draft} errors={errors} disabled={shared.disabled} businessSlug={catalog.clinic.slug} live={live} onChange={change} onCopy={() => void copyLink()} />
      <QuestionsSection draft={draft} bookingKeys={options.bookingKeys} errors={errors} disabled={shared.disabled} terms={t} onChange={change} />
      <RoutesSection shared={shared} onChange={change} />
      {form ? <PreviewPanel formId={form.id} questions={baseline.questions} options={options} terms={t} open={previewOpen} onOpenChange={setPreviewOpen} /> : null}
      <AlertDialog open={confirmDelete} onOpenChange={(next) => { if (!pending) setConfirmDelete(next); }}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this form?</AlertDialogTitle>
            <AlertDialogDescription>The address stops working and the form is removed. Past responses are kept in your reports. This cannot be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose disabled={pending === "delete"} render={<Button variant="ghost" />}>Keep it</AlertDialogClose>
            <Button variant="destructive" loading={pending === "delete"} onClick={() => void remove()}>Delete form</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </WorkspacePage>
  );
}

/** Opens one form (or a blank new one) in the builder. Waits for the form and the pick-lists before showing it. */
export function RoutingFormBuilder({ formId, options, onBack, onSaved }: {
  formId: string | null; options: RoutingBuilderOptions; onBack: () => void; onSaved: (id: string) => void;
}) {
  const query = useRoutingForm(formId);
  const [reloads, setReloads] = useState(0);
  if (formId && query.isPending) return <div role="status" aria-label="Loading the form" className="flex w-full flex-col gap-3 p-4 md:p-6"><Skeleton className="h-10 w-1/2" /><Skeleton className="h-40 w-full" /><Skeleton className="h-40 w-full" /></div>;
  if (formId && (query.isError || !query.data)) {
    return (
      <div className="w-full p-4 md:p-6">
        <Alert variant="error">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>The form could not be opened</AlertTitle>
          <AlertDescription><p>{query.error instanceof Error ? query.error.message : "Something went wrong."}</p>
            <div className="mt-2 flex gap-2"><Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => void query.refetch()}>Try again</Button><Button size="sm" variant="ghost" className="min-h-11 sm:min-h-8" onClick={onBack}>Back to the list</Button></div></AlertDescription>
        </Alert>
      </div>
    );
  }
  return (
    <BuilderBody key={`${formId ?? "new"}-${reloads}`} initial={query.data ?? null} options={options} onBack={onBack} onSaved={onSaved}
      onReload={async () => { await query.refetch(); setReloads((count) => count + 1); }} />
  );
}
