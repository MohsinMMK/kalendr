"use client";

import { useCallback, useMemo } from "react";
import {
  CalendarDays,
  CircleHelp,
  ClipboardList,
  ExternalLink,
  FolderHeart,
  History,
  LayoutDashboard,
  Dumbbell,
  ListTodo,
  Megaphone,
  MessagesSquare,
  Receipt,
  Settings,
  ShieldAlert,
  Split,
  Star,
  Stethoscope,
  Ticket,
  UserRound,
  UsersRound,
  ChartColumn,
  type LucideIcon,
  ListChecks,
} from "lucide-react";

import { useFeatures, useTerms } from "@/features/terms/business-profile-context";
import {
  readSidebarSettings,
  resolveSidebar,
  sidebarPageId,
  writeSidebarSettings,
  type ResolvedSidebar,
  type SidebarEntry,
  type SidebarEntryId,
  type SidebarSection,
  type SidebarSettings,
} from "@/lib/sidebar";
import { canOpenPage, type StaffPageId } from "@/lib/page-access";

import { usePageLayout } from "./workspace-layout-provider";
import { useStaffAccess } from "./staff-access";

/** What an entry does when chosen, which the sidebar's names and order do not decide. */
interface EntryAction {
  icon: LucideIcon;
  /** A page address. Entries without one open a panel (Settings, Help) or the business's own page. */
  href?: string;
}

export const entryActions: Record<SidebarEntryId, EntryAction> = {
  dashboard: { icon: LayoutDashboard, href: "/dashboard" },
  schedule: { icon: CalendarDays, href: "/schedule" },
  bookings: { icon: ClipboardList, href: "/bookings" },
  patients: { icon: UsersRound, href: "/patients" },
  "follow-ups": { icon: ListTodo, href: "/follow-ups" },
  classes: { icon: Dumbbell, href: "/classes" },
  messages: { icon: MessagesSquare, href: "/messages" },
  reviews: { icon: Star, href: "/reviews" },
  spam: { icon: ShieldAlert, href: "/spam" },
  records: { icon: FolderHeart, href: "/records" },
  billing: { icon: Receipt, href: "/billing" },
  campaigns: { icon: Megaphone, href: "/campaigns" },
  "routing-forms": { icon: Split, href: "/routing-forms" },
  offers: { icon: Ticket, href: "/offers" },
  reports: { icon: ChartColumn, href: "/reports" },
  activity: { icon: History, href: "/activity" },
  services: { icon: ListChecks, href: "/services" },
  doctors: { icon: Stethoscope, href: "/doctors" },
  settings: { icon: Settings },
  "your-page": { icon: ExternalLink },
  help: { icon: CircleHelp },
  profile: { icon: UserRound, href: "/profile" },
};

/** The sidebar as this business arranged it, in its words, with the editing functions for owners and admins. */
export function useSidebarSettings() {
  const { layout, canEdit, update } = usePageLayout(sidebarPageId);
  const t = useTerms();
  const settings = useMemo(() => readSidebarSettings(layout), [layout]);
  const resolved = useMemo(() => resolveSidebar(t, settings), [t, settings]);
  const save = useCallback((next: SidebarSettings) => update(writeSidebarSettings(next, t)), [t, update]);
  return { settings, resolved, canEdit, save };
}

/** Every entry's name, as the business sees it. Used by page titles, breadcrumbs, the palette, the tour and Help. */
export function useNavLabels(): ResolvedSidebar["labels"] {
  return useSidebarSettings().resolved.labels;
}

export function useNavLabel(id: SidebarEntryId): string {
  return useNavLabels()[id];
}

export interface NavItem extends SidebarEntry {
  icon: LucideIcon;
  href?: string;
}

export interface NavSection extends Omit<SidebarSection, "entries"> {
  entries: NavItem[];
}

/**
 * Whether this person has this entry at all: they may open its page, and its feature is on for this business. Hiding an
 * entry is a separate, presentation-only choice.
 */
export function useEntryAvailable(): (id: SidebarEntryId) => boolean {
  const access = useStaffAccess();
  const features = useFeatures();
  return useMemo(() => {
    // Which pages a person may open comes from one table shared with the server's page guards (`src/lib/page-access.ts`).
    // The lines below only add what is not about permission: the business's features, and the practitioner's own view.
    const open = (page: StaffPageId) => canOpenPage(access.permissions, page);
    const allowed: Partial<Record<SidebarEntryId, boolean>> = {
      bookings: open("bookings"),
      // Follow-ups are the front desk's call list; a practitioner's own visits are on their Schedule and Bookings.
      "follow-ups": features.recalls && access.role !== "practitioner" && open("follow-ups"),
      messages: open("messages"),
      records: open("records") && features.records,
      billing: open("billing"),
      campaigns: open("campaigns"),
      "routing-forms": open("routing-forms"),
      services: open("services"),
      // Classes and offers are run by the front desk. A practitioner who teaches a class can still open /classes, where
      // the server shows only the sessions they teach.
      classes: access.role !== "practitioner" && open("classes"),
      offers: open("offers") && access.role !== "practitioner",
      reports: open("reports"),
      reviews: open("reviews"),
      spam: open("spam"),
      activity: open("activity"),
      settings: open("settings"),
    };
    return (id) => allowed[id] !== false;
  }, [access, features.recalls, features.records]);
}

/**
 * The sidebar sections to draw: hidden entries are left out, and so are entries this person has no access to. Hiding is
 * presentation only, so an address typed by hand still goes to the page, and the server decides whether it opens.
 */
export function useNavSections(): NavSection[] {
  const { resolved } = useSidebarSettings();
  const available = useEntryAvailable();
  return useMemo(() => resolved.sections.map((section) => ({
    ...section,
    entries: section.entries
      .filter((entry) => !entry.hidden && available(entry.id))
      .map((entry) => ({ ...entry, ...entryActions[entry.id] })),
  })), [resolved, available]);
}
