/**
 * Opening Settings at "Plan and billing" from anywhere (the upgrade dialog, the banners). The settings dialog lives in
 * the staff frame, so this is a tiny request channel: callers ask, the frame opens Settings, the workspace picks the section.
 */
const eventName = "kalendr:open-billing";
/** When the section was last asked for. A request stays valid for a few seconds, so a Settings that mounts after a page change still sees it. */
let requestedAt = 0;
const validForMs = 4000;

export function requestBillingSection(): void {
  if (typeof window === "undefined") return;
  requestedAt = Date.now();
  window.dispatchEvent(new Event(eventName));
}

/** True while a request is fresh: the workspace asks when it mounts or hears the event. */
export function takeBillingRequest(): boolean {
  return Date.now() - requestedAt < validForMs;
}

export function onBillingRequest(listener: () => void): () => void {
  window.addEventListener(eventName, listener);
  return () => window.removeEventListener(eventName, listener);
}
