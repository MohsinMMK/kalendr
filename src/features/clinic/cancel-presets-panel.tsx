"use client";

import { MessageSquareText, Plus, X } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Frame, FrameDescription, FrameHeader, FramePanel } from "@/components/ui/frame";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";
import { CANCEL_PRESET_LABEL_MAX, MAX_CANCEL_PRESETS, type CancelPreset } from "@/lib/cancel-policy";

import { useCatalogLookups } from "./clinic-catalog";
import { useStaffAccess } from "./staff-access";

class PresetError extends Error {
  constructor(message: string, readonly code: string, readonly fieldErrors: Record<string, string[]>) { super(message); }
}

async function request(path: string, method: "GET" | "POST" | "DELETE", body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { method, cache: "no-store", signal, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result: unknown = await response.json().catch(() => null);
  if (response.ok) return typeof result === "object" && result !== null && "data" in result ? (result as { data: unknown }).data : null;
  const error = (typeof result === "object" && result !== null && "error" in result ? (result as { error: { code?: string; message?: string; fieldErrors?: Record<string, string[]> } }).error : null) ?? {};
  throw new PresetError(error.message ?? "Something went wrong. Try again.", error.code ?? "error", error.fieldErrors ?? {});
}

const listPresets = async (signal?: AbortSignal): Promise<CancelPreset[]> => {
  const data = await request("/api/staff/cancel-presets", "GET", undefined, signal);
  return Array.isArray(data) ? (data as CancelPreset[]) : [];
};

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; presets: CancelPreset[] };

/**
 * The reasons staff pick from when they cancel a booking, kept per business. Anyone who books can read them;
 * changing them needs the settings permission.
 */
