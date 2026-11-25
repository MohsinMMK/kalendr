"use client";

import { useCallback, useEffect, useState } from "react";

import { registerServiceWorker } from "./service-worker";

/**
 * `unsupported`: this browser cannot do push. `unavailable`: the server has no push keys. `blocked`: the person
 * said no in the browser. `off` and `on` are the two states the button toggles between.
 */
export type PushState = "checking" | "unsupported" | "unavailable" | "blocked" | "off" | "on";

export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** The browser wants the key as bytes, not as the URL-safe text the server holds. */
export function keyToBytes(key: string): Uint8Array<ArrayBuffer> {
  const padded = key.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(key.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

function publicKeyOf(body: unknown): string | null {
  if (typeof body === "object" && body !== null && "data" in body) {
    const data = (body as { data: unknown }).data;
    if (typeof data === "object" && data !== null && "publicKey" in data && typeof data.publicKey === "string") return data.publicKey;
  }
  return null;
}

/**
 * Push on this device, for staff (`/api/staff/push/subscribe`) or a customer (`/api/portal/push/subscribe`).
 * Nothing is asked of the person until `enable` runs, and `enable` is only ever called from a button press.
 */
export function usePush(endpoint: string): { state: PushState; error: string; enable: () => Promise<void>; disable: () => Promise<void> } {
  const [state, setState] = useState<PushState>("checking");
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function check() {
      if (!pushSupported()) return setState("unsupported");
      if (Notification.permission === "denied") return setState("blocked");
      const registration = await registerServiceWorker();
      const existing = registration ? await navigator.serviceWorker.ready.then((ready) => ready.pushManager.getSubscription()).catch(() => null) : null;
      if (cancelled) return;
      if (existing && Notification.permission === "granted") {
        // Saying so again keeps the saved copy pointing at whoever is signed in on this device now.
        const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(existing.toJSON()) }).catch(() => null);
        if (!cancelled) setState(response?.ok ? "on" : "off");
        return;
      }
      const keyResponse = await fetch(endpoint, { cache: "no-store" }).catch(() => null);
      const key = keyResponse?.ok ? publicKeyOf(await readJson(keyResponse)) : null;
      if (!cancelled) setState(key ? "off" : "unavailable");
    }
    void check();
    return () => { cancelled = true; };
  }, [endpoint]);

  const enable = useCallback(async () => {
    setError("");
    try {
      const keyResponse = await fetch(endpoint, { cache: "no-store" });
      const key = publicKeyOf(await readJson(keyResponse));
      if (!key) {
        setState("unavailable");
        return;
      }
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "blocked" : "off");
        return;
      }
      const registration = await navigator.serviceWorker.ready;
      const subscription = (await registration.pushManager.getSubscription())
        ?? (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(key) }));
      const saved = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(subscription.toJSON()) });
      if (!saved.ok) throw new Error("save");
      setState("on");
    } catch {
      setError("Alerts could not be turned on. Check your connection and try again.");
    }
  }, [endpoint]);

  const disable = useCallback(async () => {
    setError("");
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await fetch(endpoint, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: subscription.endpoint }) });
        await subscription.unsubscribe();
      }
      setState("off");
    } catch {
      setError("Alerts could not be turned off. Try again.");
    }
  }, [endpoint]);

  return { state, error, enable, disable };
}

/** Before signing out: forget this device on the server, so the next person to sign in here does not get your alerts. */
export async function releasePushForSignOut(endpoint: string): Promise<void> {
  try {
    if (!pushSupported()) return;
    const registration = await navigator.serviceWorker.getRegistration("/");
    const subscription = await registration?.pushManager.getSubscription();
    if (!subscription) return;
    await fetch(endpoint, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: subscription.endpoint }) });
  } catch {
    // Signing out must never wait on this.
  }
}
