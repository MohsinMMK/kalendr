"use client";

import { Banknote, Bot, BellRing, Blocks, Building2, CalendarDays, ClipboardList, Code2, CreditCard, FileUp, Gauge, Globe, Globe2, Layers, Link2, ListChecks, MessageSquareText, Network, Palette, PanelLeft, Search, ShieldCheck, ShieldUser } from "lucide-react";

import { useTerms } from "@/features/terms/business-profile-context";
import type { Permission } from "@/lib/permissions";
import type { TermWords } from "@/lib/terminology";

import { useStaffAccess } from "./staff-access";

/**
 * The Settings sections and their groups. Kept apart from the panels themselves, so the staff frame's settings sidebar and
 * breadcrumb can name the sections without loading every settings panel.
 */
export type SettingsSection = "business" | "sidebar" | "patient" | "guide" | "forms" | "hours" | "limits" | "brand" | "domain" | "messaging" | "reminders" | "workflows" | "website" | "security" | "privacy" | "payments" | "import" | "developers" | "cancelreasons" | "billing" | "templates" | "organisation" | "assistant" | "apps" | "discovery";

/**
 * Settings is for setting the business up; work that comes back every day (reviews, spam, the activity log, who can sign
 * in) lives on its own pages in the sidebar. The sections fall into four groups of about six, each answering one question.
 */
type SettingsGroupId = "business" | "booking" | "messages" | "account";

const settingsGroups = (t: TermWords): { id: SettingsGroupId; title: string; sections: SettingsSection[] }[] => [
  // What the business is: its name and words, its look, when it opens, what it offers.
  { id: "business", title: `Your ${t.business}`, sections: ["business", "brand", "hours", "cancelreasons", "templates", "limits"] },
  // How customers find it, book and pay.
  { id: "booking", title: "Booking and payments", sections: ["patient", "forms", "guide", "payments", "discovery", "domain", "website"] },
  // What is sent to customers, and the software it talks to.
  { id: "messages", title: "Messages and connections", sections: ["workflows", "messaging", "assistant", "apps", "developers", "import", "reminders"] },
  // The account itself: plan, organisation, how the app looks for the team, and keeping data safe.
  { id: "account", title: "Account and security", sections: ["billing", "organisation", "sidebar", "security", "privacy"] },
];

export interface SettingsItem {
  id: SettingsSection;
  title: string;
  description: string;
  icon: typeof Globe;
  /** Who may open this section. The server checks again on every save. */
  permission: Permission;
  /** Only the owner sees it (billing). */
  ownerOnly?: boolean;
}

export const clinicItems = (t: TermWords): SettingsItem[] => [
  { id: "business", title: "Business profile", description: "Business type, words and features", icon: Building2, permission: "settings.manage" },
  { id: "sidebar", title: "Customize sidebar", description: "Rename, hide and reorder what your team sees", icon: PanelLeft, permission: "settings.manage" },
  { id: "patient", title: `${t.Customer} page`, description: `What ${t.customers} see when they book`, icon: Globe, permission: "settings.manage" },
  { id: "guide", title: "Help me choose", description: `Questions that point ${t.customers} to the right ${t.provider}`, icon: ListChecks, permission: "settings.manage" },
  { id: "forms", title: "Booking forms", description: `Questions ${t.customers} answer when they book`, icon: ClipboardList, permission: "settings.manage" },
  { id: "workflows", title: "Reminders and follow-ups", description: `Messages sent before and after a ${t.visit}`, icon: BellRing, permission: "settings.manage" },
  { id: "brand", title: "Logo, cover and colours", description: `Your look on booking pages and emails`, icon: Palette, permission: "settings.manage" },
  { id: "discovery", title: "Find and share", description: `Be found on Google, share links and a printable poster`, icon: Search, permission: "settings.manage" },
  { id: "domain", title: "Own web address", description: `Let ${t.customers} book at your own address`, icon: Link2, permission: "settings.manage" },
  { id: "hours", title: "Hours", description: "Working days, lunch, and time off", icon: CalendarDays, permission: "hours.edit" },
  { id: "cancelreasons", title: "Cancellation reasons", description: `Quick choices when you cancel ${t.anAppointment}`, icon: MessageSquareText, permission: "settings.manage" },
  { id: "payments", title: "Payments", description: `Deposits, online payment and refund rules`, icon: Banknote, permission: "payments.settings" },
  { id: "templates", title: "Service templates", description: "Define a service once and give it to every branch", icon: Layers, permission: "services.manage" },
  { id: "limits", title: "Team limits", description: `Cap what a few ${t.practitioners} take on together`, icon: Gauge, permission: "settings.manage" },
  { id: "assistant", title: "AI assistant", description: `Answers ${t.customers} on your page and WhatsApp, day and night`, icon: Bot, permission: "settings.manage" },
  { id: "organisation", title: "Organisation", description: "Teams, roles, company sign-in and directory sync", icon: Network, permission: "org.manage" },
  { id: "messaging", title: "WhatsApp and text messages", description: `Which channels reach ${t.customers}, and template approvals`, icon: MessageSquareText, permission: "settings.manage" },
  { id: "security", title: "Data protection", description: "Encryption key and file checks", icon: ShieldCheck, permission: "settings.manage" },
  { id: "privacy", title: "Privacy", description: `How long information is kept, and ${t.customer} privacy requests`, icon: ShieldUser, permission: "privacy.manage" },
  { id: "billing", title: "Plan and billing", description: "Your plan, usage and invoices", icon: CreditCard, permission: "settings.manage", ownerOnly: true },
  { id: "import", title: "Import data", description: `Bring ${t.customers}, ${t.services} and ${t.appointments} in from a spreadsheet`, icon: FileUp, permission: "settings.manage" },
  { id: "apps", title: "Apps", description: "Connect Slack, a CRM and other tools", icon: Blocks, permission: "apps.manage" },
  { id: "developers", title: "Developers", description: "API keys and webhooks for other software", icon: Code2, permission: "api.manage" },
  { id: "website", title: "Website connection", description: "Booking link and website installation code", icon: Globe2, permission: "settings.manage" },
];

const laterItems: SettingsItem[] = [
  { id: "reminders", title: "Reminder channels", description: "Channels and timing · not stored yet", icon: MessageSquareText, permission: "settings.manage" },
];

/** Settings sections this person can open, grouped, in nav order. Groups with nothing this person may open are left out. */
export function useSettingsSections(): { groups: { id: SettingsGroupId; title: string; items: SettingsItem[] }[]; all: SettingsItem[] } {
  const access = useStaffAccess();
  const t = useTerms();
  const allowed = [...clinicItems(t), ...laterItems].filter((item) => access.can(item.permission) && (!item.ownerOnly || access.role === "owner"));
  const byId = new Map(allowed.map((item) => [item.id, item]));
  const groups = settingsGroups(t)
    .map((group) => ({ id: group.id, title: group.title, items: group.sections.flatMap((id) => byId.get(id) ?? []) }))
    .filter((group) => group.items.length > 0);
  return { groups, all: groups.flatMap((group) => group.items) };
}

/** The Settings page address, opened at a section when one is given. */
export function settingsHref(section?: SettingsSection | null): string {
  return section ? `/settings?section=${section}` : "/settings";
}

/** The section the address asks for, or the first one this person may open. */
export function pickSettingsSection(asked: string | null, items: SettingsItem[]): SettingsItem | undefined {
  return items.find((item) => item.id === asked) ?? items.find((item) => item.id === "patient") ?? items[0];
}
