import { maxTermLength, type TermWords } from "@/lib/terminology";
import type { ListLayout, PageLayout } from "@/lib/workspace-layout";

/**
 * The staff sidebar as one source. Every place that names a page reads it: the sidebar itself, the phone bar, the
 * breadcrumb, page titles, the command palette, the product tour and Help.
 *
 * What a business changes is stored on its workspace layout, under the page id `sidebar`, and only the differences from
 * the defaults are kept:
 * - `lists.entries`: the order of the entries and the ones hidden.
 * - `options["name-<id>"]` renames one entry, and `options["heading-<section>"]` renames a section heading.
 *
 * Hiding is presentation only. Who may open a page is still decided by permissions on the server.
 */

export const sidebarPageId = "sidebar";
export const sidebarEntriesList = "entries";

export const sidebarSectionIds = ["front-desk", "business"] as const;
export type SidebarSectionId = (typeof sidebarSectionIds)[number];

export const sidebarEntryIds = [
  "dashboard",
  "schedule",
  "bookings",
  "patients",
  "follow-ups",
  "classes",
  "messages",
  "records",
  "billing",
  "campaigns",
  "routing-forms",
  "offers",
  "reports",
  "reviews",
  "spam",
  "activity",
  "services",
  "doctors",
  "settings",
  "your-page",
  "help",
  "profile",
] as const;
export type SidebarEntryId = (typeof sidebarEntryIds)[number];

/** Where an entry lives. Account entries sit in the account menu, not in a sidebar section. */
type EntrySection = SidebarSectionId | "account";

interface EntryDefinition {
  section: EntrySection;
  /** Settings, My profile and Help are always there: they can be renamed but never hidden. */
  locked?: true;
  label: (t: TermWords) => string;
}

const entryDefinitions: Record<SidebarEntryId, EntryDefinition> = {
  dashboard: { section: "front-desk", label: () => "Today" },
  schedule: { section: "front-desk", label: () => "Schedule" },
  bookings: { section: "front-desk", label: () => "Bookings" },
  patients: { section: "front-desk", label: (t) => t.Customers },
  "follow-ups": { section: "front-desk", label: () => "Follow-ups" },
  classes: { section: "front-desk", label: () => "Classes" },
  messages: { section: "front-desk", label: () => "Messages" },

  records: { section: "business", label: () => "Records" },
  billing: { section: "business", label: () => "Billing" },
  campaigns: { section: "business", label: () => "Campaigns" },
  "routing-forms": { section: "business", label: () => "Routing forms" },
  offers: { section: "business", label: () => "Offers" },
  reports: { section: "business", label: () => "Reports" },
  reviews: { section: "business", label: () => "Reviews" },
  spam: { section: "business", label: () => "Spam" },
  activity: { section: "business", label: () => "Activity" },
  services: { section: "business", label: (t) => t.Services },
  doctors: { section: "business", label: (t) => t.Practitioners },
  settings: { section: "business", locked: true, label: () => "Settings" },
  "your-page": { section: "business", label: () => "Your page" },
  help: { section: "business", locked: true, label: () => "Help" },
  profile: { section: "account", locked: true, label: () => "My profile" },
};

const headingDefaults: Record<SidebarSectionId, (t: TermWords) => string> = {
  "front-desk": () => "Front desk",
  business: (t) => t.Business,
};

export function isSidebarEntryId(value: unknown): value is SidebarEntryId {
  return typeof value === "string" && Object.hasOwn(entryDefinitions, value);
}

export function isSidebarLocked(id: SidebarEntryId): boolean {
  return entryDefinitions[id].locked === true;
}

export function sidebarSectionOf(id: SidebarEntryId): EntrySection {
  return entryDefinitions[id].section;
}

/** The longest name an entry or heading can have. Same limit as the business's other words. */
export const maxSidebarNameLength = maxTermLength;

