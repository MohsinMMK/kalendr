"use client";

import { useEffect } from "react";

import { InstallBanner } from "./install-banner";
import { registerServiceWorker, setServiceWorkerScope } from "./service-worker";

/**
 * Registers the service worker and tells it who is signed in (so it never shows one person's saved schedule to
 * another), then offers to install the app after a few visits.
 */
export function AppSupport({ scope, appName, offerInstall = true }: { scope: string; appName: string; offerInstall?: boolean }) {
  useEffect(() => {
    void registerServiceWorker().then(() => navigator.serviceWorker?.ready).then(() => setServiceWorkerScope(scope));
    // A worker that takes control later (first install) still needs to hear it.
    const onController = () => setServiceWorkerScope(scope);
    navigator.serviceWorker?.addEventListener("controllerchange", onController);
    return () => navigator.serviceWorker?.removeEventListener("controllerchange", onController);
  }, [scope]);
  return offerInstall ? <InstallBanner appName={appName} /> : null;
}
