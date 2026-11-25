"use client";

import { Ellipsis, KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";

import { RichMenu, RichMenuContent, RichMenuItem, RichMenuTrigger } from "@/components/rich-menu";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertDialog, AlertDialogClose, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogPopup, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Frame, FrameDescription, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Skeleton } from "@/components/ui/skeleton";
import { toastManager } from "@/components/ui/toast";
import { apiScopeLabels } from "@/lib/api-scopes";
import type { ApiKeyView, CreatedApiKey } from "@/server/api-keys-contracts";

import { useApiKeys, useRevokeApiKey } from "./api";
import { CreateKeyDialog } from "./key-dialog";
import { errorText, formatDay, formatStamp, SecretRevealDialog } from "./shared";

type KeyState = "active" | "expired" | "revoked";

function stateOf(key: ApiKeyView, now: number): KeyState {
  if (key.revokedAt) return "revoked";
  if (key.expiresAt && Date.parse(key.expiresAt) <= now) return "expired";
  return "active";
}

function StateBadge({ state }: { state: KeyState }) {
  if (state === "active") return <Badge variant="success" size="lg">Active</Badge>;
  if (state === "expired") return <Badge variant="warning" size="lg">Expired</Badge>;
  return <Badge variant="secondary" size="lg">Revoked</Badge>;
}

function ScopeBadges({ scopes }: { scopes: ApiKeyView["scopes"] }) {
  const shown = scopes.slice(0, 2);
  const rest = scopes.length - shown.length;
  return (
    <span className="flex flex-wrap gap-1" aria-label={`Allowed: ${scopes.map((scope) => apiScopeLabels[scope].label).join(", ")}`}>
      {shown.map((scope) => <Badge key={scope} variant="outline">{apiScopeLabels[scope].label}</Badge>)}
      {rest > 0 ? <Badge variant="outline">+{rest} more</Badge> : null}
    </span>
  );
}

function KeyRow({ apiKey, now, canManage, onRevoke }: { apiKey: ApiKeyView; now: number; canManage: boolean; onRevoke: (key: ApiKeyView) => void }) {
  const state = stateOf(apiKey, now);
  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <span className="truncate font-medium">{apiKey.name}</span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-foreground">{apiKey.prefix}…</code>
            <span>{apiKey.mode === "test" ? "Test key" : "Live key"}</span>
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StateBadge state={state} />
          {canManage && state !== "revoked" ? (
            <RichMenu>
              <RichMenuTrigger render={<Button type="button" variant="ghost" size="icon-lg" aria-label={`More for ${apiKey.name}`} />}><Ellipsis aria-hidden="true" /></RichMenuTrigger>
              <RichMenuContent>
                <RichMenuItem destructive icon={<Trash2 aria-hidden="true" />} onClick={() => onRevoke(apiKey)}>Revoke key</RichMenuItem>
              </RichMenuContent>
            </RichMenu>
          ) : null}
        </div>
      </div>
      <ScopeBadges scopes={apiKey.scopes} />
      <dl className="flex flex-wrap gap-x-6 gap-y-0.5 text-muted-foreground text-xs">
        <div className="flex gap-1"><dt>Last used</dt><dd className="text-foreground">{apiKey.lastUsedAt ? formatStamp(apiKey.lastUsedAt) : "Never"}</dd></div>
        <div className="flex gap-1"><dt>{state === "expired" ? "Expired" : "Expires"}</dt><dd className="text-foreground">{apiKey.expiresAt ? formatDay(apiKey.expiresAt) : "Never"}</dd></div>
        {apiKey.revokedAt ? <div className="flex gap-1"><dt>Revoked</dt><dd className="text-foreground">{formatDay(apiKey.revokedAt)}</dd></div> : null}
      </dl>
    </li>
  );
}

