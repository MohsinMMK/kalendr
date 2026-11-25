"use client";

import { useCallback, useEffect, useState } from "react";
import { BellRing, Copy, Ellipsis, Pencil, Plus, Send, Sparkles, Trash2 } from "lucide-react";

import { ActionMenuButton, type ActionMenuEntry } from "@/components/action-bar";
import { SelectField } from "@/components/form-fields";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import {
  channelLabels,
  describeWorkflow,
  type WorkflowInput,
  type WorkflowListView,
  type WorkflowSettings as QuietHours,
  type WorkflowView,
} from "@/lib/workflow-contracts";

import { WorkflowApiError, WorkflowEditor, type FieldErrors } from "./workflow-editor";

const base = "/api/staff/workflows";

function readFieldErrors(error: unknown): FieldErrors {
  const result: FieldErrors = {};
  if (typeof error !== "object" || error === null || !("fieldErrors" in error)) return result;
  const raw = (error as { fieldErrors?: unknown }).fieldErrors;
  if (typeof raw !== "object" || raw === null) return result;
  for (const [path, value] of Object.entries(raw)) {
    const message = Array.isArray(value) ? value.find((item): item is string => typeof item === "string") : value;
    if (typeof message === "string" && message) result[path] = message;
  }
  return result;
}

/** One request to the workflows API. A refusal becomes a WorkflowApiError that keeps the field errors. */
async function call<T>(path: string, init?: { method?: string; body?: unknown; idempotencyKey?: string; signal?: AbortSignal }): Promise<T> {
  const headers: Record<string, string> = {};
  if (init?.body !== undefined) headers["Content-Type"] = "application/json";
  if (init?.idempotencyKey) headers["Idempotency-Key"] = init.idempotencyKey;
  let response: Response;
  try {
    response = await fetch(path, {
      method: init?.method ?? "GET",
      headers,
      cache: "no-store",
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init?.signal,
    });
  } catch (cause: unknown) {
    if (init?.signal?.aborted) throw cause;
    throw new WorkflowApiError("We could not reach the server. Check your connection and try again.");
  }
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok || typeof result !== "object" || result === null || !("data" in result)) {
    const error = typeof result === "object" && result !== null && "error" in result ? (result as { error: unknown }).error : null;
    const message = typeof error === "object" && error !== null && "message" in error && typeof (error as { message: unknown }).message === "string"
      ? (error as { message: string }).message
      : "Something went wrong. Try again.";
    const code = typeof error === "object" && error !== null && "code" in error && typeof (error as { code: unknown }).code === "string"
      ? (error as { code: string }).code
      : "unknown";
    throw new WorkflowApiError(message, response.status, code, readFieldErrors(error));
  }
  return (result as { data: T }).data;
}

function toInput(workflow: WorkflowView, patch: Partial<WorkflowInput> = {}): WorkflowInput {
  return {
    name: workflow.name,
    trigger: workflow.trigger,
    offsetMinutes: workflow.offsetMinutes,
    filters: workflow.filters,
    active: workflow.active,
    steps: workflow.steps.map((step) => ({
      channel: step.channel,
      subject: step.subject,
      body: step.body,
      templateKey: step.templateKey,
      waitMinutes: step.waitMinutes,
      ignoreQuietHours: step.ignoreQuietHours,
      skipIfConfirmed: step.skipIfConfirmed,
    })),
    ...patch,
  };
}

function formatMinute(minute: number): string {
  const hours = Math.floor(minute / 60);
  const rest = minute % 60;
  const suffix = hours >= 12 ? "pm" : "am";
  const shown = hours % 12 === 0 ? 12 : hours % 12;
  return `${shown}:${String(rest).padStart(2, "0")} ${suffix}`;
}

function timeOptions(current: number) {
  const minutes = new Set<number>(Array.from({ length: 48 }, (_, index) => index * 30));
  minutes.add(current);
  return [...minutes].sort((a, b) => a - b).map((minute) => ({ value: String(minute), label: formatMinute(minute) }));
}

