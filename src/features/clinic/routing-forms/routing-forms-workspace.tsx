"use client";

import { Plus, Split, TriangleAlert } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { toastManager } from "@/components/ui/toast";

import { WorkspaceFrame, WorkspacePage } from "@/components/workspace-page";
import { StatusBadge } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs";
import { useUpgradePrompt } from "@/features/billing/upgrade-prompt";
import { useTerms } from "@/features/terms/business-profile-context";
import type { RoutingFormSummary } from "@/lib/routing-forms";

import { useCatalogLookups } from "../clinic-catalog";
import { StaffApiError } from "../queries/http";
import { useStaffAccess } from "../staff-access";
import { createRoutingFormRequest, routingKeys, useRoutingForms, useRoutingOptions } from "./queries";
import { buildTemplateDraft, routingTemplates, type RoutingTemplateId } from "./routing-form-templates";
import { ReportTab } from "./report-tab";
import { RoutingFormBuilder } from "./routing-form-builder";
import { WrongAssignmentsTab } from "./wrong-assignments-tab";

function ListSkeleton() {
  return <div role="status" aria-label="Loading routing forms" className="flex flex-col gap-2"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>;
}

function FormRow({ form, onOpen }: { form: RoutingFormSummary; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} className="flex min-h-16 w-full min-w-0 flex-col gap-1 px-4 py-2 text-start outline-none hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring sm:flex-row sm:items-center sm:gap-3">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 flex-wrap items-center gap-2"><span className="truncate font-medium text-sm">{form.name}</span>{form.status === "live" ? <StatusBadge tone="success">Live</StatusBadge> : <StatusBadge tone="neutral">Draft</StatusBadge>}</span>
          <span className="truncate text-muted-foreground text-xs">Version {form.version} · {form.routeCount} {form.routeCount === 1 ? "route" : "routes"}</span>
        </span>
        <span className="text-muted-foreground text-xs tabular-nums">{form.responses30d} {form.responses30d === 1 ? "response" : "responses"} in 30 days</span>
      </button>
    </li>
  );
}

