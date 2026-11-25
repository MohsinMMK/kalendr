"use client";

import { useCallback, useEffect, useState } from "react";

const VISITS_KEY = "kalendr.visits";
const DISMISSED_KEY = "kalendr.install-dismissed";
/** The install offer waits until someone has come back a few times. */
export const VISITS_BEFORE_PROMPT = 3;
const DISMISS_DAYS = 30;

/** The event Chromium fires when the app can be installed. Not in the DOM types. */
interface InstallEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function readNumber(key: string): number {
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

function write(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private windows: the offer simply never reaches the visit count.
  }
}

/** Counts one visit per browser session, so reloading or opening a second tab does not count again. */
export function countVisit(): number {
  try {
    if (window.sessionStorage.getItem(VISITS_KEY)) return readNumber(VISITS_KEY);
    window.sessionStorage.setItem(VISITS_KEY, "1");
  } catch {
    return readNumber(VISITS_KEY);
  }
  const visits = readNumber(VISITS_KEY) + 1;
  write(VISITS_KEY, String(visits));
  return visits;
}

export function shouldOfferInstall(visits: number, dismissedAt: number, now = Date.now()): boolean {
  if (visits < VISITS_BEFORE_PROMPT) return false;
  return !dismissedAt || now - dismissedAt > DISMISS_DAYS * 24 * 60 * 60 * 1000;
}

/** `canInstall` turns true once the browser says the app can be installed, if the person has been back a few times. */
export function useInstallPrompt(): { canInstall: boolean; install: () => Promise<void>; dismiss: () => void } {
  const [event, setEvent] = useState<InstallEvent | null>(null);

  useEffect(() => {
    const eligible = shouldOfferInstall(countVisit(), readNumber(DISMISSED_KEY));
    const onPrompt = (raw: Event) => {
      // Hold the browser's own offer back; it stays in the browser's menu either way.
      raw.preventDefault();
      if (eligible) setEvent(raw as InstallEvent);
    };
    const onInstalled = () => setEvent(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const dismiss = useCallback(() => {
    write(DISMISSED_KEY, String(Date.now()));
    setEvent(null);
  }, []);
  const install = useCallback(async () => {
    if (!event) return;
    await event.prompt();
    const choice = await event.userChoice;
    if (choice.outcome === "dismissed") write(DISMISSED_KEY, String(Date.now()));
    setEvent(null);
  }, [event]);

  return { canInstall: event !== null, install, dismiss };
}
