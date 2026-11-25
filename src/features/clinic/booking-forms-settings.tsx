"use client";

import { useCallback, useEffect, useState } from "react";
import { ClipboardList, Plus, Sparkles } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { starterForms, type FormDefinition } from "@/lib/booking-forms";

import { useBusinessProfile, useTerms } from "../terms/business-profile-context";
import { blankQuestion, cloneFields, FormEditor, type Editing } from "./booking-form-editor";
import { useCatalogLookups } from "./clinic-catalog";
import { useStaffAccess } from "./staff-access";
import { staffQuery } from "./staff-snapshot-provider";

/** Settings → Booking forms. Questions customers answer when they book. Owners and admins edit them. */
export function BookingFormsSettings() {
  const profile = useBusinessProfile();
  const t = useTerms();
  const access = useStaffAccess();
  const catalog = useCatalogLookups();
  const canChange = access.role === "owner" || access.role === "admin";

  const [forms, setForms] = useState<FormDefinition[]>([]);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [editing, setEditing] = useState<Editing | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoadState("loading");
    setLoadError("");
    try {
      const list = await staffQuery<FormDefinition[]>("/api/staff/forms", signal);
      setForms(list);
      setLoadState("ready");
    } catch (cause: unknown) {
      if (signal?.aborted) return;
      setLoadError(cause instanceof Error ? cause.message : "Booking forms could not be loaded.");
      setLoadState("error");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => void load(controller.signal));
    return () => controller.abort();
  }, [load]);

  function startSuggested() {
    const starter = starterForms[profile.businessType];
    setEditing({
      key: null,
      draft: { ...starter, fields: cloneFields(starter.fields), isActive: true, appliesToAll: true, serviceIds: [] },
    });
  }

  function startBlank() {
    setEditing({
      key: null,
      draft: { name: "", description: "", fields: [blankQuestion([])], isActive: true, appliesToAll: true, serviceIds: [] },
    });
  }

  function openForm(form: FormDefinition) {
    setEditing({
      key: form.key,
      draft: {
        name: form.name,
        description: form.description,
        fields: cloneFields(form.fields),
        isActive: form.isActive,
        appliesToAll: form.appliesToAll,
        serviceIds: [...form.serviceIds],
        ...(form.requiredOverrides ? { requiredOverrides: structuredClone(form.requiredOverrides) } : {}),
      },
    });
  }

  const readOnlyNote = !canChange ? (
    <Alert role="note">
      <AlertDescription>Only the owner or an admin can change booking forms.</AlertDescription>
    </Alert>
  ) : null;

  if (editing) {
    return (
      <div className="flex flex-col gap-4">
        {readOnlyNote}
        <FormEditor
          key={editing.key ?? "new"}
          initial={editing}
          canChange={canChange}
          onCancel={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            toastManager.add({ title: "Booking form saved.", type: "success" });
            await load();
          }}
        />
      </div>
    );
  }

  const serviceSummary = (form: FormDefinition) =>
    form.appliesToAll ? `All ${t.services}` : form.serviceIds.map((id) => catalog.serviceName(id)).join(", ") || `No ${t.services} chosen`;

  return (
    <div className="flex flex-col gap-4">
      {readOnlyNote}
      {loadState === "error" ? (
        <Alert variant="error">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>{loadError}</span>
            <Button variant="outline" size="sm" onClick={() => void load()}>Try again</Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {loadState === "loading" ? (
        <div role="status" className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
          <Spinner aria-hidden="true" /> Loading booking forms…
        </div>
      ) : loadState === "ready" && forms.length === 0 ? (
        <Frame>
          <FramePanel>
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon"><ClipboardList aria-hidden="true" /></EmptyMedia>
                <EmptyTitle>No booking forms yet</EmptyTitle>
                <EmptyDescription>
                  Ask {t.customers} a few questions when they book, so you have what you need before they arrive.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent className="flex flex-row flex-wrap justify-center gap-2">
                <Button onClick={startSuggested} disabled={!canChange}>
                  <Sparkles aria-hidden="true" /> Start from a suggested form
                </Button>
                <Button variant="outline" onClick={startBlank} disabled={!canChange}>Start from scratch</Button>
              </EmptyContent>
            </Empty>
          </FramePanel>
        </Frame>
      ) : loadState === "ready" ? (
        <Frame>
          <FrameHeader className="flex-row flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1 basis-64">
              <FrameTitle>Your forms</FrameTitle>
              <FrameDescription>
                A form chosen for a {t.service} is used instead of one for all {t.services}.
              </FrameDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={startSuggested} disabled={!canChange}>
                <Sparkles aria-hidden="true" /> Suggested form
              </Button>
              <Button size="sm" onClick={startBlank} disabled={!canChange}>
                <Plus aria-hidden="true" /> New form
              </Button>
            </div>
          </FrameHeader>
          <FramePanel className="p-0">
            <ul className="flex flex-col divide-y">
              {forms.map((form) => (
                <li key={form.key} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                  <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate font-medium text-sm">{form.name}</span>
                      <Badge variant={form.isActive ? "success" : "outline"}>{form.isActive ? "On" : "Off"}</Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {form.fields.length} {form.fields.length === 1 ? "question" : "questions"} · {serviceSummary(form)} · Version {form.version}
                    </p>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => openForm(form)} aria-label={`${canChange ? "Edit" : "View"} ${form.name}`}>
                    {canChange ? "Edit" : "View"}
                  </Button>
                </li>
              ))}
            </ul>
          </FramePanel>
        </Frame>
      ) : null}
    </div>
  );
}
