"use client";

import { useCallback, useMemo } from "react";

import {
  columnsChanged, columnsList, hideColumn, moveColumn, moveColumnTo, renameColumn, resetColumns, resizeColumn, resolveColumns, showColumn,
  visibleColumns, type GridColumn, type GridColumnSpec,
} from "@/lib/grid-columns";
import type { ListLayout, WorkspacePage } from "@/lib/workspace-layout";

import type { GridCustomize } from "@/components/reui/data-grid/data-grid-customize";

import { usePageLayout } from "./workspace-layout-provider";

/** The column menu's actions for a table, wired to its columns. A table adds its own rename (for fields), filter and field actions. */
export function customizeFor(columns: GridColumns, extras: Partial<GridCustomize> & Pick<GridCustomize, "isSystem">): GridCustomize {
  return {
    canEdit: columns.canEdit,
    canMove: columns.canMove,
    rename: columns.rename,
    hide: columns.hide,
    move: columns.move,
    moveTo: columns.moveTo,
    ...extras,
  };
}

export interface GridColumns {
  /** Every column in the business's order, hidden ones included. */
  all: GridColumn[];
  visible: GridColumn[];
  /** Owners and admins arrange columns for everyone; the others see the same arrangement. */
  canEdit: boolean;
  /** A saved view's columns are on screen: anyone may show, hide or reset them, since only this screen changes. */
  personal?: boolean;
  changed: boolean;
  rename: (id: string, name: string) => void;
  hide: (id: string) => void;
  show: (id: string) => void;
  move: (id: string, direction: -1 | 1) => void;
  moveTo: (id: string, targetId: string) => void;
  resize: (id: string, width: number) => void;
  reset: () => void;
  canMove: (id: string, direction: -1 | 1) => boolean;
}

/**
 * One table's columns as the business arranged them (saved with the workspace layout, so everyone on the team sees the same).
 * `specs` must be stable between renders. Pass `ready: false` while the table's own fields are still loading: arranging then
 * would drop the order of columns that have not arrived yet.
 */
export function useGridColumns(page: WorkspacePage, specs: readonly GridColumnSpec[], ready = true): GridColumns {
  const { layout, canEdit, update } = usePageLayout(page);
  const stored = layout.lists?.[columnsList];
  const all = useMemo(() => resolveColumns(specs, stored), [specs, stored]);
  const visible = useMemo(() => visibleColumns(all), [all]);
  const editable = canEdit && ready;

  const apply = useCallback((next: ListLayout | undefined) => {
    if (!editable || JSON.stringify(next) === JSON.stringify(stored)) return;
    const lists = { ...layout.lists };
    if (next) lists[columnsList] = next;
    else delete lists[columnsList];
    update({ ...layout, lists });
  }, [editable, layout, stored, update]);

  return useMemo<GridColumns>(() => ({
    all,
    visible,
    canEdit: editable,
    changed: columnsChanged(stored),
    rename: (id, name) => apply(renameColumn(specs, stored, id, name)),
    hide: (id) => apply(hideColumn(specs, stored, id)),
    show: (id) => apply(showColumn(specs, stored, id)),
    move: (id, direction) => apply(moveColumn(specs, stored, id, direction)),
    moveTo: (id, targetId) => apply(moveColumnTo(specs, stored, id, targetId)),
    resize: (id, width) => apply(resizeColumn(specs, stored, id, width)),
    reset: () => apply(resetColumns()),
    canMove: (id, direction) => {
      const at = visible.findIndex((column) => column.id === id);
      return at >= 0 && at + direction >= 0 && at + direction < visible.length;
    },
  }), [all, apply, editable, specs, stored, visible]);
}
