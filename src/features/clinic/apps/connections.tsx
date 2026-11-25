"use client";

import { Ellipsis, Plus, RefreshCw, Trash2, Unplug } from "lucide-react";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";

import { RichMenu, RichMenuContent, RichMenuItem, RichMenuTrigger } from "@/components/rich-menu";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { toastManager } from "@/components/ui/toast";
import { apiScopeLabels, apiScopes, type ApiScope } from "@/lib/api-scopes";
import type { OAuthClientView } from "@/lib/oauth";

import { errorText, formatDay, formatStamp, SecretRevealDialog, serverFieldErrors } from "../developers/shared";
import { useClients, useCreateClient, useGrants, useRevokeClient, useRevokeGrant, type GrantRow } from "./api";

/** People's approvals: who connected which app, and what it may do. Revoking is immediate. */
export function GrantsPanel() {
  const query = useGrants();
  const revoke = useRevokeGrant();
  const [revoking, setRevoking] = useState<GrantRow | null>(null);

  if (query.isPending) return <div role="status" aria-label="Loading connections" className="flex flex-col gap-3"><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>;
  if (query.isError) {
    return <Alert variant="error"><AlertTitle>Connections could not be loaded</AlertTitle><AlertDescription><p>{errorText(query.error, "Try again.")}</p>
      <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void query.refetch()}><RefreshCw aria-hidden="true" /> Retry</Button></AlertDescription></Alert>;
  }
  const grants = query.data.grants;
  async function confirm() {
    if (!revoking) return;
    try { await revoke.mutateAsync(revoking.id); toastManager.add({ title: "Disconnected", description: "It stopped working straight away.", type: "success" }); }
    catch (cause: unknown) { toastManager.add({ title: "Could not disconnect", description: errorText(cause, "Try again."), type: "error" }); }
    finally { setRevoking(null); }
  }

  return (
    <>
      {grants.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><Unplug aria-hidden="true" /></EmptyMedia>
            <EmptyTitle>No apps signed in as you</EmptyTitle>
            <EmptyDescription>When you connect the browser extension or another app to your account, it shows here. You can disconnect it any time.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <Frame>
          <FrameHeader><FrameTitle>Signed-in apps</FrameTitle><FrameDescription>Each one can only do what is listed. Disconnecting stops it at once.</FrameDescription></FrameHeader>
          <FramePanel>
            <ul aria-label="Signed-in apps" className="flex flex-col divide-y">
              {grants.map((grant) => (
                <li key={grant.id} className="flex items-start justify-between gap-3 py-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="truncate font-medium">{grant.clientName}{grant.mine ? <Badge variant="secondary" className="ms-2">You</Badge> : null}</span>
                    <span className="flex flex-wrap gap-1">{grant.scopes.map((scope) => <Badge key={scope} variant="outline">{apiScopeLabels[scope].label}</Badge>)}</span>
                    <span className="text-muted-foreground text-xs">Connected {formatDay(grant.createdAt)} · Last used {grant.lastUsedAt ? formatStamp(grant.lastUsedAt) : "never"}</span>
                  </div>
                  <Button type="button" variant="outline" size="lg" onClick={() => setRevoking(grant)}>Disconnect</Button>
                </li>
              ))}
            </ul>
          </FramePanel>
        </Frame>
      )}
      <AlertDialog open={revoking !== null} onOpenChange={(open) => { if (!open) setRevoking(null); }}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {revoking?.clientName}?</AlertDialogTitle>
            <AlertDialogDescription>It signs out at once and can no longer read or change anything. You can connect it again later.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button type="button" variant="ghost" size="lg" />}>Keep connected</AlertDialogClose>
            <Button type="button" variant="destructive" size="lg" disabled={revoke.isPending} onClick={() => void confirm()}>Disconnect</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

interface ClientForm { name: string; redirects: string; scopes: ApiScope[] }

function RegisterDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (result: { client: OAuthClientView; secret: string }) => void }) {
  const create = useCreateClient();
  const { register, control, handleSubmit, reset } = useForm<ClientForm>({ defaultValues: { name: "", redirects: "", scopes: ["services:read"] } });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const submit = handleSubmit(async (values) => {
    setErrors({});
    const redirectUris = values.redirects.split(/\s+/).filter(Boolean);
    try {
      onCreated(await create.mutateAsync({ name: values.name, redirectUris, scopes: values.scopes }));
      reset();
    } catch (cause: unknown) {
      const fields = serverFieldErrors(cause);
      const mapped: Record<string, string> = {};
      for (const [path, message] of Object.entries(fields)) mapped[path.split(".")[0] ?? path] = message;
      setErrors(mapped);
      if (Object.keys(fields).length === 0) toastManager.add({ title: "Could not register the app", description: errorText(cause, "Try again."), type: "error" });
    }
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup>
        <form onSubmit={(event) => void submit(event)} noValidate className="flex min-h-0 flex-col">
          <DialogHeader>
            <DialogTitle>Register your own app</DialogTitle>
            <DialogDescription>For software you or your developer built. It signs in with OAuth and can only ask for what you tick here.</DialogDescription>
          </DialogHeader>
          <DialogPanel className="flex flex-col gap-5">
            <Field invalid={Boolean(errors.name)}>
              <FieldLabel>Name</FieldLabel>
              <Input size="lg" autoComplete="off" placeholder="Our CRM sync" {...register("name")} />
              {errors.name ? <FieldError match>{errors.name}</FieldError> : <FieldDescription>Shown to people when they approve it.</FieldDescription>}
            </Field>
            <Field invalid={Boolean(errors.redirectUris)}>
              <FieldLabel>Redirect addresses</FieldLabel>
              <Textarea rows={3} autoComplete="off" spellCheck={false} placeholder="https://app.example.com/callback" {...register("redirects")} />
              {errors.redirectUris ? <FieldError match>{errors.redirectUris}</FieldError> : <FieldDescription>One per line. The sign-in only ever returns to these.</FieldDescription>}
            </Field>
            <fieldset className="flex flex-col gap-2">
              <legend className="font-medium text-base/4.5 sm:text-sm/4">What it may ask for</legend>
              <Controller control={control} name="scopes" render={({ field }) => (
                <ul className="flex w-full flex-col divide-y rounded-lg border">
                  {apiScopes.map((scope) => (
                    <li key={scope}>
                      <Label className="flex min-h-11 items-start gap-3 px-3 py-2.5">
                        <Checkbox className="mt-0.5" checked={field.value.includes(scope)} onCheckedChange={(checked) => field.onChange(checked ? [...field.value, scope] : field.value.filter((item) => item !== scope))} />
                        <span className="flex flex-col gap-0.5"><span className="font-medium">{apiScopeLabels[scope].label}</span><span className="text-muted-foreground text-xs">{apiScopeLabels[scope].description}</span></span>
                      </Label>
                    </li>
                  ))}
                </ul>
              )} />
              {errors.scopes ? <p role="alert" className="text-destructive-foreground text-xs">{errors.scopes}</p> : null}
            </fieldset>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="ghost" size="lg" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" size="lg" disabled={create.isPending}>{create.isPending ? <Spinner aria-hidden="true" /> : null}{create.isPending ? "Registering…" : "Register app"}</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** Apps the owner registered for their own software. */
export function ClientsPanel({ isOwner }: { isOwner: boolean }) {
  const query = useClients(true);
  const revoke = useRevokeClient();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ client: OAuthClientView; secret: string } | null>(null);
  const [removing, setRemoving] = useState<OAuthClientView | null>(null);

  if (query.isPending) return <Skeleton role="status" aria-label="Loading your apps" className="h-24 w-full" />;
  if (query.isError) {
    return <Alert variant="error"><AlertTitle>Your apps could not be loaded</AlertTitle><AlertDescription><p>{errorText(query.error, "Try again.")}</p>
      <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void query.refetch()}><RefreshCw aria-hidden="true" /> Retry</Button></AlertDescription></Alert>;
  }
  const clients = query.data.clients.filter((client) => !client.revokedAt);
  const add = <Button type="button" size="lg" disabled={!isOwner} onClick={() => setCreating(true)}><Plus aria-hidden="true" /> Register app</Button>;
  async function confirm() {
    if (!removing) return;
    try { await revoke.mutateAsync(removing.id); toastManager.add({ title: "App removed", description: "Everything it was connected to stopped working.", type: "success" }); }
    catch (cause: unknown) { toastManager.add({ title: "Could not remove the app", description: errorText(cause, "Try again."), type: "error" }); }
    finally { setRemoving(null); }
  }
  return (
    <div className="flex flex-col gap-4">
      {!isOwner ? <Alert role="note"><AlertDescription>Only the owner can register an app.</AlertDescription></Alert> : null}
      {clients.length === 0 ? (
        <Empty>
          <EmptyHeader><EmptyMedia variant="icon"><Plus aria-hidden="true" /></EmptyMedia><EmptyTitle>No apps of your own</EmptyTitle>
            <EmptyDescription>Register one when your developer builds software that should sign in with Kalendr instead of using a key.</EmptyDescription></EmptyHeader>
          <EmptyContent>{add}</EmptyContent>
        </Empty>
      ) : (
        <Frame>
          <FrameHeader className="flex-row items-start justify-between gap-3"><div className="min-w-0"><FrameTitle>Your apps</FrameTitle><FrameDescription>Each has an id and a secret. The secret is shown once.</FrameDescription></div>{add}</FrameHeader>
          <FramePanel>
            <ul aria-label="Your apps" className="flex flex-col divide-y">
              {clients.map((client) => (
                <li key={client.id} className="flex items-start justify-between gap-3 py-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="truncate font-medium">{client.name}</span>
                    <code className="w-fit max-w-full truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{client.id}</code>
                    <span className="text-muted-foreground text-xs">Secret {client.secretPrefix}… · {client.scopes.length} {client.scopes.length === 1 ? "permission" : "permissions"} · added {formatDay(client.createdAt)}</span>
                  </div>
                  {isOwner ? (
                    <RichMenu>
                      <RichMenuTrigger render={<Button type="button" variant="ghost" size="icon-lg" aria-label={`More for ${client.name}`} />}><Ellipsis aria-hidden="true" /></RichMenuTrigger>
                      <RichMenuContent><RichMenuItem destructive icon={<Trash2 aria-hidden="true" />} onClick={() => setRemoving(client)}>Remove app</RichMenuItem></RichMenuContent>
                    </RichMenu>
                  ) : null}
                </li>
              ))}
            </ul>
          </FramePanel>
        </Frame>
      )}
      <RegisterDialog open={creating} onOpenChange={setCreating} onCreated={(result) => { setCreating(false); setCreated(result); }} />
      <SecretRevealDialog open={created !== null} title="Copy your app's secret" description={created ? `${created.client.name} is registered. Its client id is ${created.client.id}.` : ""} label="Client secret" secret={created?.secret ?? ""} onDone={() => setCreated(null)} />
      <AlertDialog open={removing !== null} onOpenChange={(open) => { if (!open) setRemoving(null); }}>
        <AlertDialogPopup>
          <AlertDialogHeader><AlertDialogTitle>Remove {removing?.name}?</AlertDialogTitle>
            <AlertDialogDescription>Every person’s sign-in through it ends at once and it cannot ask again. This cannot be undone.</AlertDialogDescription></AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button type="button" variant="ghost" size="lg" />}>Keep app</AlertDialogClose>
            <Button type="button" variant="destructive" size="lg" disabled={revoke.isPending} onClick={() => void confirm()}>Remove app</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
