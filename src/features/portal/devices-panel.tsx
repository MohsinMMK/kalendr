"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { EllipsisVertical, LogOut, MonitorSmartphone, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Frame, FrameDescription, FrameHeader, FramePanel } from "@/components/ui/frame";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";

import { portalAuth, portalDevices, type PortalDevice } from "../records/records-client";

const previewDevice: PortalDevice = {
  id: "preview",
  label: "This browser (preview)",
  createdAt: new Date(0).toISOString(),
  expiresAt: new Date(0).toISOString(),
  remember: false,
  current: true,
};

function signedInOn(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time) || time <= 0) return "Signed in today";
  return `Signed in ${new Date(time).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}`;
}

/** Where this person is signed in, with a way to end any of those sessions. */
export function DevicesPanel({ preview = false }: { preview?: boolean }) {
  const router = useRouter();
  const [devices, setDevices] = useState<PortalDevice[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [confirmCurrent, setConfirmCurrent] = useState(false);

  const load = useCallback(async () => {
    setLoadError("");
    if (preview) {
      setDevices([previewDevice]);
      return;
    }
    try {
      setDevices(await portalDevices.list());
    } catch (cause: unknown) {
      setLoadError(cause instanceof Error ? cause.message : "Your devices could not be loaded.");
    }
  }, [preview]);

  useEffect(() => {
    // Reading the signed-in devices is the external synchronization this effect performs.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  function leave() {
    router.replace("/portal/sign-in");
    router.refresh();
  }

  async function signOutDevice(device: PortalDevice) {
    setBusy(device.id);
    setActionError("");
    setMessage("");
    try {
      if (preview) {
        portalAuth.previewSignOut();
        leave();
        return;
      }
      await portalDevices.signOut(device.id);
      if (device.current) {
        leave();
        return;
      }
      setDevices((current) => (current ?? []).filter((item) => item.id !== device.id));
      setMessage(`Signed out ${device.label}.`);
    } catch (cause: unknown) {
      setActionError(cause instanceof Error ? cause.message : "That device could not be signed out.");
    } finally {
      setBusy("");
      setConfirmCurrent(false);
    }
  }

  async function signOutOthers() {
    setBusy("others");
    setActionError("");
    setMessage("");
    try {
      const result = await portalDevices.signOutOthers();
      const count = typeof result?.signedOut === "number" ? result.signedOut : 0;
      setDevices((current) => (current ?? []).filter((item) => item.current));
      setMessage(count === 1 ? "Signed out 1 other device." : `Signed out ${count} other devices.`);
    } catch (cause: unknown) {
      setActionError(cause instanceof Error ? cause.message : "Other devices could not be signed out.");
    } finally {
      setBusy("");
    }
  }

  const current = devices?.find((device) => device.current);
  const others = (devices ?? []).filter((device) => !device.current);

  return (
    <Frame>
      <FrameHeader className="flex-row flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-heading text-base font-semibold">Devices</h2>
          <FrameDescription>Places where you are signed in right now.</FrameDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={preview || devices === null || others.length === 0 || busy !== ""}
          loading={busy === "others"}
          onClick={() => void signOutOthers()}
        >
          Sign out everywhere else
        </Button>
      </FrameHeader>
      <FramePanel className="flex flex-col gap-3">
        {message ? <Alert variant="success" role="status"><AlertDescription>{message}</AlertDescription></Alert> : null}
        {actionError ? <Alert variant="error" role="alert"><TriangleAlert aria-hidden="true" /><AlertDescription>{actionError}</AlertDescription></Alert> : null}

        {devices === null && !loadError ? (
          <div aria-busy="true" className="flex flex-col gap-2">
            <span className="sr-only" role="status">Loading your devices</span>
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : null}

        {loadError ? (
          <Alert variant="error" role="alert">
            <TriangleAlert aria-hidden="true" />
            <AlertDescription>
              <span>{loadError}</span>
              <Button variant="outline" size="sm" className="w-fit" onClick={() => void load()}>Try again</Button>
            </AlertDescription>
          </Alert>
        ) : null}

        {devices !== null && devices.length === 0 ? (
          <Empty className="py-8">
            <EmptyHeader>
              <EmptyMedia variant="icon"><MonitorSmartphone aria-hidden="true" /></EmptyMedia>
              <EmptyTitle className="text-base font-semibold">No devices to show</EmptyTitle>
              <EmptyDescription>Sign-ins appear here once they are listed.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}

        {devices !== null && devices.length > 0 ? (
          <ul className="flex flex-col gap-2" aria-label="Signed-in devices">
            {devices.map((device) => (
              <li key={device.id} className="flex items-center justify-between gap-3 rounded-xl border p-3">
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="min-w-0 break-words text-sm font-medium">{device.label}</span>
                    {device.current ? <Badge variant="success">This device</Badge> : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {signedInOn(device.createdAt)}
                    {" · "}
                    {device.remember ? "Remembered for 30 days" : "Signed out automatically after a day"}
                  </p>
                </div>
                <Menu>
                  <MenuTrigger render={<Button variant="ghost" size="icon" aria-label={`Actions for ${device.label}`} disabled={busy !== ""} />}>
                    <EllipsisVertical aria-hidden="true" />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    <MenuItem onClick={() => (device.current ? setConfirmCurrent(true) : void signOutDevice(device))}>
                      <LogOut aria-hidden="true" /> Sign out
                    </MenuItem>
                  </MenuPopup>
                </Menu>
              </li>
            ))}
          </ul>
        ) : null}
      </FramePanel>

      <AlertDialog open={confirmCurrent} onOpenChange={(open) => { if (!open && busy === "") setConfirmCurrent(false); }}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out of this device?</AlertDialogTitle>
            <AlertDialogDescription>You will need a new code to sign in again here.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="ghost" onClick={() => setConfirmCurrent(false)} disabled={busy !== ""}>Stay signed in</Button>
            <Button variant="destructive" loading={busy !== ""} onClick={() => current && void signOutDevice(current)}>Sign out</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </Frame>
  );
}