/** What a business has changed, cleaned. Unknown ids are dropped and a locked entry is never hidden. */
export interface SidebarSettings {
  /** The entries in the order the business chose. Entries it has not placed keep their default place. */
  order: SidebarEntryId[];
  hidden: SidebarEntryId[];
  names: Partial<Record<SidebarEntryId, string>>;
  headings: Partial<Record<SidebarSectionId, string>>;
}

export const defaultSidebarSettings: SidebarSettings = { order: [], hidden: [], names: {}, headings: {} };

/** A name to keep: one line, trimmed, within the limit. Anything else is no name, which puts the default back. */
export function cleanSidebarName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.replace(/[\s\p{Cc}]+/gu, " ").trim();
  return name && name.length <= maxSidebarNameLength ? name : null;
}

function uniqueEntries(ids: readonly unknown[] | undefined): SidebarEntryId[] {
  const seen = new Set<SidebarEntryId>();
  for (const id of ids ?? []) {
    if (isSidebarEntryId(id)) seen.add(id);
  }
  return [...seen];
}

/** Reads the stored `sidebar` page of a workspace layout. Anything malformed is ignored instead of failing the page. */
export function readSidebarSettings(page: PageLayout | undefined): SidebarSettings {
  const list = page?.lists?.[sidebarEntriesList];
  const names: SidebarSettings["names"] = {};
  const headings: SidebarSettings["headings"] = {};
  for (const id of sidebarEntryIds) {
    const name = cleanSidebarName(page?.options?.[`name-${id}`]);
    if (name) names[id] = name;
  }
  for (const id of sidebarSectionIds) {
    const name = cleanSidebarName(page?.options?.[`heading-${id}`]);
    if (name) headings[id] = name;
  }
  return {
    order: uniqueEntries(list?.order),
    hidden: uniqueEntries(list?.hidden).filter((id) => !isSidebarLocked(id)),
    names,
    headings,
  };
}

/** The `sidebar` page to store: only what differs from the defaults, so a later default change still reaches the business. */
export function writeSidebarSettings(settings: SidebarSettings, t: TermWords): PageLayout {
  const order = fullOrder(settings.order);
  const defaultOrder = fullOrder([]);
  const moved = order.some((id, index) => id !== defaultOrder[index]);
  const hidden = uniqueEntries(settings.hidden).filter((id) => !isSidebarLocked(id));
  const list: ListLayout = { ...(moved ? { order } : {}), ...(hidden.length > 0 ? { hidden } : {}) };
  const options: Record<string, string> = {};
  for (const id of sidebarEntryIds) {
    const name = cleanSidebarName(settings.names[id]);
    if (name && name !== entryDefinitions[id].label(t)) options[`name-${id}`] = name;
  }
  for (const id of sidebarSectionIds) {
    const name = cleanSidebarName(settings.headings[id]);
    if (name && name !== headingDefaults[id](t)) options[`heading-${id}`] = name;
  }
  return {
    ...(Object.keys(list).length > 0 ? { lists: { [sidebarEntriesList]: list } } : {}),
    ...(Object.keys(options).length > 0 ? { options } : {}),
  };
}

/** Every entry once, in the stored order, with entries the order does not know where they sit by default. */
function fullOrder(stored: readonly SidebarEntryId[]): SidebarEntryId[] {
  const ordered = stored.filter((id, index) => stored.indexOf(id) === index);
  sidebarEntryIds.forEach((id, index) => {
    if (ordered.includes(id)) return;
    const before = sidebarEntryIds.slice(0, index).reverse().find((other) => ordered.includes(other));
    ordered.splice(before ? ordered.indexOf(before) + 1 : 0, 0, id);
  });
  return ordered;
}

export interface SidebarEntry {
  id: SidebarEntryId;
  section: EntrySection;
  /** What the business sees: its own name, or the default in its words. */
  label: string;
  defaultLabel: string;
  renamed: boolean;
  hidden: boolean;
  locked: boolean;
}

export interface SidebarSection {
  id: SidebarSectionId;
  label: string;
  defaultLabel: string;
  renamed: boolean;
  /** In the business's order, hidden entries included. Filter on `hidden` to draw the sidebar. */
  entries: SidebarEntry[];
}

