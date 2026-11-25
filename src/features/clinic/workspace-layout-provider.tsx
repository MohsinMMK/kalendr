"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";

import { toastManager } from "@/components/ui/toast";
import {
  emptyWorkspaceLayout,
  parseWorkspaceLayout,
  type PageLayout,
  type WorkspaceLayout,
  type WorkspacePage,
} from "@/lib/workspace-layout";
import type { FieldSet } from "@/lib/visit-fields";

const previewStorageKey = "kalendr.workspace-layout";

function parseStored(raw: string): WorkspaceLayout {
  try {
    return parseWorkspaceLayout(JSON.parse(raw));
  } catch {
    return emptyWorkspaceLayout;
  }
}

const noSubscribe = () => () => {};
function readPreviewLayout(): string | null {
  try {
    return window.localStorage.getItem(previewStorageKey);
  } catch {
    // Storage can be blocked; the default layout still works.
    return null;
  }
}

interface WorkspaceLayoutValue {
  layout: WorkspaceLayout;
  /** Owners and admins arrange the workspace for the whole team. */
  canEdit: boolean;
  setPage: (page: WorkspacePage, next: PageLayout) => void;
  /** Saves how one set of properties is named, iconed, ordered and extended. */
  setFields: (set: string, next: FieldSet) => void;
}

const WorkspaceLayoutContext = createContext<WorkspaceLayoutValue>({
  layout: emptyWorkspaceLayout,
  canEdit: false,
  setPage: () => {},
  setFields: () => {},
});

/**
 * Shares the business's workspace layout with every page. Changes show at once and save after a short pause:
 * to the business in the database, or to this browser in preview mode.
 */
export function WorkspaceLayoutProvider({ initial, preview, canEdit, children }: {
  initial: WorkspaceLayout;
  preview: boolean;
  canEdit: boolean;
  children: ReactNode;
}) {
  // Preview mode keeps the layout in this browser; it is read after hydration so the server render still matches.
  const stored = useSyncExternalStore(noSubscribe, () => (preview ? readPreviewLayout() : null), () => null);
  const base = useMemo(() => (stored ? parseStored(stored) : initial), [stored, initial]);
  const [edited, setEdited] = useState<WorkspaceLayout | null>(null);
  const layout = edited ?? base;
  const saved = useRef<WorkspaceLayout | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persist = useCallback((next: WorkspaceLayout) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      if (preview) {
        try { window.localStorage.setItem(previewStorageKey, JSON.stringify(next)); } catch { /* ignore */ }
        saved.current = next;
        return;
      }
      try {
        const response = await fetch("/api/staff/workspace-layout", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(next),
        });
        if (!response.ok) throw new Error("save failed");
        saved.current = next;
      } catch {
        setEdited(saved.current);
        toastManager.add({ title: "The layout could not be saved", description: "Your last change was undone.", type: "error" });
      }
    }, 400);
  }, [preview]);

  const setPage = useCallback((page: WorkspacePage, next: PageLayout) => {
    if (!canEdit) return;
    if (!saved.current) saved.current = layout;
    const updated = { ...layout, pages: { ...layout.pages, [page]: next } };
    setEdited(updated);
    persist(updated);
  }, [canEdit, layout, persist]);

  const setFields = useCallback((set: string, next: FieldSet) => {
    if (!canEdit) return;
    if (!saved.current) saved.current = layout;
    const updated = { ...layout, fields: { ...layout.fields, [set]: next } };
    setEdited(updated);
    persist(updated);
  }, [canEdit, layout, persist]);

  const value = useMemo(() => ({ layout, canEdit, setPage, setFields }), [layout, canEdit, setPage, setFields]);
  return <WorkspaceLayoutContext.Provider value={value}>{children}</WorkspaceLayoutContext.Provider>;
}

/** One page's layout, and a setter that saves it for the business. */
export function usePageLayout(page: WorkspacePage) {
  const { layout, canEdit, setPage } = useContext(WorkspaceLayoutContext);
  const pageLayout = layout.pages[page] ?? {};
  const update = useCallback((next: PageLayout) => setPage(page, next), [page, setPage]);
  return { layout: pageLayout, canEdit, update };
}

/** One set of properties as the business arranged it, and a setter that saves it. */
export function useFieldSet(set: string) {
  const { layout, canEdit, setFields } = useContext(WorkspaceLayoutContext);
  const fieldSet = layout.fields?.[set] ?? emptyFieldSet;
  const update = useCallback((next: FieldSet) => setFields(set, next), [set, setFields]);
  return { fieldSet, canEdit, update };
}
const emptyFieldSet: FieldSet = {};

export function useWorkspaceLayout() {
  return useContext(WorkspaceLayoutContext);
}
