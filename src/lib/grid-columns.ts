/**
 * One column model for every staff table (Customers, Bookings, Records), Notion style: a column can be renamed, hidden and shown
 * again, moved, and resized, and the business's own fields join as columns of their own. What a business changed lives in the
 * "columns" list of the page's layout (`tenants.layout`); only what differs from the defaults is stored, and ids the table no
 * longer has are ignored on read and dropped on write. Pure functions, so every table behaves the same and one test covers them all.
 */
import type { ListLayout } from "./workspace-layout";

/** The id of the list that holds a table's columns inside its page layout. */
export const columnsList = "columns";

export const MIN_COLUMN_WIDTH = 64;
export const MAX_COLUMN_WIDTH = 640;
export const MAX_COLUMN_NAME = 40;

export interface GridColumnSpec {
  id: string;
  /** The default name, in the business's own words. */
  label: string;
  /** A field the system needs (name, phone, email): it can be renamed and hidden but never deleted. */
  system?: boolean;
  /** One of the business's own fields: its name, kind and values live with the field, not in the layout. */
  custom?: boolean;
  /** Hidden until the business shows it, like the extra Bookings columns. */
  defaultHidden?: boolean;
}

export interface GridColumn extends GridColumnSpec {
  /** The name shown: the business's rename, else the default. */
  title: string;
  renamed: boolean;
  hidden: boolean;
  /** Dragged width in pixels, when the business set one. */
  width?: number;
}

const cleanName = (value: string) => value.trim().replace(/\s+/g, " ").slice(0, MAX_COLUMN_NAME);

function hiddenIds(specs: readonly GridColumnSpec[], layout: ListLayout | undefined): Set<string> {
  // Until the business hides or shows something the defaults apply; after that the stored list is the whole truth.
  if (layout?.hidden === undefined) return new Set(specs.filter((spec) => spec.defaultHidden).map((spec) => spec.id));
  return new Set(layout.hidden);
}

/** Every column in the order the business chose, hidden ones included. New columns keep their default place. */
export function resolveColumns(specs: readonly GridColumnSpec[], layout: ListLayout | undefined): GridColumn[] {
  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  const ordered: GridColumnSpec[] = [];
  for (const id of layout?.order ?? []) {
    const spec = byId.get(id);
    if (spec && !ordered.includes(spec)) ordered.push(spec);
  }
  specs.forEach((spec, index) => {
    if (ordered.includes(spec)) return;
    const before = specs.slice(0, index).reverse().find((other) => ordered.includes(other));
    ordered.splice(before ? ordered.indexOf(before) + 1 : 0, 0, spec);
  });
  const hidden = hiddenIds(specs, layout);
  return ordered.map((spec) => {
    const rename = spec.custom ? undefined : layout?.labels?.[spec.id];
    return { ...spec, title: rename || spec.label, renamed: Boolean(rename) && rename !== spec.label, hidden: hidden.has(spec.id), width: layout?.widths?.[spec.id] };
  });
}

export const visibleColumns = (columns: readonly GridColumn[]): GridColumn[] => columns.filter((column) => !column.hidden);

/** The layout after a change, cleaned: only known ids, and nothing stored that equals the default. */
function tidy(specs: readonly GridColumnSpec[], order: readonly string[], hidden: ReadonlySet<string>, extra: Pick<ListLayout, "labels" | "widths">): ListLayout | undefined {
  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  const labels = Object.fromEntries(Object.entries(extra.labels ?? {}).filter(([id, name]) => {
    const spec = byId.get(id);
    return spec && !spec.custom && name !== spec.label;
  }));
  const widths = Object.fromEntries(Object.entries(extra.widths ?? {}).filter(([id]) => byId.has(id)));
  const defaultOrder = specs.map((spec) => spec.id);
  const sameOrder = order.length === defaultOrder.length && order.every((id, index) => id === defaultOrder[index]);
  const defaultHidden = specs.filter((spec) => spec.defaultHidden).map((spec) => spec.id);
  const sameHidden = hidden.size === defaultHidden.length && defaultHidden.every((id) => hidden.has(id));
  const next: ListLayout = {
    ...(sameOrder ? {} : { order: [...order] }),
    // A stored hidden list is authoritative, so an empty one is kept whenever the defaults hide something.
    ...(sameHidden ? {} : { hidden: specs.filter((spec) => hidden.has(spec.id)).map((spec) => spec.id) }),
    ...(Object.keys(labels).length ? { labels } : {}),
    ...(Object.keys(widths).length ? { widths } : {}),
  };
  return Object.keys(next).length ? next : undefined;
}

