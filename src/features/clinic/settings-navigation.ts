/**
 * Opening Settings at a named section from anywhere in the staff frame (the setup checklist, the go-live check). Same idea as
 * the billing request channel: callers ask, and the frame goes to the Settings page at that section.
 */
import type { SettingsSection } from "./settings-sections";

const eventName = "kalendr:open-settings-section";
let requested: { section: SettingsSection; at: number } | null = null;
const validForMs = 4000;

export function requestSettingsSection(section: SettingsSection): void {
  if (typeof window === "undefined") return;
  requested = { section, at: Date.now() };
  window.dispatchEvent(new Event(eventName));
}

/** Open the Settings page. */
export function requestSettings(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(eventName));
}

/** The section asked for, while the request is fresh. Taking it clears it, so a later plain request opens Settings where it was. */
export function takeSettingsRequest(): SettingsSection | null {
  const fresh = requested && Date.now() - requested.at < validForMs ? requested.section : null;
  requested = null;
  return fresh;
}

export function onSettingsRequest(listener: () => void): () => void {
  window.addEventListener(eventName, listener);
  return () => window.removeEventListener(eventName, listener);
}

const customizeSidebarEvent = "kalendr:customize-sidebar";

/** Opens the "Customize sidebar" panel. A section heading's ⋯ asks; the staff frame shows the panel. */
export function requestCustomizeSidebar(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(customizeSidebarEvent));
}

export function onCustomizeSidebarRequest(listener: () => void): () => void {
  window.addEventListener(customizeSidebarEvent, listener);
  return () => window.removeEventListener(customizeSidebarEvent, listener);
}