export function CancelPresetsPanel() {
  const t = useTerms();
  const database = useCatalogLookups().database;
  const canChange = useStaffAccess().can("settings.manage");
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!database) return;
    const controller = new AbortController();
    listPresets(controller.signal).then((presets) => {
      if (!controller.signal.aborted) setLoad({ state: "ready", presets });
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setLoad({ state: "error", message: cause instanceof Error ? cause.message : "The reasons could not be loaded." });
    });
    return () => controller.abort();
  }, [database, reloadKey]);

  const reload = useCallback(() => { setLoad({ state: "loading" }); setReloadKey((key) => key + 1); }, []);

  if (!database) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><MessageSquareText aria-hidden="true" /></EmptyMedia>
          <EmptyTitle>Cancellation reasons are not available in the preview</EmptyTitle>
          <EmptyDescription>They are saved on the {t.business} database. Start the local database to add some.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const presets = load.state === "ready" ? load.presets : [];
  const full = presets.length >= MAX_CANCEL_PRESETS;
  const suggestions = [...new Set([`${t.Provider} unwell`, "Staff unwell", "Closed that day"])];

  async function add(event: FormEvent) {
    event.preventDefault();
    const trimmed = label.trim();
    if (trimmed.length < 2) { setFieldError("Write at least 2 letters."); return; }
    setSaving(true); setFieldError(""); setMessage("");
    try {
      await request("/api/staff/cancel-presets", "POST", { label: trimmed });
      setLabel("");
      reload();
    } catch (cause: unknown) {
      if (cause instanceof PresetError && cause.fieldErrors.label?.[0]) setFieldError(cause.fieldErrors.label[0]);
      else setMessage(cause instanceof Error ? cause.message : "The reason could not be added.");
    } finally {
      setSaving(false);
    }
  }

  async function addSuggested() {
    setSaving(true); setMessage("");
    try {
      for (const suggestion of suggestions) {
        try { await request("/api/staff/cancel-presets", "POST", { label: suggestion }); } catch (cause: unknown) {
          // A reason that is already there is fine; anything else stops here.
          if (!(cause instanceof PresetError && cause.code === "preset_exists")) throw cause;
        }
      }
    } catch (cause: unknown) {
      setMessage(cause instanceof Error ? cause.message : "The suggested reasons could not be added.");
    } finally {
      setSaving(false);
      reload();
    }
  }

  async function remove(preset: CancelPreset) {
    setRemovingId(preset.id); setMessage("");
    try {
      await request(`/api/staff/cancel-presets/${preset.id}`, "DELETE");
      toastManager.add({ title: `"${preset.label}" removed. Bookings already cancelled keep it.`, type: "success" });
      reload();
    } catch (cause: unknown) {
      setMessage(cause instanceof Error ? cause.message : "The reason could not be removed.");
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <Frame>
      <FrameHeader>
        <h3 className="font-semibold text-sm">Cancellation reasons</h3>
        <FrameDescription className="text-xs">Quick choices when you cancel {t.anAppointment}. The {t.customer} sees the one you pick.</FrameDescription>
      </FrameHeader>
      <FramePanel className="flex flex-col gap-4 py-3">
        {message ? <Alert variant="error"><AlertDescription>{message}</AlertDescription></Alert> : null}
        {canChange ? (
          <form onSubmit={(event) => void add(event)} noValidate>
            <Field invalid={Boolean(fieldError)} className="w-full">
              <FieldLabel>Add a reason</FieldLabel>
              <div className="flex w-full flex-nowrap items-center gap-2">
                <Input size="lg" aria-label="New cancellation reason" value={label} maxLength={CANCEL_PRESET_LABEL_MAX} disabled={saving || full} placeholder="For example, Power cut"
                  onChange={(event) => { setLabel(event.target.value); setFieldError(""); }} />
                <Button type="submit" size="lg" className="shrink-0" disabled={saving || full || label.trim() === ""}>
                  {saving ? <Spinner aria-hidden="true" /> : <Plus aria-hidden="true" />} Add
                </Button>
              </div>
              {fieldError ? <FieldError match>{fieldError}</FieldError> : <FieldDescription>{full ? `You have reached ${MAX_CANCEL_PRESETS} reasons. Remove one to add another.` : `Up to ${CANCEL_PRESET_LABEL_MAX} letters.`}</FieldDescription>}
            </Field>
          </form>
        ) : null}

        {load.state === "loading" ? (
          <div className="flex flex-col gap-2" role="status" aria-label="Loading the reasons"><Skeleton className="h-11 w-full" /><Skeleton className="h-11 w-full" /></div>
        ) : null}
        {load.state === "error" ? (
          <Alert variant="error">
            <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
              <span>{load.message}</span>
              <Button size="sm" variant="outline" onClick={reload}>Try again</Button>
            </AlertDescription>
          </Alert>
        ) : null}
        {load.state === "ready" && presets.length === 0 ? (
          <Empty className="py-6">
            <EmptyHeader>
              <EmptyMedia variant="icon"><MessageSquareText aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>No reasons yet</EmptyTitle>
              <EmptyDescription>{canChange ? `Add your own above, or start with ${suggestions.join(", ").replace(/, ([^,]*)$/, " and $1")}.` : "Nobody has added any yet."}</EmptyDescription>
            </EmptyHeader>
            {canChange ? (
              <Button variant="outline" disabled={saving} onClick={() => void addSuggested()}>
                {saving ? <Spinner aria-hidden="true" /> : <Plus aria-hidden="true" />} Add suggested reasons
              </Button>
            ) : null}
          </Empty>
        ) : null}
        {presets.length > 0 ? (
          <ul aria-label="Cancellation reasons" className="flex flex-col divide-y">
            {presets.map((preset) => (
              <li key={preset.id} className="flex items-center justify-between gap-3 py-1.5">
                <span className="min-w-0 truncate text-sm">{preset.label}</span>
                {canChange ? (
                  <Button variant="ghost" size="icon-lg" aria-label={`Remove ${preset.label}`} disabled={removingId !== null || saving} onClick={() => void remove(preset)}>
                    {removingId === preset.id ? <Spinner aria-hidden="true" /> : <X aria-hidden="true" />}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </FramePanel>
    </Frame>
  );
}