function change(specs: readonly GridColumnSpec[], layout: ListLayout | undefined, apply: (state: { order: string[]; hidden: Set<string>; labels: Record<string, string>; widths: Record<string, number> }) => void): ListLayout | undefined {
  const columns = resolveColumns(specs, layout);
  const state = {
    order: columns.map((column) => column.id),
    hidden: new Set(columns.filter((column) => column.hidden).map((column) => column.id)),
    labels: { ...layout?.labels },
    widths: { ...layout?.widths },
  };
  apply(state);
  return tidy(specs, state.order, state.hidden, state);
}

/** Gives a built-in column a name of the business's own. An empty name, or the default one, takes the override away. A custom field is renamed on the field itself. */
export function renameColumn(specs: readonly GridColumnSpec[], layout: ListLayout | undefined, id: string, name: string): ListLayout | undefined {
  const spec = specs.find((item) => item.id === id);
  if (!spec || spec.custom) return layout;
  return change(specs, layout, (state) => {
    const clean = cleanName(name);
    if (!clean || clean === spec.label) delete state.labels[id];
    else state.labels[id] = clean;
  });
}

/** Hides a column. The last visible column stays, so a table never shows nothing. */
export function hideColumn(specs: readonly GridColumnSpec[], layout: ListLayout | undefined, id: string): ListLayout | undefined {
  if (!specs.some((spec) => spec.id === id)) return layout;
  return change(specs, layout, (state) => {
    const shown = state.order.filter((item) => !state.hidden.has(item));
    if (shown.length <= 1 && shown.includes(id)) return;
    state.hidden.add(id);
  });
}

export function showColumn(specs: readonly GridColumnSpec[], layout: ListLayout | undefined, id: string): ListLayout | undefined {
  if (!specs.some((spec) => spec.id === id)) return layout;
  return change(specs, layout, (state) => { state.hidden.delete(id); });
}

/** Moves a column one place among the columns that are showing; hidden ones keep their own places. */
export function moveColumn(specs: readonly GridColumnSpec[], layout: ListLayout | undefined, id: string, direction: -1 | 1): ListLayout | undefined {
  return change(specs, layout, (state) => {
    const shown = state.order.filter((item) => !state.hidden.has(item));
    const neighbour = shown[shown.indexOf(id) + direction];
    if (!shown.includes(id) || !neighbour) return;
    const rest = state.order.filter((item) => item !== id);
    const at = rest.indexOf(neighbour);
    rest.splice(direction === -1 ? at : at + 1, 0, id);
    state.order = rest;
  });
}

/** Drops a column where another one sits (dragging a header onto a neighbour): before it when moving left, after it when moving right. */
export function moveColumnTo(specs: readonly GridColumnSpec[], layout: ListLayout | undefined, id: string, targetId: string): ListLayout | undefined {
  if (id === targetId) return layout;
  return change(specs, layout, (state) => {
    const from = state.order.indexOf(id);
    const to = state.order.indexOf(targetId);
    if (from < 0 || to < 0) return;
    state.order.splice(from, 1);
    state.order.splice(to, 0, id);
  });
}

/** Remembers a dragged width, kept within what a column can sensibly be. */
export function resizeColumn(specs: readonly GridColumnSpec[], layout: ListLayout | undefined, id: string, width: number): ListLayout | undefined {
  if (!specs.some((spec) => spec.id === id) || !Number.isFinite(width)) return layout;
  return change(specs, layout, (state) => { state.widths[id] = Math.round(Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, width))); });
}

/** Brings back the default names, order, visibility and widths. */
export function resetColumns(): undefined {
  return undefined;
}

/** Whether the business changed anything from the defaults. */
export function columnsChanged(layout: ListLayout | undefined): boolean {
  return Boolean(layout && (layout.order?.length || layout.hidden !== undefined || Object.keys(layout.labels ?? {}).length || Object.keys(layout.widths ?? {}).length));
}
