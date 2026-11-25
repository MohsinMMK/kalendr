import { z } from "zod";

import { fieldSetSchema } from "./visit-fields";

/**
 * How one business arranges its staff workspace. Each page keeps:
 * - `lists`: ordered, hideable things such as overview tiles, columns and header actions.
 * - `options`: small view settings such as the default view.
 * Only what differs from the page's defaults needs to be stored; unknown ids are ignored on read.
 */

const idSchema = z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/i);

const listLayoutSchema = z.object({
  order: z.array(idSchema).max(64).optional(),
  hidden: z.array(idSchema).max(64).optional(),
  // A bad name or width drops only itself, never the whole layout.
  /** Names the business gave to built-in items (a table's columns). Only what differs from the default is stored. */
  labels: z.record(idSchema, z.string().trim().min(1).max(40)).optional().catch(undefined),
  /** Widths in pixels the business dragged a table's columns to. */
  widths: z.record(idSchema, z.number().int().min(48).max(800)).optional().catch(undefined),
});

const pageLayoutSchema = z.object({
  lists: z.record(idSchema, listLayoutSchema).optional(),
  options: z.record(idSchema, z.union([z.string().max(64), z.boolean(), z.number().finite()])).optional(),
});

export const workspaceLayoutSchema = z.object({
  pages: z.record(idSchema, pageLayoutSchema).default({}),
  /** Property sets, such as the properties on a visit: names, icons, order and the business's own. */
  fields: z.record(idSchema, fieldSetSchema).optional(),
});

export type ListLayout = z.infer<typeof listLayoutSchema>;
export type PageLayout = z.infer<typeof pageLayoutSchema>;
export type WorkspaceLayout = z.infer<typeof workspaceLayoutSchema>;
export type LayoutOption = string | boolean | number;

export const emptyWorkspaceLayout: WorkspaceLayout = { pages: {} };

/** The pages that can be arranged, in sidebar order. */
export const workspacePages = [
  "today",
  "schedule",
  "patients",
  "bookings",
  "follow-ups",
  "messages",
  "records",
  "practitioners",
  "profile",
  "help",
  "sidebar",
] as const;
export type WorkspacePage = (typeof workspacePages)[number];

/** Reads a stored layout, dropping anything malformed instead of failing the page. */
export function parseWorkspaceLayout(value: unknown): WorkspaceLayout {
  const parsed = workspaceLayoutSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : emptyWorkspaceLayout;
}

/** Applies a stored order and visibility to a page's items. New items keep their default place. */
export function arrangeList<T extends { id: string }>(
  items: readonly T[],
  layout: ListLayout | undefined,
): { item: T; hidden: boolean }[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const hidden = new Set(layout?.hidden ?? []);
  const ordered: T[] = [];
  for (const id of layout?.order ?? []) {
    const item = byId.get(id);
    if (item && !ordered.includes(item)) ordered.push(item);
  }
  // Items the stored order does not know yet go back where they sit by default.
  items.forEach((item, index) => {
    if (ordered.includes(item)) return;
    const before = items.slice(0, index).reverse().find((other) => ordered.includes(other));
    const at = before ? ordered.indexOf(before) + 1 : 0;
    ordered.splice(at, 0, item);
  });
  return ordered.map((item) => ({ item, hidden: hidden.has(item.id) }));
}

/** Where a business's saved service order lives: the profile page's "services" list. */
export const serviceOrderPage = "profile";
export const serviceOrderList = "services";

/** The saved order of a business's services, for the staff editor and the public booking page alike. */
export function serviceOrder(layout: WorkspaceLayout | undefined): ListLayout | undefined {
  return layout?.pages[serviceOrderPage]?.lists?.[serviceOrderList];
}

/** Services in the order the business dragged them into. Services it has not placed keep their place. */
export function orderServices<T extends { id: string }>(services: readonly T[], layout: WorkspaceLayout | undefined): T[] {
  return arrangeList(services, serviceOrder(layout)).map((entry) => entry.item);
}

/** Only the visible items, in the stored order. */
export function visibleList<T extends { id: string }>(items: readonly T[], layout: ListLayout | undefined): T[] {
  return arrangeList(items, layout).filter((entry) => !entry.hidden).map((entry) => entry.item);
}

export function withListLayout(page: PageLayout, list: string, next: ListLayout): PageLayout {
  return { ...page, lists: { ...page.lists, [list]: next } };
}

export function withOption(page: PageLayout, option: string, value: LayoutOption | undefined): PageLayout {
  const options = { ...page.options };
  if (value === undefined) delete options[option];
  else options[option] = value;
  return { ...page, options };
}

/** Moves one item one place, within the full arranged list. */
export function moveInList(ids: string[], id: string, direction: -1 | 1): string[] {
  const index = ids.indexOf(id);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= ids.length) return ids;
  const next = [...ids];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