type Editing = { workflow: WorkflowView | null } | null;

/** Settings → Reminders and follow-ups. Rules that send a message at the right moment. */
export function WorkflowSettings() {
  const t = useTerms();
  const [data, setData] = useState<WorkflowListView | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [loadError, setLoadError] = useState("");
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<WorkflowView | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [quietPending, setQuietPending] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoadState("loading");
    setLoadError("");
    try {
      const view = await call<WorkflowListView>(base, { signal });
      setData(view);
      setConflict(false);
      setLoadState("ready");
    } catch (cause: unknown) {
      if (signal?.aborted) return;
      setLoadError(cause instanceof Error ? cause.message : "Reminders could not be loaded.");
      setLoadState("error");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => void load(controller.signal));
    return () => controller.abort();
  }, [load]);

  function replace(view: WorkflowView) {
    setData((before) => (before ? { ...before, workflows: before.workflows.map((item) => (item.id === view.id ? view : item)) } : before));
  }

  function fail(cause: unknown, fallback: string) {
    if (cause instanceof WorkflowApiError && cause.code === "version_conflict") {
      setConflict(true);
      return;
    }
    toastManager.add({ title: cause instanceof Error ? cause.message : fallback, type: "error" });
  }

  async function toggle(workflow: WorkflowView, active: boolean) {
    setBusy(true);
    try {
      replace(await call<WorkflowView>(`${base}/${encodeURIComponent(workflow.id)}`, {
        method: "PATCH",
        body: { ...toInput(workflow, { active }), expectedVersion: workflow.version },
      }));
    } catch (cause: unknown) {
      fail(cause, "That could not be changed.");
    } finally {
      setBusy(false);
    }
  }

  async function duplicate(workflow: WorkflowView) {
    try {
      const copy = await call<WorkflowView>(`${base}/${encodeURIComponent(workflow.id)}/duplicate`, { method: "POST" });
      setData((before) => (before ? { ...before, workflows: [...before.workflows, copy] } : before));
      toastManager.add({ title: "Copied. It starts turned off so you can check it first.", type: "success" });
      setEditing({ workflow: copy });
    } catch (cause: unknown) {
      fail(cause, "That could not be copied.");
    }
  }

  async function sendTest(workflow: WorkflowView) {
    try {
      await call<{ queued: boolean }>(`${base}/${encodeURIComponent(workflow.id)}/test`, { method: "POST" });
      toastManager.add({ title: "A test is on its way to you. Nobody else gets it.", type: "success" });
    } catch (cause: unknown) {
      fail(cause, "The test could not be sent.");
    }
  }

  async function remove(workflow: WorkflowView) {
    setBusy(true);
    try {
      await call<{ id: string }>(`${base}/${encodeURIComponent(workflow.id)}`, { method: "DELETE" });
      setData((before) => (before ? { ...before, workflows: before.workflows.filter((item) => item.id !== workflow.id) } : before));
      setDeleting(null);
      toastManager.add({ title: "Workflow deleted.", type: "success" });
    } catch (cause: unknown) {
      setDeleting(null);
      fail(cause, "That could not be deleted.");
    } finally {
      setBusy(false);
    }
  }

  async function saveWorkflow(input: WorkflowInput, idempotencyKey: string) {
    const existing = editing?.workflow ?? null;
    const saved = existing
      ? await call<WorkflowView>(`${base}/${encodeURIComponent(existing.id)}`, { method: "PATCH", body: { ...input, expectedVersion: existing.version } })
      : await call<WorkflowView>(base, { method: "POST", body: input, idempotencyKey });
    setData((before) => {
      if (!before) return before;
      const known = before.workflows.some((item) => item.id === saved.id);
      return { ...before, workflows: known ? before.workflows.map((item) => (item.id === saved.id ? saved : item)) : [...before.workflows, saved] };
    });
    setEditing(null);
    toastManager.add({ title: "Workflow saved.", type: "success" });
  }

  async function saveQuiet(next: QuietHours) {
    if (!data) return;
    const before = data.settings;
    setData({ ...data, settings: next });
    setQuietPending(true);
    try {
      const saved = await call<QuietHours>(`${base}/settings`, { method: "PUT", body: next });
      setData((current) => (current ? { ...current, settings: saved } : current));
      toastManager.add({ title: "Quiet hours saved.", type: "success" });
    } catch (cause: unknown) {
      setData((current) => (current ? { ...current, settings: before } : current));
      toastManager.add({ title: cause instanceof Error ? cause.message : "Quiet hours could not be saved.", type: "error" });
    } finally {
      setQuietPending(false);
    }
  }

  async function applyPresets() {
    setBusy(true);
    try {
      setData(await call<WorkflowListView>(`${base}/presets`, { method: "POST" }));
      toastManager.add({ title: "The standard set is on.", type: "success" });
    } catch (cause: unknown) {
      fail(cause, "The standard set could not be turned on.");
    } finally {
      setBusy(false);
    }
  }

  if (loadState === "loading" && !data) {
    return (
      <div role="status" className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <Spinner aria-hidden="true" /> Loading reminders…
      </div>
    );
  }

  if (loadState === "error" && !data) {
    return (
      <Alert variant="error">
        <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
          <span>{loadError}</span>
          <Button variant="outline" size="sm" onClick={() => void load()}>Try again</Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (!data) return null;

  if (data.unavailable) {
    return (
      <Frame>
        <FramePanel>
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon"><BellRing aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>Not available in the preview</EmptyTitle>
              <EmptyDescription>
                Reminders and follow-ups need the {t.business} database to store them and send them. In the preview nothing can be saved or sent, so there is nothing to edit here.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </FramePanel>
      </Frame>
    );
  }

  const { workflows, settings, options } = data;
  const notReady = new Map(options.channels.filter((channel) => !channel.ready).map((channel) => [channel.key, channel]));

  return (
    <div className="flex flex-col gap-4">
      {conflict ? (
        <Alert variant="warning" role="alert">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>Someone else changed this workflow. Reload to see the latest, then try your change again.</span>
            <Button variant="outline" size="sm" onClick={() => void load()}>Reload</Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {loadState === "error" ? (
        <Alert variant="error">
          <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
            <span>{loadError}</span>
            <Button variant="outline" size="sm" onClick={() => void load()}>Try again</Button>
          </AlertDescription>
        </Alert>
      ) : null}

      <Frame>
        <FrameHeader>
          <FrameTitle>Quiet hours</FrameTitle>
          <FrameDescription>
            Messages due then wait until the end, except confirmations the {t.customer} just asked for.
          </FrameDescription>
        </FrameHeader>
        <FramePanel className="grid grid-cols-2 gap-3">
          <SelectField
            label="Quiet hours start"
            value={String(settings.quietStartMinute)}
            onValueChange={(next) => void saveQuiet({ ...settings, quietStartMinute: Number(next) })}
            options={timeOptions(settings.quietStartMinute)}
            disabled={quietPending}
          />
          <SelectField
            label="Quiet hours end"
            value={String(settings.quietEndMinute)}
            onValueChange={(next) => void saveQuiet({ ...settings, quietEndMinute: Number(next) })}
            options={timeOptions(settings.quietEndMinute)}
            disabled={quietPending}
          />
        </FramePanel>
      </Frame>

      {workflows.length === 0 ? (
        <Frame>
          <FramePanel>
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon"><BellRing aria-hidden="true" /></EmptyMedia>
                <EmptyTitle>No reminders yet</EmptyTitle>
                <EmptyDescription>
                  A workflow sends a message at the right moment, like a reminder the day before a {t.appointment}. Start with our standard set, or make your own.
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent className="flex flex-row flex-wrap justify-center gap-2">
                <Button onClick={() => void applyPresets()} disabled={busy}>
                  {busy ? <Spinner aria-hidden="true" /> : <Sparkles aria-hidden="true" />} Turn on the standard set
                </Button>
                <Button variant="outline" onClick={() => setEditing({ workflow: null })}>
                  <Plus aria-hidden="true" /> New workflow
                </Button>
              </EmptyContent>
            </Empty>
          </FramePanel>
        </Frame>
      ) : (
        <Frame>
          <FrameHeader className="flex-row flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1 basis-56">
              <FrameTitle>Your workflows</FrameTitle>
              <FrameDescription>Each one sends messages when its moment comes.</FrameDescription>
            </div>
            <Button size="sm" onClick={() => setEditing({ workflow: null })}>
              <Plus aria-hidden="true" /> New workflow
            </Button>
          </FrameHeader>
          <FramePanel className="p-0">
            <ul className="flex flex-col divide-y">
              {workflows.map((workflow) => {
                const sentence = describeWorkflow(workflow, t.appointment);
                const blocked = [...new Set(workflow.steps.map((step) => step.channel))].filter((channel) => notReady.has(channel));
                const menu: ActionMenuEntry[] = [
                  { id: "duplicate", label: "Duplicate", icon: <Copy aria-hidden="true" />, onSelect: () => void duplicate(workflow) },
                  { id: "test", label: "Send me a test", icon: <Send aria-hidden="true" />, onSelect: () => void sendTest(workflow) },
                  { kind: "separator", id: "sep" },
                  { id: "delete", label: "Delete", icon: <Trash2 aria-hidden="true" />, destructive: true, onSelect: () => setDeleting(workflow) },
                ];
                return (
                  <li key={workflow.id} className="flex flex-col gap-3 px-5 py-4">
                    <div className="flex min-w-0 flex-col gap-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="min-w-0 break-words font-medium text-sm">{workflow.name}</h3>
                        {!workflow.active ? <Badge variant="outline">Off</Badge> : null}
                        {blocked.map((channel) => (
                          <Badge key={channel} variant="warning">{channelLabels[channel]} not set up</Badge>
                        ))}
                      </div>
                      <p className="break-words text-sm text-muted-foreground">{sentence}</p>
                    </div>
                    <div className="flex flex-nowrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <Switch
                          aria-label={`${workflow.name} is on`}
                          checked={workflow.active}
                          disabled={busy}
                          onCheckedChange={(on) => void toggle(workflow, on)}
                        />
                        <span aria-hidden="true" className="text-xs text-muted-foreground">{workflow.active ? "On" : "Off"}</span>
                      </div>
                      <div className="flex flex-nowrap items-center gap-1">
                        <Button variant="outline" size="sm" onClick={() => setEditing({ workflow })} aria-label={`Edit ${workflow.name}`}>
                          <Pencil aria-hidden="true" /> Edit
                        </Button>
                        <ActionMenuButton label={`More actions for ${workflow.name}`} iconOnly variant="ghost" icon={<Ellipsis aria-hidden="true" />} items={menu} />
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </FramePanel>
        </Frame>
      )}

      {editing ? (
        <WorkflowEditor
          key={editing.workflow ? `${editing.workflow.id}-${editing.workflow.version}` : "new"}
          workflow={editing.workflow}
          options={options}
          onSave={saveWorkflow}
          onClose={() => setEditing(null)}
          onReload={() => {
            setEditing(null);
            void load();
          }}
        />
      ) : null}

      <AlertDialog open={deleting !== null} onOpenChange={(open) => { if (!open) setDeleting(null); }}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this workflow?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleting ? `"${deleting.name}" will stop sending. Messages already waiting to go out are cancelled. This cannot be undone.` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>Keep it</AlertDialogClose>
            <Button variant="destructive" disabled={busy} onClick={() => { if (deleting) void remove(deleting); }}>
              {busy ? <Spinner aria-hidden="true" /> : null} Delete workflow
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
