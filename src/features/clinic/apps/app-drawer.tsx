"use client";

import { Ellipsis, KeyRound, PauseCircle, PlayCircle, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";

import { RichMenu, RichMenuContent, RichMenuItem, RichMenuTrigger } from "@/components/rich-menu";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Drawer, DrawerDescription, DrawerFooter, DrawerHeader, DrawerPanel, DrawerPopup, DrawerTitle } from "@/components/ui/drawer";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { toastManager } from "@/components/ui/toast";
import { appErrorMessages, type AppDetail } from "@/lib/apps/catalog";

import { errorText, formatStamp, serverFieldErrors } from "../developers/shared";
import {
  useAppDetail, useCheckApp, useInstallApp, useReplaceCredentials, useSaveAppSettings, useSetAppStatus, useUninstallApp,
} from "./api";
import { SettingFieldInput } from "./setting-fields";

interface FormValues { credentials: Record<string, string>; settings: Record<string, unknown> }

function StateBadge({ detail }: { detail: AppDetail }) {
  if (detail.state === "active") return <Badge variant="success" size="lg">Connected</Badge>;
  if (detail.state === "paused") return <Badge variant="secondary" size="lg">Paused</Badge>;
  if (detail.state === "failing") return <Badge variant="error" size="lg">Switched off</Badge>;
  if (detail.state === "uninstalling") return <Badge variant="warning" size="lg">Removing</Badge>;
  return null;
}

function Activity({ detail }: { detail: AppDetail }) {
  if (detail.events.length === 0) {
    return <p className="text-muted-foreground text-sm">Nothing yet. The first line appears when the app is checked or hears about a booking.</p>;
  }
  return (
    <ul aria-label="Recent activity" className="flex flex-col divide-y rounded-lg border">
      {detail.events.map((event) => (
        <li key={event.id} className="flex items-start justify-between gap-3 px-3 py-2 text-sm">
          <div className="flex min-w-0 flex-col">
            <span className="font-medium">{eventLabel(event.eventType)}</span>
            <span className="text-muted-foreground text-xs">
              {formatStamp(event.createdAt)}{event.errorCode ? ` · ${appErrorMessages[event.errorCode] ?? "It did not go through."}` : ""}
            </span>
          </div>
          <Badge variant={event.outcome === "delivered" ? "success" : event.outcome === "failed" ? "error" : "secondary"}>
            {event.outcome === "delivered" ? "Sent" : event.outcome === "failed" ? "Failed" : "Skipped"}
          </Badge>
        </li>
      ))}
    </ul>
  );
}

const eventNames: Record<string, string> = {
  check: "Connection check", uninstall: "Removed",
  "appointment.created": "New booking", "appointment.rescheduled": "Booking moved", "appointment.cancelled": "Booking cancelled",
  "appointment.completed": "Visit finished", "customer.created": "New customer",
};
const eventLabel = (type: string): string => eventNames[type] ?? "Update";

function CredentialInputs({ detail, register, errors }: { detail: AppDetail; register: ReturnType<typeof useForm<FormValues>>["register"]; errors: Record<string, string> }) {
  return (
    <>
      {detail.credentialFields.map((field) => (
        <Field key={field.key} invalid={Boolean(errors[`credentials.${field.key}`])}>
          <FieldLabel>{field.label}</FieldLabel>
          <Input size="lg" type="password" autoComplete="off" spellCheck={false} placeholder={field.placeholder} {...register(`credentials.${field.key}`)} />
          {errors[`credentials.${field.key}`] ? <FieldError match>{errors[`credentials.${field.key}`]}</FieldError> : <FieldDescription>{field.help}</FieldDescription>}
        </Field>
      ))}
    </>
  );
}

