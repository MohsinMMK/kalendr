/** The browser side of public/sw.js: register it, tell it who is signed in, and wipe what it kept. */

const SW_PATH = "/sw.js";

export function serviceWorkerSupported(): boolean {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator;
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!serviceWorkerSupported()) return null;
  try {
    return await navigator.serviceWorker.register(SW_PATH, { scope: "/", updateViaCache: "none" });
  } catch {
    return null;
  }
}

function postToWorker(message: { type: "clear" } | { type: "scope"; scope: string }): void {
  if (!serviceWorkerSupported()) return;
  navigator.serviceWorker.controller?.postMessage(message);
}

/** Tells the worker whose schedule it may keep. A different person than last time makes it drop the old one. */
export function setServiceWorkerScope(scope: string): void {
  postToWorker({ type: "scope", scope });
}

/**
 * Removes everything the app kept on this device for the signed-in person: the worker's private cache, and
 * (in case the worker is not in control yet) the caches themselves. Safe to call anywhere; never throws.
 */
export async function clearOfflineData(): Promise<void> {
  postToWorker({ type: "clear" });
  try {
    if (typeof caches === "undefined") return;
    for (const name of await caches.keys()) {
      if (name.startsWith("kalendr-private-") || name.startsWith("kalendr-meta-")) await caches.delete(name);
    }
  } catch {
    // Private windows and blocked storage have nothing to clear.
  }
}