export interface ResolvedSidebar {
  sections: SidebarSection[];
  /** Every entry by id, including My profile. */
  entries: Record<SidebarEntryId, SidebarEntry>;
  /** Every entry's label by id: the names for titles, breadcrumbs, the palette, the tour and Help. */
  labels: Record<SidebarEntryId, string>;
}

/** Applies a business's settings to the defaults in its words. Pure; safe on the server and in the browser. */
export function resolveSidebar(t: TermWords, settings: SidebarSettings = defaultSidebarSettings): ResolvedSidebar {
  const hidden = new Set(settings.hidden);
  const entries = Object.fromEntries(sidebarEntryIds.map((id): [SidebarEntryId, SidebarEntry] => {
    const definition = entryDefinitions[id];
    const defaultLabel = definition.label(t);
    const own = settings.names[id];
    return [id, {
      id,
      section: definition.section,
      label: own ?? defaultLabel,
      defaultLabel,
      renamed: own !== undefined && own !== defaultLabel,
      hidden: !definition.locked && hidden.has(id),
      locked: definition.locked === true,
    }];
  })) as Record<SidebarEntryId, SidebarEntry>;
  const ordered = fullOrder(settings.order);
  const sections = sidebarSectionIds.map((id): SidebarSection => {
    const defaultLabel = headingDefaults[id](t);
    const own = settings.headings[id];
    return {
      id,
      label: own ?? defaultLabel,
      defaultLabel,
      renamed: own !== undefined && own !== defaultLabel,
      entries: ordered.map((entryId) => entries[entryId]).filter((entry) => entry.section === id),
    };
  });
  const labels = Object.fromEntries(sidebarEntryIds.map((id) => [id, entries[id].label])) as Record<SidebarEntryId, string>;
  return { sections, entries, labels };
}

/** Shorthand for the pages that only need names: the `sidebar` page of a layout, in a business's words. */
export function sidebarLabels(t: TermWords, page: PageLayout | undefined): Record<SidebarEntryId, string> {
  return resolveSidebar(t, readSidebarSettings(page)).labels;
}

/** Whether anything differs from the defaults, so "Reset" can be offered only when it would do something. */
export function isSidebarCustomised(settings: SidebarSettings): boolean {
  return settings.order.length > 0 || settings.hidden.length > 0 || Object.keys(settings.names).length > 0 || Object.keys(settings.headings).length > 0;
}

/** Puts the named entries of one section in a new order, leaving every other entry where it is. */
export function reorderSection(settings: SidebarSettings, section: SidebarSectionId, ids: readonly SidebarEntryId[]): SidebarSettings {
  const current = fullOrder(settings.order);
  // Only the entries named take part, so a screen that lists some of a section's entries (the ones this person can open)
  // leaves the others where they are.
  const named = ids.filter((id, index) => sidebarSectionOf(id) === section && ids.indexOf(id) === index);
  const taking = new Set(named);
  const queue = [...named];
  const next = current.map((id) => (taking.has(id) ? queue.shift() ?? id : id));
  return { ...settings, order: next };
}

export function renameEntry(settings: SidebarSettings, id: SidebarEntryId, name: string): SidebarSettings {
  const names = { ...settings.names };
  const clean = cleanSidebarName(name);
  if (clean) names[id] = clean;
  else delete names[id];
  return { ...settings, names };
}

export function renameHeading(settings: SidebarSettings, id: SidebarSectionId, name: string): SidebarSettings {
  const headings = { ...settings.headings };
  const clean = cleanSidebarName(name);
  if (clean) headings[id] = clean;
  else delete headings[id];
  return { ...settings, headings };
}

/** Shows or hides one entry. A locked entry stays shown. */
export function setEntryHidden(settings: SidebarSettings, id: SidebarEntryId, hide: boolean): SidebarSettings {
  if (isSidebarLocked(id)) return settings;
  const hidden = settings.hidden.filter((other) => other !== id);
  if (hide) hidden.push(id);
  return { ...settings, hidden };
}