/** Three starter forms on an empty list. Choosing one saves a draft through the normal create call, then opens it in the builder. */
function TemplateCards({ onCreated }: { onCreated: (id: string) => void }) {
  const t = useTerms();
  const client = useQueryClient();
  const options = useRoutingOptions();
  const [busy, setBusy] = useState<RoutingTemplateId | null>(null);

  async function start(id: RoutingTemplateId) {
    if (busy) return;
    setBusy(id);
    try {
      // Wait for the business's real services and locations so the draft never holds placeholder choices.
      const loaded = options.data ?? (await options.refetch()).data ?? null;
      const draft = buildTemplateDraft(id, t, loaded, crypto.randomUUID().replaceAll("-", "").slice(0, 5));
      const created = await createRoutingFormRequest(draft, crypto.randomUUID());
      await client.invalidateQueries({ queryKey: routingKeys.list() });
      onCreated(created.form.id);
    } catch (cause: unknown) {
      toastManager.add({ title: "The form could not be created", description: cause instanceof Error ? cause.message : "Something went wrong.", type: "error" });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="routing-templates" className="flex flex-col gap-3 px-4 pb-6">
      <h2 id="routing-templates" className="font-medium text-sm">Start from a template</h2>
      <ul className="grid gap-3 sm:grid-cols-3">
        {routingTemplates(t).map((template) => (
          <li key={template.id} className="flex">
            <button type="button" disabled={busy !== null} aria-busy={busy === template.id} onClick={() => void start(template.id)} className="flex min-h-11 w-full flex-col gap-1 rounded-lg border p-4 text-start outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-64">
              <span className="font-medium text-sm">{template.title}</span>
              <span className="text-muted-foreground text-xs">{template.description}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function FormsTab({ onOpen }: { onOpen: (id: string) => void }) {
  const t = useTerms();
  const access = useStaffAccess();
  const upgrade = useUpgradePrompt();
  const forms = useRoutingForms();
  if (forms.isPending) return <div className="p-4"><ListSkeleton /></div>;
  if (forms.isError) {
    const limited = forms.error instanceof StaffApiError && forms.error.code === "plan_limit";
    return (
      <Alert variant={limited ? "warning" : "error"} className="m-4 w-auto">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>{limited ? "Routing forms are not on your plan" : "Routing forms could not be loaded"}</AlertTitle>
        <AlertDescription>
          <p>{forms.error instanceof Error ? forms.error.message : "Something went wrong."}</p>
          {limited ? <Button size="sm" className="mt-2 min-h-11 sm:min-h-8" onClick={() => upgrade.fromError(forms.error)}>See plans</Button>
            : <Button size="sm" variant="outline" className="mt-2 min-h-11 sm:min-h-8" onClick={() => void forms.refetch()}>Try again</Button>}
        </AlertDescription>
      </Alert>
    );
  }
  if (forms.data.length === 0) {
    return (
      <>
      <Empty className="p-6">
        <EmptyHeader>
          <EmptyMedia variant="icon"><Split aria-hidden="true" /></EmptyMedia>
          <EmptyTitle className="text-base">No routing forms yet</EmptyTitle>
          <EmptyDescription>Ask a few questions, then send each {t.customer} to the right {t.service} and the right {t.provider}. Use New routing form to start.</EmptyDescription>
        </EmptyHeader>
      </Empty>
      {access.can("routing.manage") ? <TemplateCards onCreated={onOpen} /> : null}
      </>
    );
  }
  return <ul aria-label="Routing forms" className="flex flex-col divide-y">{forms.data.map((form) => <FormRow key={form.id} form={form} onOpen={() => onOpen(form.id)} />)}</ul>;
}

/** Routing forms: a few questions that send each customer to the right service and person. Needs the database. */
export function RoutingFormsWorkspace() {
  const t = useTerms();
  const access = useStaffAccess();
  const catalog = useCatalogLookups();
  const live = catalog.database;
  const params = useSearchParams();
  const initial = params.get("form");
  // null: the list. "new": a blank form. Anything else: that form's id.
  const [open, setOpen] = useState<string | null>(initial);
  const options = useRoutingOptions(live && open !== null);
  const forms = useRoutingForms(live);
  const [tab, setTab] = useState<"forms" | "report" | "wrong">("forms");

  function show(next: string | null) {
    const url = new URL(window.location.href);
    if (next && next !== "new") url.searchParams.set("form", next); else url.searchParams.delete("form");
    window.history.replaceState({}, "", url);
    setOpen(next);
  }

  if (!live) {
    return (
      <WorkspacePage nav="routing-forms">
      <WorkspaceFrame>
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyMedia variant="icon"><Split aria-hidden="true" /></EmptyMedia>
          <EmptyTitle>Routing forms are not available in the preview</EmptyTitle>
          <EmptyDescription>Routing forms need the {t.business} database, your {t.services} and your {t.providers}. Nothing here is saved from the preview.</EmptyDescription>
        </EmptyHeader>
      </Empty>
      </WorkspaceFrame>
      </WorkspacePage>
    );
  }

  if (open !== null) {
    if (options.isPending) return <div role="status" aria-label="Loading the builder" className="flex w-full flex-col gap-3 p-4 md:p-6"><Skeleton className="h-10 w-1/2" /><Skeleton className="h-40 w-full" /></div>;
    if (options.isError || !options.data) {
      return (
        <div className="w-full p-4 md:p-6">
          <Alert variant="error"><TriangleAlert aria-hidden="true" /><AlertTitle>The builder could not be loaded</AlertTitle>
            <AlertDescription><p>{options.error instanceof Error ? options.error.message : "Something went wrong."}</p>
              <div className="mt-2 flex gap-2"><Button size="sm" variant="outline" className="min-h-11 sm:min-h-8" onClick={() => void options.refetch()}>Try again</Button><Button size="sm" variant="ghost" className="min-h-11 sm:min-h-8" onClick={() => show(null)}>Back to the list</Button></div></AlertDescription></Alert>
        </div>
      );
    }
    return <RoutingFormBuilder formId={open === "new" ? null : open} options={options.data} onBack={() => show(null)} onSaved={(id) => show(id)} />;
  }

  return (
    <Tabs value={tab} onValueChange={(next) => setTab(next as typeof tab)} className="gap-0">
      <WorkspacePage
        nav="routing-forms"
        bar={access.can("routing.manage") ? [{ id: "new", label: "New routing form", variant: "default", pinned: true, icon: <Plus aria-hidden="true" />, onSelect: () => show("new") }] : []}
      >
        <WorkspaceFrame
          flush={tab === "forms"}
          start={
            <TabsList variant="underline" aria-label="Routing forms sections">
              <TabsTab value="forms" className="min-h-11 sm:min-h-8">Forms</TabsTab>
              <TabsTab value="report" className="min-h-11 sm:min-h-8">Report</TabsTab>
              <TabsTab value="wrong" className="min-h-11 sm:min-h-8">Wrong assignments</TabsTab>
            </TabsList>
          }
        >
          <TabsPanel value="forms"><FormsTab onOpen={(id) => show(id)} /></TabsPanel>
          <TabsPanel value="report"><ReportTab forms={forms.data ?? []} /></TabsPanel>
          <TabsPanel value="wrong"><WrongAssignmentsTab /></TabsPanel>
        </WorkspaceFrame>
      </WorkspacePage>
    </Tabs>
  );
}
