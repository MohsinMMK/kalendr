import type { GridColumn } from "@/lib/grid-columns";

import type { GridColumns } from "./use-grid-columns";

/** A saved view's column ids that still exist, once each, in the view's order. Empty means the view keeps the business's columns. */
export function cleanViewColumns(ids: readonly string[] | null | undefined, known: readonly string[]): string[] {
  if (!ids?.length) return [];
  return [...new Set(ids.filter((id) => known.includes(id)))];
}

function arrange(all: readonly GridColumn[], ids: readonly string[]): GridColumn[] {
  const byId = new Map(all.map((column) => [column.id, column]));
  const shown = ids.flatMap((id) => {
    const column = byId.get(id);
    return column ? [{ ...column, hidden: false }] : [];
  });
  const rest = all.filter((column) => !ids.includes(column.id)).map((column) => ({ ...column, hidden: true }));
  return [...shown, ...rest];
}

/**
 * The table's columns while a saved view is applied: the view's own columns, in its order, with the business's names and
 * widths. Showing, hiding and moving change only what this view shows on this screen (the address holds it); renaming and
 * widths still change the business's columns. "Reset columns" goes back to the business's arrangement.
 */
export function withViewColumns(grid: GridColumns, ids: readonly string[], setIds: (next: string[] | null) => void): GridColumns {
  if (ids.length === 0) return grid;
  const all = arrange(grid.all, ids);
  const visible = all.filter((column) => !column.hidden);
  const order = visible.map((column) => column.id);
  const moveTo = (id: string, targetId: string) => {
    const from = order.indexOf(id);
    const to = order.indexOf(targetId);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...order];
    next.splice(from, 1);
    next.splice(to, 0, id);
    setIds(next);
  };
  return {
    ...grid,
    all,
    visible,
    personal: true,
    changed: true,
    hide: (id) => { if (order.length > 1) setIds(order.filter((item) => item !== id)); },
    show: (id) => { if (!order.includes(id)) setIds([...order, id]); },
    move: (id, direction) => {
      const at = order.indexOf(id);
      const target = order[at + direction];
      if (at >= 0 && target) moveTo(id, target);
    },
    moveTo,
    reset: () => setIds(null),
    canMove: (id, direction) => {
      const at = order.indexOf(id);
      return at >= 0 && at + direction >= 0 && at + direction < order.length;
    },
  };
}
