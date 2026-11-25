/**
 * The service editor's map: which group each tab sits in, and an index of the settings inside the tabs that the search
 * box filters. Pure data, so the left nav, the search and the tests read one source.
 *
 * Tab ids are what `?tab=` deep links carry, so they never change. A later feature adds a settings entry here and puts a
 * `SettingRow` with the same `settingId` in its tab.
 */
import type { TermWords } from "@/lib/terminology";

export const serviceEditorGroupIds = ["setup", "experience", "policies", "automation"] as const;
export type ServiceEditorGroupId = (typeof serviceEditorGroupIds)[number];

export const serviceEditorGroupLabels: Record<ServiceEditorGroupId, string> = {
  setup: "Setup",
  experience: "Booking experience",
  policies: "Policies",
  automation: "Automation",
};

/** Tab ids in each group, in the order the nav shows them. Every id of `serviceEditorTabs` appears exactly once. */
export const serviceEditorGroups: Record<ServiceEditorGroupId, readonly string[]> = {
  setup: ["basics", "lengths", "where", "hours"],
  experience: ["look", "page", "questions"],
  policies: ["timing", "limits", "approval", "cancelling", "payment"],
  automation: ["routing", "calendar"],
};

export function groupOfTab(tabId: string): ServiceEditorGroupId {
  return serviceEditorGroupIds.find((group) => serviceEditorGroups[group].includes(tabId)) ?? "setup";
}

export interface SettingIndexEntry {
  /** The `settingId` of the SettingRow. The page scrolls to `[data-setting="<id>"]`. */
  id: string;
  tab: string;
  title: (t: TermWords) => string;
  /** Other words people search for, lower case. */
  keywords: readonly string[];
}

export const settingsIndex: readonly SettingIndexEntry[] = [
  { id: "name", tab: "basics", title: () => "Basics", keywords: ["name", "description", "title", "category", "link name", "slug"] },
  { id: "who", tab: "basics", title: (t) => `Who gives the ${t.service}, and where`, keywords: ["people", "branch", "location", "staff"] },
  { id: "lengths", tab: "lengths", title: () => "Lengths and prices", keywords: ["duration", "minutes", "price", "cost"] },
  { id: "meeting", tab: "where", title: () => "Where it happens", keywords: ["in person", "phone", "video", "address", "online"] },
  { id: "hours", tab: "hours", title: () => "Hours for this one", keywords: ["schedule", "availability", "business hours", "times"] },
  { id: "look", tab: "look", title: () => "Colour and picture", keywords: ["color", "photo", "banner", "image", "description"] },
  { id: "layouts", tab: "page", title: () => "Booking page layout", keywords: ["month", "week", "column", "view", "timezone", "time zone", "week starts"] },
  { id: "intake", tab: "questions", title: () => "What we ask for", keywords: ["questions", "contact", "phone", "email"] },
  { id: "guests", tab: "questions", title: (t) => `${t.Customers} can add guests`, keywords: ["guests", "people", "attendees"] },
  { id: "verify-email", tab: "questions", title: () => "Check the email with a code", keywords: ["verify", "otp", "confirm email"] },
  { id: "buffers", tab: "timing", title: () => "Buffers", keywords: ["before", "after", "gap", "break"] },
  { id: "notice", tab: "timing", title: () => "Minimum notice", keywords: ["lead", "advance", "last minute"] },
  { id: "window", tab: "timing", title: () => "How far ahead", keywords: ["days ahead", "date range", "booking window"] },
  { id: "interval", tab: "timing", title: () => "Slot interval", keywords: ["start times", "spacing", "offset"] },
  { id: "after-booking", tab: "page", title: (t) => `After ${t.aCustomer} books`, keywords: ["thank you", "redirect", "confirmation message", "success"] },
  { id: "limits", tab: "limits", title: () => "Limits", keywords: ["per day", "per week", "maximum", "cap", "first slot"] },
  { id: "approval", tab: "approval", title: () => "Approval", keywords: ["confirm", "request", "accept", "manual"] },
  { id: "cancel", tab: "cancelling", title: (t) => `${t.Customers} can cancel online`, keywords: ["cancel", "cancellation", "cutoff", "refund"] },
  { id: "reschedule", tab: "cancelling", title: (t) => `${t.Customers} can move their booking`, keywords: ["move", "reschedule", "change time"] },
  { id: "payment", tab: "payment", title: () => "Payment when booking", keywords: ["deposit", "price", "pay", "card", "online payment"] },
  { id: "routing", tab: "routing", title: () => "Team routing", keywords: ["round robin", "assign", "who gets", "priority", "weight"] },
  { id: "calendar-wording", tab: "calendar", title: () => "Calendar entry wording", keywords: ["title", "description", "placeholder", "busy", "privacy"] },
];

/** The settings whose title or keywords contain every word typed. Empty input matches nothing. */
export function searchSettings(query: string, t: TermWords): SettingIndexEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return settingsIndex.filter((entry) => {
    const haystack = [entry.title(t), ...entry.keywords].join(" ").toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}
