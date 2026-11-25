/**
 * Which staff screens a person may open. One table for the server (the page guards), the sidebar (which links to show)
 * and the tests, so a screen can never be hidden in one place and open in another.
 *
 * A rule is either "member" (any signed-in staff member; what they see is then limited by the data itself, such as a
 * practitioner seeing only their own customers) or a list of permissions where holding any one opens the screen. The
 * list follows the permission the screen's own data request already needs, so opening a page never lands on a refusal.
 * Doing things on a screen is still checked on the server per action.
 */
import type { Permission } from "@/lib/permissions";

export const staffPageIds = [
  "dashboard",
  "schedule",
  "bookings",
  "patients",
  "doctors",
  "follow-ups",
  "classes",
  "messages",
  "offers",
  "billing",
  "billing-invoice",
  "campaigns",
  "routing-forms",
  "services",
  "reports",
  "records",
  "reviews",
  "spam",
  "activity",
  "settings",
  "settings-import",
  "settings-privacy-requests",
  "print-poster",
  "appointment-new",
  "appointment",
  "appointment-series",
  "profile",
] as const;

export type StaffPageId = (typeof staffPageIds)[number];

export type PageRule = "member" | { anyOf: readonly Permission[] };

/**
 * The Settings sections that each have their own permission (see `settings-sections.ts`, which a test keeps in step).
 * Settings opens for anyone who may open at least one of them; each section then checks its own permission.
 */
export const settingsSectionPermissions: readonly Permission[] = [
  "settings.manage",
  "hours.edit",
  "payments.settings",
  "services.manage",
  "org.manage",
  "privacy.manage",
  "apps.manage",
  "api.manage",
];

export const staffPageRules: Record<StaffPageId, PageRule> = {
  // Everyone signed in lands here after signing in, so it never refuses; its cards follow the person's permissions.
  dashboard: "member",
  // Every role may look at the schedule, patients, doctors and their own profile; changing things is checked per action.
  schedule: "member",
  patients: "member",
  doctors: "member",
  profile: "member",
  appointment: "member",
  // The bookings list and a repeating series are read with the same permission on the server.
  bookings: { anyOf: ["appointments.status"] },
  "appointment-series": { anyOf: ["appointments.status"] },
  "appointment-new": { anyOf: ["appointments.book"] },
  "follow-ups": { anyOf: ["appointments.book"] },
  classes: { anyOf: ["schedule.read", "classes.manage"] },
  messages: { anyOf: ["inbox.reply", "messages.retry", "appointments.book"] },
  offers: { anyOf: ["schedule.read"] },
  billing: { anyOf: ["payments.collect"] },
  "billing-invoice": { anyOf: ["payments.collect"] },
  campaigns: { anyOf: ["campaigns.manage"] },
  "routing-forms": { anyOf: ["routing.manage"] },
  // The list and the editor read and save a service, which the server allows with settings.manage.
  services: { anyOf: ["settings.manage"] },
  reports: { anyOf: ["reports.view"] },
  records: { anyOf: ["records.view"] },
  reviews: { anyOf: ["settings.manage"] },
  spam: { anyOf: ["spam.manage"] },
  activity: { anyOf: ["audit.view"] },
  settings: { anyOf: settingsSectionPermissions },
  "settings-import": { anyOf: ["settings.manage"] },
  "settings-privacy-requests": { anyOf: ["privacy.manage"] },
  // The printable poster reads the booking-page listing, which Settings owns.
  "print-poster": { anyOf: ["settings.manage"] },
};

/** Whether holding these permissions opens the screen. */
export function canOpenPage(permissions: readonly Permission[], page: StaffPageId): boolean {
  const rule = staffPageRules[page];
  return rule === "member" || rule.anyOf.some((permission) => permissions.includes(permission));
}

/** Whether holding these permissions opens at least one of them. */
export function holdsAny(permissions: readonly Permission[], wanted: readonly Permission[]): boolean {
  return wanted.some((permission) => permissions.includes(permission));
}
