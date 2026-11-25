"use client";

import { Download, X } from "lucide-react";

import { Button } from "@/components/ui/button";

import { useInstallPrompt } from "./install-prompt";

/** Offers to add the app to the home screen, after a few visits. One tap to install, one to say not now. */
export function InstallBanner({ appName }: { appName: string }) {
  const { canInstall, install, dismiss } = useInstallPrompt();
  if (!canInstall) return null;
  return (
    <div
      role="region"
      aria-label={`Install ${appName}`}
      className="fixed inset-x-4 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] z-40 flex items-center gap-3 rounded-xl border bg-popover p-3 text-popover-foreground shadow-lg/10 sm:inset-x-auto sm:bottom-4 sm:end-4 sm:max-w-sm"
    >
      <Download aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 text-sm">Add {appName} to your home screen. It opens faster and shows the last schedule even with no signal.</p>
      <Button size="sm" onClick={() => void install()}>Install</Button>
      <Button size="icon-sm" variant="ghost" aria-label="Not now" onClick={dismiss}><X aria-hidden="true" /></Button>
    </div>
  );
}