function DrawerBody({ appKey, onClose }: { appKey: string; onClose: () => void }) {
  const query = useAppDetail(appKey);
  const install = useInstallApp(appKey);
  const save = useSaveAppSettings(appKey);
  const replace = useReplaceCredentials(appKey);
  const status = useSetAppStatus(appKey);
  const check = useCheckApp(appKey);
  const remove = useUninstallApp(appKey);
  const [replacing, setReplacing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const { register, control, handleSubmit, reset } = useForm<FormValues>({ defaultValues: { credentials: {}, settings: {} } });
  const detail = query.data;

  // Fill the form from the saved choices when they change, not on every refetch of the activity log.
  const version = detail?.version ?? 0;
  const loadedKey = detail?.key;
  useEffect(() => {
    if (detail) reset({ credentials: {}, settings: detail.settings });
  }, [loadedKey, version]); // eslint-disable-line react-hooks/exhaustive-deps -- the form follows the saved version only

  if (query.isPending) return <DrawerPanel><div role="status" aria-label="Loading app" className="flex flex-col gap-3"><Skeleton className="h-6 w-1/2" /><Skeleton className="h-24 w-full" /><Skeleton className="h-24 w-full" /></div></DrawerPanel>;
  if (query.isError || !detail) {
    return (
      <DrawerPanel>
        <Alert variant="error">
          <AlertTitle>This app could not be loaded</AlertTitle>
          <AlertDescription><p>{errorText(query.error, "Check your connection and try again.")}</p>
            <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void query.refetch()}><RefreshCw aria-hidden="true" /> Retry</Button></AlertDescription>
        </Alert>
      </DrawerPanel>
    );
  }

  const installed = detail.version !== null;
  const busy = install.isPending || save.isPending || replace.isPending;
  const problem = (cause: unknown, fallback: string) => {
    const fields = serverFieldErrors(cause);
    setServerErrors(fields);
    if (Object.keys(fields).length === 0) toastManager.add({ title: fallback, description: errorText(cause, "Try again."), type: "error" });
  };

  const submit = handleSubmit(async (values) => {
    setServerErrors({});
    try {
      if (!installed) {
        await install.mutateAsync({ credentials: values.credentials, settings: values.settings });
        toastManager.add({ title: `${detail.name} is connected`, description: "Kalendr is checking the connection. The result shows under Activity.", type: "success" });
      } else if (replacing) {
        await replace.mutateAsync({ credentials: values.credentials, expectedVersion: detail.version ?? 1 });
        setReplacing(false);
        toastManager.add({ title: "New key saved", description: "Kalendr is checking it.", type: "success" });
      } else {
        await save.mutateAsync({ settings: values.settings, expectedVersion: detail.version ?? 1 });
        toastManager.add({ title: "Saved", type: "success" });
      }
    } catch (cause: unknown) {
      problem(cause, "Could not save");
    }
  });

  async function act(run: () => Promise<unknown>, done: string, fail: string) {
    try { await run(); toastManager.add({ title: done, type: "success" }); } catch (cause: unknown) { toastManager.add({ title: fail, description: errorText(cause, "Try again."), type: "error" }); }
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="flex min-h-0 flex-1 flex-col">
      <DrawerHeader>
        <div className="flex items-center gap-2"><DrawerTitle>{detail.name}</DrawerTitle><StateBadge detail={detail} /></div>
        <DrawerDescription>{detail.description}</DrawerDescription>
      </DrawerHeader>
      <DrawerPanel className="flex flex-col gap-5">
        {detail.state === "failing" ? (
          <Alert variant="error">
            <AlertTitle>Switched off</AlertTitle>
            <AlertDescription>{detail.disabledReason === "credential_rejected" ? "The other service no longer accepts the saved key. Replace the key to turn it back on." : "It failed too many times in a row. Check the activity, then replace the key or send a check."}</AlertDescription>
          </Alert>
        ) : null}
        {detail.needsUpgrade && !installed ? <Alert variant="warning"><AlertTitle>Part of the Growth plan</AlertTitle><AlertDescription>Upgrade your plan to connect apps.</AlertDescription></Alert> : null}

        <section aria-labelledby="sends-title" className="flex flex-col gap-2 rounded-lg border bg-muted/40 p-3">
          <h3 id="sends-title" className="flex items-center gap-2 font-medium text-sm"><ShieldCheck aria-hidden="true" className="size-4" /> What this app receives</h3>
          <ul className="flex list-disc flex-col gap-1 ps-5 text-sm">{detail.dataSent.map((line) => <li key={line}>{line}</li>)}</ul>
        </section>

        {(!installed || replacing) ? <CredentialInputs detail={detail} register={register} errors={serverErrors} /> : null}
        {!replacing ? detail.settingFields.map((field) => (
          <SettingFieldInput key={field.key} field={field} control={control} error={serverErrors[`settings.${field.key}`]} />
        )) : null}
        {installed ? (
          <section aria-labelledby="activity-title" className="flex flex-col gap-2">
            <h3 id="activity-title" className="font-medium text-sm">Activity</h3>
            <Activity detail={detail} />
          </section>
        ) : null}
        {installed && detail.uninstallNote ? <p className="text-muted-foreground text-xs">When you remove it: {detail.uninstallNote}</p> : null}
      </DrawerPanel>
      <DrawerFooter className="flex-row items-center justify-between gap-2">
        <Button type="button" variant="ghost" size="lg" onClick={replacing ? () => setReplacing(false) : onClose}>{replacing ? "Cancel" : "Close"}</Button>
        <div className="flex items-center gap-2">
          {installed && detail.state !== "uninstalling" ? (
            <RichMenu>
              <RichMenuTrigger render={<Button type="button" variant="outline" size="icon-lg" aria-label={`More for ${detail.name}`} />}><Ellipsis aria-hidden="true" /></RichMenuTrigger>
              <RichMenuContent>
                <RichMenuItem icon={<RefreshCw aria-hidden="true" />} onClick={() => void act(() => check.mutateAsync(), "Check queued", "Could not queue the check")}>Send a check</RichMenuItem>
                <RichMenuItem icon={<KeyRound aria-hidden="true" />} onClick={() => setReplacing(true)}>Replace the key</RichMenuItem>
                {detail.state === "paused"
                  ? <RichMenuItem icon={<PlayCircle aria-hidden="true" />} onClick={() => void act(() => status.mutateAsync({ status: "active", expectedVersion: detail.version ?? 1 }), "Turned on", "Could not turn it on")}>Turn on</RichMenuItem>
                  : detail.state === "active" ? <RichMenuItem icon={<PauseCircle aria-hidden="true" />} onClick={() => void act(() => status.mutateAsync({ status: "paused", expectedVersion: detail.version ?? 1 }), "Paused", "Could not pause")}>Pause</RichMenuItem> : null}
                <RichMenuItem destructive icon={<Trash2 aria-hidden="true" />} onClick={() => setRemoving(true)}>Remove app</RichMenuItem>
              </RichMenuContent>
            </RichMenu>
          ) : null}
          {detail.state !== "uninstalling" ? (
            <Button type="submit" size="lg" disabled={busy || (detail.needsUpgrade && !installed)}>
              {busy ? <Spinner aria-hidden="true" /> : null}{!installed ? (busy ? "Connecting…" : "Connect") : replacing ? "Save new key" : busy ? "Saving…" : "Save changes"}
            </Button>
          ) : null}
        </div>
      </DrawerFooter>
      <AlertDialog open={removing} onOpenChange={setRemoving}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {detail.name}?</AlertDialogTitle>
            <AlertDialogDescription>It stops at once. Kalendr revokes the key where it can and deletes the saved key and choices. The activity log stays.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button type="button" variant="ghost" size="lg" />}>Keep it</AlertDialogClose>
            <Button type="button" variant="destructive" size="lg" disabled={remove.isPending} onClick={() => void act(async () => { await remove.mutateAsync(); setRemoving(false); onClose(); }, "Removing", "Could not remove it")}>Remove app</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </form>
  );
}

/** The install and settings panel for one app: a side drawer on wide screens, a bottom sheet on phones. */
export function AppDrawer({ appKey, onClose }: { appKey: string | null; onClose: () => void }) {
  return (
    <Drawer open={appKey !== null} onOpenChange={(open) => { if (!open) onClose(); }} position="right">
      <DrawerPopup showBar>{appKey ? <DrawerBody appKey={appKey} onClose={onClose} /> : null}</DrawerPopup>
    </Drawer>
  );
}
