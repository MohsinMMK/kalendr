"use client";

import { KeyRound, RotateCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { StatusBadge } from "@/components/status-badge";
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
import { Button } from "@/components/ui/button";
import { Frame, FrameDescription, FrameFooter, FrameHeader, FramePanel, FrameTitle } from "@/components/ui/frame";
import { Skeleton } from "@/components/ui/skeleton";
import { toastManager } from "@/components/ui/toast";
import { useTerms } from "@/features/terms/business-profile-context";

import { staffMutation, staffQuery } from "./staff-snapshot-provider";

interface DataProtectionStatus {
  keyVersion: number;
  keyCreatedAt: string | null;
  itemsOnOlderKeys: number;
  filesWaitingForScan: number;
  scanning: "on" | "off" | "required";
  canRotate: boolean;
}

const path = "/api/staff/settings/data-protection";

function keyDate(value: string): string {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value));
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString("en-IN")} ${count === 1 ? one : many}`;
}

/**
 * Settings → Data protection: which key protects the business's records and files, whether
 * uploads are virus-checked, and "Replace key now" for the owner or an admin.
 */
export function DataProtectionSettings() {
  const t = useTerms();
  const [status, setStatus] = useState<DataProtectionStatus | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [confirming, setConfirming] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      setStatus(await staffQuery<DataProtectionStatus>(path, signal));
      setLoadState("ready");
    } catch {
      if (!signal?.aborted) setLoadState("error");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => void load(controller.signal));
    return () => controller.abort();
  }, [load]);

  // While older data is being moved or files are being checked, refresh the counts.
  const busy = Boolean(status && (status.itemsOnOlderKeys > 0 || status.filesWaitingForScan > 0));
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(timer);
  }, [busy, load]);

  async function rotate() {
    if (!status) return;
    setRotating(true);
    setMessage("");
    try {
      const result = await staffMutation<{ keyVersion: number }>(path, "POST", { keyVersion: status.keyVersion }, {
        idempotencyKey: crypto.randomUUID(),
      });
      setConfirming(false);
      toastManager.add({
        title: `Key ${result.keyVersion} is now in use`,
        description: "Older records are moved to it in the background. Everything stays readable meanwhile.",
        type: "success",
      });
      await load();
    } catch (cause: unknown) {
      setMessage(cause instanceof Error ? cause.message : "The key could not be replaced.");
      setConfirming(false);
    } finally {
      setRotating(false);
    }
  }

  if (loadState === "loading") {
    return (
      <Frame>
        <FramePanel className="flex flex-col gap-3">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </FramePanel>
      </Frame>
    );
  }

  if (loadState === "error" || !status) {
    return (
      <Alert variant="error">
        <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
          Data protection could not be loaded.
          <Button variant="outline" size="sm" onClick={() => { setLoadState("loading"); void load(); }}>
            <RotateCw aria-hidden="true" />
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {message ? (
        <Alert variant="error">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
      <Frame>
        <FrameHeader>
          <FrameTitle className="flex items-center gap-2">
            <KeyRound aria-hidden="true" className="size-4" />
            Encryption key
          </FrameTitle>
          <FrameDescription>
            {t.Customer} records, form answers, files and pictures are encrypted with a key that belongs to this {t.business}{" "}
            alone. It is replaced every year; you can also replace it now.
          </FrameDescription>
        </FrameHeader>
        <FramePanel className="flex flex-col gap-3">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-1">
              <dt className="text-muted-foreground text-xs">Key in use</dt>
              <dd className="font-medium">
                {status.keyVersion > 0 ? `Key ${status.keyVersion}` : "Made with the first record"}
                {status.keyCreatedAt ? <span className="text-muted-foreground font-normal"> · since {keyDate(status.keyCreatedAt)}</span> : null}
              </dd>
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <dt className="text-muted-foreground text-xs">Older data</dt>
              <dd>
                {status.itemsOnOlderKeys > 0 ? (
                  <StatusBadge tone="attention">{plural(status.itemsOnOlderKeys, "item", "items")} still moving</StatusBadge>
                ) : (
                  <StatusBadge tone="success">All on the current key</StatusBadge>
                )}
              </dd>
            </div>
          </dl>
        </FramePanel>
        {status.canRotate ? (
          <FrameFooter className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-muted-foreground text-xs">Nothing becomes unreadable: older keys keep opening older data until it is moved.</p>
            <Button variant="outline" onClick={() => setConfirming(true)}>
              <KeyRound aria-hidden="true" />
              Replace key now
            </Button>
          </FrameFooter>
        ) : null}
      </Frame>

      <Frame>
        <FrameHeader>
          <FrameTitle className="flex items-center gap-2">
            <ShieldCheck aria-hidden="true" className="size-4" />
            File checks
          </FrameTitle>
          <FrameDescription>
            Every file and picture is checked for viruses before anyone can open or share it. A file that fails is removed.
          </FrameDescription>
        </FrameHeader>
        <FramePanel className="flex flex-wrap items-center gap-2 text-sm">
          {status.scanning === "on" ? <StatusBadge tone="success">Virus checks on</StatusBadge> : null}
          {status.scanning === "off" ? <StatusBadge tone="neutral">Not checked on this server</StatusBadge> : null}
          {status.scanning === "required" ? <StatusBadge tone="danger">Uploads paused until checks are set up</StatusBadge> : null}
          {status.filesWaitingForScan > 0 ? (
            <span className="text-muted-foreground">{plural(status.filesWaitingForScan, "file", "files")} being checked</span>
          ) : null}
        </FramePanel>
      </Frame>

      <AlertDialog open={confirming} onOpenChange={(open) => { if (!rotating) setConfirming(open); }}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace the encryption key?</AlertDialogTitle>
            <AlertDialogDescription>
              New records and files use the new key straight away. Older ones are moved to it in the background over the
              next few minutes, and stay readable the whole time. Do this if you think the key may have been exposed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" disabled={rotating} />}>Keep current key</AlertDialogClose>
            <Button loading={rotating} onClick={() => void rotate()}>Replace key</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