/** Developers > API keys. Only the owner can create one; the server checks that again. */
export function KeysTab({ isOwner }: { isOwner: boolean }) {
  const query = useApiKeys(true);
  const revoke = useRevokeApiKey();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [revoking, setRevoking] = useState<ApiKeyView | null>(null);
  const [now] = useState(() => Date.now());

  const createButton = (
    <Button type="button" size="lg" disabled={!isOwner} onClick={() => setCreating(true)}><Plus aria-hidden="true" /> Create key</Button>
  );
  const ownerNote = !isOwner ? (
    <Alert role="note"><AlertDescription>Only the owner can create an API key. You can still see the keys that exist and revoke one that should stop working.</AlertDescription></Alert>
  ) : null;

  if (query.isPending) return <div role="status" aria-label="Loading API keys" className="flex flex-col gap-3"><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div>;
  if (query.isError) {
    return (
      <Alert variant="error">
        <AlertTitle>API keys could not be loaded</AlertTitle>
        <AlertDescription>
          <p>{errorText(query.error, "Check your connection and try again.")}</p>
          <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => void query.refetch()}><RefreshCw aria-hidden="true" /> Retry</Button>
        </AlertDescription>
      </Alert>
    );
  }

  const keys = query.data.keys;
  const active = keys.filter((key) => stateOf(key, now) === "active");
  const inactive = keys.filter((key) => stateOf(key, now) !== "active");

  async function confirmRevoke() {
    if (!revoking) return;
    const target = revoking;
    try {
      await revoke.mutateAsync(target.id);
      toastManager.add({ title: "Key revoked", description: "It stopped working straight away.", type: "success" });
    } catch (cause: unknown) {
      toastManager.add({ title: "Could not revoke the key", description: errorText(cause, "Try again."), type: "error" });
    } finally {
      setRevoking(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      {ownerNote}
      {keys.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><KeyRound aria-hidden="true" /></EmptyMedia>
            <EmptyTitle>No API keys yet</EmptyTitle>
            <EmptyDescription>Make a key when you want your website or another tool to read services and free times, or to book for you.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>{createButton}</EmptyContent>
        </Empty>
      ) : (
        <Frame>
          <FrameHeader className="flex-row items-start justify-between gap-3">
            <div className="min-w-0">
              <FrameTitle>API keys</FrameTitle>
              <FrameDescription>{active.length} active. A key is shown only when you make it.</FrameDescription>
            </div>
            {createButton}
          </FrameHeader>
          <FramePanel>
            <ul aria-label="API keys" className="flex flex-col divide-y">
              {active.map((key) => <KeyRow key={key.id} apiKey={key} now={now} canManage onRevoke={setRevoking} />)}
            </ul>
            {active.length === 0 ? <p className="py-2 text-muted-foreground text-sm">No active keys. Revoked and expired keys are listed below.</p> : null}
          </FramePanel>
          {inactive.length ? (
            <FramePanel>
              <h3 className="pb-1 font-medium text-muted-foreground text-xs">Revoked and expired</h3>
              <ul aria-label="Revoked and expired API keys" className="flex flex-col divide-y">
                {inactive.map((key) => <KeyRow key={key.id} apiKey={key} now={now} canManage={false} onRevoke={setRevoking} />)}
              </ul>
            </FramePanel>
          ) : null}
        </Frame>
      )}

      <CreateKeyDialog open={creating} onOpenChange={setCreating} onCreated={(result) => { setCreating(false); setCreated(result); }} />
      <SecretRevealDialog
        open={created !== null}
        title="Copy your new key"
        description={created ? `${created.key.name} is ready to use.` : ""}
        label="API key"
        secret={created?.secret ?? ""}
        onDone={() => setCreated(null)}
      />
      <AlertDialog open={revoking !== null} onOpenChange={(open) => { if (!open) setRevoking(null); }}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this key?</AlertDialogTitle>
            <AlertDialogDescription>{revoking ? `${revoking.name} (${revoking.prefix}…) will stop working at once. Anything using it will be refused. This cannot be undone.` : ""}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button type="button" variant="ghost" size="lg" />}>Keep key</AlertDialogClose>
            <Button type="button" variant="destructive" size="lg" disabled={revoke.isPending} onClick={() => void confirmRevoke()}>Revoke key</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
