import { useSyncExternalStore } from "react";
import { vi } from "vitest";

/**
 * A stand-in for next/navigation in unit tests of the Settings page: the section lives in the address, so replace() and
 * push() change window.location and the page re-renders as it would under the app router.
 */
const listeners = new Set<() => void>();
const go = (href: string) => {
  window.history.replaceState({}, "", href);
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); };

export const settingsRouterMock = {
  useRouter: () => ({ push: vi.fn(go), replace: vi.fn(go), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(useSyncExternalStore(subscribe, () => window.location.search, () => "")),
  usePathname: () => useSyncExternalStore(subscribe, () => window.location.pathname, () => "/settings"),
};
