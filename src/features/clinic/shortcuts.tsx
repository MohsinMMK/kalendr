"use client";

import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/kbd";
import { useTerms } from "@/features/terms/business-profile-context";

import { type ShortcutId, shortcutList, useHotkeys } from "./hotkeys";

type Handlers = Partial<Record<ShortcutId, () => void>>;

interface ShortcutRegistry {
  /** A page claims some shortcuts while it is on screen. Returns the way to let go. */
  register: (handlers: Handlers) => () => void;
  openHelp: () => void;
}

const ShortcutContext = createContext<ShortcutRegistry | null>(null);

/**
 * A page that knows better than the frame what a key should do (the schedule steps its own date) claims
 * those keys while it is open. Anything it does not claim keeps the frame's default.
 */
export function usePageShortcuts(handlers: Handlers) {
  const registry = useContext(ShortcutContext);
  const latest = useRef(handlers);
  useEffect(() => { latest.current = handlers; });
  const keys = Object.keys(handlers).sort().join(",");
  useEffect(() => {
    if (!registry) return;
    const wrapped: Handlers = {};
    for (const key of keys.split(",").filter(Boolean) as ShortcutId[]) wrapped[key] = () => latest.current[key]?.();
    return registry.register(wrapped);
  }, [registry, keys]);
}

export function useShortcutHelp(): (() => void) | null {
  return useContext(ShortcutContext)?.openHelp ?? null;
}

/** Wires the daily-action keys for every staff screen and shows the "?" sheet. */
export function ShortcutsProvider({ children, onSearch }: { children: ReactNode; onSearch: () => void }) {
  const router = useRouter();
  const [helpOpen, setHelpOpen] = useState(false);
  const claimed = useRef<Handlers[]>([]);

  const register = useCallback((handlers: Handlers) => {
    claimed.current = [...claimed.current, handlers];
    return () => { claimed.current = claimed.current.filter((item) => item !== handlers); };
  }, []);
  const openHelp = useCallback(() => setHelpOpen(true), []);

  const run = useCallback((id: ShortcutId, fallback: () => void) => () => {
    const page = [...claimed.current].reverse().find((handlers) => handlers[id]);
    (page?.[id] ?? fallback)();
  }, []);

  useHotkeys({
    new: run("new", () => router.push("/appointments/new")),
    today: run("today", () => router.push("/dashboard")),
    previous: run("previous", () => undefined),
    next: run("next", () => undefined),
    search: run("search", onSearch),
    help: openHelp,
  }, { ignoreInside: "[data-clinic-calendar]" });

  const value = useMemo(() => ({ register, openHelp }), [register, openHelp]);
  return <ShortcutContext.Provider value={value}>
    {children}
    <ShortcutsDialog open={helpOpen} onOpenChange={setHelpOpen} />
  </ShortcutContext.Provider>;
}

function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useTerms();
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogPopup>
      <DialogHeader>
        <DialogTitle>Keyboard shortcuts</DialogTitle>
        <DialogDescription>They work anywhere except while you are typing in a box.</DialogDescription>
      </DialogHeader>
      <DialogPanel>
        <dl className="flex flex-col divide-y text-sm">
          {shortcutList.map((item) => <div key={item.id} className="flex items-center justify-between gap-4 py-2.5">
            <dt>{item.label.replace("appointment", t.appointment)}</dt>
            <dd className="flex gap-1">{item.keys.map((key) => <Kbd key={key}>{key}</Kbd>)}</dd>
          </div>)}
          <div className="flex items-center justify-between gap-4 py-2.5">
            <dt>Search {t.customers} and actions</dt>
            <dd className="flex gap-1"><Kbd>Ctrl</Kbd><Kbd>K</Kbd></dd>
          </div>
        </dl>
      </DialogPanel>
      <DialogFooter><DialogClose render={<Button variant="outline" />}>Close</DialogClose></DialogFooter>
    </DialogPopup>
  </Dialog>;
}
